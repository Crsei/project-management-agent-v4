import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistant-streaming.ts";

test("paragraph boundaries keep fenced code and headings together", () => {
  assert.deepEqual(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n"), {
    ready: "Intro\n\n",
    rest: "```ts\nx()\n\n",
  });
  assert.deepEqual(splitBufferedAssistantText("```ts\nx()\n```\nrest"), {
    ready: "```ts\nx()\n```\n",
    rest: "rest",
  });
  assert.deepEqual(splitBufferedAssistantText("Intro\n\n## Results\n\n"), {
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  assert.deepEqual(splitBufferedAssistantText("**Results**\n\nBody\n\nNext"), {
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
  assert.deepEqual(splitBufferedAssistantText("- first\n- second"), {
    ready: "- first\n",
    rest: "- second",
  });
});

test("paragraph releases are throttled per key and can be released by a timer", () => {
  const filter = makeAssistantStreamingFilter("paragraph");
  assert.equal(filter.update("first", "One\n\n", 1_000), "One\n\n");
  assert.equal(filter.update("first", "One\n\nTwo\n\npartial", 1_100), null);
  assert.equal(filter.update("second", "Other\n\n", 1_100), "Other\n\n");
  assert.equal(filter.nextDelay(1_100), 300);
  assert.deepEqual(filter.releaseDue(1_399), []);
  assert.equal(filter.nextDelay(1_399), 1);
  assert.deepEqual(filter.releaseDue(1_400), [{ key: "first", text: "One\n\nTwo\n\n" }]);
  assert.equal(filter.nextDelay(1_400), null);
  assert.deepEqual(filter.flush(), [{ key: "first", text: "One\n\nTwo\n\npartial" }]);
  assert.deepEqual(filter.flush(), []);
});

test("turn mode holds independent cumulative strings until finish or terminal flush", () => {
  const filter = makeAssistantStreamingFilter("turn");
  assert.equal(filter.update("legacy", "First\n\n", 0), null);
  assert.equal(filter.update("legacy", "First\n\nsecond", 500), null);
  assert.equal(filter.update("native", "Another\n\n", 500), null);
  assert.equal(filter.nextDelay(1_000), null);
  assert.deepEqual(filter.releaseDue(1_000), []);
  assert.equal(filter.finish("native", "Another\n\nfinal"), "Another\n\nfinal");
  assert.deepEqual(filter.flush(), [{ key: "legacy", text: "First\n\nsecond" }]);
  assert.deepEqual(filter.flush(), []);
});

test("finish preserves a complete final value even when no paragraph was released", () => {
  const filter = makeAssistantStreamingFilter("paragraph");
  assert.equal(filter.update("item", "An unfinished paragraph", 0), null);
  assert.equal(filter.finish("item", "An unfinished paragraph, now final."), "An unfinished paragraph, now final.");
  assert.deepEqual(filter.flush(), []);
});
