import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDataPreserved, compareVersions, safeMaterialPath, validateReceiptIdentity, validateSnapshot, verifyInstallE2EReceipt } from "./install-e2e/evidence.mjs";
import { createReceiptFixture } from "./install-e2e/fixtures.mjs";
import { parseOptions, requireWindowsNative, runWindowsInstallE2E } from "./install-e2e/windows.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-install-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createReceiptFixture(directory);
}
const verify = (value) => verifyInstallE2EReceipt(value.receiptPath, { output: value.output, manifest: value.manifest, finalArtifacts: value.finalArtifacts });
const proof = (value, name) => value.documents.get(value.receipt.scenarios.find((entry) => entry.name === name).proof);

// These are contract/boundary tests over synthetic receipts. Their success is
// never evidence that native Windows installation, GUI, or upgrade executed.
test("complete typed receipt binds artifact, installed ASAR, source, run and all scenarios", async (t) => {
  const value = await fixture(t);
  const result = await verify(value);
  assert.equal(result.summary.status, "passed");
  assert.equal(result.summary.electronGuiExecuted, false);
  assert.equal(result.summary.scenarios.length, 11);
  assert.deepEqual(result.receipt.source, value.manifest.source);
  assert.equal(result.materials.length, value.receipt.materials.length);
  assert.equal(proof(value, "uninstall-full").remaining.dataRoot, true);
  assert.equal(proof(value, "uninstall-full").remaining.ownedData, false);
});

test("same-version overwrite is not true upgrade, including prerelease ordering", () => {
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-rc.10", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.throws(() => compareVersions("latest", "1.0.0"), /exact semantic/);
});

for (const [name, mutate, expected] of [
  ["a claimed pass with no baseline", (value) => { value.receipt.baseline = null; }, /exact older baseline/],
  ["same-version fake upgrade", (value) => { value.receipt.baseline.version = value.receipt.version; }, /exact older baseline/],
  ["wrong dirty source digest", (value) => { value.receipt.source.sha256 = "f".repeat(64); }, /source digest/],
  ["dirty source masquerading as clean commit", (value) => { value.receipt.source.dirty = false; }, /source digest/],
  ["another Actions attempt", (value) => { value.receipt.run.attempt = "3"; }, /another build run/],
  ["another installer artifact", (value) => { value.receipt.artifact.sha256 = "f".repeat(64); }, /artifact mismatch/],
  ["checkout controller substitution", (value) => { value.receipt.controller.scope = "checkout-built"; }, /checkout controller/],
  ["failed native run relabeled as receipt", (value) => { value.receipt.status = "failed"; }, /did not pass/],
  ["blocked upgrade criterion", (value) => { value.receipt.scenarios.find((entry) => entry.name === "version-upgrade").status = "blocked"; }, /scenarios/],
  ["missing mandatory matrix mode", (value) => { value.receipt.scenarios.pop(); }, /scenarios/],
  ["administrator account substitution", (value) => { value.receipt.native.administrator = true; }, /isolated account/],
  ["unbound harness bytes", (value) => { value.receipt.harness.files[0].sha256 = "f".repeat(64); }, /harness differs/],
  ["changed PM/Agent migration compatibility", (value) => { value.receipt.baseline.compatibility.migrationsSha256 = "f".repeat(64); }, /migration compatibility/],
]) test(`receipt rejects ${name}`, async (t) => {
  const value = await fixture(t); mutate(value); await value.persist(); await assert.rejects(verify(value), expected);
});

