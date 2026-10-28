// Separate build entry: the SDK reads HOME/environment at load time. Supervisor
// mode remains the process-group identity anchor after the SDK worker exits.
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { executeCursorSdk, serializeCursorError } from "./cursor-sdk.ts";
import type { CursorRequest, CursorSdkModule, CursorSqliteModule, CursorWorkerMessage, CursorSerializedError } from "./cursor-sdk.ts";
import { cursorOwnedGroupMembers } from "./cursor-process-tree.ts";
import type { CursorProcessOwnerMessage } from "./cursor-process-tree.ts";

function send(message: CursorWorkerMessage | CursorProcessOwnerMessage): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (!process.send || !process.connected) reject(new Error("Cursor worker's owner disconnected."));
  else process.send(message, (error: Error | null) => error ? reject(error) : resolve());
  return promise;
}

function supervise(filename: string, cancelGraceMs: number, terminateGraceMs: number): void {
  // Ignore TERM only in this trusted supervisor. SDK/shell/MCP workers still
  // receive it, and the group identity stays reserved until our final KILL.
  process.on("SIGTERM", () => undefined);
  const worker = fork(filename, [], {
    execArgv: [], detached: false, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
  });
  let stopping = false;
  let workerReported = false;
  let finalizing = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let killAt = Infinity;

  const killGroup = async () => {
    if (finalizing) return;
    finalizing = true;
    clearTimeout(termTimer);
    clearTimeout(killTimer);
    try {
      const members = cursorOwnedGroupMembers(process.pid);
      await send({ type: "owner-killing", groupId: process.pid, members });
    } finally {
      if (process.platform !== "win32") {
        // Only the still-live owner signals its own group: never a recycled PID.
        process.kill(-process.pid, "SIGKILL");
      }
      // Windows: the server runs taskkill /T /F outside this live owned tree.
      // Keeping both supervisor and SDK worker alive preserves its ancestry.
    }
  };
  const scheduleKill = (deadline: number) => {
    if (deadline >= killAt) return;
    killAt = deadline;
    clearTimeout(killTimer);
    killTimer = setTimeout(() => { void killGroup(); }, Math.max(0, deadline - Date.now()));
  };
  const terminateGroup = () => {
    if (process.platform === "win32") { void killGroup(); return; }
    process.kill(-process.pid, "SIGTERM");
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (worker.connected) worker.send({ type: "cancel" }, () => undefined);
    termTimer = setTimeout(terminateGroup, cancelGraceMs);
    scheduleKill(Date.now() + cancelGraceMs + terminateGraceMs);
  };
  const completeWorker = async (code: number | null, signal: NodeJS.Signals | null) => {
    if (workerReported) return;
    workerReported = true;
    await send({ type: "worker-exit", code, signal });
    // The SDK leader exiting is not tree completion. On Linux this exact live
    // group snapshot also detects descendants reparented to init by leader exit.
    if (process.platform === "linux" && cursorOwnedGroupMembers(process.pid).length === 0) {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      process.exit(0);
    }
    clearTimeout(termTimer);
    terminateGroup();
    scheduleKill(Date.now() + terminateGraceMs);
  };
  worker.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null ||
        !["event", "result", "error"].includes(String(Reflect.get(message, "type")))) {
      void send({ type: "error", error: { name: "Error", message: "Invalid Cursor SDK worker message." } }).catch(stop);
      stop();
      return;
    }
    void send(message as CursorWorkerMessage).then(() => {
      // Native Windows workers deliberately remain alive after disposing the SDK
      // so taskkill's tree traversal cannot lose their orphaned descendants.
      if (process.platform === "win32" && Reflect.get(message, "type") !== "event")
        return completeWorker(Reflect.get(message, "type") === "result" ? 0 : 1, null);
    }).catch(stop);
  });
  worker.once("error", (error) => {
    void send({ type: "error", error: serializeCursorError(error) }).catch(stop);
    stop();
  });
  worker.once("close", (code, signal) => { void completeWorker(code, signal).catch(stop); });
  process.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) { stop(); return; }
    if (Reflect.get(message, "type") === "cancel") stop();
    else if (worker.connected) worker.send(message, () => undefined);
  });
  process.once("disconnect", stop);
}

function runNativeWorker(): void {
  const requireSdk = createRequire(import.meta.url);
  const controller = new AbortController();
  let started = false;
  let sdkLoaded = false;
  let activeRequest: CursorRequest | undefined;
  const privateError = (error: unknown): CursorSerializedError => {
    const serialized = serializeCursorError(error);
    serialized.sdkLoaded = sdkLoaded;
    if (activeRequest?.operation === "login") {
      serialized.message = "Cursor sign-in failed. Start sign-in again.";
      return serialized;
    }
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key))
      .map(([, value]) => value!);
    if (activeRequest?.apiKey) secrets.push(activeRequest.apiKey);
    for (const secret of secrets) {
      if (secret.length >= 4) serialized.message = serialized.message.split(secret).join("[redacted]");
    }
    return serialized;
  };
  // Match t3code's narrow SDK guards; every other unhandled rejection is fatal
  // to this isolated operation, not the Agent server or another provider.
  process.on("unhandledRejection", (reason: unknown) => {
    if (reason instanceof Error && reason.name === "WriteIterableClosedError") {
      console.error("Cursor SDK wrote to a closed exec stream.");
      return;
    }
    if (typeof reason === "object" && reason !== null) {
      const syscall = Reflect.get(reason, "syscall");
      const code = Reflect.get(reason, "code");
      const args = Reflect.get(reason, "spawnargs");
      if (typeof syscall === "string" && syscall.startsWith("spawn") && typeof code === "string" &&
          Array.isArray(args) && args.some((arg) => typeof arg === "string" &&
            ["dump_zsh_state", "dump_bash_state", "__CURSOR_SANDBOX_ENV_RESTORE"].some((marker) => arg.includes(marker)))) {
        console.error("Cursor shell spawn failed.");
        return;
      }
    }
    void send({ type: "error", error: privateError(reason) }).finally(() => {
      if (process.platform !== "win32") process.exit(1);
    });
  });
  process.once("disconnect", () => controller.abort());
  process.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    if (Reflect.get(message, "type") === "cancel") { controller.abort(); return; }
    if (Reflect.get(message, "type") !== "request" || started) return;
    started = true;
    const request = Reflect.get(message, "request") as CursorRequest;
    activeRequest = request;
    void (async () => {
      try {
        // Webpack chunks and native optional platform packages stay disk-backed.
        const sdk = requireSdk("@cursor/sdk") as CursorSdkModule;
        sdkLoaded = true;
        const result = await executeCursorSdk(
          sdk, () => requireSdk("@cursor/sdk/sqlite") as CursorSqliteModule,
          request, controller.signal, (event) => send({ type: "event", event }),
        );
        await send({ type: "result", result });
        if (process.platform !== "win32") process.exit(0);
      } catch (error) {
        try { await send({ type: "error", error: privateError(error) }); }
        finally { if (process.platform !== "win32") process.exit(1); }
      }
    })();
  });
}

if (process.argv[2] === "--cursor-supervisor") {
  const filename = process.argv[3];
  const cancelGraceMs = Number(process.argv[4]);
  const terminateGraceMs = Number(process.argv[5]);
  if (!filename || !Number.isSafeInteger(cancelGraceMs) || cancelGraceMs < 0 ||
      !Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 0) throw new Error("Invalid Cursor supervisor options.");
  supervise(filename, cancelGraceMs, terminateGraceMs);
} else runNativeWorker();
