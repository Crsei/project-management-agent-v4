import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { createInstallStamp } from "../scripts/install-stamp.mjs";
import { captureUninstallSnapshot, createInstallationManifest, executeUninstall, planUninstall, UNINSTALL_GOLDEN, verifyInstallationManifest } from "./uninstall.mjs";
import { ensurePrivateDirectory } from "./private-state.mjs";

const instanceId = "b40e9550-d9c5-4b6e-8554-dac85bd5fcc1";
const stamp = createInstallStamp({ commit: "a".repeat(40), version: "1.2.3", platform: "win32", arch: "x64", distribution: "nsis", source: { sha256: "b".repeat(64), dirty: true }, signing: "unsigned", compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "desktop-uninstall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install"), userDataDir = join(root, "userData"), dataDir = join(userDataDir, "workspace"), external = join(root, "external"), nativeHome = join(root, "native-home");
  async function put(base, path, value) { await mkdir(dirname(join(base, path)), { recursive: true, mode: 0o700 }); await writeFile(join(base, path), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); }
  await put(installRoot, "PM Agent v4.exe", "gui-binary");
  await put(installRoot, "resources/app.asar", "application");
  await put(installRoot, "resources/desktop-runtime/node/node.exe", "standalone-node");
  await put(installRoot, "resources/desktop-runtime/postgres/bin/postgres.exe", "standalone-pg");
  await put(installRoot, "resources/workspace-runtime/server.mjs", "standalone-server");
  await put(installRoot, "resources/desktop-maintenance/uninstall-cli.mjs", "maintenance-controller");
  await put(installRoot, "resources/desktop-install-stamp.json", stamp);
  await mkdir(join(installRoot, "resources", "empty-owned-gui-directory"));
  const manifest = await createInstallationManifest(installRoot, stamp);
  await put(installRoot, "resources/desktop-install-files.json", manifest);
  await put(dataDir, "managed-postgres.json", { formatVersion: 1, postgresMajor: 16, instanceId, phase: "ready" });
  await put(dataDir, "service-ports.json", { instanceId });
  await put(dataDir, "postgres/.desktop-instance.json", { formatVersion: 1, postgresMajor: 16, instanceId });
  await put(dataDir, "postgres/PG_VERSION", "16\n");
  await put(dataDir, "postgres/base/database", "database-data");
  await put(dataDir, "agent-data/chat.sqlite", "agent-data");
  await put(dataDir, "pm-workspaces/core.md", "markdown-data");
  await put(dataDir, "blobs/attachment", "attachment-data");
  await put(dataDir, "projects/repo/source.ts", "user-source-never-delete");
  await put(userDataDir, "connection.json", { version: 2, dataDir });
  await put(userDataDir, "Partitions/session/IndexedDB/chat", "browser-state");
  await put(userDataDir, "operator-notes.txt", "not-app-owned");
  await put(external, ".pm/core/project.md", "external-project");
  await put(nativeHome, ".credentials", "native-provider-private-fixture");
  await ensurePrivateDirectory(userDataDir);
  await ensurePrivateDirectory(dataDir);
  await ensurePrivateDirectory(join(dataDir, "agent-data"));
  return { root, installRoot, userDataDir, dataDir, external, nativeHome, put, stamp, externalRoots: [external, nativeHome] };
}
function options(f, mode, extra = {}) { return { ...f, mode, consent: { mode, deleteData: ["full", "data-only"].includes(mode) }, stop: async () => ({ stopped: true, remainingProcesses: 0 }), ...extra }; }
async function files(root) {
  const output = [];
  async function visit(path, prefix = "") { for (const item of await readdir(path, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) { const name = prefix + item.name; if (item.isDirectory()) await visit(join(path, item.name), `${name}/`); else output.push(name); } }
  await visit(root); return output.sort();
}

for (const mode of ["app-only", "app+runtime", "full", "data-only"]) test(`real filesystem golden sets for ${mode}`, async t => {
  const f = await fixture(t);
  const before = { installation: await files(f.installRoot), instance: await files(f.dataDir), userData: await files(f.userDataDir) };
  const plan = await planUninstall(options(f, mode));
  assert.deepEqual(plan.golden, UNINSTALL_GOLDEN[mode]);
  assert.ok(plan.snapshots.installation.fileCount > 0);
  assert.ok(plan.snapshots.instance.fileCount > 0);
  assert.ok(plan.snapshots.userData.fileCount > 0);
  const removeInstall = mode === "data-only" ? [] : mode === "app-only" ? ["PM Agent v4.exe", "resources/app.asar"] : before.installation;
  const removeInstance = ["full", "data-only"].includes(mode) ? before.instance.filter(path => !path.startsWith("projects/")) : [];
  const removeUser = ["full", "data-only"].includes(mode) ? ["Partitions/session/IndexedDB/chat", "connection.json"] : [];
  assert.deepEqual(plan.delete.filter(entry => entry.scope === "installation").map(entry => entry.path).sort(), removeInstall.sort());
  assert.deepEqual(plan.delete.filter(entry => entry.scope === "instance").map(entry => entry.path).sort(), removeInstance.sort());
  assert.deepEqual(plan.delete.filter(entry => entry.scope === "userData").map(entry => entry.path).sort(), removeUser.sort());
  // Windows real deletion is deliberately external, after Electron exits. Native
  // NSIS driver exercises that executor; portable hosts exercise actual unlink.
  if (process.platform === "win32") {
    const result = await executeUninstall(options(f, mode, { deferInstallation: true }));
    assert.equal(result.deletionExecuted, false);
    assert.deepEqual(await files(f.installRoot), before.installation);
  } else {
    const result = await executeUninstall(options(f, mode));
    assert.equal(result.status, "complete");
    assert.deepEqual(await files(f.installRoot), before.installation.filter(path => !removeInstall.includes(path)));
    assert.deepEqual(await files(f.dataDir), before.instance.filter(path => !removeInstance.includes(path)));
    assert.equal(await readFile(join(f.userDataDir, "operator-notes.txt"), "utf8"), "not-app-owned");
    for (const item of result.preserve) assert.ok(!result.delete.some(deleted => join(result.roots[deleted.scope], deleted.path) === join(result.roots[item.scope], item.path)));
  }
  assert.equal(await readFile(join(f.dataDir, "projects/repo/source.ts"), "utf8"), "user-source-never-delete");
  assert.equal(await readFile(join(f.external, ".pm/core/project.md"), "utf8"), "external-project");
  assert.equal(await readFile(join(f.nativeHome, ".credentials"), "utf8"), "native-provider-private-fixture");
});

test("unowned install, unknown code, modified payload and empty snapshots fail closed", async t => {
  const f = await fixture(t);
  await f.put(f.installRoot, "operator-file.txt", "not-owned");
  await assert.rejects(planUninstall(options(f, "app+runtime")), /Unknown or modified/);
  await rm(join(f.installRoot, "operator-file.txt"));
  await mkdir(join(f.installRoot, "unknown-empty-tree"));
  await assert.rejects(planUninstall(options(f, "app+runtime")), /installation directories/);
  await rm(join(f.installRoot, "unknown-empty-tree"), { recursive: true });
  await f.put(f.installRoot, "resources/app.asar", "tampered");
  await assert.rejects(verifyInstallationManifest(f.installRoot, stamp), /Unknown or modified/);
  const empty = join(f.root, "empty"); await mkdir(empty);
  await assert.rejects(captureUninstallSnapshot(empty), /Empty uninstall snapshots/);
  await assert.rejects(captureUninstallSnapshot(parse(f.root).root), /non-root/);
  const managed = { ...stamp, distribution: "os-managed", ownership: { installation: "os-managed", scope: "per-user" } };
  await assert.rejects(planUninstall(options(f, "app+runtime", { stamp: managed })), /operating system/);
});

test("consent and stop failures precede every deletion", async t => {
  const f = await fixture(t), before = await files(f.installRoot);
  let called = false;
  await assert.rejects(executeUninstall(options(f, "full", { consent: { mode: "full" }, stop: async () => { called = true; } })), /consent/);
  assert.equal(called, false);
  await assert.rejects(executeUninstall(options(f, "full", { stop: async () => ({ stopped: false, remainingProcesses: 1 }) })), /not verifiably stopped/);
  await assert.rejects(executeUninstall(options(f, "full", { stop: async () => { throw new Error("shutdown timeout"); } })), /shutdown timeout/);
  assert.deepEqual(await files(f.installRoot), before);
  assert.equal(await readFile(join(f.dataDir, "postgres/base/database"), "utf8"), "database-data");
});

test("data deletion rejects foreign/partial instances, unknown trees and live PG metadata", async t => {
  const f = await fixture(t);
  await f.put(f.dataDir, "service-ports.json", { instanceId: "another-instance" });
  await assert.rejects(planUninstall(options(f, "data-only")), /ownership/);
  await f.put(f.dataDir, "service-ports.json", { instanceId });
  await f.put(f.dataDir, "operator-source/file.ts", "not-owned");
  await assert.rejects(planUninstall(options(f, "full")), /Unknown instance tree/);
  await rm(join(f.dataDir, "operator-source"), { recursive: true });
  await f.put(f.dataDir, "postgres/postmaster.pid", "owned-or-foreign-must-stop-first");
  await assert.rejects(planUninstall(options(f, "data-only")), /process ownership/);
});

test("project/Provider overlap and linked/hardlinked data never become deletion permission", async t => {
  const f = await fixture(t);
  await assert.rejects(planUninstall(options(f, "full", { externalRoots: [join(f.dataDir, "agent-data")] })), /protected project or native Provider/);
  const linked = join(f.dataDir, "linked");
  if (process.platform !== "win32") {
    await symlink(f.external, linked);
    await assert.rejects(planUninstall(options(f, "full")), /links/);
    await rm(linked);
  }
  await link(join(f.nativeHome, ".credentials"), linked);
  await assert.rejects(planUninstall(options(f, "full")), /shared files/);
});

test("saved explicit native Provider roots nested in private state are never deleted", async t => {
  const f = await fixture(t), native = join(f.dataDir, "runtime-home", "codex");
  await f.put(f.dataDir, "runtime-home/codex/auth.json", "synthetic-native-credential");
  await f.put(f.dataDir, "agent-data/provider-instances.json", { version: 1, instances: [{ instanceId: "codex", driver: "codex", config: { homePath: native } }] });
  await assert.rejects(executeUninstall(options(f, "full")), /protected project or native Provider/);
  assert.equal(await readFile(join(native, "auth.json"), "utf8"), "synthetic-native-credential");
});

test("same-byte file replacement changes snapshot identity evidence", async t => {
  const f = await fixture(t), before = await captureUninstallSnapshot(f.installRoot);
  const file = join(f.installRoot, "resources/app.asar"), replacement = join(f.root, "replacement");
  await writeFile(replacement, await readFile(file)); await rename(replacement, file);
  const after = await captureUninstallSnapshot(f.installRoot);
  assert.notEqual(after.sha256, before.sha256);
  assert.notDeepEqual(after.entries.find(entry => entry.path === "resources/app.asar").fileIdentity, before.entries.find(entry => entry.path === "resources/app.asar").fileIdentity);
});

test("upgrade preparation preserves exact old code/data and records no migration", async t => {
  const f = await fixture(t);
  const beforeCode = await captureUninstallSnapshot(f.installRoot), beforeData = await captureUninstallSnapshot(f.dataDir);
  const prepared = await executeUninstall(options(f, "app+runtime", { deferInstallation: true }));
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.deletionExecuted, false);
  assert.deepEqual(prepared.rollbackCompatibility, { ...stamp.compatibility, migrationsPerformed: false });
  assert.equal((await captureUninstallSnapshot(f.installRoot)).sha256, beforeCode.sha256);
  assert.equal((await captureUninstallSnapshot(f.dataDir)).sha256, beforeData.sha256);
});

