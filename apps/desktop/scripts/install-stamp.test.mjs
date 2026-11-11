import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
test("version-only build provenance does not block an update with unchanged state code", async t => {
  const f = await fixture(t), metadata = join(f.agent, "build-inputs.json");
  await writeFile(metadata, JSON.stringify({ version: 1, hostBuildInputs: [{ path: "package.json", sha256: "a".repeat(64) }] }));
  const baseline = await computeMigrationsSha256(f.root);
  await writeFile(metadata, JSON.stringify({ version: 1, hostBuildInputs: [{ path: "package.json", sha256: "b".repeat(64) }] }));
  assert.equal(await computeMigrationsSha256(f.root), baseline);
  // Only the packager's exact root provenance document is non-runtime data.
  await mkdir(join(f.agent, "provider"));
  await writeFile(join(f.agent, "provider", "build-inputs.json"), '{"dataSchema":2}');
  assert.notEqual(await computeMigrationsSha256(f.root), baseline);
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

if (process.platform === "win32") {
  test("native manual first-updater handoff accepts only historical unsigned 0.1.0 and preserves its exact identity", async (t) => {
    const f = await fixture(t);
    const installRoot = join(f.root, "installed");
    await mkdir(join(installRoot, "resources"), { recursive: true });
    const stampPath = join(installRoot, "resources", "desktop-install-stamp.json");
    const helper = join(import.meta.dirname, "../assets/desktop-maintenance.ps1");
    const script = join(f.root, "read-native-identity.ps1");
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    // Execute the real production validator functions under system PowerShell.
    // Parsing avoids executing installer/registry/process side effects; these
    // are behavioral results on actual files, not source/wiring assertions.
    await writeFile(script, `param([string]$IdentityStage)
$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(helper)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid native helper syntax'}
foreach($name in @('Read-Json','Get-Stamp')){
  $function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
  if(-not $function){throw 'Native identity validator is unavailable'}
  . ([scriptblock]::Create($function.Extent.Text))
}
$InstallRoot=${quote(installRoot)}
$Stage=$IdentityStage
Get-Stamp | ConvertTo-Json -Depth 20 -Compress
`);
    const execute = promisify(execFile);
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const readNative = (stage) => execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-IdentityStage", stage], { windowsHide: true, timeout: 30_000 });
    const current = createInstallStamp({ ...input, version: "0.1.1-preview.1", compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) } });
    const historical = { ...current, version: "0.1.0", updateMechanism: "none" };
    const bytes = `${JSON.stringify(historical, null, 2)}\n`;
    await writeFile(stampPath, bytes);
    assert.deepEqual(JSON.parse((await readNative("prepare-install")).stdout), historical);
    assert.equal(await readFile(stampPath, "utf8"), bytes);
    for (const stage of ["prepare-uninstall", "runtime", "handoff", "upgrade", "restore"]) await assert.rejects(readNative(stage));
    for (const change of [{ version: "0.1.1-preview.1" }, { signing: "signed" }, { distribution: "os-managed" }, { updateMechanism: "unknown" }, { compatibility: { ...current.compatibility, migrationsSha256: "unknown" } }]) {
      await writeFile(stampPath, JSON.stringify({ ...historical, ...change }));
      await assert.rejects(readNative("prepare-install"));
    }
    await writeFile(stampPath, JSON.stringify(current));
    for (const stage of ["prepare-install", "prepare-uninstall"]) assert.deepEqual(JSON.parse((await readNative(stage)).stdout), current);
  });
}
