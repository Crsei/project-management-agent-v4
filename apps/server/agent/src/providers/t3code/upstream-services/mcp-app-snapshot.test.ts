import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { MCP_APP_MAX_HTML_BYTES, MCP_APP_MIME_TYPE } from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import { providerAttachmentsDirectory, resolveAttachmentPath } from "./attachments.ts";
import { snapshotMcpApp } from "./mcp-app-snapshot.ts";

async function isolated(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pm-native-snapshot-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
function snapshot(attachmentsDir = providerAttachmentsDirectory(), html = "<html><head></head><body>Native app</body></html>") {
  return Effect.runPromise(snapshotMcpApp({ attachmentsDir, threadId: ThreadId.make("snapshot-thread"),
    server: "native-server", tool: "native-tool", resourceUri: "ui://native/widget",
    contents: [{ uri: "ui://native/widget", mimeType: MCP_APP_MIME_TYPE, text: html }],
  }));
}

test("native snapshot registration admits its private file but rejects subsequently changed bytes", async () => {
  await isolated(async () => {
    const result = await snapshot();
    assert.ok(result);
    const attachmentsDir = providerAttachmentsDirectory();
    const metadata = JSON.parse(await readFile(path.join(attachmentsDir, ".registry", `${result.attachmentId}.json`), "utf8")) as { attachment: ChatAttachment };
    const file = resolveAttachmentPath({ attachmentsDir, attachment: metadata.attachment });
    assert.equal(file, path.join(attachmentsDir, `${result.attachmentId}.html`));
    await appendFile(file!, "changed");
    assert.equal(resolveAttachmentPath({ attachmentsDir, attachment: metadata.attachment }), null);
  });
});

test("native snapshots reject a foreign attachment root and remove payloads after registry escape rejection", async () => {
  await isolated(async root => {
    const foreign = path.join(root, "foreign");
    await mkdir(foreign);
    await assert.rejects(snapshot(foreign), /does not belong/);
    assert.deepEqual(await readdir(foreign), []);
    const attachmentsDir = providerAttachmentsDirectory();
    await mkdir(attachmentsDir);
    await symlink(foreign, path.join(attachmentsDir, ".registry"));
    await assert.rejects(snapshot(), /Unsafe attachment registry/);
    assert.deepEqual(await readdir(attachmentsDir), [".registry"]);
    assert.deepEqual(await readdir(foreign), []);
  });
});

test("UTF-8 documents over the native byte limit are rejected before private storage is created", async () => {
  await isolated(async root => {
    const oversized = "界".repeat(Math.floor(MCP_APP_MAX_HTML_BYTES / 2));
    assert.equal(await snapshot(providerAttachmentsDirectory(), oversized), undefined);
    assert.deepEqual(await readdir(root), []);
  });
});
