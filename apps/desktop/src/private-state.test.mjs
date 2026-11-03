import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPrivatePath, ensurePrivateDirectory, readPrivateJson, securePrivateFile, writePrivateJson } from "./private-state.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-private-state-")));
  await ensurePrivateDirectory(root, { newlyCreated: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("desktop metadata is owner-private and supports atomic replacement without widening permissions", async t => {
  const root = await fixture(t);
  const filename = join(root, "metadata.json");
  await writePrivateJson(filename, { value: "first" }, { exclusive: true });
  await assertPrivatePath(filename);
  await assert.rejects(writePrivateJson(filename, { value: "not-written" }, { exclusive: true }), { code: "EEXIST" });
  assert.deepEqual(await readPrivateJson(filename), { value: "first" });
  await writePrivateJson(filename, { value: "second" });
  assert.deepEqual(await readPrivateJson(filename), { value: "second" });
  if (process.platform !== "win32") {
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  }
});

test("desktop metadata recovers a crash between its own atomic link and temporary unlink", async t => {
  const root = await fixture(t);
  const filename = join(root, "metadata.json");
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, '{"complete":true}\n', { flag: "wx", mode: 0o600 });
  await securePrivateFile(temporary, { newlyCreated: true });
  await link(temporary, filename);
  assert.equal((await lstat(filename)).nlink, 2);
  assert.deepEqual(await readPrivateJson(filename), { complete: true });
  assert.equal((await lstat(filename)).nlink, 1);
  await assert.rejects(lstat(temporary), { code: "ENOENT" });
});

test("desktop metadata rejects unknown hard links without deleting either name", async t => {
  const root = await fixture(t);
  const filename = join(root, "metadata.json");
  await writePrivateJson(filename, { private: true });
  const foreign = join(root, "unknown-link");
  await link(filename, foreign);
  await assert.rejects(readPrivateJson(filename), /unknown hard link/);
  assert.equal(await readFile(filename, "utf8"), await readFile(foreign, "utf8"));
});

test("desktop metadata rejects oversized or malformed state and does not replace it", async t => {
  const root = await fixture(t);
  const filename = join(root, "metadata.json");
  await writeFile(filename, "{".repeat(20_000), { mode: 0o600 });
  await securePrivateFile(filename, { newlyCreated: true });
  await assert.rejects(readPrivateJson(filename), /Unsafe desktop private metadata/);
  await writeFile(filename, "{broken", { mode: 0o600 });
  await assert.rejects(readPrivateJson(filename), /Corrupt desktop private metadata/);
  assert.equal(await readFile(filename, "utf8"), "{broken");
});

test("desktop metadata rejects symbolic-link state paths", { skip: process.platform === "win32" }, async t => {
  const root = await fixture(t);
  const source = join(root, "source.json");
  const filename = join(root, "metadata.json");
  await writePrivateJson(source, { private: true });
  await symlink(source, filename);
  await assert.rejects(readPrivateJson(filename), /Unsafe desktop private state path/);
  await assert.rejects(writePrivateJson(filename, { replaced: true }), /Unsafe desktop private state path/);
  assert.deepEqual(await readPrivateJson(source), { private: true });
});