for (const [name, mutate, expected] of [
  ["failed installer exit", (value) => { value.documents.get(proof(value, "silent-install").commands[0]).exitCode = 2; }, /command\/log/],
  ["timed out installer", (value) => { value.documents.get(proof(value, "silent-install").commands[0]).timedOut = true; }, /command\/log/],
  ["claim without executed installer", (value) => { value.documents.get(proof(value, "silent-install").commands[0]).executableScope = "native-system"; }, /exact installer/],
  ["installed controller launched from checkout", (value) => { const item = proof(value, "version-upgrade").commands.map((path) => value.documents.get(path)).find((entry) => entry.executableScope === "installed-controller"); item.executable = "C:\\checkout\\electron.exe"; }, /observed installed root/],
  ["empty Agent data snapshot", (value) => { value.documents.get("evidence/snapshot-before.json").components.agent.entries = []; }, /empty agent/],
  ["changed PostgreSQL records", (value) => { value.documents.get("evidence/snapshot-after.json").components.postgres.entries[0].sha256 = "f".repeat(64); }, /postgres data/],
  ["reparse evidence", (value) => { value.documents.get(proof(value, "version-upgrade").state).paths[0].reparse = true; }, /ACL\/reparse/],
  ["foreign process after stop", (value) => { value.documents.get(proof(value, "stop-owned-processes").state).processes.push({ pid: 9, creationTime: "time", executable: "C:\\foreign.exe", ownerSid: "S-1-5-18" }); }, /owned PID\/birth/],
  ["owned processes surviving stop", (value) => { value.documents.get(proof(value, "stop-owned-processes").state).processes.push({ pid: 9, creationTime: "time", executable: "C:\\owned.exe", ownerSid: value.receipt.native.accountSid }); }, /remain after stop/],
  ["interruption before payload mutation", (value) => { proof(value, "interrupted-upgrade-recovery").mutationObserved = false; }, /interruption/],
  ["PID reuse at injected interruption", (value) => { value.documents.get("evidence/interruption.json").creationTime = "different-process-birth"; }, /exact installer PID/],
  ["claimed mutation with unchanged payload bytes", (value) => { const mutation = value.documents.get("evidence/payload-mutation.json"); mutation.after = { exists: true, sha256: mutation.beforeSha256 }; }, /payload content mutation/],
  ["rollback restored from a different baseline", (value) => { value.documents.get("evidence/rollback-restoration.json").baselineSource.commit = "f".repeat(40); }, /rollback restoration/],
  ["old version started on candidate-migrated data", (value) => { proof(value, "interrupted-upgrade-recovery").recoveryCompatibility = "start-old-on-migrated-data"; }, /pre-upgrade identity/],
  ["copy-startup inode compatibility claim", (value) => { value.documents.get("evidence/pre-upgrade-copy.json").startupSource = "byte-copy-with-new-inodes"; }, /diagnostic copy/],
  ["uninstall asserted golden but observed retained owned data", (value) => { const path = value.documents.get(proof(value, "uninstall-full").state).paths.find((entry) => entry.label === "managedPostgres"); path.exists = true; path.files = 1; }, /observed uninstall/],
  ["uninstall from empty initial roots", (value) => { value.documents.get(proof(value, "uninstall-full").beforeState).paths.find((entry) => entry.label === "data").files = 0; }, /nonempty pre-deletion/],
  ["external project removal", (value) => { proof(value, "uninstall-full").externalPreservation.sha256After = "f".repeat(64); }, /external preservation/],
  ["native cleanup with no deletion", (value) => { value.documents.get(proof(value, "uninstall-full").cleanup).deletionExecuted = false; }, /cleanup receipt/],
  ["false health result", (value) => { value.documents.get("evidence/healthy-controller.json").result.ready = false; }, /health/],
  ["missing baseline startup result", (value) => { value.documents.get("evidence/baseline-install-health-controller.json").ok = false; }, /actual installed/],
  ["stop result with surviving processes", (value) => { value.documents.get("evidence/stop-controller.json").result.remainingProcesses = 1; }, /shutdown result/],
  ["PID-based fault substituted for held process handle", (value) => { value.documents.get("evidence/interruption.json").heldHandle = false; }, /original spawned installer process handle/],
  ["installer descendant still alive during restoration", (value) => { value.documents.get("evidence/installer-tree-quiescence.json").remainingProcesses = 1; }, /descendants/],
  ["selected owned file surviving deletion", (value) => { value.documents.get(proof(value, "uninstall-full").fileOutcome).deleted[0].exists = true; }, /selected owned files/],
  ["preserved project bytes changed", (value) => { value.documents.get(proof(value, "uninstall-full").fileOutcome).preserved[0].sha256 = "f".repeat(64); }, /preserved project/],
  ["selected empty owned directory surviving deletion", (value) => { value.documents.get(proof(value, "uninstall-full").fileOutcome).deletedDirectories[0].exists = true; }, /selected owned directories/],
  ["installation root left behind after full uninstall", (value) => { value.documents.get(proof(value, "uninstall-full").state).paths.find((entry) => entry.label === "installation").exists = true; }, /observed uninstall/],
]) test(`rehashing cannot legitimize ${name}`, async (t) => {
  const value = await fixture(t); mutate(value); await value.persist(); await assert.rejects(verify(value), expected);
});

