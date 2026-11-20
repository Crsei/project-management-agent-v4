import assert from "node:assert/strict";
import test from "node:test";
import {
  citationAnchorFromQuote,
  isMarkdownCitationHref,
  markdownCitationExcerpt,
  markdownCitationLabel,
  MAX_CITATION_TEXT_LENGTH,
  parseMarkdownCitationHref,
  serializeMarkdownCitation,
} from "./markdown-citation.ts";

test("round-trips a citation with unicode text, newlines and a source thread", () => {
  const anchor = { messageId: "message-1", threadId: "thread-1", text: "第一行\nsecond line — ünïcode" };
  const href = serializeMarkdownCitation(anchor);
  assert.ok(href?.startsWith("#assistant-citation/v1/"));
  assert.deepEqual(parseMarkdownCitationHref(href), anchor);
});

test("round-trips a citation without a thread and keeps the excerpt for fallback", () => {
  const href = serializeMarkdownCitation({ messageId: "message/with?chars", text: "quoted text" });
  assert.ok(href);
  const parsed = parseMarkdownCitationHref(href);
  assert.deepEqual(parsed, { messageId: "message/with?chars", text: "quoted text" });
  assert.equal(markdownCitationExcerpt(href), "quoted text");
});

test("rejects malformed or unanchored links instead of inventing an id", () => {
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/?text=hello"), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1//?text=hello"), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/message-1"), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/message-1?text="), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/message-1?text=a&text=b"), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/message-1?text=a&extra=b"), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/%E0%A4%A?text=hi"), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/a/b/c?text=hi"), null);
  assert.equal(parseMarkdownCitationHref("#other-fragment"), null);
  assert.equal(parseMarkdownCitationHref(undefined), null);
  assert.equal(parseMarkdownCitationHref(`#assistant-citation/v1/${"x".repeat(257)}?text=hi`), null);
  assert.equal(parseMarkdownCitationHref("#assistant-citation/v1/message-1?text=hi\u0000"), null);
});

test("the anchorless excerpt survives a missing or invalid source id", () => {
  assert.equal(markdownCitationExcerpt("#assistant-citation/v1/?text=hello%20world"), "hello world");
  assert.equal(markdownCitationExcerpt("#assistant-citation/v1/%E0%A4%A?text=hi"), "hi");
  assert.equal(markdownCitationExcerpt("#assistant-citation/v1/message-1?id=x&text=hi"), undefined);
  assert.equal(markdownCitationExcerpt("#assistant-citation/v1/message-1?text="), undefined);
  assert.equal(markdownCitationExcerpt("#assistant-citation/v1/message-1"), undefined);
  assert.equal(markdownCitationExcerpt("#plain"), undefined);
});

test("serialization refuses inputs that cannot become a real anchor", () => {
  assert.equal(serializeMarkdownCitation({ messageId: "", text: "hi" }), undefined);
  assert.equal(serializeMarkdownCitation({ messageId: "message-1", text: "" }), undefined);
  assert.equal(serializeMarkdownCitation({ messageId: "message-1", text: "x".repeat(MAX_CITATION_TEXT_LENGTH + 1) }), undefined);
  assert.equal(serializeMarkdownCitation({ messageId: "message\n1", text: "hi" }), undefined);
  assert.equal(serializeMarkdownCitation({ messageId: "message-1", threadId: "", text: "hi" }), undefined);
});

test("href detection is scoped to the exact citation prefix", () => {
  assert.equal(isMarkdownCitationHref("#assistant-citation/v1/message-1?text=hi"), true);
  assert.equal(isMarkdownCitationHref("#assistant-citation/v2/message-1?text=hi"), false);
  assert.equal(isMarkdownCitationHref("https://example.com/#assistant-citation/v1/message-1?text=hi"), false);
});

test("labels collapse whitespace and truncate by code point", () => {
  assert.equal(markdownCitationLabel({ text: "  a\n\nb   c  " }), "a b c");
  assert.equal(markdownCitationLabel({ text: "abcdef" }, 4), "abc…");
  const surrogate = "😀".repeat(10);
  assert.equal(markdownCitationLabel({ text: surrogate }, 4), `${"😀".repeat(3)}…`);
});

test("quote metadata only becomes an anchor when its source id is valid", () => {
  assert.deepEqual(citationAnchorFromQuote({ messageId: "message-1", text: "quoted" }), { messageId: "message-1", text: "quoted" });
  assert.equal(citationAnchorFromQuote({ messageId: "", text: "quoted" }), null);
  assert.equal(citationAnchorFromQuote({ messageId: 42, text: "quoted" }), null);
  assert.equal(citationAnchorFromQuote({ messageId: "message-1", text: "" }), null);
  assert.equal(citationAnchorFromQuote(undefined), null);
});
