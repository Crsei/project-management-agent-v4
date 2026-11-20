import assert from "node:assert/strict";
import test from "node:test";
import type { ChatContextInput } from "@agent-workspace/contracts/message-context";
import {
  CITATION_COMMENT_MAX_LENGTH, citationCommentSupported, citationCommentTooLong, citationCommentValue, withCitationComment,
} from "./citation-comment.ts";

const citation = (comment?: string): Extract<ChatContextInput, { kind: "response" }> => ({
  contextId: "c1", kind: "response", source: { type: "response", threadId: "t", messageId: "m" },
  selectedText: "quoted", ...(comment === undefined ? {} : { comment }),
});

test("only response citations expose an editable comment structure", () => {
  assert.equal(citationCommentSupported({ kind: "response" }), true);
  assert.equal(citationCommentSupported({ kind: "thread" }), false);
  assert.equal(citationCommentSupported({ kind: "terminal" }), false);
  assert.equal(citationCommentSupported({ kind: "review-comment" }), false);
});

test("comment values default to empty and round-trip trimmed text", () => {
  assert.equal(citationCommentValue({}), "");
  assert.equal(citationCommentValue({ comment: "hi" }), "hi");
  const edited = withCitationComment(citation(), "  explain this  ");
  assert.equal(edited.comment, "explain this");
  assert.equal(edited.contextId, "c1");
  assert.equal(edited.kind, "response");
});

test("clearing deletes the field instead of persisting an empty string", () => {
  const cleared = withCitationComment(citation("old"), "   ");
  assert.equal("comment" in cleared, false);
  assert.equal(citationCommentValue(cleared), "");
});

test("length validation matches the host comment limit", () => {
  assert.equal(citationCommentTooLong("a".repeat(CITATION_COMMENT_MAX_LENGTH)), false);
  assert.equal(citationCommentTooLong("a".repeat(CITATION_COMMENT_MAX_LENGTH + 1)), true);
});
