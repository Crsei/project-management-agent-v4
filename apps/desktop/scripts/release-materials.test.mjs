import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { asarTools, inspectPackagedApplication } from "./packaged-application.mjs";
import { captureSource, checksumDelivery, collectLegal, contentDigest, fileRecord, publicSourcePath, refreshVerification, requireUnchangedSource } from "./release-materials.mjs";
import { verifyDelivery, verifyDeliveryFiles } from "./verify-delivery.mjs";
import { inspectDeployment } from "./stage-workspace.mjs";
import { inventoryTree, runtimeSources, verifyRuntime } from "./runtime-manifest.mjs";
import { archiveMemberPath, inspectFinalArtifacts, verifyInstalledApplication } from "./final-artifact.mjs";
import { dependencyLayoutManifest } from "./dependency-layout-verifier.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-release-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, name, value) {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), value);
}
async function snapshot(root, extra = {}) {
  const entries = {
    "README.md": "public fixture source\n",
    "apps/desktop/package.json": JSON.stringify({ name: "@agent-workspace/desktop", version: "0.1.0" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    ...extra,
  };
  const files = [];
  for (const name of Object.keys(entries).sort()) {
    await put(root, name, entries[name]);
    files.push({ path: name, bytes: Buffer.byteLength(entries[name]), mode: 0o644, sha256: hash(entries[name]) });
  }
  const source = { schemaVersion: 1, commit: "a".repeat(40), dirty: true, files, sha256: contentDigest(files) };
  await put(root, "desktop-source.json", JSON.stringify(source));
  return source;
}

test("source selection excludes private, credential, generated and internal-history paths", () => {
  for (const path of [".env", "apps/server/.env.agent", "apps/web/.envrc", "apps/desktop/credentials.json", "apps/desktop/token", "apps/desktop/signing.pfx", "apps/desktop/.cache/archive", "apps/desktop/.runtime/runtime", "apps/desktop/releases/installer.exe", "apps/web/node_modules/a/index.js", "vendor/x/target/binary", "docs/implementation/internal.md", ".git/config", ".local/evidence/report", "Home/credentials", "../README.md", "apps/../README.md", "apps\\server\\code.ts"]) {
    assert.equal(publicSourcePath(path), false, path);
  }
  for (const path of ["LICENSE", "pnpm-lock.yaml", ".github/workflows/desktop.yml", "apps/desktop/scripts/package.mjs", "vendor/t3code/source-manifest.json", "docs/guides/desktop.md"]) assert.equal(publicSourcePath(path), true, path);
});

test("gitless reviewed snapshot preserves exact identity and never copies private siblings", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  const source = await snapshot(input);
  await put(input, ".env", "PRIVATE_SENTINEL_NOT_A_REAL_CREDENTIAL");
  await put(input, ".local/token", "PRIVATE_SENTINEL_NOT_A_REAL_CREDENTIAL");
  const output = join(root, "captured");
  assert.deepEqual(await captureSource(output, input), source);
  assert.deepEqual((await readdir(output)).sort(), ["README.md", "apps", "desktop-source.json", "pnpm-lock.yaml"]);
  await assert.rejects(lstat(join(output, ".env")), { code: "ENOENT" });
  await requireUnchangedSource(source, input);
  await put(input, "README.md", "different source bytes\n");
  await assert.rejects(requireUnchangedSource(source, input), /Source changed/);
  await assert.rejects(captureSource(join(root, "changed"), input), /Snapshot source bytes differ/);
});

test("gitless snapshot refuses unrecorded public code instead of attributing it to HEAD", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input);
  await put(input, "apps/desktop/unrecorded.mjs", "export const changed = true;\n");
  await assert.rejects(captureSource(join(root, "captured"), input), /unrecorded public source/);
});

