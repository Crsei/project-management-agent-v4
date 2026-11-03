// Local security adaptation of the copied McpAppFrame/host transport.
// A WindowProxy and opaque origin survive navigation; neither authenticates a document.
import { z } from "zod";
const READY = "pm-mcp-app-document/v1/ready";
const GONE = "pm-mcp-app-document/v1/gone";
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PENDING_ATTESTATIONS = 16;
const ATTESTATION_TIMEOUT_MS = 2000;
const encoder = new TextEncoder();
const documentSignalSchema = z.strictObject({ type: z.enum([READY, GONE]), capability: z.string().regex(/^[a-f0-9]{64}$/) });
const portSignalSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("document-gone") }),
  z.strictObject({ type: z.literal("attested"), id: z.string().max(128) }),
]);

type CapturedDocument = { html: string; capability: string };

/** Inject before every App script, but after the server-captured CSP. No capability enters a URL. */
export function bindMcpAppDocument(html: string, parentOrigin: string): CapturedDocument {
  const prefix = /^(?:\uFEFF?\s*<!doctype[^>]*>\s*)?<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/i.exec(html)?.[0];
  if (!prefix) throw new Error("The private App document has no leading captured security policy.");
  const capability = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const config = JSON.stringify({ capability, parentOrigin, ready: READY, gone: GONE }).replaceAll("<", "\\u003c");
  const bootstrap = `<script data-mcp-app-document-binding>
(() => {
  "use strict";
  const config = ${config};
  const originalDocument = document;
  const originalParent = window.parent;
  const originalView = originalDocument.defaultView;
  const channel = new MessageChannel();
  const port = channel.port1;
  let active = true;
  const current = () => {
    // defaultView is the browsing context's WindowProxy: after commit it cannot expose this old document.
    try { return active && originalView !== null && originalView.document === originalDocument; }
    catch { return false; }
  };
  port.onmessage = (event) => {
    if (!current() || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "attest" && typeof event.data.id === "string") {
      port.postMessage({ type: "attested", id: event.data.id });
    } else if (event.data.type === "host-message") {
      // Native SDK PostMessageTransport still sees its actual captured parent WindowProxy.
      // Delivery uses this document's port, never postMessage to a replacement WindowProxy.
      window.dispatchEvent(new MessageEvent("message", {
        data: event.data.message, origin: config.parentOrigin, source: originalParent
      }));
    }
  };
  port.start();
  const revoke = () => {
    if (!active) return;
    active = false;
    port.postMessage({ type: "document-gone" });
    // Also authenticate pagehide directly, in case closing a port drops its queued notification.
    originalParent.postMessage({ type: config.gone, capability: config.capability }, config.parentOrigin);
    port.close();
  };
  window.addEventListener("pagehide", revoke, { once: true });
  window.addEventListener("unload", revoke, { once: true });
  originalParent.postMessage({ type: config.ready, capability: config.capability }, config.parentOrigin, [channel.port2]);
  document.currentScript?.remove();
})();
</script>`;
  return { capability, html: prefix + bootstrap + html.slice(prefix.length) };
}

function boundedRpcMessage(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("jsonrpc" in value) || value.jsonrpc !== "2.0") return false;
  try { return encoder.encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_BYTES; }
  catch { return false; }
}

/**
 * Raw native SDK messages are only candidates. Each is admitted after a fresh challenge on
 * the original document's one-use port. A replacement document cannot attest, even before load.
 */
export function makeMcpAppDocumentBridge(options: {
  capability: string;
  source: () => Window | null;
  receive: (message: unknown) => void;
  invalidated: () => void;
}) {
  let port: MessagePort | undefined;
  let claimed = false;
  let disposed = false;
  const pending = new Map<string, { message: unknown; timer: ReturnType<typeof setTimeout> }>();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); port = undefined; }
  };
  const invalidate = () => { if (!disposed) { dispose(); options.invalidated(); } };
  return {
    receive(event: MessageEvent) {
      if (disposed || event.source === null || event.source !== options.source() || event.origin !== "null") return;
      const data: unknown = event.data;
      const signal = documentSignalSchema.safeParse(data);
      if (signal.success && signal.data.type === GONE && signal.data.capability === options.capability) { invalidate(); return; }
      if (signal.success && signal.data.type === READY) {
        if (claimed || signal.data.capability !== options.capability || event.ports.length !== 1) {
          for (const candidate of event.ports) candidate.close();
          return;
        }
        claimed = true; port = event.ports[0]!;
        port.onmessage = (answer: MessageEvent<unknown>) => {
          if (disposed) return;
          const signal = portSignalSchema.safeParse(answer.data);
          if (!signal.success) return;
          if (signal.data.type === "document-gone") { invalidate(); return; }
          const entry = pending.get(signal.data.id);
          if (!entry) return;
          pending.delete(signal.data.id); clearTimeout(entry.timer);
          options.receive(entry.message);
        };
        port.onmessageerror = invalidate;
        port.start();
        return;
      }
      for (const candidate of event.ports) candidate.close();
      if (!port || !boundedRpcMessage(data) || pending.size >= MAX_PENDING_ATTESTATIONS) return;
      const id = crypto.randomUUID();
      const timer = setTimeout(invalidate, ATTESTATION_TIMEOUT_MS);
      pending.set(id, { message: data, timer });
      port.postMessage({ type: "attest", id });
    },
    post(message: unknown) {
      if (!disposed && port) port.postMessage({ type: "host-message", message });
    },
    dispose,
    invalidate,
  };
}
