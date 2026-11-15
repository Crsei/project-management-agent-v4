import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeChatAttachments, validateChatAttachments } from "./chat-attachments.ts";
import { providerAttachmentsDirectory, resolveAttachmentPath } from "./t3code/upstream-services/attachments.ts";
import { validateContextAttachmentBindings } from "../durable/message-context.ts";
import { closeStore } from "../durable/store.ts";

const oldData = process.env.AGENT_WORKSPACE_DATA_DIR;
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "chat-attachment-boundary-")); process.env.AGENT_WORKSPACE_DATA_DIR = directory; });
afterEach(async () => { closeStore(); if (oldData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldData; await rm(directory, { recursive: true, force: true }); });

test("native attachments persist exact complete bytes through the existing registry and detect later mutation", async () => {
  const parts = [{ type: "file" as const, mediaType: "text/plain", filename: "selected.txt", url: "data:text/plain;base64,ZXhhY3QgYnl0ZXM=" }];
  const first = materializeChatAttachments(parts, "codex"), second = materializeChatAttachments(parts, "claude");
  assert.deepEqual(first, second);
  assert.equal(first[0]!.type, "file");
  const file = resolveAttachmentPath({ attachmentsDir: providerAttachmentsDirectory(), attachment: first[0]! });
  assert.ok(file); assert.ok(file.endsWith(".txt"));
  assert.equal(await readFile(file, "utf8"), "exact bytes");
  await writeFile(file, "other bytes");
  assert.throws(() => materializeChatAttachments(parts, "codex"), { code: "attachment_store_changed" });
});

test("unsupported providers, remote/blob/local attachment URLs and unsupported media fail explicitly", () => {
  const supported = { type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" };
  assert.throws(() => validateChatAttachments([supported], "opencode"), { code: "unsupported_attachment" });
  for (const url of ["https://not-fetched.invalid/image.png", "blob:browser-only", "file:///private/file.png"])
    assert.throws(() => validateChatAttachments([{ ...supported, url }], "codex"), { code: "unsupported_attachment" });
  assert.throws(() => validateChatAttachments([{ type: "file", mediaType: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zy8+" }], "codex"), { code: "unsupported_attachment" });
  assert.throws(() => validateChatAttachments([{ type: "image", url: "https://not-fetched.invalid/image.png" }], "codex"), { code: "unsupported_attachment" });
});

test("screenshot context correlation must identify the exact existing wire attachment part", () => {
  const message = { id: "user", role: "user" as const, parts: [{ type: "text" as const, text: "Review this selection" },
    { type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" }],
    metadata: { custom: { contextAttachments: [{ attachmentId: "actual-attachment", partIndex: 1 }] } } };
  const context = { contextId: "element", kind: "element" as const, source: { type: "browser" as const, url: "http://localhost:3000/", selector: "button", attachmentId: "actual-attachment" }, text: "actual picker text" };
  validateContextAttachmentBindings(message, [context]);
  assert.throws(() => validateContextAttachmentBindings(message, [{ ...context, source: { ...context.source, attachmentId: "missing-attachment" } }]), { code: "invalid_context_attachment" });
  assert.throws(() => validateContextAttachmentBindings({ ...message, metadata: { custom: { contextAttachments: [{ attachmentId: "actual-attachment", partIndex: 0 }] } } }, [context]), { code: "invalid_context_attachment" });
});
