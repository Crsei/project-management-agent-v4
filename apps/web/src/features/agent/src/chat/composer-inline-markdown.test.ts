import assert from "node:assert/strict";
import test from "node:test";
import { parseInlineMarkdown, serializeInlineText, serializedPrefixLength, sourceOffsetToTextIndex } from "./composer-inline-markdown.ts";

test("inline markdown parses only supported marks and keeps other blocks literal", () => {
  assert.deepEqual(parseInlineMarkdown("**bold** and *italic* and ~~gone~~ and `code`"), [
    { text: "bold", marks: ["bold"] },
    { text: " and ", marks: [] },
    { text: "italic", marks: ["italic"] },
    { text: " and ", marks: [] },
    { text: "gone", marks: ["strike"] },
    { text: " and ", marks: [] },
    { text: "code", marks: ["code"] },
  ]);
  assert.deepEqual(parseInlineMarkdown("# heading"), [{ text: "# heading", marks: [] }]);
  assert.deepEqual(parseInlineMarkdown("- list"), [{ text: "- list", marks: [] }]);
  assert.deepEqual(parseInlineMarkdown("\\*literal\\*"), [{ text: "*literal*", marks: [] }]);
  assert.deepEqual(parseInlineMarkdown("**a *b***"), [
    { text: "a ", marks: ["bold"] },
    { text: "b", marks: ["bold", "italic"] },
  ]);
});

test("serialized marks round-trip without losing literal markers", () => {
  for (const [text, marks] of [
    ["plain * text", []], ["bold", ["bold"]], ["italic", ["italic"]], ["gone", ["strike"]], ["both", ["bold", "italic"]],
  ] as const) {
    const source = serializeInlineText(text, [...marks]);
    const parsed = parseInlineMarkdown(source);
    assert.deepEqual(parsed.map(segment => ({ text: segment.text, marks: [...segment.marks].sort() })), [{ text, marks: [...marks].sort() }], `${text} -> ${source}`);
  }
});

test("prefix lengths include opening and closing markers at the end", () => {
  assert.equal(serializedPrefixLength("bold", 0, ["bold"]), 0);
  assert.equal(serializedPrefixLength("bold", 2, ["bold"]), 4);
  assert.equal(serializedPrefixLength("bold", 4, ["bold"]), 8);
  assert.equal(serializedPrefixLength("a*b", 2, []), 2);
  assert.equal(sourceOffsetToTextIndex("bold", 6, ["bold"]), 4);
  assert.equal(sourceOffsetToTextIndex("bold", 2, ["bold"]), 0);
});