if (process.platform !== "win32") test("app-only retains usable ownership and maintenance code for later runtime cleanup", async t => {
  const f = await fixture(t);
  await executeUninstall(options(f, "app-only"));
  const retained = JSON.parse(await readFile(join(f.installRoot, "resources/desktop-install-files.json"), "utf8"));
  assert.equal(retained.retainedRuntime, true);
  await verifyInstallationManifest(f.installRoot, stamp);
  const next = await planUninstall(options(f, "app+runtime"));
  assert.ok(next.delete.some(entry => entry.path === "resources/desktop-maintenance/uninstall-cli.mjs"));
  await executeUninstall(options(f, "app+runtime"));
  assert.deepEqual(await files(f.installRoot), []);
  assert.equal(await readFile(join(f.dataDir, "postgres/base/database"), "utf8"), "database-data");
});

test("code-only uninstall records genuine absent data, not an accepted empty snapshot", async t => {
  const f = await fixture(t);
  await rm(f.userDataDir, { recursive: true });
  const plan = await planUninstall(options(f, "app+runtime"));
  assert.equal(plan.snapshots.instance.absent, true);
  assert.equal(plan.snapshots.userData.absent, true);
  assert.ok(plan.snapshots.installation.fileCount > 0);
  await assert.rejects(planUninstall(options(f, "full")), /nonempty owned instance/);
  await mkdir(f.userDataDir);
  await assert.rejects(planUninstall(options(f, "app+runtime")), /Empty uninstall snapshots/);
});
