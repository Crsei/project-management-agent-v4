import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { NativeOutputEvent, NativeInteractionResponse } from "@agent-workspace/contracts/output";
import { createOpenCodeTestHarness, waitForOpenCodeFixtureGate } from "./opencode-test-harness.ts";

for (const generation of ["v1", "v2"] as const) {
  test(`original OpenCode ${generation} answers ordinary information questions without inferring secrets from wording`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "question" });
    try {
      const events: NativeOutputEvent[] = []; let offered = 0; let requestId = ""; let requestItemId = "";
      const result = await f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22",
        onEvent: event => events.push(event), onRequest: async request => {
          offered++; requestId = request.id; requestItemId = request.itemId;
          assert.equal(request.kind, "user_input"); assert.equal(request.respondable, true);
          assert.match(request.questions![0]!.prompt, /password is ordinary text/);
          return { answers: { [request.questions![0]!.id]: generation === "v2" ? "blue" : "Blue" } };
        } });
      assert.equal(result.text, "計算=42"); assert.equal(offered, 1, "Repeated native ask events must not prompt twice");
      const replies = f.wire.requests.filter(request => /\/(?:question|form)\/.+\/reply$/.test(request.path));
      assert.equal(replies.length, 1);
      assert.deepEqual(replies[0]!.body, generation === "v2" ? { answer: { color: "blue" } } : { answers: [["Blue"]] });
      const lifecycle = events.flatMap(event => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.id === requestItemId ? [event.item] : []);
      assert.ok(lifecycle.some(item => item.status === "waiting" && item.request?.id === requestId && item.request.respondable));
      assert.equal(lifecycle.at(-1)?.status, "completed");
      assert.equal(lifecycle.at(-1)?.request?.id, requestId);
      assert.equal(lifecycle.at(-1)?.request?.respondable, false);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} preserves native question order and multiple answers`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "multi-question" });
    try {
      await f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22", onRequest: async request => {
        const questions = request.questions!;
        assert.equal(questions[0]!.multiple, true);
        return { answers: { [questions[0]!.id]: generation === "v2" ? ["blue", "red"] : ["Blue", "Red"],
          ...(generation === "v1" ? { [questions[1]!.id]: "notes" } : {}) } };
      } });
      const reply = f.wire.requests.find(request => /\/(?:question|form)\/.+\/reply$/.test(request.path));
      assert.deepEqual(reply?.body, generation === "v2" ? { answer: { colors: ["blue", "red"] } } : { answers: [["Blue", "Red"], ["notes"]] });
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} cancels a question through its native reject API, never an approval decision`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "question" });
    try {
      const run = f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22", signal: t.signal, onRequest: async () => ({ cancelled: true }) });
      if (generation === "v2") await assert.rejects(run, { terminalStatus: "interrupted" });
      else assert.equal((await run).text, "計算=42");
      assert.ok(f.wire.requests.some(request => generation === "v2" ? request.method === "DELETE" && request.path.endsWith("/form/frm_fixture") : request.path.endsWith("/question/que_fixture/reject")));
      assert.equal(f.wire.requests.some(request => /\/(?:question|form)\/.+\/reply$/.test(request.path)), false);
      f.wire.assertClean();
    } finally { await f.close(); }
  });

  for (const bad of ["unknown", "extra", "permission"] as const) {
    test(`original OpenCode ${generation} rejects ${bad} information response before forwarding it`, { timeout: 20_000 }, async (t) => {
      const f = await createOpenCodeTestHarness(generation, { scenario: "question" });
      try {
        let offered = 0;
        await assert.rejects(f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22", signal: t.signal, onRequest: async request => {
          offered++;
          assert.equal(request.kind, "user_input");
          assert.equal(request.respondable, true);
          return bad === "permission" ? { optionId: "approve" } : { answers: { [request.questions![0]!.id]: bad === "unknown" ? "unoffered" : generation === "v2" ? "blue" : "Blue", ...(bad === "extra" ? { unexpected: "extra" } : {}) } };
        } }));
        assert.equal(offered, 1, "A startup failure must not pass an invalid-answer regression");
        assert.equal(f.wire.requests.some(request => /\/(?:question|form)\/.+\/reply$/.test(request.path)), false);
        f.wire.assertClean();
      } finally { await f.close(); }
    });
  }

  test(`original OpenCode ${generation} consumes external question closure while a late answer is still pending`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "question" });
    const answer = Promise.withResolvers<NativeInteractionResponse>(); const offered = Promise.withResolvers<void>();
    let answerId = ""; const events: NativeOutputEvent[] = [];
    const controller = new AbortController();
    const run = f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22", signal: AbortSignal.any([controller.signal, t.signal]), onEvent: event => events.push(event),
      onRequest: request => { answerId = request.questions![0]!.id; offered.resolve(); return answer.promise; } });
    try {
      await waitForOpenCodeFixtureGate(offered.promise, run, t.signal, "native information question"); f.wire.closeQuestion();
      if (generation === "v2") await assert.rejects(run, { terminalStatus: "interrupted" });
      else assert.equal((await run).text, "計算=42");
      answer.resolve({ answers: { [answerId]: generation === "v2" ? "blue" : "Blue" } }); await setImmediate();
      assert.equal(f.wire.requests.some(request => /\/(?:question|form)\/.+\/reply$/.test(request.path)), false);
      assert.ok(events.some(event => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "cancelled" && event.item.request?.respondable === false));
      f.wire.assertClean();
    } finally { controller.abort(); answer.resolve({ cancelled: true }); await f.close(); }
  });

  test(`original OpenCode ${generation} cancellation closes the question and discards an eventual answer`, { timeout: 20_000 }, async (t) => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "question" });
    const answer = Promise.withResolvers<NativeInteractionResponse>(); const offered = Promise.withResolvers<void>(); const controller = new AbortController();
    const run = f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22", signal: AbortSignal.any([controller.signal, t.signal]),
      onRequest: () => { offered.resolve(); return answer.promise; } });
    try {
      await waitForOpenCodeFixtureGate(offered.promise, run, t.signal, "pending cancellable native question");
      controller.abort(); await assert.rejects(run, { terminalStatus: "cancelled" });
      answer.resolve({ answers: { color: "blue" } }); await setImmediate();
      assert.equal(f.wire.requests.some(request => /\/(?:question|form)\/.+\/reply$/.test(request.path)), false); f.wire.assertClean();
    } finally { controller.abort(); answer.resolve({ cancelled: true }); await f.close(); }
  });

  test(`original OpenCode ${generation} native permission cannot be authorized by an information callback`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation, { scenario: "permission" });
    try {
      let called = false; const events: NativeOutputEvent[] = [];
      await f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22", onEvent: event => events.push(event),
        onRequest: async () => { called = true; return { optionId: "approve" }; } });
      assert.equal(called, false);
      assert.ok(events.some(event => event.type === "item.upsert" && event.item.type === "approval_request" && event.item.request?.respondable === false));
      const reply = f.wire.requests.find(request => request.path.includes("/permission/") && request.path.endsWith("/reply"));
      assert.equal(reply?.body[generation === "v2" ? "decision" : "reply"], "reject"); f.wire.assertClean();
    } finally { await f.close(); }
  });
}

