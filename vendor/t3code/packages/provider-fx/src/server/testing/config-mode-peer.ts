import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as AcpAgent from "effect-acp/agent";

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;
  let enforcedMode = "auto";
  let writeCount = 0;
  let closed = false;
  const configOptions = (currentValue: string) => [{
    configId: "mode", name: "Mode", category: "mode" as const, type: "select" as const,
    currentValue, options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Auto" }],
  }];
  yield* agent.handleInitialize(() => Effect.succeed({
    protocolVersion: 2, capabilities: { session: {} }, info: { name: "controlled-mode", version: "1" },
  }));
  // Reproduce FX's advertised-mode/enforced-mode discrepancy without performing writes.
  yield* agent.handleCreateSession(() => Effect.succeed({ sessionId: "mode-session", configOptions: configOptions("ask") }));
  yield* agent.handleSetSessionConfigOption(request => Effect.sync(() => {
    if (closed || request.type !== "id" || request.configId !== "mode" || typeof request.value !== "string" || !["ask", "auto"].includes(request.value))
      throw new Error("Invalid mode transition.");
    enforcedMode = request.value;
    writeCount++;
    return { configOptions: configOptions(enforcedMode) };
  }));
  yield* agent.handleUnknownExtRequest(method => Effect.sync(() => {
    if (method !== "pm-test/mode-state" || closed) throw new Error("Unknown or closed session.");
    return { enforcedMode, writeCount };
  }));
  yield* agent.handleCloseSession(() => Effect.sync(() => { closed = true; return {}; }));
  yield* Effect.never;
});
program.pipe(Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)), Effect.scoped, NodeRuntime.runMain);
