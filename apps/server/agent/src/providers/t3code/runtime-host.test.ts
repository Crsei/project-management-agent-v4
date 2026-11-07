import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { makePmProviderRuntimeHost, pmRuntimeBinding } from "./runtime-host.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { agentWorkspaceEnvironment } from "../../durable/execution.testkit.ts";

const context: ProviderDriverContext = { instanceId: "account", driver: "codex", config: {}, homeDirectory: "/private/home", stateDirectory: "/private/state",
  cwd: "/workspace", env: {}, revision: 1, execution: { threadId: "chat", generationId: "generation", messageId: "message", environment: agentWorkspaceEnvironment("/workspace", true) },
  pmToolBridge: { command: "/node", args: ["/agent-tools.mjs", "http://127.0.0.1:1/generation"] },
  authorizeExecution: async () => { throw new Error("Binding-only fixture must not authorize execution."); } };

test("identical nested bindings retain ownership until the final scope closes; conflicting generations never replace them", async () => {
  const host = makePmProviderRuntimeHost();
  const scope1 = await Effect.runPromise(Scope.make());
  const scope2 = await Effect.runPromise(Scope.make());
  const binding = pmRuntimeBinding(context, ThreadId.make("chat"), "generation");
  const key = { threadId: binding.threadId, providerInstanceId: binding.providerInstanceId };
  try {
    await Effect.runPromise(host.bind(binding).pipe(Effect.provideService(Scope.Scope, scope1)));
    await Effect.runPromise(host.bind(binding).pipe(Effect.provideService(Scope.Scope, scope2)));
    await assert.rejects(Effect.runPromise(Effect.scoped(host.bind({ ...binding, executionId: "other-generation" }))), { code: "provider_busy", status: 409 });
    await Effect.runPromise(Scope.close(scope1, Exit.void));
    assert.deepEqual(await Effect.runPromise(host.read(key)), binding);
    assert.equal(await Effect.runPromise(host.read({ ...key, providerInstanceId: ProviderInstanceId.make("another-account") })), undefined);
    await Effect.runPromise(Scope.close(scope2, Exit.void));
    assert.equal(await Effect.runPromise(host.read(key)), undefined);
  } finally {
    await Effect.runPromise(Scope.close(scope1, Exit.void));
    await Effect.runPromise(Scope.close(scope2, Exit.void));
  }
});

test("PM tool transport requires both Chat identity and a live authorization callback", () => {
  assert.throws(() => pmRuntimeBinding({ ...context, execution: undefined }, ThreadId.make("technical"), "run"), { code: "scope_required", status: 412 });
  assert.throws(() => pmRuntimeBinding({ ...context, authorizeExecution: undefined }, ThreadId.make("chat"), "generation"), { code: "scope_required", status: 412 });
  const connector = { name: "automation_github", transport: "stdio" as const, command: "/node", args: ["/scoped-broker.mjs"] };
  assert.throws(() => pmRuntimeBinding({ ...context, pmToolBridge: undefined, mcpServers: [connector], execution: undefined }, ThreadId.make("technical"), "run"), { code: "scope_required", status: 412 });
  assert.throws(() => pmRuntimeBinding({ ...context, pmToolBridge: undefined, mcpServers: [connector], authorizeExecution: undefined }, ThreadId.make("chat"), "generation"), { code: "scope_required", status: 412 });
  assert.throws(() => pmRuntimeBinding({ ...context, mcpServers: [{ ...connector, name: "pm_tools" }] }, ThreadId.make("chat"), "generation"), { code: "scope_required", status: 412 });
});

test("technical analysis rejects descriptor injection and ordinary descriptors remain generation-bound", () => {
  const connector = { name: "authorized_connector", transport: "stdio" as const, command: "/node", args: ["/scoped-broker.mjs"] };
  assert.throws(() => pmRuntimeBinding({ ...context, pmAnalysis: true }, ThreadId.make("chat"), "generation"), { code: "scope_required" });
  assert.throws(() => pmRuntimeBinding({ ...context, pmToolBridge: undefined, pmAnalysis: true, mcpServers: [connector] }, ThreadId.make("chat"), "generation"), { code: "scope_required" });
  assert.throws(() => pmRuntimeBinding({ ...context, mcpServers: [connector, connector] }, ThreadId.make("chat"), "generation"), { code: "scope_required" });
  const binding = pmRuntimeBinding({ ...context, mcpServers: [connector] }, ThreadId.make("chat"), "generation");
  assert.equal(binding.nativePermissions, "deny-ungranted");
  assert.deepEqual(binding.mcpServers.map(server => server.name), ["pm_tools", "authorized_connector"]);
});

