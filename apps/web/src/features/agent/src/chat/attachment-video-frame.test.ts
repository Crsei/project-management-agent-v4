import assert from "node:assert/strict";
import test from "node:test";
import type { Attachment } from "@assistant-ui/react";
import { attachmentMediaType, captureVideoFirstFrame, isVideoAttachment, videoPreviewPlan } from "./attachment-video-frame.ts";

const videoFile = () => new File(["bytes"], "clip.mp4", { type: "video/mp4" });
const base = { id: "v1", name: "clip.mp4", type: "file" as const, status: { type: "complete" as const } };

test("video attachments are identified by media type, not by a fabricated type", () => {
  assert.equal(attachmentMediaType({ contentType: "VIDEO/MP4" }), "VIDEO/MP4");
  assert.equal(isVideoAttachment({ ...base, contentType: "video/mp4" }), true);
  assert.equal(isVideoAttachment({ ...base, file: videoFile() }), true);
  assert.equal(isVideoAttachment({ ...base, content: [{ type: "file", data: "data:video/webm;base64,AA", mimeType: "video/webm" }] }), true);
  assert.equal(isVideoAttachment({ type: "image", content: [{ type: "image", image: "data:image/png;base64,AA" }] }), false);
  assert.equal(isVideoAttachment({ type: "video" }), true);
});

test("only local video bytes are decoded automatically; remote and embedded URLs wait for the user", () => {
  const local: Attachment = { ...base, contentType: "video/mp4", file: videoFile(), content: [] };
  const localPlan = videoPreviewPlan(local);
  assert.equal(localPlan.kind, "local-file");
  const embedded: Attachment = { ...base, contentType: "video/mp4", content: [{ type: "file", data: "data:video/mp4;base64,AA", mimeType: "video/mp4" }] };
  assert.deepEqual(videoPreviewPlan(embedded), { kind: "deferred", reason: "embedded" });
  const remote: Attachment = { ...base, contentType: "video/mp4", content: [{ type: "file", data: "https://example.test/clip.mp4", mimeType: "video/mp4" }] };
  assert.deepEqual(videoPreviewPlan(remote), { kind: "deferred", reason: "remote" });
  assert.deepEqual(videoPreviewPlan({ ...base, contentType: "video/mp4" }), { kind: "unavailable", reason: "no-source" });
  assert.deepEqual(videoPreviewPlan({ type: "image", content: [{ type: "image", image: "data:image/png;base64,AA" }] }), { kind: "unavailable", reason: "not-video" });
});

test("a non-browser environment yields no frame instead of a placeholder", async () => {
  assert.equal(await captureVideoFirstFrame(videoFile()), null);
});
