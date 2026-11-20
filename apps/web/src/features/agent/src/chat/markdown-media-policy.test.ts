import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKDOWN_IMAGE_MAX_BYTES,
  MARKDOWN_IMAGE_MAX_COPY_SOURCE,
  markdownAuthorizedImageSource,
  markdownGalleryFileName,
  markdownGalleryIndex,
  markdownImageCandidate,
  markdownImageContentTypeAllowed,
  markdownImageCopySource,
  markdownImageWithinSizeLimit,
} from "./markdown-media-policy.ts";

const session = {
  canOpenFiles: true,
  executionPath: "/work/project",
  documentPath: "docs/readme.md",
};

test("auto-loads only images that resolve inside the session execution root", () => {
  assert.deepEqual(markdownAuthorizedImageSource("images/a.png", session), { path: "docs/images/a.png" });
  assert.deepEqual(markdownAuthorizedImageSource("/work/project/assets/b.JPG", session), { path: "assets/b.JPG" });
  assert.deepEqual(markdownAuthorizedImageSource("./assets/c.webp", session), { path: "docs/assets/c.webp" });
  assert.deepEqual(
    markdownAuthorizedImageSource("assets/a.png#L12", { ...session, documentPath: undefined }),
    { path: "assets/a.png", line: 12 },
  );
});

test("rejects external, data, blob and protocol-relative image sources", () => {
  for (const src of [
    "https://evil.example/a.png",
    "http://evil.example/a.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:http://localhost/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    "//evil.example/a.png",
    "javascript:alert(1)",
    "file:///etc/passwd",
  ]) {
    assert.equal(markdownAuthorizedImageSource(src, session), undefined, src);
  }
});

test("rejects image sources that escape the execution root", () => {
  assert.equal(markdownAuthorizedImageSource("/work/other/a.png", session), undefined);
  assert.equal(markdownAuthorizedImageSource("../../secret.png", session), undefined);
  assert.equal(markdownAuthorizedImageSource("../a.png", { ...session, documentPath: undefined }), undefined);
  assert.equal(markdownAuthorizedImageSource("/work/project/../../secret.png", session), undefined);
});

test("requires file access, an execution root and a raster image extension", () => {
  assert.equal(markdownAuthorizedImageSource("assets/a.png", { ...session, canOpenFiles: false }), undefined);
  assert.equal(markdownAuthorizedImageSource("assets/a.png", { canOpenFiles: true }), undefined);
  assert.equal(markdownAuthorizedImageSource(undefined, session), undefined);
  for (const src of ["notes.txt", "icon.svg", "report.pdf", "clip.mp4"]) {
    assert.equal(markdownAuthorizedImageSource(src, session), undefined, src);
  }
});

test("image extension candidate is limited to raster formats", () => {
  for (const path of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.avif", "A.PNG"]) {
    assert.equal(markdownImageCandidate(path), true, path);
  }
  for (const path of ["a.svg", "a.bmp", "a.tiff", "a.png.txt", "a"]) {
    assert.equal(markdownImageCandidate(path), false, path);
  }
});

test("content type guard accepts only allow-listed image MIME types", () => {
  for (const value of ["image/png", "image/jpeg; charset=binary", "IMAGE/WEBP", "image/avif", "image/gif"]) {
    assert.equal(markdownImageContentTypeAllowed(value), true, value);
  }
  for (const value of ["image/svg+xml", "text/html", "audio/mpeg", "video/mp4", "", null, undefined]) {
    assert.equal(markdownImageContentTypeAllowed(value), false, String(value));
  }
});

test("20 MiB size guard covers declared and actual bytes", () => {
  assert.equal(markdownImageWithinSizeLimit(String(MARKDOWN_IMAGE_MAX_BYTES)), true);
  assert.equal(markdownImageWithinSizeLimit(String(MARKDOWN_IMAGE_MAX_BYTES + 1)), false);
  assert.equal(markdownImageWithinSizeLimit(MARKDOWN_IMAGE_MAX_BYTES), true);
  assert.equal(markdownImageWithinSizeLimit(undefined, MARKDOWN_IMAGE_MAX_BYTES), true);
  assert.equal(markdownImageWithinSizeLimit(undefined, MARKDOWN_IMAGE_MAX_BYTES + 1), false);
  assert.equal(markdownImageWithinSizeLimit(null), true);
  assert.equal(markdownImageWithinSizeLimit("not-a-number"), true);
  assert.equal(markdownImageWithinSizeLimit("-1"), true);
});

test("copy affordance stays short and unambiguous", () => {
  assert.equal(markdownImageCopySource("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(markdownImageCopySource("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(markdownImageCopySource("blob:https://example.com/1b9d6bcd"), "blob:https://example.com/1b9d6bcd");
  assert.equal(markdownImageCopySource("/app/assets/a.png"), "/app/assets/a.png");
  for (const src of ["javascript:alert(1)", "mailto:someone@example.com", "file:///etc/passwd", "images/a.png", "//evil.example/a.png"]) {
    assert.equal(markdownImageCopySource(src), undefined, src);
  }
  assert.equal(markdownImageCopySource("https://example.com/a b.png"), undefined);
  assert.equal(markdownImageCopySource(""), undefined);
  assert.equal(markdownImageCopySource(undefined), undefined);
  assert.equal(markdownImageCopySource(`data:image/png;base64,${"A".repeat(MARKDOWN_IMAGE_MAX_COPY_SOURCE)}`), undefined);
});

test("gallery navigation wraps in both directions and never leaves the list", () => {
  assert.equal(markdownGalleryIndex(0, -1, 3), 2);
  assert.equal(markdownGalleryIndex(2, 1, 3), 0);
  assert.equal(markdownGalleryIndex(1, 0, 3), 1);
  assert.equal(markdownGalleryIndex(0, 5, 3), 2);
  assert.equal(markdownGalleryIndex(-1, 0, 3), 2);
  assert.equal(markdownGalleryIndex(99, 0, 3), 0);
  assert.equal(markdownGalleryIndex(0, 1, 1), 0);
  assert.equal(markdownGalleryIndex(0, 1, 0), 0);
});

test("download names keep the source basename", () => {
  assert.equal(markdownGalleryFileName("docs/screens/header image.png"), "header image.png");
  assert.equal(markdownGalleryFileName("logo.avif"), "logo.avif");
  assert.equal(markdownGalleryFileName("docs/"), "image");
});
