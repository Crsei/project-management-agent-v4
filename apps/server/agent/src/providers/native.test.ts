import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindPmProviderExecutionService, forkNativeSession } from "./native.ts";
import { getStoredInstance } from "./instances.ts";
import { closeStore } from "../durable/store.ts";
import { agentWorkspaceEnvironment } from "../durable/execution.testkit.ts";

test("fork delegates once to the assembled V2 service with trusted target identity and preserves source guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-v2-fork-"));
  const previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  let release: (() => void) | undefined;
  try {
    const instance = getStoredInstance("codex")!;
    const source = { providerInstanceId: instance.instanceId, driver: "codex" as const, sessionId: "source", turnId: "native-turn",
      modelId: "explicit", cwd: directory, instanceRevision: instance.revision };
    const execution = { threadId: "branch", generationId: "fork-generation", messageId: "fork-message", environment: agentWorkspaceEnvironment(directory, true) };
    let calls = 0;
    release = bindPmProviderExecutionService({
      run: async () => assert.fail("Metadata fork must not run a prompt"),
      fork: async (context, ref, boundary) => {
        calls++;
        assert.equal(context.execution, execution);
        assert.equal(context.pmToolBridge, undefined);
        assert.equal(context.cwd, directory);
        assert.equal(ref, source);
        assert.deepEqual(boundary, { turnId: "native-turn" });
        return { ...source, sessionId: "fork" };
      },
    });
    assert.equal((await forkNativeSession(instance, source, { turnId: "native-turn" }, directory, undefined, execution)).sessionId, "fork");
    assert.equal(calls, 1);
    await assert.rejects(forkNativeSession(instance, { ...source, instanceRevision: instance.revision + 1 }, undefined, directory), { code: "session_mismatch" });
    await assert.rejects(forkNativeSession(instance, source, { messageId: "not-a-native-turn" }, directory), { code: "unsupported_fork" });
    assert.equal(calls, 1);
    release();
    await assert.rejects(forkNativeSession(instance, source, undefined, directory), { code: "provider_not_configured" });
  } finally {
    release?.(); closeStore();
    if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
