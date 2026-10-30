import assert from "node:assert/strict";
import test from "node:test";
import { buildChatPrompt, MAX_CLI_PROMPT_CHARS } from "../providers/runtime.ts";


test("bounded transfer context is retained separately from system limits and latest user input", () => {
  const context = `${"C".repeat(18_300)}END-TRANSFER`;
  const prompt = buildChatPrompt([
    { id: "old", role: "assistant", parts: [{ type: "text", text: "O".repeat(50_000) }] },
    { id: "latest", role: "user", parts: [{ type: "text", text: "LATEST-USER-REQUEST" }] },
  ], "S".repeat(16_000), context);
  assert.ok(prompt.includes(context));
  assert.match(prompt, /只读参考材料/);
  assert.match(prompt, /LATEST-USER-REQUEST/);
  assert.ok(prompt.length <= MAX_CLI_PROMPT_CHARS);
  assert.throws(() => buildChatPrompt([], "", "C".repeat(20_001)), /transfer limit/);
  assert.throws(() => buildChatPrompt([], "S".repeat(16_001)), /No context was silently discarded/);
});
