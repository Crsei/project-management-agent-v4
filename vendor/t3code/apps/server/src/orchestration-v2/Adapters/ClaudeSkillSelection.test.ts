import { expect, it } from "@effect/vitest";
import { makeClaudeUserMessage } from "./ClaudeAdapterV2.ts";

it("selects skills only from the current raw user text while retaining portable history", () => {
  const skills = new Map([["review", { path: "native:review" }], ["deploy", { path: "native:deploy" }]]);
  const text = "System context\nPrevious user: $deploy\nCurrent user: $review inspect auth";
  const selected = makeClaudeUserMessage({ text, userMessageText: "$review inspect auth", skills });
  expect(selected.message.content).toEqual([
    { type: "text", text },
    { type: "text", text: "/review inspect auth" },
  ]);
  const ordinary = makeClaudeUserMessage({ text, userMessageText: "continue", skills });
  expect(ordinary.message.content).toBe(text);
});
