import assert from "node:assert/strict";
import test from "node:test";
import { formatMessageAuthorLabel, messageAuthorName } from "./message-accessibility.ts";

test("author names follow the requested locale", () => {
  assert.equal(messageAuthorName("user", "zh-CN"), "用户消息");
  assert.equal(messageAuthorName("assistant", "zh-CN"), "助手消息");
  assert.equal(messageAuthorName("user", "en"), "User message");
  assert.equal(messageAuthorName("assistant", "en"), "Assistant message");
});

test("missing or invalid timestamps never invent a date", () => {
  assert.equal(formatMessageAuthorLabel("assistant", undefined, "zh-CN"), "助手消息");
  assert.equal(formatMessageAuthorLabel("assistant", "", "zh-CN"), "助手消息");
  assert.equal(formatMessageAuthorLabel("assistant", "not-a-date", "en"), "Assistant message");
});

test("valid timestamps append the formatted time to the author", () => {
  const label = formatMessageAuthorLabel("user", "2026-11-18T09:30:00.000Z", "en");
  assert.match(label, /^User message, /u);
  assert.match(label, /2026/u);
  const chinese = formatMessageAuthorLabel("assistant", "2026-11-18T09:30:00.000Z", "zh-CN");
  assert.match(chinese, /^助手消息，/u);
});
