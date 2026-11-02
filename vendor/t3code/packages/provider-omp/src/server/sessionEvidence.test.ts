import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { readOmpActiveBranch, readOmpSessionHeader, ompBranchPreservesConversationHead } from "./sessionEvidence.ts";
import { ompRecordString } from "./rpc.ts";

describe("OMP native evidence", () => {
  it("walks only the active branch and never treats tool-use/error/aborted messages as successful native turns", () => {
    const entry = (id: string, parentId: string | null, stopReason: string) => ({ type: "message", id, parentId,
      message: { role: "assistant", stopReason, content: [] } });
    const branch = readOmpActiveBranch({ entries: [entry("root", null, "stop"), entry("abandoned", "root", "stop"),
      entry("tool", "root", "toolUse"), entry("error", "tool", "error"), entry("abort", "error", "aborted")], leafId: "abort" });
    assert.deepEqual(branch?.entries.map(value => ompRecordString(value, "id")), ["root", "tool", "error", "abort"]);
    assert.deepEqual(branch?.completedTurnRefs.map(value => value.nativeId), ["root"]);
    assert.isUndefined(readOmpActiveBranch({ entries: [entry("cycle", "cycle", "stop")], leafId: "cycle" }));
    assert.isUndefined(readOmpActiveBranch({ entries: [entry("a", "missing", "stop")], leafId: "a" }));
    assert.isUndefined(readOmpActiveBranch({ entries: [entry("a", null, "stop"), entry("a", null, "stop")], leafId: "a" }));
  });

  it("accepts only proven non-conversation descendants, not unseen content, unknown custom data, or another branch", () => {
    const saved = { type: "message", id: "saved", parentId: null, message: { role: "assistant", stopReason: "stop" } };
    const suffix = [
      { type: "custom", id: "exit-1", parentId: "saved", customType: "session_exit", data: {
        reason: "dispose", kind: "normal", recordedAt: "2026-10-31T06:15:28.486Z" } },
      { type: "custom", id: "exit-2", parentId: "exit-1", customType: "session_exit", data: {
        reason: "dispose", kind: "normal", recordedAt: "2026-10-31T06:15:29.888Z", pendingToolCalls: [] } },
      { type: "model_change", id: "model", parentId: "exit-2", model: "fixture/model", role: "default" },
      { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: null, configured: null },
    ];
    const branch = readOmpActiveBranch({ entries: [saved, ...suffix], leafId: "thinking" })!;
    assert.isTrue(ompBranchPreservesConversationHead(branch.entries, "saved"));
    for (const entry of [
      { type: "message", message: { role: "user", content: [] } },
      { type: "custom_message", customType: "context-injection", content: "Unseen" },
      { type: "custom", customType: "unknown-extension-state", data: {} },
      { type: "compaction", summary: "Unseen rewrite" },
      { type: "reset_boundary" },
      { type: "custom", customType: "session_exit", data: { reason: "exit", kind: "fatal", recordedAt: "2026-10-31T06:15:29.888Z" } },
      { type: "custom", customType: "session_exit", data: { reason: "exit", kind: "normal", recordedAt: "2026-10-31T06:15:29.888Z", pendingToolCalls: [{ toolName: "write" }] } },
    ]) assert.isFalse(ompBranchPreservesConversationHead([...branch.entries, { ...entry, id: "unseen", parentId: "thinking" }], "saved"));
    const fork = readOmpActiveBranch({ entries: [saved, { type: "message", id: "fork", parentId: null, message: { role: "assistant", stopReason: "stop" } }], leafId: "fork" })!;
    assert.isFalse(ompBranchPreservesConversationHead(fork.entries, "saved"));
  });

  it.effect("accepts the native title slot + header and rejects foreign cwd, symlink escape and non-session paths", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "omp-evidence-test-" });
    const root = `${directory}/sessions`, cwd = `${directory}/workspace`, foreign = `${directory}/foreign`;
    yield* fs.makeDirectory(root); yield* fs.makeDirectory(cwd); yield* fs.makeDirectory(foreign);
    const sessionFile = `${root}/native.jsonl`;
    const header = { type: "session", version: 3, id: "omp-native-id", cwd };
    yield* fs.writeFileString(sessionFile, JSON.stringify({ type: "title", v: 1, title: "Native", pad: "" }) + "\n" + JSON.stringify(header) + "\n");
    const result = yield* readOmpSessionHeader({ sessionFile, sessionsDirectory: root, cwd });
    assert.equal(result.id, "omp-native-id");
    assert.equal((yield* Effect.result(readOmpSessionHeader({ sessionFile, sessionsDirectory: root, cwd: foreign })))._tag, "Failure");
    const outside = `${foreign}/outside.jsonl`;
    yield* fs.writeFileString(outside, JSON.stringify(header) + "\n");
    yield* fs.symlink(outside, `${root}/escape.jsonl`);
    assert.equal((yield* Effect.result(readOmpSessionHeader({ sessionFile: `${root}/escape.jsonl`, sessionsDirectory: root, cwd })))._tag, "Failure");
    assert.equal((yield* Effect.result(readOmpSessionHeader({ sessionFile: "relative.jsonl", sessionsDirectory: root, cwd })))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
});
