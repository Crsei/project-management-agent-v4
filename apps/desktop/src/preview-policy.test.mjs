import assert from "node:assert/strict";
import test from "node:test";
import {
  elementCropRect,
  isAllowedPreviewUrl,
  isPreviewPartition,
  normalizePreviewRect,
  normalizePreviewUrl,
  pipPageDataUrl,
  previewPartition,
  previewTabId,
} from "./preview/preview-policy.mjs";

test("preview partitions are stable per origin and isolated from other origins", () => {
  const first = previewPartition("http://127.0.0.1:3224");
  assert.equal(first, previewPartition("http://127.0.0.1:3224"));
  assert.match(first, /^persist:pm-preview-[a-f0-9]{16}$/);
  assert.notEqual(first, previewPartition("https://workspace.example.com"));
  assert.equal(isPreviewPartition(first), true);
  assert.equal(isPreviewPartition("persist:desktop-connection"), false);
  assert.throws(() => previewPartition(""));
});

test("preview URLs default loopback to HTTP and other hosts to HTTPS", () => {
  assert.equal(normalizePreviewUrl("127.0.0.1:3223/pm"), "http://127.0.0.1:3223/pm");
  assert.equal(normalizePreviewUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizePreviewUrl("example.com/path?q=1"), "https://example.com/path?q=1");
  assert.equal(normalizePreviewUrl("http://example.com"), "http://example.com/");
  assert.equal(normalizePreviewUrl("https://example.com"), "https://example.com/");
});

test("preview URLs reject non-web schemes and embedded credentials", () => {
  for (const value of ["ftp://example.com", "mailto:alice@example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "http://user:pass@example.com"]) {
    assert.throws(() => normalizePreviewUrl(value), undefined, value);
    assert.equal(isAllowedPreviewUrl(value), false);
  }
  assert.throws(() => normalizePreviewUrl(""));
  assert.throws(() => normalizePreviewUrl(`https://example.com/${"a".repeat(2048)}`));
});

test("preview tab ids are bounded strings", () => {
  assert.equal(previewTabId("browser:1"), "browser:1");
  assert.throws(() => previewTabId(""));
  assert.throws(() => previewTabId("x".repeat(129)));
  assert.throws(() => previewTabId(42));
});

test("element crop rect scales by DPR and clamps to the captured image", () => {
  assert.deepEqual(
    elementCropRect({ x: 10, y: 20, width: 100, height: 50 }, 2, { width: 400, height: 300 }),
    { x: 20, y: 40, width: 200, height: 100 },
  );
  assert.deepEqual(
    elementCropRect({ x: 350, y: 280, width: 100, height: 100 }, 1, { width: 400, height: 300 }),
    { x: 350, y: 280, width: 50, height: 20 },
  );
  assert.equal(
    elementCropRect({ x: 500, y: 400, width: 10, height: 10 }, 1, { width: 400, height: 300 }),
    null,
  );
  assert.equal(elementCropRect({ x: 10, y: 10, width: 0, height: 10 }, 1, { width: 400, height: 300 }), null);
});

test("preview rects reject non-finite and non-positive geometry", () => {
  assert.deepEqual(normalizePreviewRect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
  assert.throws(() => normalizePreviewRect({ x: 1, y: 2, width: 0, height: 4 }));
  assert.throws(() => normalizePreviewRect({ x: Number.NaN, y: 2, width: 3, height: 4 }));
});

test("PiP page has a restrictive CSP and only the frame/close bridge", () => {
  const url = pipPageDataUrl();
  assert.match(url, /^data:text\/html;base64,/);
  const html = Buffer.from(url.slice("data:text/html;base64,".length), "base64").toString("utf8");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.match(html, /previewPictureInPicture\.onFrame/);
  assert.match(html, /previewPictureInPicture\.close/);
  assert.doesNotMatch(html, /https?:\/\//);
});