async function fixtureGit(root, args) {
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, ".local/no-global-config"), HOME: join(root, ".local/home"), XDG_CONFIG_HOME: join(root, ".local/home") });
  return execute("git", ["-c", "user.name=Source fixture", "-c", "user.email=source-fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, ".local/empty-hooks")}`, ...args], { cwd: root, env: environment, windowsHide: true });
}

test("dirty Git source refuses a tracked directory redirected into private checkout data", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  const publicBytes = "export const publicValue = true;\n";
  await snapshot(input, { "apps/example/config.ts": publicBytes });
  await put(input, ".gitignore", ".local/\n");
  await fixtureGit(input, ["init"]);
  await fixtureGit(input, ["add", "--", "README.md", ".gitignore", "apps", "pnpm-lock.yaml"]);
  await fixtureGit(input, ["commit", "-m", "Synthetic source fixture"]);
  const source = await captureSource(join(root, "before"), input);
  const privateBytes = "PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL";
  await put(input, ".local/private/config.ts", privateBytes);
  await rename(join(input, "apps/example"), join(input, ".local/original-example"));
  await symlink(join(input, ".local/private"), join(input, "apps/example"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await lstat(join(input, "apps/example"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(input, "apps/example/config.ts"), "utf8"), privateBytes);
  const output = join(root, "rejected");
  await assert.rejects(captureSource(output, input));
  await assert.rejects(lstat(join(output, "apps/example/config.ts")), { code: "ENOENT" });
  await assert.rejects(lstat(join(output, "desktop-source.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(input, ".local/private/config.ts"), "utf8"), privateBytes);
  // Equal content is not permission to follow a replaced source directory.
  await put(input, ".local/private/config.ts", publicBytes);
  await assert.rejects(requireUnchangedSource(source, input));
});

test("gitless source refuses an internal ancestor junction before copying its leaf", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input, { "apps/example/config.ts": "public source bytes" });
  await put(input, ".local/private/config.ts", "PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL");
  await rename(join(input, "apps/example"), join(input, ".local/original-example"));
  await symlink(join(input, ".local/private"), join(input, "apps/example"), process.platform === "win32" ? "junction" : "dir");
  const output = join(root, "rejected");
  await assert.rejects(captureSource(output, input), /link|junction|directory/i);
  await assert.rejects(lstat(join(output, "apps/example/config.ts")), { code: "ENOENT" });
});

test("source ancestor replacement during an opened-file copy rejects and removes the partial copy", {
  skip: process.platform === "win32" ? "POSIX rename-after-open fixture; Windows rejects renaming this open source directory. Separate junction/reparse cases still run." : false,
}, async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input);
  const privateBytes = "PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL";
  await put(input, ".local/private-desktop/package.json", privateBytes);
  const output = join(root, "rejected");
  const original = fs.createWriteStream;
  let replaced = false;
  const mocked = t.mock.method(fs, "createWriteStream", (filename, options) => {
    if (filename === join(output, "apps/desktop/package.json")) {
      fs.renameSync(join(input, "apps/desktop"), join(input, ".local/original-desktop"));
      fs.symlinkSync(join(input, ".local/private-desktop"), join(input, "apps/desktop"), process.platform === "win32" ? "junction" : "dir");
      replaced = true;
    }
    return original(filename, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(captureSource(output, input));
    assert.equal(replaced, true);
    assert.equal((await lstat(join(input, "apps/desktop"))).isSymbolicLink(), true);
    await assert.rejects(lstat(join(output, "apps/desktop/package.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(output, "desktop-source.json")), { code: "ENOENT" });
    assert.equal(await readFile(join(input, ".local/private-desktop/package.json"), "utf8"), privateBytes);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const gitBacked of [false, true]) {
  test(`${gitBacked ? "Git" : "gitless"} source accepts stable file-dependency hardlinks but still rejects changed content`, async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    const sourcePath = "vendor/t3code/third-party/mdast-util-math/index.d.ts";
    const approvedBytes = "export interface ApprovedPublicFileDependency {}\n";
    await snapshot(input, { [sourcePath]: approvedBytes });
    if (gitBacked) {
      await fixtureGit(input, ["init"]);
      await fixtureGit(input, ["add", "--", "README.md", "apps", "vendor", "pnpm-lock.yaml"]);
      await fixtureGit(input, ["commit", "-m", "Synthetic public file dependency"]);
    }
    const before = await captureSource(join(root, "before-install"), input);
    const installedAlias = join(input, "node_modules/file-dependency/index.d.ts");
    await mkdir(dirname(installedAlias), { recursive: true });
    await link(join(input, sourcePath), installedAlias);
    assert.equal((await lstat(join(input, sourcePath))).nlink, 2);
    await requireUnchangedSource(before, input);
    const afterRoot = join(root, "after-install");
    const after = await captureSource(afterRoot, input);
    assert.deepEqual(after.files, before.files);
    assert.equal(after.sha256, before.sha256);
    if (gitBacked) assert.equal(after.dirty, false);
    const copy = await lstat(join(afterRoot, sourcePath));
    const original = await lstat(join(input, sourcePath));
    assert.equal(copy.nlink, 1);
    assert.notEqual(`${copy.dev}:${copy.ino}`, `${original.dev}:${original.ino}`);
    await writeFile(installedAlias, "changed through the dependency's hardlinked inode\n");
    await assert.rejects(requireUnchangedSource(before, input), /Source changed/);
    assert.equal(await readFile(join(afterRoot, sourcePath), "utf8"), approvedBytes);
  });
}

test("source dirty identity compares actual bytes with HEAD even under assume-unchanged", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input);
  await fixtureGit(input, ["init"]);
  await fixtureGit(input, ["add", "--", "README.md", "apps", "pnpm-lock.yaml"]);
  await fixtureGit(input, ["commit", "-m", "Synthetic source fixture"]);
  assert.equal((await captureSource(join(root, "clean"), input)).dirty, false);
  await fixtureGit(input, ["update-index", "--assume-unchanged", "--", "README.md"]);
  await put(input, "README.md", "changed raw source bytes hidden from git status\n");
  assert.equal((await fixtureGit(input, ["status", "--porcelain", "--", "README.md"])).stdout, "");
  const changed = await captureSource(join(root, "changed"), input);
  assert.equal(changed.dirty, true);
  assert.equal(changed.files.find((file) => file.path === "README.md").sha256, hash("changed raw source bytes hidden from git status\n"));
});

for (const gitBacked of [false, true]) {
  test(`${gitBacked ? "Git" : "gitless"} source recheck rejects approved-path additions and removals`, async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    await snapshot(input);
    if (gitBacked) {
      await fixtureGit(input, ["init"]);
      await fixtureGit(input, ["add", "--", "README.md", "apps", "pnpm-lock.yaml"]);
      await fixtureGit(input, ["commit", "-m", "Synthetic source fixture"]);
    }
    const source = await captureSource(join(root, "before"), input);
    const addition = "apps/desktop/scripts/release-materials.test.mjs";
    await put(input, addition, "new approved public source path\n");
    await assert.rejects(requireUnchangedSource(source, input), /Source selection changed/);
    if (gitBacked) {
      const withAddition = await captureSource(join(root, "with-addition"), input);
      await rm(join(input, addition));
      await assert.rejects(requireUnchangedSource(withAddition, input), /Source selection changed/);
    } else {
      await rm(join(input, addition));
      await rm(join(input, "README.md"));
      await assert.rejects(requireUnchangedSource(source, input), /Source selection changed/);
    }
  });
}

async function archive(root, files) {
  const application = join(root, "application");
  const resources = join(root, "resources");
  await put(application, "package.json", JSON.stringify({ name: "pm-agent-v4-desktop", version: "0.1.0", main: "dist/main.mjs" }));
  await put(application, "dist/main.mjs", "export const desktop = true;\n");
  const instances = [];
  const dependencies = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (name.startsWith("node_modules/") && name.endsWith("/package.json")) {
      const metadata = { version: "1.0.0", ...JSON.parse(bytes) };
      await put(application, name, JSON.stringify(metadata));
      const path = name.slice(0, -"/package.json".length);
      dependencies[path.slice("node_modules/".length)] = path;
      instances.push({ id: path, path, sourceId: `original/${path}`, name: metadata.name, version: metadata.version, dependencies: {}, absentDependencies: [], files: [] });
    } else await put(application, name, bytes);
  }
  for (const instance of instances) instance.files = await inventoryTree(join(application, instance.path));
  await put(application, dependencyLayoutManifest, JSON.stringify({ schemaVersion: 1, contexts: [{ id: "electron", root: ".", dependencies, instances, absentDependencies: [], effectSingleton: null }] }));
  await mkdir(resources);
  await asarTools().createPackage(application, join(resources, "app.asar"));
  await put(resources, `workspace-runtime/${dependencyLayoutManifest}`, JSON.stringify({ schemaVersion: 1, contexts: [
    { id: "pm", root: ".", dependencies: {}, instances: [], absentDependencies: [], effectSingleton: null },
    { id: "agent", root: "apps/server/agent", dependencies: {}, instances: [], absentDependencies: [], effectSingleton: null },
  ] }));
  await put(resources, "workspace-runtime/desktop-runtime-native.json", JSON.stringify({ schemaVersion: 1, files: [] }));
  return resources;
}

test("final ASAR inspection rejects Claude CLI metadata aliases inside the real archive", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {
    "node_modules/renamed-platform/package.json": JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-win32-x64" }),
    "node_modules/renamed-platform/claude.exe": "unit fixture, not a real executable",
  });
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"), /External Agent CLI packages/);
});

test("final inspection includes orphaned unpacked package bytes and preserves unrelated names", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json": JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk" }),
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": "export const sdk = true;\n",
    "node_modules/other/package.json": JSON.stringify({ name: "other" }),
    "node_modules/other/claude.exe": "unrelated unit resource",
  });
  assert.equal((await inspectPackagedApplication(resources, "0.1.0")).status, "passed");
  await assert.rejects(inspectPackagedApplication(resources, "0.2.0"), /identity\/version/);
  await put(resources, "app.asar.unpacked/node_modules/alias/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-linux-x64" }));
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"), /External Agent CLI packages/);
});

