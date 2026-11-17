import assert from "node:assert/strict";
import test from "node:test";
import { getSchema, Mark, Node } from "@tiptap/react";
import { serializeComposerFileLink } from "@agent-workspace/client-runtime";
import {
  composerDocumentCursor, composerPasteSlice, composerSourceCursor, parseComposerDocument,
  readComposerCitation, readComposerContexts, serializeComposerDocument, type ComposerContextPayload,
} from "./rich-composer-document.ts";

const schema = getSchema([
  Node.create({ name: "doc", topNode: true, content: "block+" }),
  Node.create({ name: "text", group: "inline" }),
  Node.create({ name: "paragraph", group: "block", content: "inline*", addAttributes: () => ({ citationOnly: { default: false } }) }),
  Node.create({ name: "codeBlock", group: "block", content: "text*", code: true, addAttributes: () => ({
    language: { default: "" }, fence: { default: "```" }, originalOpening: { default: null },
    originalLanguage: { default: null }, closing: { default: "```" }, hasBodyLine: { default: true },
  }) }),
  Node.create({ name: "composerReference", group: "inline", inline: true, atom: true, addAttributes: () => ({
    kind: { default: "file" }, value: { default: "" }, source: { default: "" },
  }) }),
  Node.create({ name: "composerCitation", group: "inline", inline: true, atom: true, addAttributes: () => ({ quote: { default: null } }) }),
  Node.create({ name: "composerContext", group: "inline", inline: true, atom: true, addAttributes: () => ({ payload: { default: null } }) }),
]);

test("restored drafts preserve source spacing, blank lines, code fences and Unicode", () => {
  for (const source of ["", "  draft  \n\n末尾\n", "```ts\nconst value = 1;\n```", "```\n```", "```\n\n```", "~~~python  \nprint('hi')\n~~~~", "```partial", "代码 中文 👩🏽‍💻\nsecond line"]) {
    const doc = schema.nodeFromJSON(parseComposerDocument(source));
    assert.equal(serializeComposerDocument(doc), source);
  }
});

test("file and skill atoms keep exact wire text and source caret positions", () => {
  const file = serializeComposerFileLink("src/a file (v2).ts");
  const source = `Read ${file} and $review then explain`;
  const doc = schema.nodeFromJSON(parseComposerDocument(source));
  assert.equal(serializeComposerDocument(doc), source);
  const kinds: string[] = [];
  doc.descendants((node) => { if (node.type.name === "composerReference") kinds.push(node.attrs.kind); });
  assert.deepEqual(kinds, ["file", "skill"]);
  for (const offset of [0, 4, 5, 5 + file.length, source.indexOf("$review"), source.indexOf("$review") + 7, source.length])
    assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset);
});

test("currency and code contents never become skill or file atoms", () => {
  const doc = schema.nodeFromJSON(parseComposerDocument("Budget $10k and $5\n```sh\necho $HOME @thing\n```"));
  let references = 0;
  doc.descendants((node) => { if (node.type.name === "composerReference") references++; });
  assert.equal(references, 0);
});

test("selected-text citation remains structured metadata, not duplicated prompt text", () => {
  for (const source of ["ask", "```ts\nconst x = 1\n```", ""]) {
    const doc = schema.nodeFromJSON(parseComposerDocument(source, { text: "selected text", messageId: "message-1" }));
    assert.equal(serializeComposerDocument(doc), source);
  }
});

test("language edits change only the opening fence language", () => {
  const doc = schema.nodeFromJSON(parseComposerDocument("~~~ts  \nconst x = 1\n~~~~"));
  const block = doc.firstChild!;
  const changed = schema.topNodeType.create(null, block.type.create({ ...block.attrs, language: "javascript" }, block.content));
  assert.equal(serializeComposerDocument(changed), "~~~javascript\nconst x = 1\n~~~~");
});