test("a permissive callback cannot elevate an explicit technical binding into tool authority", async () => {
  const host = makePmProviderRuntimeHost();
  const binding = pmRuntimeBinding({ ...context, pmToolBridge: undefined, pmAnalysis: true }, ThreadId.make("analysis"), "analysis-generation");
  let calls = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* host.bind(binding, () => Effect.sync(() => { calls++; }));
    yield* Effect.tryPromise({ try: () => assert.rejects(Effect.runPromise(host.authorize({
      providerInstanceId: binding.providerInstanceId, threadId: binding.threadId, executionId: binding.executionId, action: "tool",
    })), { code: "scope_required", status: 403 }), catch: error => error });
  })));
  assert.equal(calls, 0);
});

test("an explicit technical model caller gains neither tool nor compaction authority", async () => {
  const host = makePmProviderRuntimeHost();
  const binding = pmRuntimeBinding({
    ...context, execution: undefined, pmToolBridge: undefined, authorizeExecution: undefined,
  }, ThreadId.make("technical"), "technical-run");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* host.bind(binding);
    for (const action of ["tool", "compaction"] as const) {
      yield* Effect.tryPromise({
        try: () => assert.rejects(Effect.runPromise(host.authorize({
          threadId: binding.threadId, providerInstanceId: binding.providerInstanceId,
          executionId: binding.executionId, action,
        })), { code: "stale_execution", status: 409 }),
        catch: error => error,
      });
    }
  })));
});

test("authorization requires a live captured execution and revocable callback; callbacks never enter transport bindings", async () => {
  const host = makePmProviderRuntimeHost();
  const binding = pmRuntimeBinding(context, ThreadId.make("chat"), "generation");
  const input = { threadId: binding.threadId, providerInstanceId: binding.providerInstanceId, executionId: binding.executionId, action: "tool" as const };
  let live = true;
  const actions: string[] = [];
  const authorization = (action: "compaction" | "tool") => Effect.suspend(() => {
    actions.push(action);
    return live ? Effect.void : Effect.fail(new Error("Execution grant revoked"));
  });
  await assert.rejects(Effect.runPromise(host.authorize(input)), { code: "stale_execution" });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* host.bind(binding);
    yield* Effect.tryPromise({ try: () => assert.rejects(Effect.runPromise(host.authorize(input)), { code: "stale_execution" }), catch: error => error });
  })));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* host.bind(binding, authorization);
    yield* host.authorize(input);
    yield* host.authorize({ ...input, action: "compaction" });
    yield* Effect.tryPromise({ try: () => assert.rejects(Effect.runPromise(host.authorize({ ...input, executionId: "later-generation" })), { code: "stale_execution" }), catch: error => error });
    live = false;
    yield* Effect.tryPromise({ try: () => assert.rejects(Effect.runPromise(host.authorize(input)), /Execution grant revoked/), catch: error => error });
    yield* Effect.tryPromise({ try: () => assert.rejects(Effect.runPromise(Effect.scoped(host.bind(binding, () => Effect.void))), { code: "provider_busy", status: 409 }), catch: error => error });
  })));
  assert.deepEqual(actions, ["tool", "compaction", "tool"]);
  assert.equal(JSON.stringify(binding).includes("authorizeExecution"), false);
  await assert.rejects(Effect.runPromise(host.authorize(input)), { code: "stale_execution" });
});

test("draining or replacing a binding during an asynchronous grant recheck never authorizes its stale owner", async () => {
  for (const replace of [false, true]) {
    const host = makePmProviderRuntimeHost();
    const binding = pmRuntimeBinding(context, ThreadId.make("chat"), "generation");
    const input = { threadId: binding.threadId, providerInstanceId: binding.providerInstanceId, executionId: binding.executionId, action: "compaction" as const };
    const oldScope = await Effect.runPromise(Scope.make());
    const newScope = await Effect.runPromise(Scope.make());
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const authorization = () => Effect.tryPromise({ try: async () => { started.resolve(); await release.promise; },
      catch: error => error instanceof Error ? error : new Error("Fixture authorization failed.") });
    try {
      await Effect.runPromise(host.bind(binding, authorization).pipe(Effect.provideService(Scope.Scope, oldScope)));
      const pending = assert.rejects(Effect.runPromise(host.authorize(input)), { code: "stale_execution" });
      await started.promise;
      await Effect.runPromise(Scope.close(oldScope, Exit.void));
      if (replace)
        await Effect.runPromise(host.bind(binding, authorization).pipe(Effect.provideService(Scope.Scope, newScope)));
      release.resolve();
      await pending;
    } finally {
      release.resolve();
      await Effect.runPromise(Scope.close(oldScope, Exit.void));
      await Effect.runPromise(Scope.close(newScope, Exit.void));
    }
  }
});
