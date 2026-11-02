import { assert, describe, it } from "@effect/vitest";
import * as Http from "node:http";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { ProviderRuntimeHost, type ProviderRuntimeHostBinding } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { authorizeOmpPrompt, makeOmpHostTools } from "./hostTools.ts";

// Only the HTTP/native transport contract is controlled here. Business
// authorization/approvals/receipts remain tested in the real PM bridge suite.
const openFixture = Effect.fnUntraced(function* () {
  const schema = { type: "object", properties: { operation: { anyOf: [{ const: "inspect" }, { const: "wait" }] } }, required: ["operation"], additionalProperties: false };
  const calls: unknown[] = [];
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const server = Http.createServer(async (req, res) => {
    if (req.url === "/tools/list") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tools: [{ name: "pm_inspect", description: "Inspect a PM object", inputSchema: schema }] })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { arguments: { operation: string } };
    calls.push(body);
    if (body.arguments.operation === "wait") {
      res.once("close", () => { cancelled.resolve(); });
      entered.resolve(); return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "pending_approval", operationId: "existing-bridge-operation", result: null }));
  });
  yield* Effect.acquireRelease(Effect.tryPromise(() => {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", listening.reject); listening.resolve(); });
    return listening.promise;
  }), () => Effect.promise(() => {
    const closed = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close(() => { closed.resolve(); });
    return closed.promise;
  }));
  const address = server.address();
  if (!address || typeof address === "string") return yield* Effect.fail(new Error("No test loopback endpoint"));
  const binding: ProviderRuntimeHostBinding = { providerInstanceId: ProviderInstanceId.make("omp-tools"), threadId: ThreadId.make("tools-thread"),
    executionId: "generation-original", cwd: "/workspace", nativePermissions: "deny-ungranted", instructionText: "",
    mcpServers: [{ name: "pm_tools", transport: "stdio", command: "node", args: ["bridge.mjs", `http://127.0.0.1:${address.port}`, "mcp"] }] };
  let live = true;
  const authorized: string[] = [];
  const host = ProviderRuntimeHost.of({ bind: () => Effect.void, read: () => Effect.succeed(binding), authorize: input => Effect.suspend(() => {
    authorized.push(input.executionId);
    return live && input.executionId === binding.executionId ? Effect.void : Effect.fail(new Error("Execution revoked"));
  }) });
  return { binding, host, schema, calls, entered, cancelled, authorized, revoke: () => { live = false; } };
});

describe("OMP host-owned PM tools", () => {
  it.effect("keeps exact schemas/arguments/correlation and does not turn pending PM approvals into business success", () => Effect.gen(function* () {
    const fixture = yield* openFixture();
    const tools = yield* makeOmpHostTools(fixture.binding, fixture.host);
    assert.deepEqual(tools.tools[0]?.parameters, fixture.schema);
    const args = { operation: "inspect" };
    const result = yield* tools.call({ id: "native-request-1", toolCallId: "model-tool-1", toolName: "pm_inspect", arguments: args });
    assert.deepEqual(fixture.calls, [{ transportId: "omp-native:generation-original", requestId: "native-request-1", name: "pm_inspect", arguments: args }]);
    assert.deepEqual(result.details, { status: "pending_approval", operationId: "existing-bridge-operation", result: null });
    fixture.revoke();
    assert.equal((yield* Effect.result(tools.call({ id: "new", toolCallId: "new", toolName: "pm_inspect", arguments: args })))._tag, "Failure");
    assert.equal(fixture.calls.length, 1);
    assert.isTrue(fixture.authorized.every(value => value === "generation-original"));
  }).pipe(Effect.scoped));

  it.effect("propagates cancellation to the in-flight bridge HTTP call without replay", () => Effect.gen(function* () {
    const fixture = yield* openFixture();
    const tools = yield* makeOmpHostTools(fixture.binding, fixture.host);
    const scope = yield* Effect.scope;
    const fiber = yield* tools.call({ id: "cancel-request", toolCallId: "cancel-tool", toolName: "pm_inspect", arguments: { operation: "wait" } }).pipe(Effect.forkIn(scope));
    yield* Effect.promise(() => fixture.entered.promise);
    yield* Fiber.interrupt(fiber);
    yield* Effect.promise(() => fixture.cancelled.promise);
    assert.equal(fixture.calls.length, 1);
  }).pipe(Effect.scoped));

  it.effect("technical prompt proof grants neither PM nor native tool authority", () => Effect.gen(function* () {
    const fixture = yield* openFixture();
    const binding: ProviderRuntimeHostBinding = { ...fixture.binding, mcpServers: [], promptAuthorization: "technical-no-tools" };
    let current: ProviderRuntimeHostBinding | undefined = binding;
    let toolAuthorizations = 0;
    const host = ProviderRuntimeHost.of({ bind: () => Effect.void, read: () => Effect.sync(() => current),
      authorize: () => Effect.sync(() => { toolAuthorizations++; }) });
    const tools = yield* makeOmpHostTools(binding, host);
    assert.equal(tools.tools.length, 0);
    assert.equal(toolAuthorizations, 0);
    assert.equal((yield* Effect.result(tools.authorize))._tag, "Failure");
    assert.equal((yield* Effect.result(tools.call({ id: "fake", toolCallId: "fake", toolName: "pm_inspect", arguments: {} })))._tag, "Failure");
    assert.equal(toolAuthorizations, 0);
    assert.equal((yield* Effect.result(makeOmpHostTools({ ...binding, mcpServers: fixture.binding.mcpServers }, host)))._tag, "Failure");
    current = { ...binding, executionId: "replacement" };
    assert.equal((yield* Effect.result(authorizeOmpPrompt(binding, host)))._tag, "Failure");
    assert.equal(fixture.calls.length, 0);
  }).pipe(Effect.scoped));
});
