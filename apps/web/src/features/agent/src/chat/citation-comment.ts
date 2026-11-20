// Citation comment model. Comments live in the existing `ChatContextInput.comment`
// field (already accepted by the resolve contract); no new contract or endpoint.
// Adapted from t3code AssistantCitationCommentEditor.tsx at
// 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c. Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
import type { ChatContextInput } from "@agent-workspace/contracts/message-context";

/** Same limit the host schema enforces on `comment`. */
export const CITATION_COMMENT_MAX_LENGTH = 4000;

/**
 * The quote structure (`QuoteInfo`) has no comment field, so an inline quote never
 * offers one. Response citations are the only structure whose comment is editable.
 */
export function citationCommentSupported(input: Pick<ChatContextInput, "kind">): boolean {
  return input.kind === "response";
}

export function citationCommentValue(input: Pick<ChatContextInput, "comment">): string {
  return typeof input.comment === "string" ? input.comment : "";
}

export function citationCommentTooLong(comment: string): boolean {
  return comment.length > CITATION_COMMENT_MAX_LENGTH;
}

/** Clearing removes the field instead of persisting an empty string. */
export function withCitationComment<T extends ChatContextInput>(input: T, comment: string): T {
  const next = { ...input } as T & { comment?: string };
  const trimmed = comment.trim();
  if (trimmed) next.comment = trimmed;
  else delete next.comment;
  return next;
}
