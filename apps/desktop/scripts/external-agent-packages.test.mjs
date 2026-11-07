import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enforceExternalAgentBoundary } from "../../server/agent/scripts/external-agent-packages.mjs";

const platforms = ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];
async function packageAt(root, relative, name, files = {}) {
  const directory = path.join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.3.276" }));
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), bytes);
  }
  return directory;
}

for (const layout of ["artifact", "pnpm-deploy"]) {
  test(`${layout} excludes only Claude CLI packages and keeps SDK/native resources`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-external-agent-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sdk = await packageAt(root, ".packages/sdk", "@anthropic-ai/claude-agent-sdk", {
      "sdk.mjs": "export const communication = true;\n", "manifest.json": "{}", "manifest.zst.json": "{}",
    });
    const cursor = await packageAt(root, ".packages/cursor", "@cursor/sdk-linux-x64", {
      "bin/rg": "native search", "bin/cursorsandbox": "native sandbox", "vendor/tree-sitter/binding.node": "native parser",
    });
    const pty = await packageAt(root, ".packages/pty", "@lydell/node-pty-linux-x64", { "pty.node": "native pty" });
    const unrelated = await packageAt(root, ".packages/unrelated", "unrelated-user-tool", { "claude.exe": "not an SDK platform package" });
    const nativeRoots = [];
    for (const platform of platforms) {
      const name = `@anthropic-ai/claude-agent-sdk-${platform}`;
      const relative = layout === "artifact" ? `.packages/${platform}` : `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-${platform}@0.3.276/node_modules/${name}`;
      const native = await packageAt(root, relative, name, { [platform.startsWith("win32") ? "claude.exe" : "claude"]: "external CLI" });
      nativeRoots.push(native);
      const alias = path.join(root, "node_modules", name);
      await mkdir(path.dirname(alias), { recursive: true });
      await symlink(path.relative(path.dirname(alias), native), alias, process.platform === "win32" ? "junction" : "dir");
      const nestedAlias = path.join(sdk, "node_modules", name);
      await mkdir(path.dirname(nestedAlias), { recursive: true });
      await symlink(path.relative(path.dirname(nestedAlias), native), nestedAlias, process.platform === "win32" ? "junction" : "dir");
    }
    await assert.rejects(enforceExternalAgentBoundary(root), /External Agent CLI packages must not be distributed/);
    const removed = await enforceExternalAgentBoundary(root, { prune: true });
    assert.equal(removed.length, platforms.length);
    for (const native of nativeRoots) await assert.rejects(lstat(native), { code: "ENOENT" });
    for (const platform of platforms) {
      await assert.rejects(lstat(path.join(root, "node_modules", `@anthropic-ai/claude-agent-sdk-${platform}`)), { code: "ENOENT" });
      await assert.rejects(lstat(path.join(sdk, "node_modules", `@anthropic-ai/claude-agent-sdk-${platform}`)), { code: "ENOENT" });
    }
    assert.equal(await readFile(path.join(sdk, "sdk.mjs"), "utf8"), "export const communication = true;\n");
    assert.equal(await readFile(path.join(sdk, "manifest.zst.json"), "utf8"), "{}");
    assert.equal(await readFile(path.join(cursor, "bin/rg"), "utf8"), "native search");
    assert.equal(await readFile(path.join(cursor, "bin/cursorsandbox"), "utf8"), "native sandbox");
    assert.equal(await readFile(path.join(cursor, "vendor/tree-sitter/binding.node"), "utf8"), "native parser");
    assert.equal(await readFile(path.join(pty, "pty.node"), "utf8"), "native pty");
    assert.equal(await readFile(path.join(unrelated, "claude.exe"), "utf8"), "not an SDK platform package");
    assert.deepEqual(await enforceExternalAgentBoundary(root), []);
    assert.deepEqual(await enforceExternalAgentBoundary(root, { prune: true }), []);
  });
}

test("deployment pruning refuses outside links without touching their target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-external-agent-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pm-external-agent-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const native = await packageAt(outside, "native", "@anthropic-ai/claude-agent-sdk-win32-x64", { "claude.exe": "untouched" });
  await symlink(native, path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(enforceExternalAgentBoundary(root, { prune: true }), /escapes/);
  assert.equal(await readFile(path.join(native, "claude.exe"), "utf8"), "untouched");
});

for (const layout of ["package-alias", "node-modules-link"]) {
  test(`${layout} classifies internal nonstandard stores without treating resource folders as packages`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-external-agent-alias-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = layout === "package-alias" ? "store" : "deps";
    const native = await packageAt(root, `${store}/native`, "@anthropic-ai/claude-agent-sdk-win32-x64", { "claude.exe": "external CLI" });
    const sdk = await packageAt(root, `${store}/sdk`, "@anthropic-ai/claude-agent-sdk", { "manifest.json": "retained SDK resource" });
    const resource = await packageAt(root, "resources/example", "@anthropic-ai/claude-agent-sdk-win32-x64", { "claude.exe": "not an installed package" });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    if (layout === "package-alias") {
      const modules = path.join(root, "node_modules");
      await mkdir(path.join(modules, "@custom"), { recursive: true });
      for (const alias of [path.join(modules, "alias"), path.join(modules, "@custom/second-alias")]) {
        await symlink(path.relative(path.dirname(alias), native), alias, linkType);
      }
      await symlink(path.relative(modules, sdk), path.join(modules, "sdk"), linkType);
    } else {
      await symlink(store, path.join(root, "node_modules"), linkType);
    }
    await assert.rejects(enforceExternalAgentBoundary(root), /External Agent CLI packages must not be distributed/);
    const removed = await enforceExternalAgentBoundary(root, { prune: true });
    assert.deepEqual(removed, [{ name: "@anthropic-ai/claude-agent-sdk-win32-x64", path: `${store}/native` }]);
    await assert.rejects(lstat(native), { code: "ENOENT" });
    assert.equal(await readFile(path.join(sdk, "manifest.json"), "utf8"), "retained SDK resource");
    assert.equal(await readFile(path.join(resource, "claude.exe"), "utf8"), "not an installed package");
    if (layout === "package-alias") {
      await assert.rejects(lstat(path.join(root, "node_modules/alias")), { code: "ENOENT" });
      await assert.rejects(lstat(path.join(root, "node_modules/@custom/second-alias")), { code: "ENOENT" });
      assert.equal(await readFile(path.join(root, "node_modules/sdk/manifest.json"), "utf8"), "retained SDK resource");
    } else {
      assert.ok((await lstat(path.join(root, "node_modules"))).isSymbolicLink());
      assert.equal(await readFile(path.join(root, "node_modules/sdk/manifest.json"), "utf8"), "retained SDK resource");
    }
    assert.deepEqual(await enforceExternalAgentBoundary(root), []);
    assert.deepEqual(await enforceExternalAgentBoundary(root, { prune: true }), []);
  });
}
