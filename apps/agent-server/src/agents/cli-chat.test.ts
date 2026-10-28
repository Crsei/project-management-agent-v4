import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliChatError, sanitizeErrorMessage } from "./cli-chat.ts";
import { createProviderInstance } from "../providers/instances.ts";
import { buildChatPrompt, MAX_CLI_PROMPT_CHARS } from "../providers/runtime.ts";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import { forkNativeSession } from "../providers/native.ts";

test("native failure sanitization retains structured quota/reset evidence", () => {
  assert.doesNotMatch(sanitizeErrorMessage("Authorization: Bearer sk-secret-test-value"), /secret-test-value/);
  const error = new CliChatError("provider_error", "Usage limit reached", { code: "usage_limit_reached", resets_at: 1900000000 });
  assert.equal(error.errorClass, "usage_limit");
  assert.equal(error.resetAt, "2030-03-17T17:46:40.000Z");
});

test("Claude native fork worker copies only the chosen native message boundary in its isolated home", async () => {
  const previous = { ...process.env };
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-history-test-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(directory, "data");
  process.env.CODEX_HOME = path.join(directory, "global-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, "global-claude");
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  try {
    const instance = createProviderInstance({ driver: "claude", label: "History account" });
    const other = createProviderInstance({ driver: "claude", label: "Other history account" });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const uuids = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000004"];
    const project = path.join(instance.homeDirectory, "projects", directory.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(project, { recursive: true });
    const original = uuids.map((uuid, index) => ({
      type: index % 2 === 0 ? "user" : "assistant", uuid, parentUuid: index ? uuids[index - 1] : null,
      sessionId, cwd: directory, isSidechain: false, timestamp: "2026-10-01T00:00:00.000Z",
      message: index % 2 === 0 ? { role: "user", content: index < 2 ? "included first user" : "excluded later user" } : { role: "assistant", content: [{ type: "text", text: index < 2 ? "included first answer" : "excluded later answer" }] },
    })).map((entry) => JSON.stringify(entry)).join("\n");
    const sourceFile = path.join(project, `${sessionId}.jsonl`);
    await writeFile(sourceFile, `${original}\n`);
    const ref: NativeSessionRef = { providerInstanceId: instance.instanceId, driver: "claude", sessionId, messageId: uuids[1], cwd: directory };
    const forked = await forkNativeSession(instance, ref, { messageId: uuids[1] }, directory);
    assert.notEqual(forked.sessionId, sessionId);
    const transcript = await readFile(path.join(project, `${forked.sessionId}.jsonl`), "utf8");
    assert.match(transcript, /included first answer/);
    assert.doesNotMatch(transcript, /excluded later/);
    assert.equal(await readFile(sourceFile, "utf8"), `${original}\n`);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, path.join(directory, "global-claude"));
    await assert.rejects(forkNativeSession(other, ref, { messageId: uuids[1] }, directory), /another instance/);
    await assert.rejects(forkNativeSession(instance, ref, { turnId: "not-a-claude-message" }, directory), /native assistant message UUID/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});

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