test("receipt rejects altered, missing and extra unhashed logs", async (t) => {
  const value = await fixture(t), path = [...value.logs.keys()][0];
  await writeFile(join(value.root, path), "tampered native output");
  await assert.rejects(verify(value), /hash\/size/);
  await value.persist(); await unlink(join(value.root, path));
  await assert.rejects(verify(value), /inventory must be exact/);
  await value.persist(); await writeFile(join(value.root, "evidence", "unrecorded.log"), "extra");
  await assert.rejects(verify(value), /inventory must be exact/);
});

test("receipt refuses hard-linked evidence even when bytes match", async (t) => {
  const value = await fixture(t), path = [...value.logs.keys()][0];
  await link(join(value.root, path), join(value.root, "outside-hardlink.log"));
  await assert.rejects(verify(value), /unaliased/);
});

if (process.platform !== "win32") test("linked evidence file cannot escape the receipt boundary", async (t) => {
  const value = await fixture(t), path = [...value.logs.keys()][0], bytes = await readFile(join(value.root, path));
  const external = join(value.root, "external-log");
  await writeFile(external, bytes); await unlink(join(value.root, path)); await symlink(external, join(value.root, path));
  await assert.rejects(verify(value), /linked evidence/);
});

test("material paths reject traversal, absolute names, ADS and Windows aliases", () => {
  for (const path of ["../escape", "evidence/../../escape", "C:/escape", "evidence/file:stream", "evidence\\file", "evidence/CON", "evidence/aux.log", "evidence/name. ", "evidence//file", "evidence/./file"])
    assert.equal(safeMaterialPath(path), false, path);
  assert.equal(safeMaterialPath("evidence/001-native-state.json"), true);
});

test("empty snapshots and changed stable records fail preservation", async (t) => {
  const value = await fixture(t), before = value.documents.get("evidence/snapshot-before.json"), after = structuredClone(before);
  assert.equal(assertDataPreserved(before, after), true);
  after.components.markdown.entries[0].bytes++;
  assert.throws(() => assertDataPreserved(before, after), /markdown data/);
  before.components.postgres.entries = [];
  assert.throws(() => validateSnapshot(before), /empty postgres/);
});

test("a final artifact ASAR mismatch cannot be promoted to native pass", async (t) => {
  const value = await fixture(t); value.finalArtifacts.artifacts[0].application.sha256 = "f".repeat(64);
  await assert.rejects(verify(value), /verified final installer/);
  await assert.rejects(verifyInstallE2EReceipt(value.receiptPath, { manifest: value.manifest }), /verified final installer/);
});

test("CLI parsing cannot override native platform or silently supply a baseline", () => {
  const args = ["--delivery", "delivery", "--root", "root", "--account-sid", "S-1-5-21-1-2-3-1001", "--run-id", "100", "--run-attempt", "1", "--repository", "example/repo"];
  const options = parseOptions(args);
  assert.equal(options.baseline, undefined);
  assert.throws(() => parseOptions([...args, "--platform", "win32"]), /explicit, unique/);
  assert.throws(() => parseOptions([...args, "--root", "other"]), /explicit, unique/);
  assert.throws(() => validateReceiptIdentity({ status: "passed", installationExecuted: true }, {}), /did not pass/);
});

if (process.platform !== "win32" || process.arch !== "x64") test("non-native entry fails before touching installer or data roots", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-native-guard-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "never-created");
  assert.throws(() => requireWindowsNative(), /Native Windows x64/);
  await assert.rejects(runWindowsInstallE2E({ root: target }), /Native Windows x64/);
  await assert.rejects(readFile(join(target, "diagnostics", "install-e2e-receipt.json")), { code: "ENOENT" });
});