test("pasted fence lines cannot prematurely close a code block", () => {
  const body = "before\n```\nafter";
  const doc = schema.topNodeType.create(null, schema.nodes.codeBlock!.create({ language: "md" }, schema.text(body)));
  const source = serializeComposerDocument(doc);
  assert.equal(source, "````md\nbefore\n```\nafter\n````");
  assert.equal(serializeComposerDocument(schema.nodeFromJSON(parseComposerDocument(source))), source);
});

test("removing a citation-only node does not insert a leading blank line", () => {
  const doc = schema.nodeFromJSON(parseComposerDocument("```ts\nvalue\n```", { text: "citation", messageId: "message-1" }));
  const withoutCitation = schema.topNodeType.create(null, [
    schema.nodes.paragraph!.create({ citationOnly: true }), doc.child(1),
  ]);
  assert.equal(serializeComposerDocument(withoutCitation), "```ts\nvalue\n```");
});

test("multiline paste merges open paragraph boundaries with surrounding text", () => {
  const doc = schema.nodeFromJSON(parseComposerDocument("leftright"));
  const result = doc.replace(5, 5, composerPasteSlice(schema, "a\nb"));
  assert.equal(serializeComposerDocument(result), "lefta\nbright");
  const trailingLine = doc.replace(5, 5, composerPasteSlice(schema, "a\n"));
  assert.equal(serializeComposerDocument(trailingLine), "lefta\nright");
});

test("single-line VS Code clipboard metadata does not create block boundaries", () => {
  const doc = schema.nodeFromJSON(parseComposerDocument("leftright"));
  const result = doc.replace(5, 5, composerPasteSlice(schema, "value", "typescript"));
  assert.equal(serializeComposerDocument(result), "leftvalueright");
});

test("citation deletion and history restoration preserve complete send metadata", () => {
  const quote = { text: "same text", messageId: "source-message" };
  const before = schema.nodeFromJSON(parseComposerDocument("draft", quote));
  const removed = before.replace(1, 2, before.slice(1, 1));
  assert.equal(readComposerCitation(removed), undefined);
  const restored = removed.replace(1, 1, before.slice(1, 2));
  assert.deepEqual(readComposerCitation(restored), quote);
  assert.equal(serializeComposerDocument(restored), "draft");
  const otherSource = schema.nodeFromJSON(parseComposerDocument("draft", { ...quote, messageId: "other-source" }));
  assert.equal(readComposerCitation(otherSource)?.messageId, "other-source");
});

test("native context, PM revision and image payload atoms survive deletion/undo without becoming user text", () => {
  const contexts: ComposerContextPayload[] = [
    { type: "native", item: { input: { contextId: "selected-half-line", kind: "response", source: { type: "response", threadId: "source-thread", messageId: "source-message", generationId: "source-generation", contentDigest: "a".repeat(64) }, selectedText: "half a line 👩🏽‍💻", comment: "Keep this exact selection" } } },
    { type: "pm", reference: { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "PRJ-001", kind: "issue", id: "TASK-001", title: "Actual task metadata", revision: "immutable-revision", availability: "unverified" } },
    { type: "attachment", attachment: { id: "real-capture-image", type: "image", name: "capture.png", contentType: "image/png", status: { type: "complete" }, content: [{ type: "image", image: "data:image/png;base64,AAAA" }] } },
  ];
  for (const source of ["/native-command original text", "```ts\nconst value = 1;\n```", ""]) {
    const before = schema.nodeFromJSON(parseComposerDocument(source, undefined, contexts));
    assert.equal(serializeComposerDocument(before), source);
    assert.deepEqual(readComposerContexts(before), contexts);
    const removed = before.replace(1, 2, before.slice(1, 1));
    assert.equal(readComposerContexts(removed).length, 2);
    const restored = removed.replace(1, 1, before.slice(1, 2));
    assert.deepEqual(readComposerContexts(restored), contexts);
    assert.equal(serializeComposerDocument(restored), source);
  }
});

