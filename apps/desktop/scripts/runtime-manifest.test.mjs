import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  inside, inventoryTree, nodeToolingPaths, prepareNodeDistribution, requireNativeTarget, RUNTIME_MANIFEST_VERSION,
  runtimeSources, targetName, validateRuntimeManifest, verifyRuntime,
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
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ version: RUNTIME_MANIFEST_VERSION, target: targetName(), sources, files: [] }));
    await assert.rejects(verifyRuntime(root), /does not match the pinned/);
  });
});

test("runtime verification rejects missing required tool closure", async () => {
  await temporary(async (root) => {
    await mkdir(join(root, "node", "bin"), { recursive: true });
    await writeFile(join(root, "node", process.platform === "win32" ? "node.exe" : "bin/node"), "fixture");
    await writeFile(join(root, "node", "LICENSE"), "complete Node license fixture");
    const nodeDistribution = await prepareNodeDistribution(root, targetName());
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ version: RUNTIME_MANIFEST_VERSION, target: targetName(),
      sources: runtimeSources(targetName()), nodeDistribution, files: await inventoryTree(root) }));
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

for (const target of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) {
  test(`${target} preparation removes only declared tooling and retains original legal bytes`, async () => {
    await temporary(async (root) => {
      const put = async (path, content) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      };
      const modulePath = target.startsWith("win32-") ? "node_modules" : "lib/node_modules";
      const executable = target.startsWith("win32-") ? "node.exe" : "bin/node";
      await put(`node/${executable}`, "original Node executable");
      await put("node/LICENSE", "complete Node and third-party licenses\n");
      await put("node/include/node/node.h", "original shared development resource\n");
      await put("node/share/man/man1/node.1", "original Node manual\n");
      await put("postgres/share/extension.sql", "complete PostgreSQL unchanged\n");
      for (const path of nodeToolingPaths(target)) {
        if (path.endsWith("/npm") && path.includes("node_modules") || path.endsWith("/corepack") && path.includes("node_modules")) {
          await put(`node/${path}/package.json`, JSON.stringify({ name: path.endsWith("/npm") ? "npm" : "corepack", version: "1.0.0" }));
          await put(`node/${path}/dist/cli.js`, "package-manager code\n");
          await put(`node/${path}/LICENSE`, `original legal material: ${path}\n`);
        } else await put(`node/${path}`, "launcher or install helper\n");
      }
      await put(`node/${modulePath}/npm/node_modules/dependency/LICENSE-MIT.txt`, "nested dependency legal bytes\n");
      await put(`node/${modulePath}/npm/node_modules/dependency/NOTICE`, "nested notice bytes\n");
      const before = await inventoryTree(root);
      const nodeDistribution = await prepareNodeDistribution(root, target);
      const files = await inventoryTree(root);
      const manifest = { version: RUNTIME_MANIFEST_VERSION, target, sources: runtimeSources(target), nodeDistribution, files };
      validateRuntimeManifest(manifest, target);
      assert.equal(nodeDistribution.sourceArchiveSha256, runtimeSources(target).node.sha256);
      assert.deepEqual(nodeDistribution.sourceFiles, before.filter((file) => file.path.startsWith("node/")).map((file) => ({ ...file, path: file.path.slice(5) })));
      for (const path of nodeToolingPaths(target)) await assert.rejects(lstat(join(root, "node", path)), { code: "ENOENT" });
      for (const file of before.filter((entry) => !entry.path.includes("node_modules") && !nodeToolingPaths(target).includes(entry.path.slice(5))))
        assert.deepEqual(files.find((entry) => entry.path === file.path), file);
      assert.equal(await readFile(join(root, `node-tooling-notices/${modulePath}/npm/node_modules/dependency/LICENSE-MIT.txt`), "utf8"), "nested dependency legal bytes\n");
      assert.equal(await readFile(join(root, `node-tooling-notices/${modulePath}/npm/node_modules/dependency/NOTICE`), "utf8"), "nested notice bytes\n");
      assert.equal(files.some((file) => file.path.endsWith("package.json") || file.path.endsWith("cli.js")), false);
      await put("runtime-manifest.json", JSON.stringify({ ...manifest, version: 1 }));
      await assert.rejects(verifyRuntime(root, target), /version\/target\/profile/);
      const retained = files.find((file) => file.path === "node/include/node/node.h");
      for (const altered of [
        files.filter((file) => file !== retained),
        files.map((file) => file === retained ? { ...file, sha256: "0".repeat(64) } : file),
        [...files, { ...retained, path: "node/unapproved-resource" }],
      ]) assert.throws(() => validateRuntimeManifest({ ...manifest, files: altered }, target), /exact declared official-archive transformation/);
    });
  });
}