async function delivery(root) {
  const input = join(root, "input");
  const source = await snapshot(input);
  const output = join(root, "delivery");
  await mkdir(output);
  await put(output, "PM-Agent-v4-0.1.0-win-x64-unsigned.exe", "unit installer bytes; not a real installer");
  await put(output, "desktop-source.json", JSON.stringify(source));
  await put(output, "desktop-source.tar.gz", "unit source archive bytes");
  await put(output, "desktop-legal.tar.gz", "unit legal archive bytes");
  const manifest = {
    schemaVersion: 2, version: "0.1.0", target: "win32-x64", signing: "unsigned",
    source: { commit: source.commit, dirty: source.dirty, sha256: source.sha256 },
    artifacts: [await fileRecord(output, "PM-Agent-v4-0.1.0-win-x64-unsigned.exe")],
    materials: await Promise.all(["desktop-source.json", "desktop-source.tar.gz", "desktop-legal.tar.gz"].map((name) => fileRecord(output, name))),
  };
  await refreshVerification(output, manifest, { schemaVersion: 1, nativeSmoke: { status: "not-run" }, published: false });
  return { output, manifest };
}

// Static inventory fixture only: these are not executable Node/PG binaries or
// evidence for an official archive download. Native Actions exercises those.
async function preparedRuntimeFixture(resources, { cliAlias = false } = {}) {
  const runtime = join(resources, "desktop-runtime");
  const files = {
    "node/node.exe": "static Node executable fixture",
    "node/LICENSE": "Node legal fixture",
    "node/npm.cmd": "static npm launcher fixture",
    "node/npx.cmd": "static npx launcher fixture",
    "node/node_modules/npm/package.json": JSON.stringify({ name: "npm", version: "unit-fixture" }),
    "node/node_modules/npm/.npmrc": "",
    "node/node_modules/npm/bin/npm-cli.js": "// static npm fixture\n",
    "postgres/LICENSE": "PostgreSQL legal fixture",
    "THIRD-PARTY-NOTICES.json": "{}",
  };
  for (const tool of ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"])
    files[`postgres/bin/${tool}.exe`] = `static ${tool} executable fixture`;
  if (cliAlias) files["node/node_modules/renamed-cli/package.json"] = JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-win32-x64" });
  for (const [name, bytes] of Object.entries(files)) await put(runtime, name, bytes);
  const manifest = { version: 1, target: "win32-x64", sources: runtimeSources("win32-x64"), files: await inventoryTree(runtime) };
  await put(runtime, "runtime-manifest.json", JSON.stringify(manifest));
  return { runtime, manifest };
}

// A real two-level 7z container fixture exercises member listing/extraction. It
// is deliberately NOT an executable NSIS installer or native execution evidence.
async function sealPayload(output, manifest, payloadRoot = join(output, "win-unpacked")) {
  const scratch = join(dirname(output), "archive-fixture");
  await mkdir(join(scratch, "$PLUGINSDIR"), { recursive: true });
  const payload = join(scratch, "$PLUGINSDIR", "app-64.7z");
  await rm(payload, { force: true });
  await execute("7z", ["a", "-t7z", payload, "resources"], { cwd: payloadRoot });
  const artifact = manifest.artifacts[0].path;
  await rm(join(output, artifact));
  await execute("7z", ["a", "-t7z", join(output, artifact), "$PLUGINSDIR"], { cwd: scratch });
  manifest.artifacts = [await fileRecord(output, artifact)];
  return inspectFinalArtifacts(output, manifest.artifacts, manifest);
}

test("final delivery is authoritative even when old unpacked staging bytes change", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(output, "win-unpacked"), {});
  const prepared = await preparedRuntimeFixture(resources);
  await verifyRuntime(prepared.runtime, manifest.target);
  const application = await inspectPackagedApplication(resources, manifest.version);
  manifest.applicationResources = "win-unpacked/resources";
  const finalArtifacts = await sealPayload(output, manifest);
  await refreshVerification(output, manifest, { checks: { application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  assert.equal((await verifyDelivery(output)).target, manifest.target);
  assert.ok(prepared.manifest.files.some((file) => file.path === "node/node_modules/npm/.npmrc" && file.bytes === 0));
  assert.equal(await readFile(join(prepared.runtime, "node/node_modules/npm/.npmrc"), "utf8"), "");
  const originalInventory = await readFile(join(prepared.runtime, "runtime-manifest.json"));
  await put(prepared.runtime, "node/node_modules/npm/.npmrc", "# changed runtime fixture bytes\n");
  // Staging bytes are no longer authority for a downloaded installer. The final
  // archive still contains the unchanged pinned runtime and remains verifiable.
  assert.equal((await verifyDelivery(output)).target, manifest.target);
  await assert.rejects(verifyRuntime(prepared.runtime, manifest.target));
  assert.deepEqual(await readFile(join(prepared.runtime, "runtime-manifest.json")), originalInventory);
});

for (const location of ["app.asar", "app.asar.unpacked", "workspace-runtime"]) {
  test(`private configuration remains forbidden in ${location} beside a valid runtime`, async (t) => {
    const root = await temporary(t);
    const resources = await archive(root, {});
    const prepared = await preparedRuntimeFixture(resources);
    await verifyRuntime(prepared.runtime, "win32-x64");
    assert.equal((await inspectPackagedApplication(resources, "0.1.0")).status, "passed");
    const privateBytes = "private configuration fixture, not real credentials";
    if (location === "app.asar") {
      await put(join(root, "application"), ".npmrc", privateBytes);
      await asarTools().createPackage(join(root, "application"), join(resources, "app.asar"));
    } else await put(resources, `${location}/.npmrc`, privateBytes);
    await assert.rejects(inspectPackagedApplication(resources, "0.1.0"));
    assert.equal(await readFile(location === "app.asar" ? join(root, "application/.npmrc") : join(resources, location, ".npmrc"), "utf8"), privateBytes);
    assert.equal(await readFile(join(prepared.runtime, "node/node_modules/npm/.npmrc"), "utf8"), "");
  });
}

test("external Claude CLI identity is rejected in runtime even when its file inventory matches", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {});
  const prepared = await preparedRuntimeFixture(resources, { cliAlias: true });
  await verifyRuntime(prepared.runtime, "win32-x64");
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"));
});

