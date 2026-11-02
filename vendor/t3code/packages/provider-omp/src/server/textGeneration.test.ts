import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeOmpTextGeneration } from "./textGeneration.ts";
import { makeOmpTestProcess, type OmpTestControls } from "./transportTestHelpers.ts";
import type { OmpRpcRecord } from "./rpc.ts";

const settings = { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] } as const;
const workspace = Effect.acquireRelease(
  Effect.sync(() => Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-text-generation-"))),
  (root) => Effect.sync(() => Fs.rmSync(root, { recursive: true, force: true })),
);
const selection = createModelSelection(ProviderInstanceId.make("omp"), "native/model", [{ id: "thinking", value: "xhigh" }]);

function replies(prompt: (request: OmpRpcRecord, controls: OmpTestControls) => Effect.Effect<void>, stateLevel = "xhigh") {
  return (request: OmpRpcRecord, controls: OmpTestControls) => {
    if (request.type === "prompt") return prompt(request, controls);
    return controls.reply(request,
      request.type === "set_model" ? { provider: "native", id: "model" }
        : request.type === "get_available_thinking_levels" ? { levels: ["off", "high", "xhigh"] }
        : request.type === "get_state" ? { thinkingLevel: stateLevel }
        : request.type === "get_last_assistant_text" ? { text: '{"subject":"Keep native identity","body":"Preserve OMP state."}' }
        : {},
    );
  };
}

 describe("OMP independent text generation", () => {
  it.effect("retains the requested model/effort and waits for correlated prompt_result plus background settlement", () => Effect.gen(function* () {
    const root = yield* workspace;
    const process = yield* makeOmpTestProcess({ onRequest: replies((request, controls) => Effect.gen(function* () {
      yield* controls.reply(request, { agentInvoked: true });
      yield* controls.emit({ type: "prompt_result", id: "older-prompt", status: "completed", agentInvoked: true, sessionSettled: true });
      yield* controls.emit({ type: "prompt_result", id: request.id, status: "completed", agentInvoked: true, sessionSettled: false });
      yield* controls.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "background result" }] } });
      yield* controls.emit({ type: "session_settled" });
    })) });
    const generator = yield* makeOmpTextGeneration(settings, { HOME: root }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process.spawner));
    const result = yield* generator.generateCommitMessage({ cwd: root, branch: "main", stagedSummary: "M native.ts", stagedPatch: "native patch", modelSelection: selection });
    assert.deepEqual(result, { subject: "Keep native identity", body: "Preserve OMP state." });
    assert.include(process.launches[0] ?? [], "--no-tools");
    assert.include(process.launches[0] ?? [], "--no-extensions");
    assert.include(process.launches[0] ?? [], "--no-session");
    assert.notInclude(process.launches[0] ?? [], "--model");
    assert.equal(process.received.find((request) => request.type === "set_thinking_level")?.level, "xhigh");
    assert.equal(process.received.at(-1)?.type, "get_last_assistant_text");
  }).pipe(Effect.scoped));

  it.effect.each(["error", "aborted", "local", "missing-terminal"] as const)("does not convert %s into generated content", (status) => Effect.gen(function* () {
    const root = yield* workspace;
    const process = yield* makeOmpTestProcess({ onRequest: replies((request, controls) => Effect.gen(function* () {
      yield* controls.reply(request, { agentInvoked: status !== "local" });
      if (status === "missing-terminal") return yield* controls.exit(0);
      if (status === "local") return;
      yield* controls.emit({ type: "prompt_result", id: request.id, status, agentInvoked: true, sessionSettled: true });
      yield* controls.emit({ type: "session_settled" });
    })) });
    const generator = yield* makeOmpTextGeneration(settings, { HOME: root }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process.spawner));
    const error = yield* generator.generateCommitMessage({ cwd: root, branch: "main", stagedSummary: "M a", stagedPatch: "patch", modelSelection: selection }).pipe(Effect.flip);
    assert.equal(error._tag, "TextGenerationError");
    assert.isUndefined(process.received.find((request) => request.type === "get_last_assistant_text"));
  }).pipe(Effect.scoped));

  it.effect("refuses a native effort downgrade before admitting a prompt", () => Effect.gen(function* () {
    const root = yield* workspace;
    const process = yield* makeOmpTestProcess({ onRequest: replies((_request, _controls) => Effect.void, "high") });
    const generator = yield* makeOmpTextGeneration(settings, { HOME: root }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process.spawner));
    const error = yield* generator.generateCommitMessage({ cwd: root, branch: "main", stagedSummary: "M a", stagedPatch: "patch", modelSelection: selection }).pipe(Effect.flip);
    assert.include(error.detail, "refusing to downgrade");
    assert.isUndefined(process.received.find((request) => request.type === "prompt"));
  }).pipe(Effect.scoped));

  it.effect("rejects unsafe startup sources without spawning or executing any native tools", () => Effect.gen(function* () {
    const root = yield* workspace;
    const home = Path.join(root, "home");
    Fs.mkdirSync(home);
    Fs.mkdirSync(Path.join(root, ".omp", "tools"), { recursive: true });
    Fs.writeFileSync(Path.join(root, ".omp", "tools", "unsafe.ts"), "process.exit(1)");
    const process = yield* makeOmpTestProcess();
    const generator = yield* makeOmpTextGeneration(settings, { HOME: home }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process.spawner));
    const error = yield* generator.generateCommitMessage({ cwd: root, branch: "main", stagedSummary: "M a", stagedPatch: "patch", modelSelection: selection }).pipe(Effect.flip);
    assert.include(error.detail, "startup refused");
    assert.lengthOf(process.launches, 0);
  }).pipe(Effect.scoped));
});