test("execution-only preparation rejects an undeclared package tree instead of laundering its removal", async () => {
  await temporary(async (root) => {
    const node = join(root, "node");
    await mkdir(join(node, "node_modules/unknown-tool"), { recursive: true });
    await writeFile(join(node, "node.exe"), "original");
    await writeFile(join(node, "LICENSE"), "original license");
    await writeFile(join(node, "node_modules/unknown-tool/package.json"), "{}");
    await assert.rejects(prepareNodeDistribution(root, "win32-x64"), /Unexpected package-manager contents/);
    assert.equal(await readFile(join(node, "node_modules/unknown-tool/package.json"), "utf8"), "{}");
  });
});

test("Unix package-manager symlinks are omitted while retained Node links remain exact", {
  skip: process.platform === "win32" ? "Symlink creation requires optional Windows developer privileges" : false,
}, async () => {
  await temporary(async (root) => {
    await mkdir(join(root, "node/bin"), { recursive: true });
    await mkdir(join(root, "node/lib/node_modules/npm/bin"), { recursive: true });
    await writeFile(join(root, "node/bin/node"), "original executable");
    await writeFile(join(root, "node/LICENSE"), "original license");
    await writeFile(join(root, "node/lib/node_modules/npm/bin/npm-cli.js"), "original npm code");
    await writeFile(join(root, "node/lib/node_modules/npm/LICENSE"), "original npm license");
    await symlink("../lib/node_modules/npm/bin/npm-cli.js", join(root, "node/bin/npm"));
    await symlink("node", join(root, "node/bin/node-alias"));
    const nodeDistribution = await prepareNodeDistribution(root, "linux-x64");
    assert.equal(nodeDistribution.sourceFiles.find((file) => file.path === "bin/npm").link, "../lib/node_modules/npm/bin/npm-cli.js");
    const files = await inventoryTree(root);
    assert.equal(files.find((file) => file.path === "node/bin/node-alias").link, "node");
    validateRuntimeManifest({ version: RUNTIME_MANIFEST_VERSION, target: "linux-x64", sources: runtimeSources("linux-x64"), nodeDistribution, files }, "linux-x64");
    await assert.rejects(lstat(join(root, "node/bin/npm")), { code: "ENOENT" });
  });
});

test("legal relocation cannot retain executable code or package metadata", async () => {
  await temporary(async (root) => {
    await mkdir(join(root, "node/node_modules/npm/licenses"), { recursive: true });
    await writeFile(join(root, "node/node.exe"), "original");
    await writeFile(join(root, "node/LICENSE"), "original license");
    await writeFile(join(root, "node/node_modules/npm/licenses/package.json"), "{}");
    await writeFile(join(root, "node/node_modules/npm/licenses/LICENSE.txt"), "original tooling license");
    await mkdir(join(root, "node/node_modules/npm/bin"));
    await writeFile(join(root, "node/node_modules/npm/bin/license.js"), "process.exit(1)");
    const distribution = await prepareNodeDistribution(root, "win32-x64");
    assert.ok(distribution.sourceFiles.some((file) => file.path === "node_modules/npm/bin/license.js"));
    assert.equal(await readFile(join(root, "node-tooling-notices/node_modules/npm/licenses/LICENSE.txt"), "utf8"), "original tooling license");
    for (const path of ["node/node_modules", "node-tooling-notices/node_modules/npm/bin/license.js", "node-tooling-notices/node_modules/npm/licenses/package.json"])
      await assert.rejects(lstat(join(root, path)), { code: "ENOENT" });
  });
});
