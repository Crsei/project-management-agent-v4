import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inside, inventoryTree, requireNativeTarget,
  runtimeSources, targetName, verifyRuntime,
} from "./runtime-manifest.mjs";

async function temporary(exercise) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-package-boundary-")));
  try { await exercise(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}


test("installer targets reject Linux, Windows arm64 and cross-native packaging", () => {
  assert.throws(() => requireNativeTarget("win32", "arm64", true), /Windows x64/);
  assert.throws(() => requireNativeTarget("linux", "x64", true), /runtime\/smoke-only/);
  const other = process.platform === "win32" ? "darwin" : "win32";
  assert.throws(() => requireNativeTarget(other, "x64", true), /matching native/);
  assert.equal(requireNativeTarget(), targetName());
});

test("runtime inventory records shipped files and detects changed executable bytes", async () => {
  await temporary(async (root) => {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "runtime"), "first executable bytes", { mode: 0o755 });
    const first = await inventoryTree(root);
    assert.equal(first.length, 1);
    assert.equal(first[0].path, "bin/runtime");
    await writeFile(join(root, "bin", "runtime"), "changed executable bytes");
    assert.notEqual((await inventoryTree(root))[0].sha256, first[0].sha256);
    assert.equal(inside(root, join(root, "bin")), true);
    assert.equal(inside(root, join(root, "..", "foreign")), false);
  });
});

test("runtime verification rejects a different source pin before executing anything", async () => {
  await temporary(async (root) => {
    const sources = runtimeSources(targetName());
    sources.node.sha256 = "0".repeat(64);
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ version: 1, target: targetName(), sources, files: [] }));
    await assert.rejects(verifyRuntime(root), /does not match the pinned/);
  });
});

test("runtime verification rejects missing required tool closure", async () => {
  await temporary(async (root) => {
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ version: 1, target: targetName(), sources: runtimeSources(targetName()), files: [] }));
    await assert.rejects(verifyRuntime(root), { code: "ENOENT" });
  });
});

test("runtime inventory rejects absolute executable links", { skip: process.platform === "win32" ? "Creating test symlinks requires optional Windows developer privileges" : false }, async () => {
  await temporary(async (root) => {
    await writeFile(join(root, "executable"), "bytes");
    await symlink(join(root, "executable"), join(root, "absolute-link"));
    await assert.rejects(inventoryTree(root), /escaping or absolute symlink/);
  });
});
