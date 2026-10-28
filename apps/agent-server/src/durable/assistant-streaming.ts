import type { ResponseStreamingMode } from "@agent-workspace/contracts/output";

/** Adapted from t3code apps/server/src/orchestration-v2/assistantStreaming.ts.
 * Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code. */
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
const BLANK_LINE_PATTERN = /^[ \t]*$/;
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

/**
 * Split only at complete Markdown block boundaries. A heading waits for its
 * content, and a fence waits for its matching closing fence. Tight list items
 * can use the next item marker as lookahead even on a partial line.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  let titleAwaitingContent = false;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = text.slice(lineStart, newline === -1 ? text.length : newline).replace(/[ \t\r]+$/, "");
    if (openFence === null && lineStart > 0 && !titleAwaitingContent && LIST_ITEM_START_PATTERN.test(line)) {
      boundary = lineStart;
    }
    if (newline === -1) break;
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) boundary = newline + 1;
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart;
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
  }
  if (boundary === -1) return { ready: "", rest: text };
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

const RELEASE_INTERVAL_MS = 400;
type StreamEntry = { text: string; ready: string; delivered: string; deliveredAt: number | null };
export type AssistantStreamingRelease = { key: string; text: string };

/**
 * Filters full cumulative strings independently by key. The caller owns a
 * single timer, using nextDelay/releaseDue after each update or release.
 * Terminal completion must call finish for that key or flush for all keys.
 */
export function makeAssistantStreamingFilter(mode: ResponseStreamingMode) {
  const entries = new Map<string, StreamEntry>();

  function release(entry: StreamEntry, now: number): string | null {
    if (mode === "turn" || !entry.ready || entry.ready === entry.delivered) return null;
    if (entry.deliveredAt !== null && now - entry.deliveredAt < RELEASE_INTERVAL_MS) return null;
    entry.delivered = entry.ready;
    entry.deliveredAt = now;
    return entry.ready;
  }

  return {
    update(key: string, text: string, now = Date.now()): string | null {
      let entry = entries.get(key);
      if (!entry) {
        entry = { text, ready: "", delivered: "", deliveredAt: null };
        entries.set(key, entry);
      }
      entry.text = text;
      entry.ready = mode === "paragraph" ? splitBufferedAssistantText(text).ready : "";
      return release(entry, now);
    },
    releaseDue(now = Date.now()): AssistantStreamingRelease[] {
      const result: AssistantStreamingRelease[] = [];
      for (const [key, entry] of entries) {
        const text = release(entry, now);
        if (text !== null) result.push({ key, text });
      }
      return result;
    },
    nextDelay(now = Date.now()): number | null {
      if (mode === "turn") return null;
      let delay: number | null = null;
      for (const entry of entries.values()) {
        if (!entry.ready || entry.ready === entry.delivered) continue;
        const remaining = entry.deliveredAt === null ? 0 : Math.max(0, entry.deliveredAt + RELEASE_INTERVAL_MS - now);
        delay = delay === null ? remaining : Math.min(delay, remaining);
      }
      return delay;
    },
    finish(key: string, text: string): string {
      entries.delete(key);
      return text;
    },
    flush(): AssistantStreamingRelease[] {
      const result: AssistantStreamingRelease[] = [];
      for (const [key, entry] of entries) {
        if (entry.text !== entry.delivered) result.push({ key, text: entry.text });
      }
      entries.clear();
      return result;
    },
  };
}