for (const scenario of ["secret", "unsupported-form"] as const) {
  test(`original OpenCode v2 declines native ${scenario} rather than exposing an answer channel`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness("v2", { scenario });
    try {
      let offered = 0;
      await assert.rejects(f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22", onRequest: async () => { offered++; return { answers: { color: "blue" } }; } }));
      assert.equal(offered, 0);
      assert.ok(f.wire.requests.some(request => request.method === "DELETE" && request.path.endsWith("/form/frm_fixture")));
      assert.equal(f.wire.requests.some(request => request.path.endsWith("/form/frm_fixture/reply")), false); f.wire.assertClean();
    } finally { await f.close(); }
  });
}

for (const values of [[], ["blue", "blue"], ["blue", "red", "blue"], ["unoffered"]]) {
  test(`original OpenCode v2 rejects invalid multiselect ${JSON.stringify(values)} before native forwarding`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness("v2", { scenario: "multi-question" });
    try {
      await assert.rejects(f.run(f.context, { model: "native-api/model/one", prompt: "ADD 20 22",
        onRequest: async () => ({ answers: { colors: values } }) }));
      assert.equal(f.wire.requests.some(request => request.path.endsWith("/form/frm_fixture/reply")), false);
      f.wire.assertClean();
    } finally { await f.close(); }
  });
}
