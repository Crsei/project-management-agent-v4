// Selection semantics adapted from t3code reviewCommentContext.ts and
// components/ThreadTerminalDrawer.tsx @ 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c (MIT).
import type { SelectedLineRange } from "@pierre/diffs";
import type { ChatContextSelection } from "@agent-workspace/contracts/message-context";

/** Bind a native old/new-side range to the exact raw patch snapshot read by the inspector. */
export function patchSelection(patch: string, range: SelectedLineRange): ChatContextSelection | null {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  let start: number | undefined;
  let end: number | undefined;
  const startSide = range.side ?? "additions";
  const endSide = range.endSide ?? startSide;
  const lines = patch.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\") || oldRemaining + newRemaining === 0) continue;
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") { inHunk = false; continue; }
    const hasOld = prefix !== "+" && oldRemaining > 0;
    const hasNew = prefix !== "-" && newRemaining > 0;
    const matches = (number: number, side: string) => side === "deletions" ? hasOld && oldLine === number : hasNew && newLine === number;
    if (matches(range.start, startSide)) start = index + 1;
    if (matches(range.end, endSide)) end = index + 1;
    if (hasOld) { oldLine += 1; oldRemaining -= 1; }
    if (hasNew) { newLine += 1; newRemaining -= 1; }
  }
  return start === undefined || end === undefined ? null : { startLine: Math.min(start, end), endLine: Math.max(start, end) };
}

export function fileSelection(contents: string, range: SelectedLineRange): ChatContextSelection | null {
  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  const lineCount = contents ? contents.split("\n").length - (contents.endsWith("\n") ? 1 : 0) : 0;
  return Number.isInteger(startLine) && Number.isInteger(endLine) && startLine > 0 && endLine <= lineCount ? { startLine, endLine } : null;
}

/** Terminal end coordinates are exclusive; buffer row labels are 1-based, not command line numbers. */
export function terminalSelectionSnapshot(terminal: {
  getSelection(): string;
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | null | undefined;
  getSelectionBufferPosition?(): { start: { x: number; y: number }; end: { x: number; y: number } } | null;
}) {
  const text = terminal.getSelection();
  const position = terminal.getSelectionBufferPosition?.() ?? terminal.getSelectionPosition();
  if (!position || !text.trim()) return null;
  const startLine = position.start.y + 1;
  const endLine = Math.max(startLine, position.end.y + (position.end.x === 0 ? 0 : 1));
  return { text, selection: { startLine, endLine } };
}

export async function inspectorContentDigest(contents: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
