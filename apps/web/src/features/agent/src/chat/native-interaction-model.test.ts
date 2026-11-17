import assert from "node:assert/strict";
import test from "node:test";
import { clampIndex, isInteractionComplete, isQuestionAnswered } from "./native-interaction-model.ts";

test("question completeness accepts options or free text but not an empty selection", () => {
  const question = { id: "q1", prompt: "Pick" };
  assert.equal(isQuestionAnswered(question, {}, {}), false);
  assert.equal(isQuestionAnswered(question, { q1: "" }, {}), false);
  assert.equal(isQuestionAnswered(question, { q1: "a" }, {}), true);
  assert.equal(isQuestionAnswered(question, {}, { q1: "typed" }), true);
  assert.equal(isQuestionAnswered({ ...question, multiple: true }, { q1: [] }, {}), false);
  assert.equal(isQuestionAnswered({ ...question, multiple: true }, { q1: ["a"] }, {}), true);
});

test("the interaction is complete only when every question has an answer", () => {
  assert.equal(isInteractionComplete([], {}, {}), false);
  assert.equal(isInteractionComplete([{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }], { a: "x" }, {}), false);
  assert.equal(isInteractionComplete([{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }], { a: "x" }, { b: "typed" }), true);
  assert.equal(isInteractionComplete(undefined, {}, {}), false);
});

test("question navigation clamps instead of wrapping or exposing an empty index", () => {
  assert.equal(clampIndex(0, 0), 0);
  assert.equal(clampIndex(-2, 3), 0);
  assert.equal(clampIndex(9, 3), 2);
  assert.equal(clampIndex(1, 3), 1);
});
