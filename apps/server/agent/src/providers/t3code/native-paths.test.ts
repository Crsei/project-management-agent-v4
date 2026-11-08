import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { confirmsProviderNativeHome } from "./native-paths.ts";

test("native Home aliases require the same existing directory, not spelling heuristics or cached proof", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-home-identity-"));
  try {
    const home = path.join(root, "Home");
    const other = path.join(root, "OtherHome");
    const alias = path.join(root, "native-alias");
    await mkdir(home);
    await mkdir(other);
    await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await confirmsProviderNativeHome(home, alias), true);
    assert.equal(await confirmsProviderNativeHome(other, home), false);
    assert.equal(await confirmsProviderNativeHome(path.join(root, "missing"), home), false);
    assert.equal(await confirmsProviderNativeHome("relative-home", home), false);
    const file = path.join(root, "not-a-home");
    await writeFile(file, "metadata-only test");
    assert.equal(await confirmsProviderNativeHome(file, home), false);
    await rm(alias);
    await symlink(other, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await confirmsProviderNativeHome(home, alias), false, "retargeted aliases cannot reuse earlier proof");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("POSIX native Homes differing only in case remain distinct", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-home-case-"));
  try {
    const home = path.join(root, "Home");
    const other = path.join(root, "home");
    await mkdir(home);
    try { await mkdir(other); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      t.skip("The temporary filesystem is case-insensitive.");
      return;
    }
    assert.equal(await confirmsProviderNativeHome(other, home), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

if (process.platform === "win32") test("Windows native Home namespace, separators and on-disk casing keep the same directory identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-home-windows-"));
  try {
    const home = path.join(root, "NativeHome");
    const other = path.join(root, "DifferentHome");
    await mkdir(home);
    await mkdir(other);
    for (const reported of [path.toNamespacedPath(home), home.replaceAll("\\", "/"), home.toUpperCase()]) {
      assert.equal(await confirmsProviderNativeHome(reported, home), true, reported);
      assert.equal(await confirmsProviderNativeHome(reported, other), false, reported);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
