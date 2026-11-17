import assert from "node:assert/strict";
import test from "node:test";
import { splitDetailsBlocks, stripTags } from "./markdown-details.ts";

test("details blocks are split without interpreting other HTML", () => {
  const segments = splitDetailsBlocks('Before\n<details open><summary>More <b>info</b></summary>\nBody **markdown**\n</details>\nAfter');
  assert.equal(segments.length, 3);
  assert.equal(segments[0]!.kind, "markdown");
  assert.equal(segments[1]!.kind, "details");
  if (segments[1]!.kind === "details") {
    assert.equal(segments[1]!.summary, "More info");
    assert.match(segments[1]!.body, /Body \*\*markdown\*\*/);
  }
  assert.equal(segments[2]!.kind, "markdown");
  assert.match(segments[2]!.kind === "markdown" ? segments[2]!.content : "", /After/);
});

test("unclosed or summary-less details stay in the markdown fallback", () => {
  assert.deepEqual(splitDetailsBlocks("<details>no end"), [{ kind: "markdown", content: "<details>no end" }]);
  assert.deepEqual(splitDetailsBlocks("<details><p>no summary</p></details>"), [{ kind: "markdown", content: "<details><p>no summary</p></details>" }]);
  assert.deepEqual(splitDetailsBlocks("plain"), [{ kind: "markdown", content: "plain" }]);
});

test("summary stripping removes tags and leaves escaped text only", () => {
  assert.equal(stripTags('a <img src=x onerror=alert(1)> b'), "a  b");
  assert.equal(stripTags("<script>alert(1)</script>ok"), "alert(1)ok");
});
