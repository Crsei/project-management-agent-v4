import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSER_PROMPT_LIMIT, composerPromptTooLong } from "./composer-limit.ts";

test("prompt length blocks only values above the persisted draft limit", () => {
  assert.equal(composerPromptTooLong(""), false);
  assert.equal(composerPromptTooLong("a".repeat(COMPOSER_PROMPT_LIMIT)), false);
  assert.equal(composerPromptTooLong("a".repeat(COMPOSER_PROMPT_LIMIT + 1)), true);
});
