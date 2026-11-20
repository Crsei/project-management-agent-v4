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
  Node.create({ name: "horizontalRule", group: "block" }),
  Node.create({ name: "taskList", group: "block", content: "taskItem+" }),
  Node.create({ name: "taskItem", content: "paragraph block*", addAttributes: () => ({ checked: { default: false }, space: { default: "" } }) }),
  Mark.create({ name: "bold" }), Mark.create({ name: "italic" }), Mark.create({ name: "strike" }), Mark.create({ name: "code" }),
  Mark.create({ name: "link", addAttributes: () => ({ href: { default: null }, title: { default: null } }) }),
]);

const taskSchema = listSchema;

test("task lists round-trip checked, unchecked and empty items", () => {
  for (const source of ["- [ ] one\n- [x] two", "- [x]", "- [ ] ", "- [X] upper", "- [ ] **bold** task"]) {
    const doc = taskSchema.nodeFromJSON(parseComposerDocument(source));
    assert.equal(serializeComposerDocument(doc), source === "- [X] upper" ? "- [x] upper" : source, source);
    assert.equal(serializeComposerDocument(taskSchema.nodeFromJSON(parseComposerDocument(serializeComposerDocument(doc)))), source === "- [X] upper" ? "- [x] upper" : source);
  }
  const mixed = taskSchema.nodeFromJSON(parseComposerDocument("- [ ] task\n- bullet"));
  assert.equal(serializeComposerDocument(mixed), "- [ ] task\n- bullet");
});

test("a checked task item keeps its checkbox state through edits", () => {
  const doc = taskSchema.nodeFromJSON(parseComposerDocument("- [ ] ship it"));
  const list = doc.firstChild!;
  const item = list.firstChild!;
  const toggled = taskSchema.topNodeType.create(null, list.type.create({ ...list.attrs },
    taskSchema.nodes.taskItem!.create({ ...item.attrs, checked: true }, item.content)));
  assert.equal(serializeComposerDocument(toggled), "- [x] ship it");
  assert.equal(taskSchema.nodeFromJSON(parseComposerDocument(serializeComposerDocument(toggled))).firstChild!.firstChild!.attrs.checked, true);
});

test("nested task items round-trip and map source carets", () => {
  const source = "- [ ] parent\n  - [x] child\n- [ ] next";
  const doc = taskSchema.nodeFromJSON(parseComposerDocument(source));
  assert.equal(serializeComposerDocument(doc), source);
  for (const offset of [6, 7, 8, 12, 21, 23, 26, 33, 35, 36]) {
    assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset, `offset ${offset}`);
  }
});

test("absolute Markdown links round-trip while relative destinations stay literal", () => {
  for (const source of [
    "[docs](https://example.com/a?b=1)",
    "read [the docs](http://example.com) first",
    "[mail](mailto:ops@example.com)",
    '[title](https://example.com "Reference")',
    "[brackets \\[inner\\]](https://example.com/x)",
    "before [link](https://example.com) after **bold**",
  ]) {
    const doc = taskSchema.nodeFromJSON(parseComposerDocument(source));
    assert.equal(serializeComposerDocument(doc), source, source);
  }
  let links = 0;
  taskSchema.nodeFromJSON(parseComposerDocument("[docs](https://example.com)")).descendants(node => { if (node.marks.some(mark => mark.type.name === "link")) links++; });
  assert.equal(links, 1);
});

test("link carets map inside the label without counting the destination", () => {
  const source = "open [docs](https://example.com/a) now";
  const doc = taskSchema.nodeFromJSON(parseComposerDocument(source));
  const labelStart = source.indexOf("[");
  // `labelStart` itself is the same caret as the text start minus one bracket; links map to the label.
  // Inside the destination the caret has no document counterpart, so only the label is mapped.
  for (const offset of [0, 4, labelStart + 1, labelStart + 2, labelStart + 3, labelStart + 4, labelStart + 5, source.length]) {
    assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset, `offset ${offset}`);
  }
});

test("relative links and file mentions are never parsed as URL links", () => {
  const relative = taskSchema.nodeFromJSON(parseComposerDocument("[readme](docs/readme.md)"));
  let links = 0;
  relative.descendants(node => { if (node.marks.some(mark => mark.type.name === "link")) links++; });
  assert.equal(links, 0);
  assert.equal(serializeComposerDocument(relative), "[readme](docs/readme.md)");
});

test("right-to-left drafts keep their exact text through serialization", () => {
  for (const source of [
    "اكتب الدالة",
    "مرحبا **بالعالم** 👩🏽‍💻",
    "- [ ] أكمل الاختبار\n- [x] راجع الكود",
    "> اقتباس\n\nثم نص",
    "[الوثائق](https://example.com/docs)",
  ]) {
    const doc = taskSchema.nodeFromJSON(parseComposerDocument(source));
    assert.equal(serializeComposerDocument(doc), source, source);
    assert.equal(serializeComposerDocument(taskSchema.nodeFromJSON(parseComposerDocument(serializeComposerDocument(doc)))), source);
  }
});

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

test("nested lists round-trip and map source carets", () => {
  const source = "- one\n  - child\n- two";
  const doc = listSchema.nodeFromJSON(parseComposerDocument(source));
  assert.equal(serializeComposerDocument(doc), source);
  for (const offset of [2, 3, 4, 10, 11, 12, 13, 14, 17, 18, 19, 20]) {
    assert.equal(composerSourceCursor(doc, composerDocumentCursor(doc, offset)), offset, `offset ${offset}`);
  }
  assert.equal(serializeComposerDocument(listSchema.nodeFromJSON(parseComposerDocument("1. one\n   1. child\n2. two"))), "1. one\n  1. child\n2. two");
});

test("horizontal rules round-trip and keep source positions", () => {
  for (const source of ["---", "***", "before\n---\nafter"]) {
    const doc = listSchema.nodeFromJSON(parseComposerDocument(source));
    assert.equal(serializeComposerDocument(doc), source === "***" ? "---" : source);
  }
  assert.equal(serializeComposerDocument(listSchema.nodeFromJSON(parseComposerDocument("# Head\nbody"))), "# Head\nbody");
});
