import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMigrationsSha256, createInstallStamp, writeInstallStamp } from "./install-stamp.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "desktop-stamp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrations = join(root, "packages/infrastructure/migrations"), agent = join(root, "apps/server/agent/dist");
  await mkdir(migrations, { recursive: true }); await mkdir(agent, { recursive: true });
  await writeFile(join(migrations, "0001.sql"), "CREATE TABLE state(id text);");
  await writeFile(join(agent, "index.mjs"), "export const dataSchema=1;\n");
  return { root, migrations, agent };
}
const input = { commit: "a".repeat(40), version: "1.2.3", platform: "win32", arch: "x64", distribution: "nsis", source: { sha256: "b".repeat(64), dirty: true }, signing: "unsigned" };
test("stamp persists exact dirty source identity and required rollback compatibility immutably", async t => {
  const f = await fixture(t);
  const migrationsSha256 = await computeMigrationsSha256(f.root);
  const stamp = await writeInstallStamp(join(f.root, "stamp.json"), { ...input, compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256 } });
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "stamp.json"), "utf8")), stamp);
  assert.equal(stamp.source.dirty, true);
  assert.equal(stamp.compatibility.migrationsSha256, migrationsSha256);
  assert.ok(Object.isFrozen(stamp)); assert.ok(Object.isFrozen(stamp.source)); assert.ok(Object.isFrozen(stamp.compatibility));
  await assert.rejects(writeInstallStamp(join(f.root, "stamp.json"), stamp), /EEXIST/);
});
test("migration/state-code modifications invalidate old-code rollback compatibility", async t => {
  const f = await fixture(t), first = await computeMigrationsSha256(f.root);
  await writeFile(join(f.migrations, "0002.sql"), "ALTER TABLE state ADD COLUMN version int;");
  const second = await computeMigrationsSha256(f.root); assert.notEqual(second, first);
  await writeFile(join(f.agent, "index.mjs"), "export const dataSchema=2;\n");
  assert.notEqual(await computeMigrationsSha256(f.root), second);
});
test("missing source or unknown compatibility never becomes a deletion-authorizing build stamp", () => {
  assert.throws(() => createInstallStamp(input), /identity|compatibility|ownership/);
  assert.throws(() => createInstallStamp({ ...input, compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "not-a-digest" } }), /compatibility|ownership/);
  assert.throws(() => createInstallStamp({ ...input, source: { dirty: false }, compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) } }), /source|ownership/);
});
test("empty migration/Agent fixtures cannot claim rollback coverage", async t => {
  const f = await fixture(t); await rm(join(f.migrations, "0001.sql"));
  await assert.rejects(computeMigrationsSha256(f.root), /nonempty PM migrations/);
});
