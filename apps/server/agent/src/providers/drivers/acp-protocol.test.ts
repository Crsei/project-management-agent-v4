import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import { continuationKey, PM_CONTINUATIONS } from "../t3code/continuation.ts";
import { deleteRecord, listRecords } from "../../durable/store.ts";
import { createAcpTestHarness } from "./acp-test-harness.ts";

for (const family of ["grok", "fx", "acpRegistry"] as const) {
  test(`original ${family} typed ACP-v2 owns one fresh process/session, arithmetic, streaming and native resume`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    try {
      const chunks: string[] = []; const events: NativeOutputEvent[] = [];
      const first = await f.run(f.context, { model: "native/other", prompt: "ADD 19 23", signal: t.signal,
        onText: text => chunks.push(text), onEvent: event => events.push(event) });
      assert.equal(first.text, "Native total=42"); assert.equal(chunks.join(""), first.text);
      assert.ok(events.some(event => event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.text === first.text));
      assert.ok(first.nativeSession); assert.equal(first.nativeSession.cwd, f.context.cwd);
      const fresh = await f.records();
      assert.equal(fresh.filter(record => record.method === "initialize").length, 1, "Generic ensure must reuse original ACP open, not spawn a replacement");
      assert.equal(fresh.filter(record => record.method === "session/new").length, 1);
      assert.equal(listRecords<{ protocol: string }>(PM_CONTINUATIONS)[0]?.protocol, "acp-v2.ndjson-jsonrpc");
      const second = await f.run(f.context, { model: "native/other", prompt: "ACCUMULATE 8", resume: first.nativeSession, signal: t.signal });
      assert.equal(second.text, "Native total=50"); assert.equal(second.nativeSession?.sessionId, first.nativeSession.sessionId);
      const wire = await f.records();
      assert.equal(wire.filter(record => record.method === "session/new").length, 1);
      assert.equal(wire.filter(record => record.method === "session/prompt").length, 2);
      assert.doesNotMatch(JSON.stringify(wire), /T3_ACP_MCP_AUTHORIZATION|orchestrator_capabilities|delegate_task|link_pull_request/);
      assert.ok(wire.some(record => record.method === "session/load" && record.sessionId === first.nativeSession!.sessionId));
    } finally { await f.close(); }
  });

  test(`original ${family} adopts old session-only metadata before load with no ensure/new or probe prompt`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    try {
      const first = await f.run(f.context, { model: "native/other", prompt: "ADD 20 22", signal: t.signal });
      assert.ok(first.nativeSession);
      deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, first.nativeSession.sessionId));
      // Old handwritten ACP records carried only a session ID, not invented completed-turn references.
      const { turnId: _turn, messageId: _message, ...legacy } = first.nativeSession;
      const resumed = await f.run(f.context, { model: "native/other", prompt: "ACCUMULATE 1", resume: legacy, signal: t.signal });
      assert.equal(resumed.text, "Native total=43");
      const wire = await f.records();
      assert.equal(wire.filter(record => record.method === "session/new").length, 1);
      assert.equal(wire.filter(record => record.method === "session/prompt").length, 2);
      const nativeList = wire.findIndex(record => record.method === "session/list");
      const nativeLoad = wire.findIndex(record => record.method === "session/load");
      assert.ok(nativeList >= 0 && nativeLoad > nativeList, "Native metadata must be captured before load can echo a caller directory");
    } finally { await f.close(); }
  });

  test(`original ${family} rejects legacy native cwd mismatch before load or replacement`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    try {
      const first = await f.run(f.context, { model: "native/other", prompt: "ADD 1 2", signal: t.signal });
      assert.ok(first.nativeSession);
      deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, first.nativeSession.sessionId));
      const statePath = path.join(f.root, "native-sessions.json");
      const state = JSON.parse(await readFile(statePath, "utf8")); state[first.nativeSession.sessionId].cwd = "/other/native-directory";
      await writeFile(statePath, JSON.stringify(state));
      const { turnId: _turn, messageId: _message, ...legacy } = first.nativeSession;
      await assert.rejects(f.run(f.context, { model: "native/other", prompt: "ACCUMULATE 1", resume: legacy, signal: t.signal }));
      const wire = await f.records();
      assert.equal(wire.filter(record => record.method === "session/new").length, 1);
      assert.equal(wire.filter(record => record.method === "session/load").length, 0);
      assert.equal(wire.filter(record => record.method === "session/prompt").length, 1);
    } finally { await f.close(); }
  });

  test(`original ${family} refuses legacy adoption of actual unfinished native work without another prompt`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    try {
      const first = await f.run(f.context, { model: "native/other", prompt: "ADD 2 3", signal: t.signal });
      assert.ok(first.nativeSession);
      deleteRecord(PM_CONTINUATIONS, continuationKey(f.context, first.nativeSession.sessionId));
      const statePath = path.join(f.root, "native-sessions.json");
      const state = JSON.parse(await readFile(statePath, "utf8")); state[first.nativeSession.sessionId].busy = true;
      await writeFile(statePath, JSON.stringify(state));
      const { turnId: _turn, messageId: _message, ...legacy } = first.nativeSession;
      await assert.rejects(f.run(f.context, { model: "native/other", prompt: "ACCUMULATE 1", resume: legacy, signal: t.signal }));
      const wire = await f.records();
      assert.equal(wire.filter(record => record.method === "session/load").length, 1);
      assert.equal(wire.filter(record => record.method === "session/new").length, 1);
      assert.equal(wire.filter(record => record.method === "session/prompt").length, 1);
    } finally { await f.close(); }
  });

  test(`original ${family} propagates callback failure instead of recording native completion`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    try {
      await assert.rejects(f.run(f.context, { model: "native/other", prompt: "ADD 1 2", signal: t.signal,
        onText: () => { throw new Error("ACP consumer failed"); } }), /ACP consumer failed/);
    } finally { await f.close(); }
  });

  test(`original ${family} cancels an admitted native turn without text becoming success`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    const abort = new AbortController();
    try {
      await assert.rejects(f.run(f.context, { model: "native/other", prompt: "HOLD_NATIVE", signal: AbortSignal.any([t.signal, abort.signal]),
        onText: () => abort.abort() }), { terminalStatus: "cancelled" });
      const wire = await f.records();
      assert.equal(wire.filter(record => record.method === "session/prompt").length, 1);
      assert.ok(wire.some(record => record.method === "session/cancel"), "The original ACP runtime must deliver cancellation to its own native session");
    } finally { abort.abort(); await f.close(); }
  });

  test(`original ${family} declines native write permission instead of treating it as PM approval`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    try {
      const result = await f.run(f.context, { model: "native/other", prompt: "REQUEST_PERMISSION ADD 6 7", signal: t.signal });
      assert.equal(result.text, "Native total=13");
      const response = (await f.records()).find(record => record.method === "permission/response");
      assert.ok(response); assert.doesNotMatch(JSON.stringify(response), /"optionId":"allow"/);
    } finally { await f.close(); }
  });

  test(`original ${family} admits the generation-owned PM stdio transport through native ACP MCP, never t3 business tools`, { timeout: 40_000 }, async t => {
    const f = await createAcpTestHarness(family);
    let authorized = 0;
    try {
      const context = { ...f.context,
        execution: { threadId: `${family}-pm-thread`, generationId: `${family}-pm-generation`, messageId: "message-1",
          scope: { workspaceId: "controlled-workspace", projectId: null } },
        pmToolBridge: { command: process.execPath, args: [fileURLToPath(new URL("../../../../../../vendor/t3code/packages/provider-acp/src/server/mcpOverAcpBridge.test-peer.ts", import.meta.url))] },
        authorizeExecution: async (action: "compaction" | "tool") => {
          if (action !== "tool") throw new Error("Compaction was not granted."); authorized++;
        },
      };
      await f.run(context, { model: "native/other", prompt: "REQUEST_PM_TOOLS ADD 1 2", signal: t.signal });
      const wire = await f.records();
      assert.ok(authorized > 0, "Native MCP admission must recheck current generation authorization");
      assert.match(JSON.stringify(wire.find(record => record.method === "mcp/tools")), /fixture_add/);
      assert.match(JSON.stringify(wire.find(record => record.method === "mcp/result")), /"text":"42"/);
      assert.doesNotMatch(JSON.stringify(wire), /T3_ACP_MCP_AUTHORIZATION|orchestrator_capabilities|delegate_task/);
    } finally { await f.close(); }
  });
}