test("delivery checksums cover every material and manifest without self-reference", async (t) => {
  const { output, manifest } = await delivery(await temporary(t));
  const checked = await verifyDeliveryFiles(output);
  assert.equal(checked.names.length, 7);
  const checksums = await readFile(join(output, "SHA256SUMS"), "utf8");
  assert.ok(checksums.includes("  desktop-package.json\n"));
  assert.ok(!checksums.includes("  SHA256SUMS\n"));
  await refreshVerification(output, manifest, { schemaVersion: 1, nativeSmoke: { status: "passed" }, published: false });
  await verifyDeliveryFiles(output);
  await put(output, manifest.artifacts[0].path, "tampered installer");
  await assert.rejects(verifyDeliveryFiles(output), /hash\/size mismatch/);
});

test("delivery refuses partial uploads, updater metadata, unknown archives and path escapes", async (t) => {
  const { output, manifest } = await delivery(await temporary(t));
  await put(output, "latest.yml", "version: 0.1.0\n");
  await assert.rejects(verifyDeliveryFiles(output), /update feed/);
  await rm(join(output, "latest.yml"));
  await put(output, "extra.zip", "unrecorded archive");
  await assert.rejects(verifyDeliveryFiles(output), /Unrecorded release artifact/);
  await rm(join(output, "extra.zip"));
  manifest.materials = manifest.materials.filter((file) => file.path !== "desktop-legal.tar.gz");
  await put(output, "desktop-package.json", JSON.stringify(manifest));
  await checksumDelivery(output, manifest);
  await assert.rejects(verifyDeliveryFiles(output), /missing required/);
  await assert.rejects(fileRecord(output, "../outside.exe"), /safe flat filenames/);
});

