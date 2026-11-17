import assert from "node:assert/strict";
import test from "node:test";
import { markdownFileReference, markdownSessionLink, safeMarkdownUrl } from "./markdown-url.ts";
import {
  markdownMediaCandidate,
  markdownMediaKind,
  markdownMermaidError,
  markdownNodeText,
  markdownTableCsv,
  markdownTableData,
  markdownTableMarkdown,
  type MarkdownNode,
} from "./markdown-rich-policy.ts";

test("keeps http, https, mailto, fragments and same-origin paths", () => {
  for (const url of [
    "https://example.com/a?b=c#d",
    "http://example.com",
    "mailto:someone@example.com",
    "#section-2",
    "/agent/workspace",
  ]) {
    assert.equal(safeMarkdownUrl(url), url);
  }
});

test("trims surrounding whitespace before judging the URL", () => {
  assert.equal(safeMarkdownUrl("  https://example.com  "), "https://example.com");
  assert.equal(safeMarkdownUrl("   "), undefined);
});

test("rejects control characters, embedded whitespace and backslashes", () => {
  for (const url of [
    "java\u0000script:alert(1)",
    "java\nscript:alert(1)",
    "https://example.com/a b",
    "\\\\evil.example.com/share",
    "https://example.com/a\\b",
    "\u007fhttps://example.com",
  ]) {
    assert.equal(safeMarkdownUrl(url), undefined, url);
  }
});

