import assert from "node:assert/strict";
import test from "node:test";
import { openCodeQuestion, openCodeQuestionAnswer } from "./opencode-questions.ts";

test("OpenCode v1 validates each native answer and keeps question order", () => {
  const question = openCodeQuestion("v1", { id: "que_1", questions: [
    { header: "Color", question: "Choose", options: [{ label: "Blue" }, { label: "Red" }], custom: false },
    { header: "Notes", question: "Add notes", options: [], custom: true },
  ] });
  assert.ok(question);
  assert.deepEqual(openCodeQuestionAnswer(question, { answers: { q0: "Blue", q1: "hello" } }, "v1"), { answers: [["Blue"], ["hello"]] });
  assert.throws(() => openCodeQuestionAnswer(question, { answers: { q0: "Green", q1: "hello" } }, "v1"), /Invalid/);
  assert.throws(() => openCodeQuestionAnswer(question, { answers: { q0: "Blue", q1: "hello", q2: "extra" } }, "v1"), /Invalid/);
});

test("OpenCode v2 accepts question forms and enforces multiselect options and limits", () => {
  const question = openCodeQuestion("v2", { form: { id: "frm_1", metadata: { kind: "question" }, title: "Questions", fields: [
    { key: "colors", type: "multiselect", title: "Colors", options: [{ value: "b", label: "Blue" }, { value: "r", label: "Red" }], minItems: 1, maxItems: 2 },
  ] } });
  assert.ok(question);
  assert.deepEqual(openCodeQuestionAnswer(question, { answers: { colors: ["b", "r"] } }, "v2"), { answer: { colors: ["b", "r"] } });
  assert.throws(() => openCodeQuestionAnswer(question, { answers: { colors: ["unknown"] } }, "v2"), /Invalid/);
  assert.throws(() => openCodeQuestionAnswer(question, { answers: { colors: ["b", "r", "b"] } }, "v2"), /Invalid/);
  assert.equal(openCodeQuestionAnswer(question, { cancelled: true }, "v2"), undefined);
  assert.equal(openCodeQuestion("v2", { form: { id: "frm_2", metadata: { kind: "authentication" }, fields: [{ key: "password", type: "string" }] } }), undefined);
  assert.equal(openCodeQuestion("v2", { form: { id: "frm_3", metadata: { kind: "question" }, fields: [{ key: "url", type: "external", url: "https://example.test" }] } }), undefined);
});
