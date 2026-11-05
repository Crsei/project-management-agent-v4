import assert from "node:assert/strict";
import test from "node:test";
import { safeMarkdownUrl } from "./markdown-url.ts";

test("keeps http, https, mailto, fragments and same-origin paths", () => {
  for (const url of [
    "https://example.com/a?b=c#d",
    "http://example.com",
    "mailto:someone@example.com",
    "#section-2",
    "/agent/workspace",
  ]) {
    assert.equal(safeMarkdownUrl(url), url);
  }
});

test("trims surrounding whitespace before judging the URL", () => {
  assert.equal(safeMarkdownUrl("  https://example.com  "), "https://example.com");
  assert.equal(safeMarkdownUrl("   "), undefined);
});

test("rejects control characters, embedded whitespace and backslashes", () => {
  for (const url of [
    "java\u0000script:alert(1)",
    "java\nscript:alert(1)",
    "https://example.com/a b",
    "\\\\evil.example.com/share",
    "https://example.com/a\\b",
    "\u007fhttps://example.com",
  ]) {
    assert.equal(safeMarkdownUrl(url), undefined, url);
  }
});

test("rejects protocol-relative and non-http protocols", () => {
  for (const url of [
    "//evil.example.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(safeMarkdownUrl(url), undefined, url);
  }
});

test("rejects strings that cannot be parsed as URLs", () => {
  assert.equal(safeMarkdownUrl("not a url"), undefined);
  assert.equal(safeMarkdownUrl("example.com"), undefined);
});
