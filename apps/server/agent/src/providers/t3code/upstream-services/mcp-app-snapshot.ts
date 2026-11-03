// Provider-facing snapshot logic adapted from pinned t3code McpAppSnapshot.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ThreadId } from "@t3tools/contracts";
import {
  injectMcpAppCsp, MCP_APP_MAX_HTML_BYTES, MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_SCHEME,
  readMcpAppCsp, readMcpAppPermissions, type McpAppReference,
} from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { providerAttachmentsDirectory, registerProviderAttachment } from "./attachments.ts";
import { registerMcpAppAsset } from "../../../mcp-apps/assets.ts";

function readMcpAppDocument(contents: ReadonlyArray<unknown>, uri: string): { html: string | null; meta: unknown } | undefined {
  for (const content of contents) {
    if (!Predicate.isObject(content)) continue;
    if (content.uri !== undefined && content.uri !== uri) continue;
    const mimeType = typeof content.mimeType === "string" ? content.mimeType : "";
    if (mimeType.replace(/\s+/g, "").toLowerCase() !== MCP_APP_MIME_TYPE) continue;
    const html = typeof content.text === "string"
      ? content.text.length > MCP_APP_MAX_HTML_BYTES ? null : content.text
      : typeof content.blob === "string"
        ? content.blob.length > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4 ? null : Buffer.from(content.blob, "base64").toString("utf8")
        : undefined;
    if (html === null) return { html: null, meta: undefined };
    if (html === undefined || html.trim() === "") continue;
    return { html, meta: Predicate.isObject(content._meta) ? content._meta.ui : undefined };
  }
  return undefined;
}

/** Stores registered private bytes only; this does not activate an iframe or browser capability. */
export const snapshotMcpApp = Effect.fn("PmMcpAppSnapshot.snapshot")(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly contents: ReadonlyArray<unknown>;
}) {
  if (!input.resourceUri.startsWith(MCP_APP_RESOURCE_SCHEME)) return undefined;
  const document = readMcpAppDocument(input.contents, input.resourceUri);
  if (!document) return undefined;
  if (document.html === null || Buffer.byteLength(document.html, "utf8") > MCP_APP_MAX_HTML_BYTES) {
    yield* Effect.logWarning("MCP app document exceeds the size limit.");
    return undefined;
  }
  const ui = Predicate.isObject(document.meta) ? document.meta : {};
  const csp = readMcpAppCsp(ui.csp);
  const html = injectMcpAppCsp(document.html, csp);
  const attachmentId = `${randomUUID()}-html`;
  const permissions = readMcpAppPermissions(ui.permissions);
  const reference = {
    attachmentId, server: input.server, tool: input.tool, resourceUri: input.resourceUri,
    ...(csp === undefined ? {} : { csp }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
  } satisfies McpAppReference;
  yield* Effect.try({
    try: () => {
      const root = path.resolve(providerAttachmentsDirectory());
      if (path.resolve(input.attachmentsDir) !== root) throw new Error("MCP snapshot attachment root does not belong to this application.");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (realpathSync(root) !== root) throw new Error("MCP snapshot attachment root is not canonical.");
      const relativePath = `${attachmentId}.html`;
      const file = path.join(root, relativePath);
      const descriptor = openSync(file, "wx", 0o600);
      try {
        try { writeFileSync(descriptor, html); }
        finally { closeSync(descriptor); }
        registerProviderAttachment({ id: attachmentId, type: "file", name: relativePath,
          mimeType: MCP_APP_MIME_TYPE, sizeBytes: Buffer.byteLength(html, "utf8") }, relativePath);
        registerMcpAppAsset(input.threadId, reference, html);
      } catch (error) {
        unlinkSync(file);
        throw error;
      }
    },
    catch: cause => cause instanceof Error ? cause : new Error("Could not register the native MCP snapshot."),
  });
  return reference;
});
