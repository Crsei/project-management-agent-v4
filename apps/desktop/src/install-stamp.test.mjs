import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSelfOwnedInstall, readInstallStamp, validateInstallStamp } from "./install-stamp.mjs";

const sampleStamp = () => ({ formatVersion: 1, appId: "com.projectmanagementagent.v4", commit: "a".repeat(40), version: "4.0.0", platform: "win32", arch: "x64", distribution: "nsis", payload: "bundled", updateMechanism: "none", ownership: { installation: "self", scope: "per-user" }, source: { sha256: "b".repeat(64), dirty: true }, signing: "unsigned", runtime: { node: "24.21.0", postgres: "16.15" }, compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) } });
const context = { platform: "win32", arch: "x64", version: "4.0.0" };

test("runtime installation identity is validated, copied and deeply frozen", () => {
  const input = sampleStamp();
  const stamp = validateInstallStamp(input, context);
  input.ownership.installation = "os-managed";
  input.source.sha256 = "c".repeat(64);
  assert.equal(stamp.ownership.installation, "self");
  assert.equal(stamp.source.sha256, "b".repeat(64));
  for (const value of [stamp, stamp.ownership, stamp.source, stamp.runtime, stamp.compatibility]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { stamp.runtime.postgres = "17.0"; }, TypeError);
  assert.equal(assertSelfOwnedInstall(stamp), stamp);
});

test("unsupported or tampered identity refuses matching runtime and self-removal", () => {
  for (const change of [{ commit: "HEAD" }, { commit: ["a".repeat(40)] }, { source: { sha256: "b".repeat(64) } }, { runtime: { node: "24.21.0", postgres: "17.0" } }, { compatibility: { dataSchema: 1, postgresMajor: 16 } }, { compatibility: { ...sampleStamp().compatibility, migrationsSha256: "unknown" } }, { updateMechanism: "unsigned-feed" }, { platform: "darwin" }, { arch: "arm64" }, { version: "4.0.1" }, { ownership: { installation: "self", scope: "per-machine" } }, { extraAuthority: true }]) assert.throws(() => validateInstallStamp({ ...sampleStamp(), ...change }, context));
  const managed = validateInstallStamp({ ...sampleStamp(), distribution: "os-managed", ownership: { installation: "os-managed", scope: "per-user" } }, context);
  assert.throws(() => assertSelfOwnedInstall(managed), /Windows Settings.*package manager/);
  const mac = { ...sampleStamp(), platform: "darwin", arch: "arm64", distribution: "dmg", ownership: { installation: "os-managed", scope: "per-user" } };
  assert.throws(() => assertSelfOwnedInstall(validateInstallStamp(mac, { platform: "darwin", arch: "arm64", version: "4.0.0" })), /macOS.*package manager/);
  assert.throws(() => validateInstallStamp({ ...mac, ownership: { installation: "self", scope: "per-user" } }, { platform: "darwin", arch: "arm64" }), /Finder/);
});

test("packaged stamp reads do not rewrite bytes and reject missing, malformed or linked files", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-install-stamp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  await mkdir(resources);
  await assert.rejects(readInstallStamp(resources, context), { code: "ENOENT" });
  const path = join(resources, "desktop-install-stamp.json");
  await writeFile(path, "{bad json");
  await assert.rejects(readInstallStamp(resources, context), /Corrupt/);
  const bytes = `${JSON.stringify(sampleStamp())}\n`;
  await writeFile(path, bytes);
  const stamp = await readInstallStamp(resources, context);
  assert.equal(stamp.source.dirty, true);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(path, "utf8"), bytes);
  const alias = join(root, "alias");
  await symlink(resources, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readInstallStamp(alias, context), /redirected|link/);
});
