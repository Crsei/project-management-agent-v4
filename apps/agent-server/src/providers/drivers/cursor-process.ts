import { execFile, fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeOutputItemSchema } from "@agent-workspace/contracts/output";
import { nativeUsageUpdateSchema } from "@agent-workspace/contracts/usage";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import { cursorAbortError } from "./cursor-sdk.ts";
import type { CursorEvent, CursorRequest, CursorResult, CursorSerializedError } from "./cursor-sdk.ts";
import { assertCursorStorageIsolation } from "./cursor-credentials.ts";
import { cursorOwnedGroupMembers, waitForCursorOwnedProcesses } from "./cursor-process-tree.ts";
import type { CursorOwnedProcess } from "./cursor-process-tree.ts";

export class CursorWorkerError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly dependencyMissing: boolean;
  readonly sdkLoaded: boolean;
  constructor(error: CursorSerializedError) {
    super(error.message);
    this.name = error.name;
    this.code = error.code;
    this.status = error.status;
    this.dependencyMissing = error.dependencyMissing === true;
    this.sdkLoaded = error.sdkLoaded === true;
  }
}

export type CursorInvokeOptions = {
  signal?: AbortSignal;
  onEvent?: (event: CursorEvent) => void;
  timeoutMs?: number;
};
export type CursorInvoker = (
  context: ProviderDriverContext,
  request: CursorRequest,
  options?: CursorInvokeOptions,
) => Promise<CursorResult>;
export type CursorProcessGrace = { cancelMs: number; terminateMs: number };

export function cursorPrivateError(error: unknown, context: ProviderDriverContext): string {
  let text = error instanceof Error ? error.message : "Cursor SDK request failed.";
  for (const [key, value] of Object.entries(context.env)) {
    if (value && value.length >= 4 && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key))
      text = text.split(value).join("[redacted]");
  }
  return sanitizeErrorMessage(text, "Cursor SDK request failed.");
}

