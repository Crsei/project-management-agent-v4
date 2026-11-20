// Pure presentation model for the composer draft stash (t3code ComposerStashMenu.tsx /
// useComposerStash.ts semantics). Copyright (c) 2026 T3 Tools Inc. MIT; LICENSE.t3code.
// Host persistence stays in the existing `/stash` endpoints; nothing here sends or mutates.
import type { ChatDraftInput } from "@agent-workspace/contracts/chat";

export const STASH_SNIPPET_MAX_CHARS = 90;

export type StashDraftCounts = { attachments: number; contexts: number; references: number; quoted: boolean };

export function stashDraftText(draft: ChatDraftInput | null | undefined): string {
  if (!draft) return "";
  return draft.message.parts.filter(part => part.type === "text").map(part => part.text).join("\n");
}

/** One-line collapsed snippet; `null` means the draft has no text and needs a count summary. */
export function stashDraftSnippet(draft: ChatDraftInput | null | undefined, maxCharacters = STASH_SNIPPET_MAX_CHARS): string | null {
  const text = stashDraftText(draft).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const characters = Array.from(text);
  if (characters.length <= maxCharacters) return text;
  return `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

export function stashDraftCounts(draft: ChatDraftInput | null | undefined): StashDraftCounts {
  if (!draft) return { attachments: 0, contexts: 0, references: 0, quoted: false };
  return {
    attachments: draft.message.parts.filter(part => part.type === "file").length,
    contexts: draft.contextItems?.length ?? 0,
    references: draft.pmReferences?.length ?? 0,
    quoted: Boolean(draft.message.metadata?.custom?.quote),
  };
}

export function stashDraftEmpty(draft: ChatDraftInput | null | undefined): boolean {
  const counts = stashDraftCounts(draft);
  return stashDraftSnippet(draft) === null && !counts.attachments && !counts.contexts && !counts.references && !counts.quoted;
}

export type StashTimeUnit = "now" | "minute" | "hour" | "day" | "date" | "unknown";
export type StashRelativeTime = { unit: StashTimeUnit; value: number };

/**
 * Relative buckets mirror the upstream RelativeTime thresholds closely enough for a
 * stash list: fresh saves read as "now", then minutes/hours/days, then an absolute date.
 * A future timestamp is treated as "now" instead of inventing elapsed time.
 */
export function stashRelativeTime(createdAt: string | number | null | undefined, now = Date.now()): StashRelativeTime {
  const then = typeof createdAt === "number" ? createdAt : createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(then)) return { unit: "unknown", value: 0 };
  const elapsed = Math.max(0, now - then);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 45) return { unit: "now", value: 0 };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { unit: "minute", value: Math.max(1, minutes) };
  const hours = Math.round(minutes / 60);
  if (hours < 22) return { unit: "hour", value: hours };
  const days = Math.round(hours / 24);
  if (days < 7) return { unit: "day", value: days };
  return { unit: "date", value: then };
}

/** Arrow keys wrap around the list; `-1` (nothing highlighted) keeps the upstream direction. */
export function moveStashHighlight(currentIndex: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  const base = currentIndex >= 0 && currentIndex < length ? currentIndex : delta > 0 ? -1 : 0;
  return (base + delta + length) % length;
}

export type StashDrawerCommand = "previous" | "next" | "restore" | "delete" | "close";

export type StashDrawerKey = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** IME composition must never trigger restore/delete. */
  composing?: boolean;
  hasHighlight: boolean;
};

/**
 * Only keys owned by the open drawer are claimed. Enter with no highlighted row returns
 * `null` so the focused control keeps its native activation.
 */
export function stashDrawerCommand(input: StashDrawerKey): StashDrawerCommand | null {
  if (input.composing) return null;
  if (input.key === "Escape") return "close";
  if (input.key === "ArrowUp" && !input.metaKey && !input.ctrlKey && !input.altKey && !input.shiftKey) return "previous";
  if (input.key === "ArrowDown" && !input.metaKey && !input.ctrlKey && !input.altKey && !input.shiftKey) return "next";
  if (input.key === "Enter" && !input.shiftKey && !input.altKey) return input.hasHighlight ? "restore" : null;
  if ((input.key === "Backspace" || input.key === "Delete") && (input.metaKey || input.ctrlKey) && !input.altKey) return input.hasHighlight ? "delete" : null;
  return null;
}
