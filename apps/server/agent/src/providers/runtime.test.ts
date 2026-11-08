import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter } from "./drivers/codex.ts";
import { piAdapter } from "./drivers/pi.ts";
import { opencodeAdapter } from "./drivers/opencode.ts";
import { bindPmProviderExecutionService } from "./native.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "./instances.ts";
import { resolveProviderRuntime, runNativeRuntime } from "./runtime.ts";
import { closeStore } from "../durable/store.ts";
import { agentWorkspaceEnvironment } from "../durable/execution.testkit.ts";

test("runtime preserves trusted Chat identity and rejects PM bridge without it before native dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-runtime-identity-"));
  const previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
  const original = { check: codexAdapter.check, run: codexAdapter.run };
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  try {
    codexAdapter.check = async () => ({ installation: { status: "installed" }, authentication: "authenticated", nativeSessionReady: true, models: [], methods: [], canLogout: false });
    updateProviderInstance("codex", { enabled: true, customModels: [{ id: "fixture", label: "Fixture" }] }, getStoredInstance("codex")!.revision);
    const runtime = await resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture" });
    const execution = { threadId: "trusted-thread", generationId: "trusted-generation", messageId: "trusted-message", environment: agentWorkspaceEnvironment(directory, true) };
    let calls = 0;
    codexAdapter.run = async (context, options) => {
      calls++;
      assert.equal(context.execution, execution);
      assert.equal(context.cwd, directory);
      assert.equal(options.model, "fixture");
      return { text: "native output" };
    };
    const pmToolBridge = { command: "/node", args: ["/agent-tools", "http://127.0.0.1/generation"] };
    // Deliberately bypass the typed caller contract to exercise the runtime boundary.
    // @ts-expect-error Server-resolved cwd is required even for plain native calls.
    await assert.rejects(runNativeRuntime(runtime, { prompt: "once" }), { code: "execution_environment_required", status: 412 });
    for (const cwd of ["", "relative-directory", "/invalid\0directory"])
      await assert.rejects(runNativeRuntime(runtime, { prompt: "once", cwd }), { code: "execution_environment_required", status: 412 });
    await assert.rejects(runNativeRuntime(runtime, { prompt: "once", cwd: directory, pmToolBridge }), { code: "scope_required", status: 412 });
    assert.equal(calls, 0);
    await assert.rejects(runNativeRuntime(runtime, { prompt: "once", cwd: directory, pmToolBridge, execution }), { code: "scope_required", status: 412 });
    const authorizeExecution = async () => {};
    assert.equal((await runNativeRuntime(runtime, { prompt: "once", cwd: directory, pmToolBridge, execution, authorizeExecution })).text, "native output");
    assert.equal(calls, 1);
  } finally {
    Object.assign(codexAdapter, original);
    closeStore();
    if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const adapter of [piAdapter, opencodeAdapter]) {
  test(`${adapter.definition.driver} native fork uses reported capabilities rather than the removed two-driver gate`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-runtime-fork-"));
    const previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
    const original = { check: adapter.check, run: adapter.run };
    process.env.AGENT_WORKSPACE_DATA_DIR = directory;
    let release: (() => void) | undefined;
    try {
      adapter.check = async () => ({ installation: { status: "installed" }, authentication: "unknown", nativeSessionReady: true,
        models: [], methods: [], canLogout: false, capabilities: {
          nativeResume: true, nativeFork: true, boundedFork: true, modelTransition: "native", portableHandoff: true,
        } });
      const instance = createProviderInstance({ driver: adapter.definition.driver, customModels: [{ id: "fixture", label: "Fixture" }] });
      const runtime = await resolveProviderRuntime({ providerInstanceId: instance.instanceId, modelName: "fixture" });
      const source = { providerInstanceId: instance.instanceId, driver: instance.driver, sessionId: "native-source",
        turnId: "completed-native-turn", instanceRevision: instance.revision, cwd: directory, modelId: "fixture" };
      const boundary = { turnId: "completed-native-turn" };
      let forks = 0;
      let runs = 0;
      release = bindPmProviderExecutionService({
        run: async () => assert.fail("The original facade owns turn dispatch"),
        fork: async (context, actualSource, actualBoundary) => {
          forks++;
          assert.equal(context.cwd, directory);
          assert.deepEqual(actualSource, source);
          assert.deepEqual(actualBoundary, boundary);
          return { ...source, sessionId: "native-fork" };
        },
      });
      adapter.run = async (_, options) => {
        runs++;
        assert.equal(options.resume?.sessionId, "native-fork");
        assert.equal(options.prompt, "new message only");
        return { text: "forked result", nativeSession: options.resume };
      };
      const input = { prompt: "new message only", cwd: directory, session: { fork: { source, boundary } } };
      await assert.rejects(runNativeRuntime({ ...runtime, capabilities: { ...runtime.capabilities, boundedFork: false } }, input),
        { code: "unsupported_fork" });
      await assert.rejects(runNativeRuntime({ ...runtime, capabilities: { ...runtime.capabilities, nativeFork: false } }, input),
        { code: "unsupported_fork" });
      await assert.rejects(runNativeRuntime(runtime, { ...input, session: { fork: { source: { ...source, instanceRevision: source.instanceRevision + 1 }, boundary } } }),
        { code: "session_mismatch" });
      assert.equal(forks, 0);
      assert.equal((await runNativeRuntime(runtime, input)).nativeSession?.sessionId, "native-fork");
      assert.equal(forks, 1);
      assert.equal(runs, 1);
    } finally {
      release?.();
      Object.assign(adapter, original);
      closeStore();
      if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
