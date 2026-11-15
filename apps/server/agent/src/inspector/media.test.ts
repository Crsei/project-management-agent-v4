import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { mediaRoutes, MEDIA_READ_LIMIT, safeMediaType } from "./media.ts";
import { openAgentWorkspace, resolveAgentWorkspaceExecution } from "../agent-workspaces.ts";
import { ensureThread } from "../durable/threads.ts";
import { closeStore } from "../durable/store.ts";
import { chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";

let directory: string, root: string;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR, originalAllowed = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const app = new Hono().route("/inspector", mediaRoutes);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "safe-media-")); root = join(directory, "root");
  await mkdir(root);
  process.env.AGENT_WORKSPACE_DATA_DIR = join(directory, "store"); process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  const workspace = openAgentWorkspace({ path: root, name: "Isolated media" });
  const selection = { version: 2 as const, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
  ensureThread("media", undefined, selection, resolveAgentWorkspaceExecution(selection).environment);
  ensureThread("chat-only", undefined, chatOnlyExecutionSelection());
});
afterEach(async () => {
  closeStore();
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
  if (originalAllowed === undefined) delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS; else process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = originalAllowed;
  await rm(directory, { recursive: true, force: true });
});
function request(path: string, threadId = "media") { return app.request(`http://localhost/inspector/media?threadId=${encodeURIComponent(threadId)}&path=${encodeURIComponent(path)}`); }
test("media requires matching extension and magic, returning private no-store/nosniff bytes", async () => {
  await writeFile(join(root, "image.png"), png);
  const response = await request("image.png"); assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png"); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await writeFile(join(root, "fake.png"), "<html><script>alert(1)</script></html>"); assert.equal((await request("fake.png")).status, 415);
  assert.equal(safeMediaType("image.svg", Buffer.from('<svg onload="alert(1)"/>')), null);
  assert.equal(safeMediaType("image.html", png), null);
});
test("media cannot bypass Session code-root binding, traversal, hidden paths or symlink escape", async () => {
  const outside = join(directory, "outside.png"); await writeFile(outside, png); await symlink(outside, join(root, "escape.png"));
  assert.equal((await request("escape.png")).status, 400);
  assert.equal((await request("../outside.png")).status, 403);
  await writeFile(join(root, ".private.png"), png); assert.equal((await request(".private.png")).status, 403);
  await writeFile(join(root, "image.png"), png); assert.equal((await request("image.png", "chat-only")).status, 412);
  assert.equal((await request("image.png", "missing")).status, 404);
});
test("internal directory aliases cannot expose .pm or .dovspace media", async () => {
  for (const hidden of [".pm", ".dovspace"]) {
    const privateRoot = join(root, hidden, "attachments");
    await mkdir(privateRoot, { recursive: true }); await writeFile(join(privateRoot, "private.png"), png);
    const alias = hidden === ".pm" ? "public-assets" : "other-assets";
    await symlink(privateRoot, join(root, alias));
    const response = await request(`${alias}/private.png`);
    assert.equal(response.status, 403); assert.match(await response.text(), /media_path_forbidden/);
  }
});
test("oversize media is rejected before bytes are returned", async () => {
  const handle = await open(join(root, "large.png"), "w");
  await handle.truncate(MEDIA_READ_LIMIT + 1); await handle.close();
  const response = await request("large.png"); assert.equal(response.status, 413); assert.match(await response.text(), /media_too_large/);
});
