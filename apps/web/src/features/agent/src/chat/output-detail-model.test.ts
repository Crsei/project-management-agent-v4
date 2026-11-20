import assert from "node:assert/strict";
import test from "node:test";
import type { ChangedFileSummary } from "./output-presenter.ts";
import {
  allDirectoryNodes,
  buildChangedFileTree,
  isDirectoryOpen,
  readDirectoryOverrides,
  sanitizeTerminalCommand,
  shellCommandLanguage,
  structuredText,
  subagentElapsedMs,
  tokenizeJson,
  visibleCommandText,
  writeDirectoryOverrides,
  type ChangedFileTreeDir,
  type ChangedFileTreeNode,
  type KeyValueStorage,
} from "./output-detail-model.ts";

function file(path: string, additions?: number, deletions?: number, partialCounts = false): ChangedFileSummary {
  return { path, records: [], additions, deletions, partialCounts };
}

function directory(node: ChangedFileTreeNode): ChangedFileTreeDir {
  assert.equal(node.kind, "dir");
  return node as ChangedFileTreeDir;
}

test("buildChangedFileTree groups nested paths with deterministic directories first", () => {
  const tree = buildChangedFileTree([
    file("src/chat/zeta.ts", 2, 1),
    file("src/chat/alpha.ts", 5, 0),
    file("README.md", 1, 1),
    file("src/index.ts"),
  ]);
  assert.equal(tree.length, 2);
  const [src, readme] = tree;
  assert.equal(src?.kind, "dir");
  if (src?.kind !== "dir" || readme?.kind !== "file") assert.fail("expected src directory and README file");
  assert.equal(src.name, "src");
  assert.equal(src.files, 3);
  assert.deepEqual(src.children.map(child => [child.kind, child.name]), [["dir", "chat"], ["file", "index.ts"]]);
  const chat = directory(src.children[0]!);
  assert.deepEqual(chat.children.map(child => child.name), ["alpha.ts", "zeta.ts"]);
  assert.equal(chat.depth, 2);
  assert.equal(readme.name, "README.md");
  assert.equal(src.additions, 7);
  assert.equal(src.deletions, 1);
  assert.equal(src.partialCounts, true, "a file without counts makes the directory total a minimum");
});

test("buildChangedFileTree keeps the original provider path and ignores duplicates", () => {
  const windows = file("apps\\web\\src\\a.ts", 3, 2);
  const tree = buildChangedFileTree([windows, windows]);
  const apps = directory(tree[0]!);
  const web = directory(apps.children[0]!);
  const src = directory(web.children[0]!);
  const leaf = src.children[0];
  assert.equal(src.children.length, 1);
  assert.equal(leaf?.kind, "file");
  if (leaf?.kind !== "file") assert.fail("expected file leaf");
  assert.equal(leaf.path, "apps\\web\\src\\a.ts");
  assert.equal(leaf.depth, 4);
});

test("directory defaults stay open to depth two and explicit overrides win", () => {
  const tree = buildChangedFileTree([file("a/b/c/d.ts")]);
  const a = directory(tree[0]!);
  const b = directory(a.children[0]!);
  const c = directory(b.children[0]!);
  const paths = allDirectoryNodes(tree).map(node => node.path);
  assert.deepEqual(paths, ["a", "a/b", "a/b/c"]);
  assert.equal(isDirectoryOpen(a, {}), true);
  assert.equal(isDirectoryOpen(b, {}), true);
  assert.equal(isDirectoryOpen(c, {}), false);
  assert.equal(isDirectoryOpen(c, { "a/b/c": true }), true);
  assert.equal(isDirectoryOpen(a, { a: false }), false);
});

test("directory overrides round-trip through session storage and reject malformed data", () => {
  const store = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
  };
  writeDirectoryOverrides(storage, "k", { "a/b": false, a: true });
  assert.deepEqual(readDirectoryOverrides(storage, "k"), { "a/b": false, a: true });
  store.set("k", "[\"not-an-object\"]");
  assert.deepEqual(readDirectoryOverrides(storage, "k"), {});
  store.set("k", "not json");
  assert.deepEqual(readDirectoryOverrides(storage, "k"), {});
  store.set("k", JSON.stringify({ a: "yes", b: true }));
  assert.deepEqual(readDirectoryOverrides(storage, "k"), { b: true });
  assert.deepEqual(readDirectoryOverrides(undefined, "k"), {});
});

