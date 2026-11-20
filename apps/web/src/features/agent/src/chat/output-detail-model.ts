import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import type { ChangedFileSummary } from "./output-presenter";

/** Pure presentation helpers for the generation summary tree, command blocks and the item inspector.
 * Nothing here invents provider data: missing fields stay missing. */

export type ChangedFileTreeFile = {
  kind: "file";
  name: string;
  /** Original provider path; actions must receive it unchanged. */
  path: string;
  depth: number;
  summary: ChangedFileSummary;
};

export type ChangedFileTreeDir = {
  kind: "dir";
  name: string;
  /** Normalized (`/`-joined) directory path used for fold state only. */
  path: string;
  depth: number;
  children: ChangedFileTreeNode[];
  files: number;
  additions?: number;
  deletions?: number;
  partialCounts: boolean;
};

export type ChangedFileTreeNode = ChangedFileTreeDir | ChangedFileTreeFile;

const DIRECTORY_DEFAULT_OPEN_DEPTH = 2;

function compareNodes(left: ChangedFileTreeNode, right: ChangedFileTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "case" });
}

function aggregate(directory: ChangedFileTreeDir): void {
  let files = 0;
  let additions: number | undefined;
  let deletions: number | undefined;
  let partialCounts = false;
  for (const child of directory.children) {
    if (child.kind === "dir") {
      aggregate(child);
      files += child.files;
      if (child.additions !== undefined) additions = (additions ?? 0) + child.additions;
      if (child.deletions !== undefined) deletions = (deletions ?? 0) + child.deletions;
      partialCounts ||= child.partialCounts;
      continue;
    }
    files += 1;
    const { additions: add, deletions: del, partialCounts: partial } = child.summary;
    if (add !== undefined) additions = (additions ?? 0) + add;
    if (del !== undefined) deletions = (deletions ?? 0) + del;
    // A file without reported counts, or with partial counts, keeps the directory total a minimum.
    if (partial || add === undefined || del === undefined) partialCounts = true;
  }
  directory.children.sort(compareNodes);
  directory.files = files;
  directory.additions = additions;
  directory.deletions = deletions;
  directory.partialCounts = partialCounts;
}

/** Group provider-reported changed files into a directory tree. Order is deterministic;
 * duplicate paths are kept once and provider order is not otherwise meaningful here. */
export function buildChangedFileTree(files: readonly ChangedFileSummary[]): ChangedFileTreeNode[] {
  const root: ChangedFileTreeDir = { kind: "dir", name: "", path: "", depth: 0, children: [], files: 0, partialCounts: false };
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.path || seen.has(file.path)) continue;
    const parts = file.path.split(/[\\/]+/u).filter(Boolean);
    if (!parts.length) continue;
    seen.add(file.path);
    let directory = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index]!;
      const path = parts.slice(0, index + 1).join("/");
      let next = directory.children.find((child): child is ChangedFileTreeDir => child.kind === "dir" && child.name === name);
      if (!next) {
        next = { kind: "dir", name, path, depth: index + 1, children: [], files: 0, partialCounts: false };
        directory.children.push(next);
      }
      directory = next;
    }
    directory.children.push({ kind: "file", name: parts.at(-1)!, path: file.path, depth: parts.length, summary: file });
  }
  aggregate(root);
  return root.children;
}

export function isDirectoryOpen(node: Pick<ChangedFileTreeDir, "depth" | "path">, overrides: Readonly<Record<string, boolean>>): boolean {
  const value = overrides[node.path];
  return value === undefined ? node.depth <= DIRECTORY_DEFAULT_OPEN_DEPTH : value;
}

export function allDirectoryNodes(nodes: readonly ChangedFileTreeNode[]): ChangedFileTreeDir[] {
  const directories: ChangedFileTreeDir[] = [];
  const visit = (node: ChangedFileTreeNode) => {
    if (node.kind !== "dir") return;
    directories.push(node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return directories;
}

/** Fold-state persistence is best effort: storage denial only resets the view to defaults. */
export type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export function readDirectoryOverrides(storage: KeyValueStorage | undefined, key: string): Record<string, boolean> {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides: Record<string, boolean> = {};
    for (const [path, value] of Object.entries(parsed)) if (typeof value === "boolean") overrides[path] = value;
    return overrides;
  } catch { return {}; }
}

export function writeDirectoryOverrides(storage: KeyValueStorage | undefined, key: string, overrides: Readonly<Record<string, boolean>>): void {
  try { storage?.setItem(key, JSON.stringify(overrides)); } catch { /* Defaults remain usable without tab storage. */ }
}

// oxlint-disable-next-line no-control-regex -- terminal control characters must be escaped, not rendered.
const terminalControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** Visible replacement for terminal control characters; newlines and tabs stay intact. */
export function visibleCommandText(input: string): string {
  return input.replace(/\r\n?/gu, "\n").replace(
    terminalControlCharacters,
    character => `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`);
}

/** Command text accepted by a PTY: no escape/control injection beyond newlines and tabs. */
export function sanitizeTerminalCommand(input: string): string {
  return input
    .replace(/\r\n?/gu, "\n")
    .replace(terminalControlCharacters, "")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "");
}

