import assert from "node:assert/strict";
import test from "node:test";
import type { ChatContextInput } from "@agent-workspace/contracts/message-context";
import type { Attachment } from "@assistant-ui/react";
import { canonicalContextAttachments, contextAttachmentBindings, readContextAttachmentBindings, reindexContextAttachmentBindings } from "./context-attachments.ts";

test("preview screenshots correlate by captured attachment identity/order, never filename or equal bytes", () => {
  const input: ChatContextInput = { contextId: "capture", kind: "preview-annotation", source: { type: "browser", url: "http://localhost:3000/", captureId: "real-capture", attachmentId: "real-image" }, text: "Selected element" };
  const makeAttachment = (id: string): Attachment => ({ id, name: "same-name.png", type: "image", contentType: "image/png", status: { type: "complete" }, content: [{ type: "image", image: "data:image/png;base64,AAAA" }] });
  const other = makeAttachment("other-image"), screenshot = makeAttachment("real-image");
  const parts = [{ type: "text", text: "Original text" }, { type: "file", filename: "same-name.png", url: "data:image/png;base64,AAAA" }, { type: "file", filename: "same-name.png", url: "data:image/png;base64,AAAA" }];
  assert.deepEqual(contextAttachmentBindings(parts, [input], [other, screenshot]), [{ attachmentId: "real-image", partIndex: 2 }]);
  assert.deepEqual(contextAttachmentBindings(parts.slice(0, 2), [input], [other]), [], "an equal image cannot stand in for the removed capture identity");
  assert.throws(() => contextAttachmentBindings(parts.slice(0, 1), [input], [other, screenshot]), /no longer match/);
});

test("edit preserves canonical image identity only for the exact original file part", () => {
  const originalPart = { type: "file", url: "data:image/png;base64,AAAA" };
  const attachment: Attachment = { id: "0", name: "capture.png", type: "image", contentType: "image/png", status: { type: "complete" }, content: [{ type: "image", image: originalPart.url }] };
  const bindings = [{ attachmentId: "original-capture", partIndex: 1 }];
  const parts = [{ type: "text", text: "ask" }, originalPart];
  assert.equal(canonicalContextAttachments([attachment], parts, bindings)[0]!.id, "original-capture");
  assert.equal(canonicalContextAttachments([{ ...attachment, id: "new-equal-image" }], parts, bindings)[0]!.id, "new-equal-image");
  assert.equal(canonicalContextAttachments([{ ...attachment, content: [{ type: "image", image: "data:image/png;base64,BBBB" }] }], parts, bindings)[0]!.id, "0");
  assert.deepEqual(canonicalContextAttachments([], parts, bindings), []);
});

test("queue text edits reindex real file objects without losing screenshot identity", () => {
  const file = { type: "file", filename: "capture.png", url: "data:image/png;base64,AAAA" };
  const original = [{ type: "text", text: "old" }, { type: "text", text: "extra text" }, file];
  const edited = [{ type: "text", text: "new" }, file];
  assert.deepEqual(reindexContextAttachmentBindings(original, edited, [{ attachmentId: "screenshot", partIndex: 2 }]), [{ attachmentId: "screenshot", partIndex: 1 }]);
  assert.throws(() => reindexContextAttachmentBindings(original, [{ ...file }], [{ attachmentId: "screenshot", partIndex: 2 }]), /could not be retained/, "a same-name/copied object is not silently substituted");
  assert.throws(() => reindexContextAttachmentBindings(original, edited, [{ attachmentId: "screenshot", partIndex: 0 }]), /invalid/);
});

test("invalid clipboard metadata cannot invent a native attachment pointer", () => {
  assert.deepEqual(readContextAttachmentBindings([{ attachmentId: "actual", partIndex: 2 }, { attachmentId: "negative", partIndex: -1 }, { attachmentId: "float", partIndex: 1.5 }, { attachmentId: 42, partIndex: 0 }]), [{ attachmentId: "actual", partIndex: 2 }]);
});