test("rejects protocol-relative and non-http protocols", () => {
  for (const url of [
    "//evil.example.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(safeMarkdownUrl(url), undefined, url);
  }
});

test("rejects strings that cannot be parsed as URLs", () => {
  assert.equal(safeMarkdownUrl("not a url"), undefined);
  assert.equal(safeMarkdownUrl("example.com"), undefined);
});

test("resolves local links only inside the current session execution root", () => {
  const root = "/workspace/project";
  for (const url of ["src/app.ts", "./src/app.ts", "/workspace/project/src/app.ts", "file:///workspace/project/src/app.ts"]) {
    assert.deepEqual(markdownFileReference(url, root), { path: "src/app.ts" });
  }
  assert.deepEqual(markdownFileReference("./src/../README.md#L12-L15", root), { path: "README.md", line: 12 });
  assert.deepEqual(markdownFileReference("src/app.ts:42:3", root), { path: "src/app.ts", line: 42 });
  assert.deepEqual(markdownFileReference("README.md:7", root), { path: "README.md", line: 7 });
  assert.deepEqual(markdownFileReference("docs/with%20spaces.md", root), { path: "docs/with spaces.md" });
  assert.deepEqual(markdownFileReference("/file.png", "/"), { path: "file.png" });
});

test("inspector references use the source document directory without escaping the session root", () => {
  const root = "/workspace/project";
  assert.deepEqual(markdownFileReference("./next.md#L9", root, "docs/guide.md"), { path: "docs/next.md", line: 9 });
  assert.deepEqual(markdownFileReference("./chart.png", root, "docs/guide.md"), { path: "docs/chart.png" });
  assert.deepEqual(markdownFileReference("../README.md", root, "docs/guide.md"), { path: "README.md" });
  assert.deepEqual(markdownFileReference("%2e%2e/next.md", root, "docs/nested/guide.md"), { path: "docs/next.md" });
  assert.deepEqual(markdownFileReference("./next.md", root, "guide.md"), { path: "next.md" });
  assert.deepEqual(markdownFileReference("/workspace/project/images/chart.png", root, "docs/guide.md"), { path: "images/chart.png" });
  assert.deepEqual(markdownFileReference("file:///workspace/project/README.md", root, "docs/guide.md"), { path: "README.md" });
  assert.equal(markdownFileReference("../../outside.md", root, "docs/guide.md"), undefined);
  assert.equal(markdownFileReference("%2e%2e/%2e%2e/outside.md", root, "docs/guide.md"), undefined);
  assert.equal(markdownFileReference("/workspace/other/chart.png", root, "docs/guide.md"), undefined);
  // An omitted document base retains the chat-message root-relative contract.
  assert.deepEqual(markdownFileReference("./next.md", root), { path: "next.md" });
  assert.equal(markdownFileReference("../README.md", root), undefined);
});

test("invalid document bases cannot silently resolve a different root-level file", () => {
  for (const documentPath of ["", "../guide.md", "docs/../../guide.md", "/workspace/project/docs/guide.md", "https://other/guide.md", "docs\\guide.md", "docs/guide.md#section", "docs/\u0000guide.md"]) {
    assert.equal(markdownFileReference("./next.md", "/workspace/project", documentPath), undefined, documentPath);
  }
});

test("off-root, ambiguous and external file references never become inspector actions", () => {
  for (const url of [
    "../secret.txt", "./a/../../secret.txt", "%2e%2e/secret.txt",
    "/workspace/project-other/a.png", "/etc/passwd", "file:///etc/passwd",
    "file://other/workspace/project/a.png", "//other/image.png", "/%2fother/image.png",
    "https://other/image.png", "data:image/png;base64,abcd", "javascript:alert(1)",
    "https%3A%2F%2Fother/image.png", "file%3A///etc/passwd",
    "src/%00file", "src/%5csecret", "src/a?threadId=other", "src/a%3fthreadId=other",
    "#L10", "src/a#L0", "src/a#L9007199254740992", "bad%zz",
  ]) {
    assert.equal(markdownFileReference(url, "/workspace/project"), undefined, url);
  }
  assert.equal(markdownFileReference("src/a.ts", ""), undefined);
});

test("table copies retain complete cell data and quote real CSV delimiters", () => {
  const table: MarkdownNode = {
    type: "element", tagName: "table", children: [
      { type: "element", tagName: "thead", children: [{ type: "element", tagName: "tr", children: [
        { type: "element", tagName: "th", children: [{ type: "text", value: "Name" }] },
        { type: "element", tagName: "th", children: [{ type: "text", value: "Value" }] },
      ] }] },
      { type: "element", tagName: "tbody", children: [{ type: "element", tagName: "tr", children: [
        { type: "element", tagName: "td", children: [{ type: "element", tagName: "strong", children: [{ type: "text", value: 'A, \"B\"' }] }] },
        { type: "element", tagName: "td", children: [{ type: "text", value: "one|two" }, { type: "element", tagName: "br" }, { type: "text", value: "three\\four" }] },
      ] }] },
    ],
  };
  const data = markdownTableData(table);
  assert.deepEqual(data, { headers: ["Name", "Value"], rows: [['A, "B"', "one|two\nthree\\four"]] });
  assert.equal(markdownTableCsv(data), 'Name,Value\r\n"A, ""B""","one|two\nthree\\four"');
  assert.equal(markdownTableMarkdown(data), '| Name | Value |\n| --- | --- |\n| A, "B" | one\\|two<br>three\\\\four |');
  assert.deepEqual(markdownTableData({ type: "element", tagName: "table" }), { headers: [], rows: [] });
});

test("CSV copy neutralizes spreadsheet formulas including hidden prefix characters", () => {
  const data = {
    headers: ["=header"],
    rows: [
      ["=1+1"], ["+2"], ["-3"], ["@SUM(A1)"], [" \t=1"],
      ["\r\n=1"], ["\u0000\u0085\u200b=1"], ["\ufeff\u00a0+1"],
      ['=HYPERLINK("https://example.test","label")'],
    ],
  };
  assert.equal(markdownTableCsv(data), [
    "'=header", "'=1+1", "'+2", "'-3", "'@SUM(A1)", "' \t=1",
    "\"'\r\n=1\"", "'\u0000\u0085\u200b=1", "'\ufeff\u00a0+1",
    "\"'=HYPERLINK(\"\"https://example.test\"\",\"\"label\"\")\"",
  ].join("\r\n"));
  assert.equal(markdownTableCsv({ headers: ["plain"], rows: [["text =1"], ["123"], ["'already text"]] }), "plain\r\ntext =1\r\n123\r\n'already text");
});

test("math annotations copy once rather than duplicating visual and accessible glyphs", () => {
  const math: MarkdownNode = { type: "element", tagName: "span", children: [
    { type: "element", tagName: "math", children: [{ type: "element", tagName: "semantics", children: [
      { type: "element", tagName: "mi", children: [{ type: "text", value: "x" }] },
      { type: "element", tagName: "annotation", children: [{ type: "text", value: "x^2" }] },
    ] }] },
    { type: "element", tagName: "span", properties: { className: ["katex-html"] }, children: [{ type: "text", value: "x2" }] },
  ] };
  assert.equal(markdownNodeText(math), "x^2");
});

test("Mermaid accepts actual graphs but rejects host/network/interactive features before rendering", () => {
  assert.equal(markdownMermaidError("flowchart TD\n  A[Start] --> B{Ready?}\n  B --> C[Finish]"), undefined);
  assert.equal(markdownMermaidError("sequenceDiagram\n  Alice->>Bob: Hello"), undefined);
  assert.equal(markdownMermaidError('flowchart TD\n  A["click here to continue"] --> B["choose a style"]'), undefined);
  for (const source of [
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA-->B',
    "---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\nA-->B",
    'flowchart TD\nclick A "javascript:alert(1)"', 'flowchart TD\nA["<img src=x>"]',
    'flowchart TD\nA@{ img: "https://example.test/pixel.png" }',
    'flowchart TD\nA["![tracking](https://example.test/pixel.png)"]',
    "flowchart TD\nstyle A fill:url(https://example.test/a)",
    "flowchart TD\nA[escaped\\label]", "x".repeat(50_001),
  ]) assert.ok(markdownMermaidError(source), source.slice(0, 100));
});

test("media filenames only offer actions and authorized MIME still controls rendering", () => {
  assert.equal(markdownMediaCandidate("images/a.PNG"), true);
  assert.equal(markdownMediaCandidate("recording.webm"), true);
  for (const path of ["page.html", "active.svg", "script.js", "photo.png?url=evil"]) assert.equal(markdownMediaCandidate(path), false);
  assert.equal(markdownMediaKind("image/png; charset=binary"), "image");
  assert.equal(markdownMediaKind("audio/ogg"), "audio");
  assert.equal(markdownMediaKind("video/mp4"), "video");
  for (const type of ["image/svg+xml", "text/html", "application/octet-stream", "application/pdf", "image/jpeg<script>"]) assert.equal(markdownMediaKind(type), undefined);
});

test("session links stay same-origin and require an explicit workspace thread id", () => {
  const origin = "http://127.0.0.1:3224";
  assert.equal(markdownSessionLink("/agent/workspace?thread=abc", origin), "abc");
  assert.equal(markdownSessionLink("http://127.0.0.1:3224/agent/workspace?thread=abc&x=1", origin), "abc");
  assert.equal(markdownSessionLink("https://example.com/agent/workspace?thread=abc", origin), undefined);
  assert.equal(markdownSessionLink("/agent/runs?thread=abc", origin), undefined);
  assert.equal(markdownSessionLink("/agent/workspace?thread=", origin), undefined);
  assert.equal(markdownSessionLink("/agent/workspace", origin), undefined);
  assert.equal(markdownSessionLink("javascript:alert(1)", origin), undefined);
});
