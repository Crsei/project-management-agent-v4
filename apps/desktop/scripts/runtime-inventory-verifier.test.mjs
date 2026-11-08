import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { nativeRuntimeManifest, verifyFinalRuntime } from "./runtime-inventory-verifier.mjs";
import { inventoryTree, runtimeSources } from "./runtime-manifest.mjs";

async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}
async function fixture(t, target = "win32-x64") {
  const resources = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-runtime-guard-")));
  t.after(() => rm(resources, { recursive: true, force: true }));
  const root = join(resources, "desktop-runtime");
  const suffix = target.startsWith("win32-") ? ".exe" : "";
  await put(root, suffix ? "node/node.exe" : "node/bin/node", "static fixture, never executed");
  for (const name of ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"]) await put(root, `postgres/bin/${name}${suffix}`, `static ${name} fixture`);
  await put(root, "node/node_modules/npm/npm.js", "// npm JavaScript resource\n");
  await put(root, "postgres/share/extension.sql", "-- required PostgreSQL resource\n");
  await put(root, "node/LICENSE", "original legal material\n");
  const manifest = { version: 1, target, sources: runtimeSources(target), files: await inventoryTree(root) };
  await put(root, "runtime-manifest.json", JSON.stringify(manifest));
  await put(resources, `workspace-runtime/${nativeRuntimeManifest}`, JSON.stringify({ schemaVersion: 1, files: [] }));
  return { resources, root, manifest };
}

test("final runtime verifies every resource and does not rewrite original inventories", async (t) => {
  const { resources, root, manifest } = await fixture(t);
  const before = await readFile(join(root, "runtime-manifest.json"));
  const report = await verifyFinalRuntime(resources, manifest.target);
  assert.equal(report.status, "passed");
  assert.equal(report.files, manifest.files.length);
  assert.deepEqual(report.signedResources, []);
  assert.deepEqual(await readFile(join(root, "runtime-manifest.json")), before);
});

for (const name of ["node/node_modules/npm/npm.js", "postgres/share/extension.sql", "node/LICENSE", "node/node.exe"]) {
  test(`final runtime rejects changed ${name} without a signature exemption`, async (t) => {
    const { resources, root, manifest } = await fixture(t);
    await put(root, name, "changed resource bytes\n");
    await assert.rejects(verifyFinalRuntime(resources, manifest.target));
  });
}

test("final runtime rejects both missing and unrecorded resource paths", async (t) => {
  const { resources, root, manifest } = await fixture(t);
  await put(root, "postgres/share/unrecorded.sql", "extra resource");
  await assert.rejects(verifyFinalRuntime(resources, manifest.target));
  await rm(join(root, "postgres/share/unrecorded.sql"));
  await rm(join(root, "postgres/share/extension.sql"));
  await assert.rejects(verifyFinalRuntime(resources, manifest.target));
});

test("signature allowlist cannot exempt JavaScript, arbitrary hashes or escaping paths", async (t) => {
  const { resources, root, manifest } = await fixture(t);
  const original = manifest.files.find((file) => file.path === "node/node_modules/npm/npm.js");
  const native = join(resources, "workspace-runtime", nativeRuntimeManifest);
  await writeFile(native, JSON.stringify({ schemaVersion: 1, files: [{ path: original.path, bytes: original.bytes, sha256: original.sha256 }] }));
  await assert.rejects(verifyFinalRuntime(resources, manifest.target));
  await writeFile(native, JSON.stringify({ schemaVersion: 1, files: [{ path: original.path, bytes: original.bytes, sha256: "0".repeat(64) }] }));
  await assert.rejects(verifyFinalRuntime(resources, manifest.target));
  await writeFile(native, JSON.stringify({ schemaVersion: 1, files: [{ path: "../outside", bytes: 0, sha256: "0".repeat(64) }] }));
  await assert.rejects(verifyFinalRuntime(resources, manifest.target));
  assert.equal(await readFile(join(root, original.path), "utf8"), "// npm JavaScript resource\n");
});

test("unsigned pre-sign inspection rejects modifications even to pre-identified Mach-O", async (t) => {
  const { resources, root, manifest } = await fixture(t, "darwin-arm64");
  const path = "node/bin/native-fixture";
  await put(root, path, Buffer.from("feedface01020304", "hex"));
  manifest.files = (await inventoryTree(root)).filter((file) => file.path !== "runtime-manifest.json");
  await put(root, "runtime-manifest.json", JSON.stringify(manifest));
  const native = manifest.files.find((file) => file.path === path);
  await put(resources, `workspace-runtime/${nativeRuntimeManifest}`, JSON.stringify({ schemaVersion: 1, files: [{ path, bytes: native.bytes, sha256: native.sha256 }] }));
  assert.equal((await verifyFinalRuntime(resources, manifest.target)).status, "passed");
  await put(root, path, Buffer.from("feedface05060708", "hex"));
  await assert.rejects(verifyFinalRuntime(resources, manifest.target));
});