test("visibleCommandText escapes control characters but keeps layout characters", () => {
  assert.equal(visibleCommandText("echo \u001b[31mred\u001b[0m"), "echo \\x1b[31mred\\x1b[0m");
  assert.equal(visibleCommandText("a\r\nb\rc\td"), "a\nb\nc\td");
  assert.equal(visibleCommandText("del\u007fbell\u0007"), "del\\x7fbell\\x07");
  assert.equal(visibleCommandText("plain command"), "plain command");
});

test("sanitizeTerminalCommand strips injection-capable characters and trailing newlines", () => {
  assert.equal(sanitizeTerminalCommand("  echo hi \u0003\n\n"), "  echo hi ");
  assert.equal(sanitizeTerminalCommand("printf '%s'\n"), "printf '%s'");
  assert.equal(sanitizeTerminalCommand("a\tb\u001b[D"), "a\tb[D");
  assert.equal(sanitizeTerminalCommand("\u0000\u0001"), "");
  assert.equal(sanitizeTerminalCommand("\r\n"), "");
  assert.equal(sanitizeTerminalCommand("line1\r\nline2"), "line1\nline2");
});

test("shellCommandLanguage recognizes common interpreters and rejects unknown text", () => {
  assert.equal(shellCommandLanguage("npm test"), undefined);
  assert.equal(shellCommandLanguage("bash script.sh"), "bash");
  assert.equal(shellCommandLanguage("/bin/zsh -lc 'echo hi'"), "bash");
  assert.equal(shellCommandLanguage("#!/usr/bin/env python3\nprint(1)"), "python");
  assert.equal(shellCommandLanguage("python3 -c 'print(1)'"), "python");
  assert.equal(shellCommandLanguage("node script.mjs"), "javascript");
  assert.equal(shellCommandLanguage('{"a": 1}'), "json");
  assert.equal(shellCommandLanguage("echo {not json}"), undefined);
});

test("tokenizeJson round-trips text and classifies keys, values and punctuation", () => {
  const text = JSON.stringify({ name: "value", count: 12, ok: true, missing: null, list: [1, -2.5e3] }, null, 2);
  const tokens = tokenizeJson(text);
  assert.equal(tokens.map(token => token.text).join(""), text);
  const kinds = new Set(tokens.map(token => token.kind));
  for (const kind of ["key", "string", "number", "boolean", "null", "punctuation"] as const) assert.ok(kinds.has(kind), `expected ${kind} token`);
  assert.ok(tokens.some(token => token.kind === "key" && token.text === "\"name\""));
  assert.ok(tokens.some(token => token.kind === "string" && token.text === "\"value\""));
});

test("tokenizeJson never throws on invalid input", () => {
  for (const text of ["[not json]", "{\"a\": }", "\"unterminated", "---", "", "\u0000\u001b"]) {
    const tokens = tokenizeJson(text);
    assert.equal(tokens.map(token => token.text).join(""), text);
  }
});

test("structuredText pretty prints JSON containers and preserves plain text", () => {
  assert.deepEqual(structuredText({ a: [1, true] }), { text: "{\n  \"a\": [\n    1,\n    true\n  ]\n}", json: true });
  assert.deepEqual(structuredText("{\"a\":1}"), { text: "{\n  \"a\": 1\n}", json: true });
  assert.deepEqual(structuredText("provider text"), { text: "provider text", json: false });
  assert.deepEqual(structuredText(undefined), { text: "", json: false });
});

test("subagentElapsedMs requires both provider timestamps", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const completed = "2026-01-01T00:00:12.000Z";
  assert.equal(subagentElapsedMs({ startedAt: start, completedAt: completed }), 12_000);
  assert.equal(subagentElapsedMs({ startedAt: start, completedAt: completed, timing: { source: "observed" } }), undefined);
  assert.equal(subagentElapsedMs({ startedAt: start }), undefined);
  assert.equal(subagentElapsedMs({ completedAt: completed }), undefined);
  assert.equal(subagentElapsedMs({ startedAt: "not-a-date", completedAt: completed }), undefined);
});