const markSchema = getSchema([
  Node.create({ name: "doc", topNode: true, content: "block+" }),
  Node.create({ name: "text", group: "inline" }),
  Node.create({ name: "paragraph", group: "block", content: "inline*", addAttributes: () => ({ citationOnly: { default: false } }) }),
  Node.create({ name: "codeBlock", group: "block", content: "text*", code: true, addAttributes: () => ({
    language: { default: "" }, fence: { default: "```" }, originalOpening: { default: null },
    originalLanguage: { default: null }, closing: { default: "```" }, hasBodyLine: { default: true },
  }) }),
  Node.create({ name: "composerReference", group: "inline", inline: true, atom: true, addAttributes: () => ({
    kind: { default: "file" }, value: { default: "" }, source: { default: "" },
  }) }),
  Mark.create({ name: "bold" }), Mark.create({ name: "italic" }), Mark.create({ name: "strike" }), Mark.create({ name: "code" }),
]);

test("composer marks serialize to escaped Markdown and map source carets", () => {
  const source = "**bold** and *italic* and ~~gone~~ and `code`";
  const doc = markSchema.nodeFromJSON(parseComposerDocument(source));
  assert.equal(serializeComposerDocument(doc), source);
  for (const offset of [0, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 21, 22]) {
    assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset, `offset ${offset}`);
  }
  const literal = markSchema.nodeFromJSON(parseComposerDocument("\\*not italic\\*"));
  assert.equal(serializeComposerDocument(literal), "*not italic*");
  assert.equal(serializeComposerDocument(markSchema.nodeFromJSON(parseComposerDocument(serializeComposerDocument(literal)))), "*not italic*");
});

const listSchema = getSchema([
  Node.create({ name: "doc", topNode: true, content: "block+" }),
  Node.create({ name: "text", group: "inline" }),
  Node.create({ name: "paragraph", group: "block", content: "inline*", addAttributes: () => ({ citationOnly: { default: false } }) }),
  Node.create({ name: "bulletList", group: "block", content: "listItem+" }),
  Node.create({ name: "orderedList", group: "block", content: "listItem+", addAttributes: () => ({ start: { default: 1 } }) }),
  Node.create({ name: "listItem", content: "paragraph block*" }),
  Node.create({ name: "blockquote", group: "block", content: "paragraph+" }),
  Node.create({ name: "heading", group: "block", content: "inline*", addAttributes: () => ({ level: { default: 1 } }) }),
  Mark.create({ name: "bold" }), Mark.create({ name: "italic" }), Mark.create({ name: "strike" }), Mark.create({ name: "code" }),
]);

test("flat bullet and ordered lists round-trip without changing literal lines", () => {
  for (const source of ["- one\n- two", "1. one\n2. two", "3. three\n4. four", "- **bold** item", "- one\n1. two", "  - indented stays literal"]) {
    const doc = listSchema.nodeFromJSON(parseComposerDocument(source));
    assert.equal(serializeComposerDocument(doc), source, source);
    if (source === "- one\n- two") {
      for (const offset of [2, 3, 4, 5, 7, 8, 9, 10]) {
        assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset, `offset ${offset}`);
      }
    }
  }
});

test("flat blockquotes round-trip and map source carets", () => {
  const source = "> one\n> two";
  const doc = listSchema.nodeFromJSON(parseComposerDocument(source));
  assert.equal(serializeComposerDocument(doc), source);
  for (const offset of [2, 3, 4, 5, 8, 9, 10, 11]) {
    assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset, `offset ${offset}`);
  }
});

test("flat headings round-trip and map source carets", () => {
  for (const source of ["# Title", "### Sub", "###### Deep"]) {
    const doc = listSchema.nodeFromJSON(parseComposerDocument(source));
    assert.equal(serializeComposerDocument(doc), source);
    const prefix = source.indexOf(" ") + 1;
    for (const offset of [prefix, prefix + 1, source.length]) {
      assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset, `${source} offset ${offset}`);
    }
  }
});
