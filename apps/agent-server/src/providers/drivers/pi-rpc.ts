// Protocol and LF-only framing ported from t3code packages/provider-pi/src/server/rpc.ts (MIT).
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { sanitizeErrorMessage } from "../../agents/cli-chat.ts";

export type PiRecord = Record<string, unknown>;
export interface PiRpc {
  request(record: PiRecord, timeoutMs?: number): Promise<unknown>;
  send(record: PiRecord): void;
  failed: Promise<never>;
  close(): Promise<void>;
  onEvent(listener: (event: PiRecord) => void): () => void;
}
export function piRecord(value: unknown): PiRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as PiRecord : {};
}
export function piString(value: unknown, key: string): string | undefined {
  const field = piRecord(value)[key];
  return typeof field === "string" ? field : undefined;
}
export function parsePiModelSlug(slug: string): { provider: string; modelId: string } {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) throw new Error("Pi models must use provider/model-id.");
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

/** Only LF ends a record: U+2028/U+2029 are valid model text, not frame boundaries. */
export function makePiFramer(maxChars = 32 * 1024 * 1024): (chunk: string) => string[] {
  let buffer = "";
  return (chunk) => {
    const frames: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (buffer.length + end - start > maxChars) throw new Error("Pi RPC record exceeded the framing limit.");
      buffer += chunk.slice(start, end);
      if (newline < 0) break;
      if (buffer.length) frames.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      buffer = "";
      start = newline + 1;
    }
    return frames;
  };
}

export function openPiRpc(options: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  options.signal?.throwIfAborted();
  const child = spawn(options.binary, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const decoder = new StringDecoder("utf8");
  const frame = makePiFramer();
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(event: PiRecord) => void>();
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => {});
  const exited = Promise.withResolvers<void>();
  let ended = false;
  let down: Error | undefined;
  let nextId = 0;
  let stderr = "";
  let closePromise: Promise<void> | undefined;
  const fail = (error: unknown) => {
    if (down) return;
    down = error instanceof Error ? error : new Error(String(error));
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(down); }
    pending.clear();
    failure.reject(down);
  };
  const signalChild = (signal: NodeJS.Signals) => {
    if (ended || !child.pid) return;
    try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Already exited. */ }
  };
  const close = () => closePromise ??= (async () => {
    options.signal?.removeEventListener("abort", abort);
    fail(new Error("Pi RPC connection closed."));
    if (!ended) {
      signalChild("SIGTERM");
      const timer = setTimeout(() => signalChild("SIGKILL"), 1_000);
      timer.unref();
      await exited.promise;
      clearTimeout(timer);
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  })();
  const abort = () => {
    if (!ended && !down) child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
    fail(options.signal?.reason ?? new Error("Pi cancelled."));
    void close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => { fail(error); ended = true; exited.resolve(); });
  child.once("exit", (code, signal) => {
    ended = true;
    exited.resolve();
    const timer = setTimeout(() => {
      fail(new Error(`Pi process exited before a successful terminal event (${signal ?? code ?? "unknown"}). ${sanitizeErrorMessage(stderr, "")}`));
      void close();
    }, 250);
    timer.unref();
  });
  child.once("close", (code, signal) => {
    ended = true;
    fail(new Error(`Pi process exited before a successful terminal event (${signal ?? code ?? "unknown"}). ${sanitizeErrorMessage(stderr, "")}`));
    exited.resolve();
  });
  child.stdin.on("error", fail);
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const line of frame(decoder.write(chunk))) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const record = piRecord(parsed);
        if (record.type === "response" && typeof record.id === "string") {
          const request = pending.get(record.id);
          if (request) {
            pending.delete(record.id);
            clearTimeout(request.timer);
            if (record.success === true) request.resolve(record.data);
            else request.reject(new Error(`Pi ${typeof record.command === "string" ? record.command : "RPC"} failed: ${sanitizeErrorMessage(record.error, "Unknown error")}`));
            continue;
          }
        }
        for (const listener of listeners) listener(record);
      }
    } catch (error) { fail(error); void close(); }
  });
  child.stdout.once("end", () => {
    const timer = setTimeout(() => { fail(new Error("Pi process closed stdout before completion.")); void close(); }, 250);
    timer.unref();
    exited.promise.then(() => clearTimeout(timer));
  });
  const send = (record: PiRecord) => {
    if (down) throw down;
    child.stdin.write(`${JSON.stringify(record)}\n`, (error) => { if (error) fail(error); });
  };
  const request = (record: PiRecord, timeoutMs = 30_000): Promise<unknown> => {
    if (down) return Promise.reject(down);
    const id = `agent-${++nextId}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Pi ${String(record.type)} timed out.`)); }, timeoutMs);
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    try { send({ ...record, id }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    return promise;
  };
  if (options.signal?.aborted) abort();
  return { request, send, failed: failure.promise, close, onEvent(listener: (event: PiRecord) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

