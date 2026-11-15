import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatFilePath } from "./chat-actions-policy.ts";

test("inspector actions retain only current execution-root file paths", () => {
  for (const input of ["src/app.ts", "./src/app.ts", "/workspace/project/src/app.ts"]) assert.equal(normalizeChatFilePath(input, "/workspace/project"), "src/app.ts");
  assert.equal(normalizeChatFilePath("./docs/a file.md", "/workspace/project/"), "docs/a file.md");
  assert.equal(normalizeChatFilePath("/README.md", "/"), "README.md");
});

test("inspector actions reject URL, traversal, sibling roots and ambiguous paths", () => {
  for (const input of ["", ".", "..", "../secret", "src/../secret", "/workspace/project-other/secret", "/etc/passwd", "//host/path", "file:///workspace/project/src/a.ts", "https://host/a", "C:\\workspace\\a.ts", "src/\u0000a", "src/\u007fa"]) assert.equal(normalizeChatFilePath(input, "/workspace/project"), null, input);
  assert.equal(normalizeChatFilePath("a.ts", ""), null);
  assert.equal(normalizeChatFilePath("a.ts", "relative/root"), null);
});
