import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleAntigravityClientRequest } from "./antigravity-files.ts";

test("native file callbacks stay inside the bound workspace and honor ACP line ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "pm-antigravity-fs-"));
  try {
    const workspace = join(root, "project"); await mkdir(workspace);
    const path = join(workspace, "file.txt"); await writeFile(path, "one\ntwo\nthree");
    assert.deepEqual(await handleAntigravityClientRequest("fs/read_text_file", { sessionId: "native", path, line: 2, limit: 1 }, workspace, "native"), { content: "two" });
    const created = join(workspace, "nested", "new.txt");
    await handleAntigravityClientRequest("fs/write_text_file", { sessionId: "native", path: created, content: "scoped" }, workspace, "native");
    assert.equal(await readFile(created, "utf8"), "scoped");
    await assert.rejects(handleAntigravityClientRequest("fs/read_text_file", { sessionId: "other", path }, workspace, "native"), /does not belong/);
    await assert.rejects(handleAntigravityClientRequest("fs/write_text_file", { sessionId: "native", path: join(root, "outside.txt"), content: "escape" }, workspace, "native"), /outside/);
    await assert.rejects(handleAntigravityClientRequest("fs/read_text_file", { sessionId: "native", path, line: -1 }, workspace, "native"), /line range/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("symlinked files and missing descendants cannot escape the workspace", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pm-antigravity-links-"));
  try {
    const workspace = join(root, "project"); const outside = join(root, "outside"); await mkdir(workspace); await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "private");
    await symlink(outside, join(workspace, "link"), "dir");
    await symlink(join(outside, "missing.txt"), join(workspace, "dangling"));
    await assert.rejects(handleAntigravityClientRequest("fs/read_text_file", { sessionId: "native", path: join(workspace, "link", "secret.txt") }, workspace, "native"), /outside/);
    await assert.rejects(handleAntigravityClientRequest("fs/write_text_file", { sessionId: "native", path: join(workspace, "link", "new", "escape.txt"), content: "escape" }, workspace, "native"), /outside/);
    await assert.rejects(handleAntigravityClientRequest("fs/write_text_file", { sessionId: "native", path: join(workspace, "dangling"), content: "escape" }, workspace, "native"), /unresolved link/);
    await assert.rejects(readFile(join(outside, "new", "escape.txt")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("no native permission or interaction question is silently approved", async () => {
  const options = [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
  assert.deepEqual(await handleAntigravityClientRequest("session/request_permission", { sessionId: "native", toolCall: { toolCallId: "shell_1" }, options }, "/bound", "native"), { outcome: { outcome: "selected", optionId: "no" } });
  assert.deepEqual(await handleAntigravityClientRequest("session/request_permission", { sessionId: "native", toolCall: { toolCallId: "interaction_1" }, options }, "/bound", "native"), { outcome: { outcome: "cancelled" } });
});