const SHELLS: readonly string[] = ["bash", "sh", "zsh", "fish", "dash", "ksh", "ash"];

/** Best-effort grammar for a single command string; unknown stays plain. */
export function shellCommandLanguage(command: string): string | undefined {
  const trimmed = command.trim();
  const shebang = /^#!\s*(?:\S*\/)?env\s+(?:-\S+\s+)*([\w.+-]+)/u.exec(trimmed)?.[1]
    ?? /^#!\s*(?:\S*\/)*([\w.+-]+)/u.exec(trimmed)?.[1];
  const first = trimmed.split(/\s+/u, 1)[0] ?? "";
  const word = (shebang ?? first).replace(/^.*[/\\]/u, "").replace(/\.(?:exe|cmd)$/iu, "").toLowerCase();
  if (SHELLS.includes(word)) return "bash";
  if (["python", "python2", "python3", "pypy", "pypy3"].includes(word)) return "python";
  if (["node", "nodejs"].includes(word)) return "javascript";
  if (["bun", "deno", "tsx"].includes(word)) return "typescript";
  if (word === "ruby") return "ruby";
  if (word === "perl") return "perl";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { JSON.parse(trimmed); return "json"; } catch { /* Not JSON; keep plain. */ }
  }
  return undefined;
}

export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punctuation" | "plain";
export type JsonToken = { text: string; kind: JsonTokenKind };

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const PUNCTUATION: readonly string[] = ["{", "}", "[", "]", ":", ","];

/** Lightweight, dependency-free JSON scanner. Invalid input still round-trips character for character. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const push = (value: string, kind: JsonTokenKind) => {
    if (!value) return;
    const last = tokens.at(-1);
    if (last?.kind === kind) last.text += value;
    else tokens.push({ text: value, kind });
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (/\s/u.test(character)) {
      let end = index + 1;
      while (end < text.length && /\s/u.test(text[end]!)) end++;
      push(text.slice(index, end), "plain");
      index = end;
      continue;
    }
    if (character === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") { end += 2; continue; }
        if (text[end] === '"') { end++; break; }
        end++;
      }
      let lookahead = end;
      while (lookahead < text.length && /\s/u.test(text[lookahead]!)) lookahead++;
      push(text.slice(index, end), text[lookahead] === ":" ? "key" : "string");
      index = end;
      continue;
    }
    if (character === "-" || /\d/u.test(character)) {
      const match = NUMBER.exec(text.slice(index));
      if (match) { push(match[0], "number"); index += match[0].length; continue; }
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (end < text.length && /[\w$]/u.test(text[end]!)) end++;
      const word = text.slice(index, end);
      push(word, word === "true" || word === "false" ? "boolean" : word === "null" ? "null" : "plain");
      index = end;
      continue;
    }
    push(character, PUNCTUATION.includes(character) ? "punctuation" : "plain");
    index++;
  }
  return tokens;
}

/** Pretty JSON text when the value can be represented; otherwise the original string. */
export function structuredText(value: unknown): { text: string; json: boolean } {
  if (value === undefined) return { text: "", json: false };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const text = JSON.stringify(parsed, null, 2);
        if (text !== undefined) return { text, json: true };
      } catch { /* Ordinary text output. */ }
    }
    return { text: value, json: false };
  }
  try {
    const text = JSON.stringify(value, null, 2);
    if (text !== undefined) return { text, json: true };
  } catch { /* Circular or unserializable values fall back to text. */ }
  return { text: String(value), json: false };
}

/** Requires both provider timestamps; observed first/last-seen times are never advertised as a provider duration. */
export function subagentElapsedMs(item: Pick<NativeOutputItem, "startedAt" | "completedAt" | "timing">): number | undefined {
  if (!item.startedAt || !item.completedAt) return undefined;
  if (item.timing?.source === "observed") return undefined;
  const start = Date.parse(item.startedAt);
  const end = Date.parse(item.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

export function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 1) return "<1s";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
