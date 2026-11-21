import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileSelection, inspectorContentDigest, patchSelection, terminalSelectionSnapshot } from "./context-selection.ts";

const patch = [
  "diff --git a/example.ts b/example.ts",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -10,3 +10,4 @@",
  " unchanged",
  "-old value",
  "+new value",
  "+another new value",
  " tail",
  "@@ -30 +31 @@",
  "-old last",
  "+new last",
  "\\ No newline at end of file",
].join("\n");

test("native diff side coordinates select exact patch rows rather than same-numbered patch lines", () => {
  assert.deepEqual(patchSelection(patch, { start: 11, side: "deletions", end: 11 }), { startLine: 6, endLine: 6 });
  assert.deepEqual(patchSelection(patch, { start: 11, side: "additions", end: 12 }), { startLine: 7, endLine: 8 });
  const acrossSides = patchSelection(patch, { start: 11, side: "deletions", end: 12, endSide: "additions" });
  assert.deepEqual(acrossSides, { startLine: 6, endLine: 8 });
  assert.equal(patch.split("\n").slice(acrossSides!.startLine - 1, acrossSides!.endLine).join("\n"), "-old value\n+new value\n+another new value");
});

test("reverse and multi-hunk selection preserve raw source coordinates and reject absent rows", () => {
  assert.deepEqual(patchSelection(patch, { start: 31, side: "additions", end: 11, endSide: "deletions" }), { startLine: 6, endLine: 12 });
  assert.deepEqual(patchSelection(patch, { start: 30, side: "deletions", end: 31, endSide: "additions" }), { startLine: 11, endLine: 12 });
  assert.equal(patchSelection(patch, { start: 20, end: 21 }), null);
  assert.equal(patchSelection(patch, { start: 0, end: 1 }), null);
});

test("added-only and deleted-only hunks do not fabricate a line on the absent side", () => {
  const added = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n";
  assert.deepEqual(patchSelection(added, { start: 1, end: 2, side: "additions" }), { startLine: 4, endLine: 5 });
  assert.equal(patchSelection(added, { start: 1, end: 2, side: "deletions" }), null);
  const deleted = "--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n";
  assert.deepEqual(patchSelection(deleted, { start: 1, end: 2, side: "deletions" }), { startLine: 4, endLine: 5 });
  assert.equal(patchSelection(deleted, { start: 1, end: 2, side: "additions" }), null);
});

test("file ranges are inclusive and cannot attach an unavailable trailing preview line", () => {
  assert.deepEqual(fileSelection("one\ntwo\n", { start: 2, end: 1 }), { startLine: 1, endLine: 2 });
  assert.equal(fileSelection("one\ntwo\n", { start: 3, end: 3 }), null);
  assert.equal(fileSelection("", { start: 1, end: 1 }), null);
  assert.equal(fileSelection("one", { start: 1.5, end: 1.5 }), null);
});

test("terminal snapshots preserve exact text and reread moving buffer positions", () => {
  let text = "  selected output\r\nnext row  ";
  let start = { x: 0, y: 20 };
  let end = { x: 0, y: 22 };
  const terminal = { getSelection: () => text, getSelectionPosition: () => ({ start, end }) };
  const initial = terminalSelectionSnapshot(terminal);
  assert.deepEqual(initial, { text, selection: { startLine: 21, endLine: 22 } });
  start = { x: 0, y: 18 }; end = { x: 3, y: 19 };
  assert.deepEqual(terminalSelectionSnapshot(terminal), { text, selection: { startLine: 19, endLine: 20 } });
  text = "changed selection";
  assert.notEqual(terminalSelectionSnapshot(terminal)?.text, initial?.text);
  assert.equal(initial?.text, "  selected output\r\nnext row  ");
  text = "\r\n  ";
  assert.equal(terminalSelectionSnapshot(terminal), null);
  assert.equal(terminalSelectionSnapshot({ getSelection: () => "selected", getSelectionPosition: () => undefined }), null);
});

test("Ghostty selections use absolute scrollback rows, not viewport rows", () => {
  const terminal = {
    getSelection: () => "x\ny",
    getSelectionPosition: () => ({ start: { x: 0, y: 1 }, end: { x: 2, y: 2 } }),
    getSelectionBufferPosition: () => ({ start: { x: 0, y: 10 }, end: { x: 2, y: 11 } }),
  };
  assert.deepEqual(terminalSelectionSnapshot(terminal), { text: "x\ny", selection: { startLine: 11, endLine: 12 } });
  assert.equal(terminalSelectionSnapshot({ getSelection: () => "x", getSelectionPosition: () => null }), null);
});

test("content freshness digests bind exact UTF-8 bytes including newline and Unicode", async () => {
  const contents = "选择的内容\r\nline\n";
  assert.equal(await inspectorContentDigest(contents), createHash("sha256").update(contents, "utf8").digest("hex"));
  assert.notEqual(await inspectorContentDigest(contents), await inspectorContentDigest(contents.replaceAll("\r\n", "\n")));
  assert.notEqual(await inspectorContentDigest(contents), await inspectorContentDigest(`${contents}changed`));
});