/** A separate SDK process per operation also isolates SDK module-global caches. */
export function createCursorInvoker(
  workerUrl?: URL,
  grace: CursorProcessGrace = { cancelMs: 5000, terminateMs: 2000 },
): CursorInvoker {
  return async (context, request, options = {}) => {
    options.signal?.throwIfAborted();
    mkdirSync(context.homeDirectory, { recursive: true, mode: 0o700 });
    assertCursorStorageIsolation(context.homeDirectory);
    const source = import.meta.url.endsWith(".ts");
    const supervisor = fileURLToPath(new URL(
      source ? "./cursor-sdk-worker.ts" : "./providers/drivers/cursor-sdk-worker.mjs",
      import.meta.url,
    ));
    const filename = workerUrl ? fileURLToPath(workerUrl) : supervisor;
    const home = context.homeDirectory;
    // The SDK and its shell/MCP children receive only the instance environment.
    const env: NodeJS.ProcessEnv = {
      ...context.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    };
    const child = fork(supervisor, [
      "--cursor-supervisor", filename, String(grace.cancelMs), String(grace.terminateMs),
    ], {
      cwd: context.cwd,
      env,
      // Node >=22.18 strips source TS; never inherit server --watch/--test/--import.
      execArgv: [],
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    const { promise, resolve, reject } = Promise.withResolvers<CursorResult>();
    let terminal: CursorResult | undefined;
    let failure: Error | undefined;
    let workerExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let ownedProcesses: CursorOwnedProcess[] = [];
    let treeTermination: Promise<void> | undefined;
    let ownerKilling = false;
    let settled = false;
    let finishing = false;
    let stopping = false;
    const stop = (error: Error) => {
      failure ??= error;
      if (stopping) return;
      stopping = true;
      // The persistent owner retains its own TERM/KILL schedule even when the
      // SDK leader closes. No saved process-group ID is ever signalled here.
      if (child.connected) child.send({ type: "cancel" }, () => undefined);
    };
    const abort = () => stop(cursorAbortError());
    const timeoutMs = options.timeoutMs ?? (request.operation === "check" ? 15_000 : request.operation === "login" ? 300_000 : undefined);
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => stop(new CursorWorkerError({
      name: "TimeoutError", message: `Cursor SDK ${request.operation} timed out.`, code: "timeout",
    })), timeoutMs);
    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (finishing || settled) return;
      finishing = true;
      clearTimeout(timeout);
      try {
        if (treeTermination) await treeTermination;
        if (child.pid && process.platform === "linux")
          ownedProcesses.push(...cursorOwnedGroupMembers(child.pid));
        await waitForCursorOwnedProcesses(ownedProcesses, ownerKilling ? child.pid : undefined);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error("Cursor owned-process cleanup failed.");
      } finally {
        settled = true;
        options.signal?.removeEventListener("abort", abort);
      }
      if (options.signal?.aborted) reject(cursorAbortError());
      else if (failure) reject(failure);
      else if (!workerExit || workerExit.code !== 0 || workerExit.signal ||
          (!ownerKilling && (code !== 0 || signal))) reject(new CursorWorkerError({
        name: "Error",
        message: `Cursor SDK worker exited without success (${workerExit?.signal || workerExit?.code || signal || code}).`,
      }));
      else if (!terminal) reject(new CursorWorkerError({ name: "Error", message: "Cursor SDK worker closed without a terminal result." }));
      else resolve(terminal);
    };
    child.on("message", (raw: unknown) => {
      if (settled) return;
      if (typeof raw !== "object" || raw === null) return stop(new Error("Invalid Cursor SDK worker message."));
      const type = Reflect.get(raw, "type");
      // Ownership messages must still be consumed after cancellation.
      if (type === "worker-exit") {
        const code = Reflect.get(raw, "code");
        const signal = Reflect.get(raw, "signal");
        if (workerExit || !(code === null || typeof code === "number") || !(signal === null || typeof signal === "string"))
          return stop(new Error("Invalid Cursor SDK worker exit observation."));
        workerExit = { code, signal: signal as NodeJS.Signals | null };
        return;
      }
      if (type === "owner-killing") {
        const groupId = Reflect.get(raw, "groupId");
        const members = Reflect.get(raw, "members") as CursorOwnedProcess[] | undefined;
        if (ownerKilling || groupId !== child.pid || !Array.isArray(members) || members.some((member) =>
          !member || !Number.isSafeInteger(member.pid) || member.pid <= 0 || typeof member.startTime !== "string"))
          return stop(new Error("Invalid Cursor owned-process cleanup observation."));
        ownerKilling = true;
        ownedProcesses = members;
        if (process.platform === "win32") {
          // Invoke outside the live owned tree; the supervisor never exits while
          // waiting for this command, so its PID/ancestry cannot be recycled.
          const done = Promise.withResolvers<void>();
          treeTermination = done.promise;
          void treeTermination.catch(() => undefined);
          execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true },
            (error) => error ? done.reject(error) : done.resolve());
        }
        return;
      }
      if (stopping || finishing) return;
      if (type === "error") {
        const error = Reflect.get(raw, "error") as CursorSerializedError | undefined;
        if (!error || typeof error.message !== "string") return stop(new Error("Invalid Cursor SDK error response."));
        stop(new CursorWorkerError(error));
      } else if (type === "result") {
        const result = Reflect.get(raw, "result") as CursorResult | undefined;
        if (terminal || !result || result.operation !== request.operation)
          return stop(new Error("Cursor SDK returned an unexpected terminal result."));
        terminal = result;
      } else if (type === "event") {
        if (terminal || failure) return stop(new Error("Cursor SDK sent output after its terminal result."));
        const event = Reflect.get(raw, "event") as CursorEvent | undefined;
        if (!event ||
            !((event.type === "text" && typeof event.text === "string") ||
              (event.type === "session" && typeof event.sessionId === "string" && event.sessionId.length > 0 &&
                (event.turnId === undefined || typeof event.turnId === "string")) ||
              (event.type === "login-url" && typeof event.url === "string") ||
              (event.type === "usage" && nativeUsageUpdateSchema.safeParse(event.update).success) ||
              (event.type === "output" && event.event !== null && typeof event.event === "object" &&
                ((event.event.type === "item.upsert" && nativeOutputItemSchema.safeParse(event.event.item).success) ||
                  (event.event.type === "command.output" && typeof event.event.itemId === "string" &&
                    event.event.itemId.length > 0 && typeof event.event.chunk === "string")))))
          return stop(new Error("Invalid Cursor SDK event."));
        try { options.onEvent?.(event); } catch (error) {
          stop(error instanceof Error ? error : new Error("Cursor SDK callback failed."));
        }
      } else stop(new Error("Unknown Cursor SDK worker message."));
    });
    child.once("error", (error) => {
      failure ??= error;
      if (!child.pid) void finish(null, null);
    });
    child.once("close", (code, signal) => { void finish(code, signal); });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else child.send({ type: "request", request }, (error) => {
      if (error && !settled) stop(error);
    });
    return promise;
  };
}

export const invokeCursorWorker: CursorInvoker = createCursorInvoker();
