import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { makePiAdapterV2 } from "@t3tools/provider-pi/server/adapter";
import { PiHostResources } from "../../../../../../vendor/t3code/packages/provider-pi/src/server/PiHostResources.ts";
import { readPiSessionEvidence } from "../../../../../../vendor/t3code/packages/provider-pi/src/server/sessionEvidence.ts";
import { makePmNativeTestHost } from "../t3code/testing/native-test-host.testkit.ts";
import { forkChatSnapshot } from "../../durable/forks.ts";
import { ensureThread, getThreadPendingFork } from "../../durable/threads.ts";
import { closeStore } from "../../durable/store.ts";

// Metadata-only wire fixture: the production Pi RPC client, original adapter and
// original native-history projector produce the cursor consumed by Chat below.
// No prompt, account, model result or PM tool permission is supplied by this peer.
const nativePeer = `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const file = process.env.PM_PI_FIXTURE_FILE;
const rows = readFileSync(file, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
const [header, ...entries] = rows;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(process.env.PM_PI_FIXTURE_TRACE, request.type + '\\n');
  let data;
  switch (request.type) {
    case 'get_state': data = { sessionFile: file, sessionId: header.id, thinkingLevel: 'high', isStreaming: false,
      isCompacting: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', autoCompactionEnabled: true,
      messageCount: entries.length, pendingMessageCount: 0 }; break;
    case 'get_entries': data = { entries, leafId: entries.at(-1)?.id ?? null }; break;
    case 'get_messages': data = { messages: entries.map(entry => entry.message) }; break;
    case 'get_available_models': data = { models: [] }; break;
    case 'get_commands': data = { commands: [] }; break;
    case 'get_session_stats': data = {}; break;
    case 'switch_session':
      if (request.sessionPath === file) { data = { cancelled: false }; break; }
      throw new Error('Unexpected native session switch');
    default:
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type,
        success: false, error: 'Only existing native metadata may be read' }) + '\\n');
      continue;
  }
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data }) + '\\n');
}
`;

test("original Pi native history supplies an exact Chat fork candidate without a prompt or invented graph turn", { timeout: 20_000 }, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "pi-native-continuity-"))),
      root => Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    const home = path.join(directory, "home");
    const cwd = path.join(directory, "workspace");
    const binary = path.join(directory, "pi-peer.mjs");
    const file = path.join(home, ".pi", "agent", "sessions", "workspace", "native.jsonl");
    const trace = path.join(directory, "wire-methods.txt");
    const nativeId = "00000000-0000-4000-8000-000000000002";
    yield* Effect.promise(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await mkdir(cwd);
      await writeFile(binary, nativePeer); await chmod(binary, 0o700);
      await writeFile(file, [
        { type: "session", version: 3, id: nativeId, cwd },
        { type: "message", id: "native-user", parentId: null, timestamp: "2026-10-30T00:00:00.000Z", message: { role: "user", content: "saved question" } },
        { type: "message", id: "native-assistant", parentId: "native-user", timestamp: "2026-10-30T00:00:01.000Z",
          message: { role: "assistant", content: [], stopReason: "stop" } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
    });
    const pm = yield* makePmNativeTestHost({ driver: "pi", cwd, config: { binaryPath: binary }, environment: {
      HOME: home, USERPROFILE: home, PM_PI_FIXTURE_FILE: file, PM_PI_FIXTURE_TRACE: trace,
    } });
    yield* Effect.addFinalizer(() => Effect.sync(closeStore));
    yield* Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make(pm.context.instanceId);
      const threadId = ThreadId.make("pi-original-native-source");
      const providerSessionId = yield* (yield* IdAllocatorV2).allocate.providerSession({ providerInstanceId: instanceId, threadId });
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({ cwd, runtimeMode: "approval-required", interactionMode: "default" });
      const adapter = yield* makePiAdapterV2({ instanceId,
        settings: { enabled: true, binaryPath: binary, launchArgs: "", customModels: [] }, environment: pm.context.env });
      const capabilities = yield* adapter.getCapabilities();
      assert.equal(capabilities.threads.canForkThread, true);
      assert.equal(capabilities.threads.canForkFromTurn, true);
      const runtime = yield* adapter.openSession({ threadId, providerSessionId, modelSelection, runtimePolicy, initialNativeThreadId: file });
      const evidence = readPiSessionEvidence(runtime);
      assert.ok(evidence);
      assert.equal((yield* evidence.probe).protocol, "pi.rpc-jsonl:get_state+get_entries");
      const snapshot = yield* evidence.readLegacy({ nativeSessionId: file, turnId: "native-user", messageId: "native-assistant",
        ensure: { threadId, providerSessionId, modelSelection, runtimePolicy } });
      assert.equal(snapshot.providerThread.nativeThreadRef?.strength, "strong");
      assert.equal(snapshot.providerThread.nativeThreadRef?.nativeId, file);
      assert.deepEqual(snapshot.providerTurns, []);
      assert.equal(snapshot.nativeHistory?.completedTurnRefs.length, 1);
      const boundary = snapshot.nativeHistory!.completedTurnRefs[0]!;
      assert.equal(boundary.nativeId, "native-user");
      ensureThread(threadId, undefined, { workspaceId: "fixture-workspace", projectId: null });
      const branch = forkChatSnapshot({ threadId, generationId: "pi-original-native-generation", messageId: "pi-original-native-message",
        context: "Saved native result", nativeSession: { providerInstanceId: instanceId, driver: "pi",
          sessionId: snapshot.providerThread.nativeThreadRef!.nativeId, instanceRevision: pm.context.revision, cwd,
          turnId: boundary.nativeId, messageId: snapshot.providerThread.nativeConversationHeadRef?.nativeId ?? undefined } });
      assert.equal(getThreadPendingFork(branch.threadId)?.boundary?.turnId, boundary.nativeId);
      assert.equal(getThreadPendingFork(branch.threadId)?.source.sessionId, file);
      const methods = (yield* Effect.promise(() => readFile(trace, "utf8"))).trim().split("\n");
      assert.ok(methods.includes("get_entries"));
      assert.equal(methods.some(method => ["prompt", "new_session", "fork"].includes(method)), false);
    }).pipe(Effect.provide(pm.layer), Effect.provideService(PiHostResources, {
      pmToolsExtensionPath: fileURLToPath(new URL("../../../../../../packages/pm-cli/pi-tools.ts", import.meta.url)),
    }));
  })));
});
