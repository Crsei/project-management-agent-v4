import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { InteractionUpdate } from "@cursor/sdk";
import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { CursorAgentSdkRunner, CursorAgentSdkRunnerError, type CursorAgentSdkSession } from "./CursorAgentSdk.ts";
import { bindCursorNativeMetadata } from "./CursorNativeMetadata.ts";
import { cursorWorkerReply, cursorOpened, cursorStarted, cursorNativeMetadata, cursorMessages, cursorRunResult, cursorVoid } from "./CursorSdkTransport.ts";

interface PendingRequest { readonly promise: Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }
/** Transport only: the child exclusively runs the original SDK runner in the bound environment. */
export function makeCursorSdkWorkerRunner(environment: NodeJS.ProcessEnv, stateRoot: string,
  runtimeHost: ProviderRuntimeHostService, agentScope: AgentScopeShape,
  entry = new URL(import.meta.url.endsWith(".ts") ? "./CursorSdkWorker.ts" : "./cursor-sdk-worker.mjs", import.meta.url)): CursorAgentSdkRunner["Service"] {
  const workers = new Set<ChildProcess>();
  return CursorAgentSdkRunner.of({
    assertComplete: Effect.try({ try: () => { if (workers.size) throw new Error("Cursor still owns an SDK worker."); },
      catch: cause => new CursorAgentSdkRunnerError({ method: "assertComplete", cause }) }),
    open: input => Effect.gen(function* () {
      const binding = input.runtimeBinding;
      const cwd = input.options.local?.cwd;
      if (typeof cwd !== "string" || (binding && (binding.threadId !== input.threadId || binding.cwd !== cwd)))
        return yield* new CursorAgentSdkRunnerError({ method: "open", cause: new Error("Cursor native operation binding mismatch.") });
      if (Object.keys(input.options.mcpServers ?? {}).length && !binding)
        return yield* new CursorAgentSdkRunnerError({ method: "open", cause: new Error("Cursor PM transport is not bound.") });
      const launch = yield* agentScope.wrap({ command: process.execPath, args: [...process.execArgv, fileURLToPath(entry)],
        name: "cursor-sdk", threadId: input.threadId, env: environment });
      const child = yield* Effect.try({
        try: () => spawn(launch.command, [...launch.args], { cwd, env: environment, serialization: "advanced",
          detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"] }),
        catch: cause => new CursorAgentSdkRunnerError({ method: "open", cause }),
      }).pipe(Effect.onError(() => launch.unit === undefined ? Effect.void : agentScope.stop(launch.unit)));
      workers.add(child);
      const pending = new Map<number, PendingRequest>();
      let sequence = 0;
      let callback: ((update: InteractionUpdate) => Promise<void>) | undefined;
      let callbackFailure: unknown;
      let agentId: string | undefined;
      let closed = false;
      const exited = Promise.withResolvers<void>();
      const fail = () => {
        for (const request of pending.values()) request.reject(new Error("Cursor SDK worker closed before its operation completed."));
        pending.clear();
      };
      const send = (message: object) => { if (child.connected) child.send!(message); };
      child.on("error", () => { fail(); if (child.pid === undefined) exited.resolve(); });
      child.on("disconnect", fail);
      child.on("exit", () => { workers.delete(child); fail(); exited.resolve(); });
      child.on("message", (raw: unknown) => {
        const parsed = cursorWorkerReply.safeParse(raw);
        if (!parsed.success) { fail(); return; }
        const message = parsed.data;
        if (message.type === "delta") {
          void Promise.resolve().then(() => callback?.(message.update)).then(
            () => send({ type: "delta.ack", sequence: message.sequence, ok: true }),
            error => { callbackFailure ??= error; send({ type: "delta.ack", sequence: message.sequence, ok: false }); });
          return;
        }
        if (message.type === "authorize") {
          const authorization = binding && message.agentId === agentId
            ? runtimeHost.authorize({ threadId: binding.threadId, providerInstanceId: binding.providerInstanceId,
                executionId: binding.executionId, action: "tool" })
            : Effect.fail(new Error("Cursor PM transport belongs to another native operation."));
          void Effect.runPromise(authorization).then(
            () => send({ type: "authorize.ack", sequence: message.sequence, ok: true }),
            error => { callbackFailure ??= error; send({ type: "authorize.ack", sequence: message.sequence, ok: false }); });
          return;
        }
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.type === "failure") request?.reject(Object.assign(new Error("Cursor native SDK operation failed."), message.error));
        else request?.resolve(message.result);
      });
      const request = <A>(operation: string, data: object, decode: (value: unknown) => A): Effect.Effect<A, CursorAgentSdkRunnerError> => Effect.tryPromise({
        try: () => {
          if (closed || !child.connected) throw new Error("Cursor SDK worker is closed.");
          const id = ++sequence;
          const result = Promise.withResolvers<unknown>();
          pending.set(id, result);
          child.send!({ id, operation, ...data }, error => { if (error) { pending.delete(id); result.reject(error); } });
          return result.promise.then(decode);
        }, catch: cause => new CursorAgentSdkRunnerError({ method: operation, cause }),
      });
      const close = yield* Effect.cached(Effect.gen(function* () {
        const graceful = yield* request("close", {}, cursorVoid.parse).pipe(Effect.timeout("10 seconds"), Effect.exit);
        closed = true;
        const terminated = yield* Effect.tryPromise(async () => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
          if (process.platform === "win32") {
            await new Promise<void>((resolve, reject) => execFile("taskkill.exe",
              ["/pid", String(child.pid), "/T", "/F"], { env: environment, windowsHide: true },
              error => error ? reject(error) : resolve()));
          } else {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) { if (!(error instanceof Error) || Reflect.get(error, "code") !== "ESRCH") throw error; }
          }
        }).pipe(Effect.exit);
        const scoped = yield* (launch.unit === undefined ? Effect.void : agentScope.stop(launch.unit)).pipe(Effect.exit);
        const settled = yield* Effect.promise(() => exited.promise).pipe(Effect.timeout("10 seconds"), Effect.exit);
        if (Exit.isSuccess(settled)) workers.delete(child);
        const cleanupResults: ReadonlyArray<Exit.Exit<void | undefined, unknown>> = [scoped, terminated, settled, graceful];
        for (const result of cleanupResults)
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      }).pipe(Effect.mapError(cause => new CursorAgentSdkRunnerError({ method: "close", cause })), Effect.uninterruptible));
      const opened = yield* request("open", { input, stateRoot }, cursorOpened.parse).pipe(
        Effect.onExit(exit => Exit.isFailure(exit) ? close.pipe(Effect.orDie) : Effect.void));
      agentId = opened.agentId;
      const session: CursorAgentSdkSession = {
        agentId,
        send: sendInput => Effect.gen(function* () {
          const context = yield* Effect.context<never>();
          callbackFailure = undefined;
          callback = sendInput.onDelta ? update => Effect.runPromiseWith(context)(sendInput.onDelta!(update)) : undefined;
          const started = yield* request("send", { input: { message: sendInput.message, options: sendInput.options } }, cursorStarted.parse);
          return { ...started, wait: request("wait", {}, cursorRunResult.parse).pipe(
            Effect.flatMap(result => callbackFailure === undefined ? Effect.succeed(result) :
              Effect.fail(new CursorAgentSdkRunnerError({ method: "callback", cause: callbackFailure }))),
            Effect.mapError(error => callbackFailure === undefined ? error :
              new CursorAgentSdkRunnerError({ method: "callback", cause: callbackFailure }))),
            cancel: request("cancel", {}, cursorVoid.parse) };
        }),
        listMessages: request("messages", {}, cursorMessages.parse), close,
      };
      bindCursorNativeMetadata(session, request("metadata", { cwd }, value => {
        const metadata = cursorNativeMetadata.parse(value);
        return { ...metadata, runs: metadata.runs.map(({ id, status, model }) => ({
          id, status, ...(model === undefined ? {} : { model }),
        })) };
      }));
      return session;
    }),
  });
}