test("delivery rejects changed ASAR bytes even when application identity and version are unchanged", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const appRoot = join(output, "win-unpacked");
  const resources = await archive(appRoot, {});
  await preparedRuntimeFixture(resources);
  const application = await inspectPackagedApplication(resources, manifest.version);
  manifest.applicationResources = "win-unpacked/resources";
  const finalArtifacts = await sealPayload(output, manifest);
  await refreshVerification(output, manifest, { checks: { application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  await put(join(appRoot, "application"), "dist/main.mjs", "export const desktop = 'different bytes, same identity';\n");
  await asarTools().createPackage(join(appRoot, "application"), join(resources, "app.asar"));
  const scratch = join(dirname(output), "archive-fixture");
  await rm(join(scratch, "$PLUGINSDIR/app-64.7z"));
  await execute("7z", ["a", "-t7z", join(scratch, "$PLUGINSDIR/app-64.7z"), "resources"], { cwd: appRoot });
  await rm(join(output, manifest.artifacts[0].path));
  await execute("7z", ["a", "-t7z", join(output, manifest.artifacts[0].path), "$PLUGINSDIR"], { cwd: scratch });
  manifest.artifacts = [await fileRecord(output, manifest.artifacts[0].path)];
  await refreshVerification(output, manifest, { checks: { application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  await assert.rejects(verifyDelivery(output), /Final distributable payload differs/);
});

test("legal derivation rejects a resource-internal relative link that escapes the copied legal root", {
  skip: process.platform === "win32" ? "Relative file symlinks require optional Windows developer privileges; source junction regressions run without them." : false,
}, async (t) => {
  const root = await temporary(t);
  const resources = join(root, "app/resources");
  for (const [name, bytes] of Object.entries({
    "workspace-runtime/licenses/LICENSE": "root license",
    "workspace-runtime/apps/web/dist/licenses/LICENSE": "web license",
    "workspace-runtime/apps/web/dist/fonts/Inter-LICENSE.txt": "font license",
    "desktop-runtime/node/LICENSE": "node license",
    "desktop-runtime/postgres/LICENSE": "postgres license",
    "desktop-runtime/THIRD-PARTY-NOTICES.json": "{}",
    "app.asar": "unit resource bytes, not an executable archive",
  })) await put(resources, name, bytes);
  await put(join(root, "app"), "LICENSE.electron.txt", "electron license");
  await put(join(root, "app"), "LICENSES.chromium.html", "chromium license");
  await symlink("../../../../../app.asar", join(resources, "workspace-runtime/apps/web/dist/licenses/cross"));
  await inspectDeployment(resources);
  await assert.rejects(collectLegal(resources, "win32", join(root, "legal")), /nonportable symlink|ENOENT|ELOOP/);
});

test("archive member safety rejects traversal, absolute paths and alternate data streams", () => {
  for (const path of ["../outside", "/absolute", "C:\\outside", "resources/../outside", "resources/file:stream", "resources//file", "resources/./file"])
    assert.throws(() => archiveMemberPath(path), /Unsafe final archive/);
  assert.equal(archiveMemberPath("$PLUGINSDIR\\app-64.7z"), "$PLUGINSDIR/app-64.7z");
});

test("actual final archive expansion is rejected while the independent staging layout remains correct", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(output, "win-unpacked"), {});
  await preparedRuntimeFixture(resources);
  const workspace = join(resources, "workspace-runtime");
  await put(workspace, "node_modules/one/package.json", JSON.stringify({ name: "one", version: "1.0.0" }));
  await put(workspace, "node_modules/one/index.js", "module.exports = { retained: true };");
  const instance = { id: "node_modules/one", path: "node_modules/one", sourceId: "original/one", name: "one", version: "1.0.0",
    dependencies: {}, absentDependencies: [], files: await inventoryTree(join(workspace, "node_modules/one")) };
  await put(workspace, dependencyLayoutManifest, JSON.stringify({ schemaVersion: 1, contexts: [
    { id: "pm", root: ".", dependencies: { one: instance.id }, instances: [instance], absentDependencies: [], effectSingleton: null },
    { id: "agent", root: "apps/server/agent", dependencies: {}, instances: [], absentDependencies: [], effectSingleton: null },
  ] }));
  assert.equal((await inspectPackagedApplication(resources, manifest.version)).status, "passed");
  const correct = await sealPayload(output, manifest);
  assert.equal(correct.status, "passed");
  assert.equal(correct.artifacts[0].sha256, manifest.artifacts[0].sha256);
  assert.ok(correct.artifacts[0].tree.files > 0 && correct.artifacts[0].tree.logicalBytes > 0);
  const expanded = join(root, "expanded-payload");
  await cp(resources, join(expanded, "resources"), { recursive: true });
  const packageRoot = join(expanded, "resources/workspace-runtime/node_modules/one");
  await cp(join(workspace, "node_modules/one"), join(packageRoot, "node_modules/one"), { recursive: true });
  await assert.rejects(sealPayload(output, manifest, expanded), /Undeclared or recursively expanded dependency/);
  assert.equal((await inspectPackagedApplication(resources, manifest.version)).status, "passed");
});

test("supplied installed resources bind all bytes to the current final artifact, not their self-declared layout", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(output, "win-unpacked"), {});
  await preparedRuntimeFixture(resources);
  await put(resources, "workspace-runtime/apps/server/pm/src/source.js", "original packaged application bytes");
  const report = await sealPayload(output, manifest);
  const payload = report.artifacts[0];
  const installed = join(root, "supplied-installed-tree/resources");
  await cp(resources, installed, { recursive: true });
  const checked = await verifyInstalledApplication(installed, payload, manifest);
  assert.equal(checked.sourceArtifact.sha256, manifest.artifacts[0].sha256);
  assert.equal(checked.installationExecutedByThisCommand, false);
  await put(installed, "workspace-runtime/apps/server/pm/src/source.js", "modified bytes outside dependency own-file inventory");
  await assert.rejects(verifyInstalledApplication(installed, payload, manifest), /differs from the current final distributable/);
  await assert.rejects(verifyInstalledApplication(installed, null, manifest), /current inspected final artifact digest/);
});

test("files-only transport remains valid for historical deliveries but cannot promote old win-unpacked smoke", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  await refreshVerification(output, manifest, { checks: {}, nativeSmoke: { status: "passed" }, published: false });
  assert.equal((await verifyDelivery(output, { filesOnly: true })).target, manifest.target);
  await assert.rejects(verifyDelivery(output), /actual final distributable payloads/);
  await assert.rejects(verifyDelivery(output, { filesOnly: true, stage: join(root, "staged") }), /bound to this final distributable payload/);
});

test("unreferenced loose ASAR dependency copies cannot hide outside the archive inventory", async (t) => {
  const resources = await archive(await temporary(t), {});
  await put(resources, "app.asar.unpacked/node_modules/orphan/package.json", JSON.stringify({ name: "orphan", version: "1.0.0" }));
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"), /Unrecorded or linked ASAR unpacked resource/);
});
