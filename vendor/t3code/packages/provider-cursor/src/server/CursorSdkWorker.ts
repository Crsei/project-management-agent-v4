import { homedir } from "node:os";
import path from "node:path";
import type { CursorNativeMetadata } from "./CursorNativeMetadata.ts";
import type { SqliteLocalAgentStore as CursorStore } from "@cursor/sdk/sqlite";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { connectCursorHostTools, type CursorHostToolConnection } from "./CursorHostTools.ts";
import { Agent, SqliteLocalAgentStore } from "./sdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import { makeCursorAgentSdkRunner, type CursorAgentSdkSession, type CursorAgentSdkRun } from "./CursorAgentSdk.ts";
import { cursorWorkerRequest } from "./CursorSdkTransport.ts";

if (!process.send) throw new Error("Cursor SDK worker requires its owning host.");
const port = { postMessage: (message: object) => process.send!(message) };
const runtime = ManagedRuntime.make(CursorSdk.layer);
const runner = await runtime.runPromise(makeCursorAgentSdkRunner(() => undefined));
let session: CursorAgentSdkSession | undefined;
let run: CursorAgentSdkRun | undefined;
let hostTools: CursorHostToolConnection | undefined;
let store: CursorStore | undefined;
async function execute<A, E>(effect: Effect.Effect<A, E>) {
  const exit = await runtime.runPromise(Effect.exit(effect));
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}
async function nativeMetadata(agentId: string, cwd: string): Promise<CursorNativeMetadata> {
  const currentStore = store;
  if (!currentStore) throw new Error("Cursor native metadata requires its owned local store.");
  const info = await Agent.get(agentId, { cwd, store: currentStore });
  if (info.runtime !== "local" || typeof info.cwd !== "string") throw new Error("Cursor did not confirm a local native directory.");
  const runs: Array<{ id: string; status: string; model?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await Agent.listRuns(agentId, { runtime: "local", cwd, store: currentStore, ...(cursor ? { cursor } : {}) });
    for (const candidate of page.items) runs.push({ id: candidate.id, status: candidate.status,
      ...(candidate.model?.id ? { model: candidate.model.id } : {}) });
    cursor = page.nextCursor;
  } while (cursor);
  return { agentId: info.agentId, runtime: info.runtime, cwd: info.cwd,
    homeDirectory: process.env.HOME || process.env.USERPROFILE || homedir(), runs };
}
let sequence = 0;
const callbacks = new Map<number, { resolve(): void; reject(error: Error): void }>();
function failure(error: unknown) {
  const source = error instanceof Error && "cause" in error && error.cause instanceof Error
    ? error.cause : error instanceof Error ? error : new Error("Cursor native SDK operation failed.");
  // Messages can contain native secrets. The host maps only the structural failure fields.
  const code = Reflect.get(source, "code");
  const status = Reflect.get(source, "status");
  return { name: source.name, ...(typeof code === "string" ? { code } : {}),
    ...(typeof status === "number" && Number.isInteger(status) ? { status } : {}) };
}
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  return closing ??= (async () => {
    for (const callback of callbacks.values()) callback.reject(new Error("Cursor SDK worker is closing."));
    callbacks.clear();
    const failures: unknown[] = [];
    // Release every owned resource even when an earlier finalizer fails.
    for (const release of [
      () => session ? execute(session.close) : Promise.resolve(),
      () => hostTools?.close(),
      () => store?.dispose(),
      () => runtime.dispose(),
    ]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    session = undefined;
    run = undefined;
    hostTools = undefined;
    store = undefined;
    if (failures.length) throw new AggregateError(failures, "Cursor SDK worker cleanup failed.");
  })();
}
process.once("disconnect", () => {
  void close().then(() => process.exit(0), () => process.exit(1));
});
process.on("message", (raw: unknown) => {
  const decoded = cursorWorkerRequest.safeParse(raw);
  if (!decoded.success) { process.disconnect?.(); return; }
  const message = decoded.data;
  if ("type" in message) {
    const pending = callbacks.get(message.sequence);
    callbacks.delete(message.sequence);
    if (message.ok) pending?.resolve(); else pending?.reject(new Error("Cursor host callback failed."));
    return;
  }
  void (async () => {
    try {
      let result: unknown;
      if (message.operation === "open") {
        if (session || store) throw new Error("Cursor worker already has an original SDK session.");
        const cwd = message.input.options.local?.cwd;
        if (typeof cwd !== "string") throw new Error("Cursor requires its verified native workspace.");
        store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: message.stateRoot });
        if (message.input.operation === "resume") {
          const agentId = message.input.agentId;
          if (!agentId) throw new Error("Cursor resume requires its native agent identity.");
          const metadata = await nativeMetadata(agentId, cwd);
          if (metadata.agentId !== agentId || path.resolve(metadata.cwd) !== path.resolve(cwd))
            throw new Error("Cursor native session belongs to another workspace.");
          if (metadata.runs.some(candidate => !["finished", "error", "cancelled"].includes(candidate.status)))
            throw new Error("Cursor native session still has an unsettled original SDK run.");
        }
        hostTools = await connectCursorHostTools(message.input.options, () => session?.agentId);
        for (const tool of Object.values(hostTools.tools)) {
          const execute = tool.execute;
          tool.execute = async (args, context) => {
            if (!context.sessionId) throw new Error("Cursor PM transport has no native session identity.");
            const pending = Promise.withResolvers<void>();
            const id = ++sequence;
            callbacks.set(id, pending);
            port.postMessage({ type: "authorize", sequence: id, agentId: context.sessionId });
            await pending.promise;
            return execute(args, context);
          };
        }
        session = await execute(runner.open({ ...message.input, options: { ...message.input.options,
          mcpServers: {}, local: { ...message.input.options.local, store,
            ...(Object.keys(hostTools.tools).length ? { customTools: hostTools.tools } : {}) } } }));
        result = { agentId: session.agentId };
      } else if (message.operation === "send") {
        if (!session) throw new Error("Cursor session is closed.");
        run = await execute(session.send({ ...message.input, onDelta: update => Effect.tryPromise(() => {
          const pending = Promise.withResolvers<void>();
          const id = ++sequence;
          callbacks.set(id, pending);
          port.postMessage({ type: "delta", sequence: id, update });
          return pending.promise;
        }) }));
        result = { runId: run.runId, agentId: run.agentId };
      } else if (message.operation === "wait") {
        if (!run) throw new Error("Cursor has no active run.");
        result = await execute(run.wait);
      } else if (message.operation === "cancel") {
        if (run) await execute(run.cancel);
      } else if (message.operation === "messages") {
        if (!session) throw new Error("Cursor session is closed.");
        result = await execute(session.listMessages);
      } else if (message.operation === "metadata") {
        if (!session) throw new Error("Cursor session is closed.");
        if (typeof message.cwd !== "string") throw new Error("Cursor native metadata requires its verified workspace.");
        result = await nativeMetadata(session.agentId, message.cwd);
      } else if (message.operation === "close") {
        await close();
      } else throw new Error("Unknown Cursor SDK transport operation.");
      port.postMessage({ type: "result", id: message.id, result });
    } catch (error) {
      port.postMessage({ type: "failure", id: message.id, error: failure(error) });
    }
  })();
});
