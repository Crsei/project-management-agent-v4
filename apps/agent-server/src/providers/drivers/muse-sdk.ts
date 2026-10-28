// Ported from t3code/packages/provider-muse/src/server/sdk.ts (MIT).
import path from "node:path";
import { spawnMspConnection, type Connection, type ProcessExit, type SpawnedMspConnection } from "@muse-code/sdk";
import type { ProviderConfig } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../driver-adapter.ts";

export interface MuseHost {
  connection: Pick<Connection, "command" | "request" | "mintCommandId" | "onNotification" | "onServerRequest" | "onProtocolError" | "closed">;
  initializeResult: SpawnedMspConnection["initializeResult"];
  exited: Promise<ProcessExit>;
  close(): Promise<void>;
}

export function validateMuseConfig(config: ProviderConfig): ProviderConfig {
  for (const key of Object.keys(config)) if (key !== "binaryPath") throw new Error(`Unknown Muse setting: ${key}`);
  if (config.binaryPath !== undefined && typeof config.binaryPath !== "string") throw new Error("Muse binaryPath must be a string.");
  const binaryPath = typeof config.binaryPath === "string" ? config.binaryPath.trim() || "muse" : "muse";
  if (binaryPath.includes("\0")) throw new Error("Muse binaryPath cannot contain NUL bytes.");
  return { binaryPath };
}

export function museBinary(context: ProviderDriverContext): string {
  const binary = String(validateMuseConfig(context.config).binaryPath);
  return binary.startsWith("~/") ? path.join(context.homeDirectory, binary.slice(2)) : binary;
}

export function museEnvironment(context: ProviderDriverContext): NodeJS.ProcessEnv {
  // Registry removes ambient secrets first; explicitly configured instance META_API_KEY is native and remains supported.
  return { ...context.env, HOME: context.homeDirectory, USERPROFILE: context.homeDirectory, MUSE_NO_AUTO_UPDATE: "1" };
}

export async function createMuseHost(context: ProviderDriverContext, options: { signal?: AbortSignal; readOnly?: boolean; startupTimeoutMs?: number } = {}): Promise<MuseHost> {
  options.signal?.throwIfAborted();
  const processExit = Promise.withResolvers<ProcessExit>();
  const handshake = spawnMspConnection({
    command: museBinary(context),
    args: options.readOnly ? ["serve", "--disable-shell", "--disable-write", "--no-session-log"] : ["serve", "--trust-workspace"],
    cwd: context.cwd,
    env: museEnvironment(context),
    shutdownTimeoutMs: 10_000,
    onProcessExit: processExit.resolve,
  });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    options.signal?.removeEventListener("abort", onAbort);
    return closePromise ??= handshake.close().then(() => undefined);
  };
  const interrupted = Promise.withResolvers<never>();
  const onAbort = () => {
    interrupted.reject(options.signal?.reason ?? new Error("Muse initialization cancelled."));
    void close().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => interrupted.reject(new Error("Muse SDK initialization timed out.")), options.startupTimeoutMs ?? 20_000);
  timer.unref();
  try {
    const host = await Promise.race([handshake.initialize({ clientInfo: { name: "agent_pm", title: "Agent PM", version: "1" }, capabilities: { requestedCapabilities: [] } }), interrupted.promise]);
    if (host.initializeResult.schema?.version !== 1) throw new Error("Muse returned an unsupported MSP protocol envelope version.");
    return { connection: host.connection, initializeResult: host.initializeResult, exited: processExit.promise, close };
  } catch (error) { await close(); throw error; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}

/** Native requests have a deadline; timing out closes the host, rather than racing a later mutation. */
export async function museRequest<T>(host: MuseHost, operation: string, work: Promise<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  const interrupted = Promise.withResolvers<never>();
  const onAbort = () => interrupted.reject(signal?.reason ?? new Error("Muse request cancelled."));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => interrupted.reject(new Error(`Muse ${operation} timed out.`)), timeoutMs);
  timer.unref();
  try { return await Promise.race([work, interrupted.promise]); }
  catch (error) { await host.close(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

/** Read the bounded stored text offered by MSP, advancing by stored bytes, not JS characters. */
export async function readMuseItemOutput(host: MuseHost, sessionId: string, itemId: string, outputRef: string, signal?: AbortSignal): Promise<{ content: string; truncated: boolean } | undefined> {
  const maxBytes = 4 * 1024 * 1024;
  let offsetBytes = 0;
  const chunks: string[] = [];
  while (offsetBytes < maxBytes) {
    const value = await museRequest(host, "item/readOutput", host.connection.request("item/readOutput", { sessionId, itemId, outputRef, offsetBytes, lengthBytes: Math.min(256 * 1024, maxBytes - offsetBytes) }), signal);
    const page = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (page.encoding === "base64") return undefined;
    if (page.encoding !== "utf8" || typeof page.content !== "string" || typeof page.eof !== "boolean" || page.offsetBytes !== offsetBytes || !Number.isSafeInteger(page.byteLen) || Number(page.byteLen) < 0 || Buffer.byteLength(page.content) !== page.byteLen || Number(page.byteLen) > maxBytes - offsetBytes) throw new Error("Muse returned an invalid stored output page.");
    chunks.push(page.content);
    offsetBytes += Number(page.byteLen);
    if (page.eof) return { content: chunks.join(""), truncated: false };
    if (page.byteLen === 0) throw new Error("Muse returned a stored output page without progress.");
  }
  return { content: chunks.join(""), truncated: true };
}
