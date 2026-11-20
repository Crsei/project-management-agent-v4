import assert from "node:assert/strict";
import test from "node:test";
import type { Attachment } from "@assistant-ui/react";
import {
  ATTACHMENT_RETRY_BYTE_LIMIT, attachmentProgressView, attachmentRetryContent, attachmentRetryPayload, attachmentRetryPlan, normalizeAttachmentProgress, readAttachmentDataUrl,
} from "./attachment-progress.ts";

const imagePart = { type: "image" as const, image: "data:image/png;base64,AA" };

test("reported progress is clamped to an integer percentage and never invented", () => {
  assert.equal(normalizeAttachmentProgress(42.4), 42);
  assert.equal(normalizeAttachmentProgress(0), 0);
  assert.equal(normalizeAttachmentProgress(150), 100);
  assert.equal(normalizeAttachmentProgress(Number.NaN), undefined);
  assert.equal(normalizeAttachmentProgress(Number.POSITIVE_INFINITY), undefined);
  assert.equal(normalizeAttachmentProgress(-3), undefined);
  assert.equal(normalizeAttachmentProgress(undefined), undefined);
  assert.equal(normalizeAttachmentProgress("40"), undefined);
});

test("only a measured upload shows a percentage; a seeded zero stays activity", () => {
  assert.deepEqual(attachmentProgressView({ type: "running", reason: "uploading", progress: 42.6 }), { kind: "determinate", percent: 43 });
  assert.deepEqual(attachmentProgressView({ type: "running", reason: "uploading", progress: 0 }), { kind: "indeterminate" });
  assert.deepEqual(attachmentProgressView({ type: "running", reason: "uploading", progress: Number.NaN }), { kind: "indeterminate" });
  assert.deepEqual(attachmentProgressView({ type: "requires-action", reason: "composer-send" }), { kind: "none" });
  assert.deepEqual(attachmentProgressView({ type: "complete" }), { kind: "none" });
  assert.deepEqual(attachmentProgressView({ type: "incomplete", reason: "error" }), { kind: "none" });
});

test("only failed attachments with surviving bytes are retryable", () => {
  const file = new File(["bytes"], "clip.mp4", { type: "video/mp4" });
  const failed = (overrides: Partial<Attachment>): Attachment => ({ id: "a", name: "clip.mp4", type: "file", file, status: { type: "incomplete", reason: "error", message: "read failed" }, ...overrides }) as Attachment;
  assert.deepEqual(attachmentRetryPlan({ id: "1", name: "a.png", type: "image", status: { type: "complete" }, content: [imagePart] }), { retryable: false, reason: "complete" });
  assert.deepEqual(attachmentRetryPlan({ id: "1", name: "a.png", type: "image", file, status: { type: "requires-action", reason: "composer-send" } }), { retryable: false, reason: "pending" });
  assert.deepEqual(attachmentRetryPlan({ id: "1", name: "a.png", type: "image", file, status: { type: "running", reason: "uploading", progress: 25 } }), { retryable: false, reason: "pending" });
  assert.deepEqual(attachmentRetryPlan(failed({})), { retryable: true, source: "file" });
  assert.deepEqual(attachmentRetryPlan(failed({ file: undefined, content: [{ type: "file", data: "data:video/mp4;base64,AA", mimeType: "video/mp4" }] })), { retryable: true, source: "content" });
  assert.deepEqual(attachmentRetryPlan(failed({ file: undefined, content: undefined })), { retryable: false, reason: "no-bytes" });
  const huge = new Proxy(new Blob([], { type: "video/mp4" }), { get: (target, key, receiver) => key === "size" ? ATTACHMENT_RETRY_BYTE_LIMIT + 1 : Reflect.get(target, key, receiver) }) as File;
  assert.deepEqual(attachmentRetryPlan(failed({ file: huge })), { retryable: false, reason: "too-large" });
});

test("retry content copies parts losslessly and refuses anything it cannot rebuild", () => {
  const attachment: Attachment = { id: "a", name: "notes.txt", type: "document", status: { type: "complete" }, content: [{ type: "text", text: "hello" }, { type: "file", data: "data:text/plain;base64,AA", mimeType: "text/plain", filename: "notes.txt" }] };
  assert.deepEqual(attachmentRetryContent(attachment), [{ type: "text", text: "hello" }, { type: "file", data: "data:text/plain;base64,AA", mimeType: "text/plain", filename: "notes.txt" }]);
  const withAudio: Attachment = { ...attachment, content: [{ type: "audio", audio: { data: "AA", format: "mp3" } }] };
  assert.equal(attachmentRetryContent(withAudio), undefined);
  assert.equal(attachmentRetryContent({ ...attachment, content: [] }), undefined);
});

test("the retry payload keeps the original identity, and cannot be built without real bytes", async () => {
  const failed: Attachment = { id: "attach-7", name: "scan.png", type: "image", contentType: "image/png", status: { type: "incomplete", reason: "error", message: "read failed" }, content: [imagePart] } as Attachment;
  assert.deepEqual(await attachmentRetryPayload(failed), { id: "attach-7", name: "scan.png", type: "image", contentType: "image/png", content: [imagePart] });
  const pendingFile = new File(["bytes"], "clip.mp4", { type: "video/mp4" });
  await assert.rejects(attachmentRetryPayload({ id: "attach-8", name: "clip.mp4", type: "file", file: pendingFile, status: { type: "incomplete", reason: "error" } }), /cannot read|FileReader/iu);
  assert.equal(await attachmentRetryPayload({ id: "attach-9", name: "gone.bin", type: "file", status: { type: "incomplete", reason: "error" } } as Attachment), undefined);
  assert.equal(await attachmentRetryPayload({ id: "attach-10", name: "ok.png", type: "image", status: { type: "complete" }, content: [imagePart] }), undefined);
});

test("byte reads fail loudly instead of returning fabricated content", async () => {
  await assert.rejects(readAttachmentDataUrl(new Blob(["bytes"])), /FileReader|cannot read/iu);
});
