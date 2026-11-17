import assert from "node:assert/strict";
import test from "node:test";
import { fenceTitleFromMeta, remarkFenceTitle } from "./remark-fence-title.ts";

test("only an explicit fence title is extracted", () => {
  assert.equal(fenceTitleFromMeta(undefined), undefined);
  assert.equal(fenceTitleFromMeta('title="src/foo.ts"'), "src/foo.ts");
  assert.equal(fenceTitleFromMeta("title='foo.ts'"), "foo.ts");
  assert.equal(fenceTitleFromMeta('linenos title=README.md other=1'), "README.md");
  assert.equal(fenceTitleFromMeta("other=1"), undefined);
  assert.equal(fenceTitleFromMeta('title="' + "x".repeat(300) + '"')?.length, 200);
});

test("the plugin attaches only the title property", () => {
  type TestNode = { type: string; meta?: string; data?: { hProperties?: Record<string, unknown> }; children?: TestNode[] };
  const tree: TestNode = { type: "root", children: [{ type: "code", meta: 'title="a.ts"' }, { type: "code", meta: "other=1" }] };
  remarkFenceTitle()(tree);
  assert.equal(tree.children![0]!.data?.hProperties?.["data-fence-title"], "a.ts");
  assert.equal(tree.children![1]!.data, undefined);
});
