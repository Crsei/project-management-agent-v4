import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";
import { createOpenCodeTestHarness, waitForOpenCodeFixtureGate } from "./opencode-test-harness.ts";

for (const generation of ["v1", "v2"] as const) {
  test(`original OpenCode ${generation} projects reasoning, commands, edits, search and plans through the public event API`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "output" });
    try {
      const events: NativeOutputEvent[] = [];
      const result = await f.run(f.context, { model: "native-api/model/one", prompt: "ADD 19 23", onEvent: event => events.push(event) });
      assert.equal(result.text, "計算=42");
      const items = events.flatMap(event => event.type === "item.upsert" ? [event.item] : []);
      const latest = new Map<string, NativeOutputItem>(items.map(item => [item.id, item]));
      assert.ok([...latest.values()].some(item => item.type === "reasoning" && item.text === "Compute, do not echo" && item.status === "completed"));
      const command = [...latest.values()].find(item => item.type === "command_execution");
      assert.ok(command); assert.equal(command.status, "completed"); assert.equal(command.exitCode, 0);
      const commandChunks = events.flatMap(event => event.type === "command.output" && event.itemId === command.id ? [event.chunk] : []);
      assert.equal(commandChunks.join(""), "arithmetic\n");
      if (generation === "v1") assert.deepEqual(commandChunks, ["arith", "m", "etic\n"], "Native cumulative command snapshots must append only their new suffix");
      assert.equal(items.filter(item => item.id === command.id && item.status === "completed").length, 1, "Repeated native completion must not duplicate the completed command");
      const firstItem = events.findIndex(event => event.type === "item.upsert" && event.item.id === command.id);
      const firstChunk = events.findIndex(event => event.type === "command.output" && event.itemId === command.id);
      assert.ok(firstItem >= 0 && firstChunk > firstItem, "Output chunks must follow their registered item");
      const edit = [...latest.values()].find(item => item.type === "file_change");
      assert.ok(edit); assert.equal(edit.fileName, "answer.txt"); assert.equal(edit.oldText, "before"); assert.equal(edit.newText, "after"); assert.equal(edit.diff, "-before\n+after");
      const search = [...latest.values()].find(item => item.type === "file_search");
      assert.ok(search); assert.ok(search.results?.some(entry => entry.text?.includes("src/a.ts")));
      assert.ok([...latest.values()].some(item => item.type === "todo_list" && item.steps?.some(step => step.text === "compute" && step.status === "completed")));
      assert.doesNotMatch(JSON.stringify(events), /PROMPT MUST NOT APPEAR|FOREIGN MUST NOT APPEAR/);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} child completion cannot complete the root or enter its assistant reply`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "child" });
    const childSeen = Promise.withResolvers<void>();
    const controller = new AbortController();
    const events: NativeOutputEvent[] = []; const chunks: string[] = []; let settled = false;
    const run = f.run(f.context, { model: "native-api/model/one", prompt: "ADD 19 23", signal: AbortSignal.any([controller.signal, t.signal]), onText: chunk => chunks.push(chunk), onEvent: event => {
      events.push(event);
      if (event.type === "item.upsert" && event.item.type === "subagent" && event.item.childSessionId === "ses_child" && event.item.status === "completed") childSeen.resolve();
    } });
    void run.then(() => { settled = true; }, () => { settled = true; });
    try {
      await waitForOpenCodeFixtureGate(childSeen.promise, run, t.signal, "owned child completion"); await setImmediate();
      assert.equal(settled, false, "A real child terminal has arrived, but the root is still held by the independent server");
      f.wire.finish(); const result = await run;
      assert.equal(result.text, "計算=42"); assert.equal(chunks.join(""), result.text);
      const items = events.flatMap(event => event.type === "item.upsert" ? [event.item] : []);
      assert.ok(items.some(item => item.type === "subagent" && item.childSessionId === "ses_child" && item.status === "completed"));
      assert.ok(items.some(item => item.type === "assistant_message" && item.text === "child arithmetic=5" && item.parentItemId));
      f.wire.assertClean();
    } finally { controller.abort(); await f.close(); }
  });
}
