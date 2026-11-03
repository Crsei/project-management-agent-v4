import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] !== "--source" || !process.argv[3] || process.argv.length !== 4) throw new Error("Usage: node vendor/t3code/scripts/verify-sync.mjs --source PINNED_CHECKOUT");
const source = path.resolve(process.argv[3]);
const script = fileURLToPath(new URL("./sync.mjs", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "pm-provider-sync-"));
const environment = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function command(binary, args, expected = 0) {
  const result = spawnSync(binary, args, { encoding: "utf8", env: environment, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${binary}: ${result.stderr}\n${result.stdout}`);
  return result;
}
function sync(destination, extra = [], expected = 0, input = source, tool = script) {
  return command(process.execPath, [tool, "--source", input, "--destination", destination, ...extra], expected);
}
async function snapshot(root, relative = "") {
  const result = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const file = path.join(relative, name), info = await lstat(path.join(root, file));
    if (info.isDirectory()) result.push(...await snapshot(root, file));
    else result.push([file, info.mode & 0o7777, sha(await readFile(path.join(root, file)))]);
  }
  return result;
}
try {
  const destination = path.join(temporary, "reconstructed");
  await mkdir(destination);
  await writeFile(path.join(destination, "unrelated-pm-file.txt"), "PM-owned sentinel\n");
  const first = JSON.parse(sync(destination).stdout);
  assert.ok(first.created > 0);
  assert.equal((await lstat(path.join(destination, "vendor/t3code/LICENSE"))).mode & 0o7777, 0o644);
  const before = await snapshot(destination);
  const second = JSON.parse(sync(destination).stdout);
  assert.equal(second.created, 0);
  assert.deepEqual(await snapshot(destination), before);
  sync(destination, ["--check"]);
  assert.equal(await readFile(path.join(destination, "unrelated-pm-file.txt"), "utf8"), "PM-owned sentinel\n");

  const pristine = path.join(temporary, "pristine");
  sync(pristine, ["--pristine"]);
  sync(pristine, ["--pristine", "--check"]);
  const inventory = JSON.parse(await readFile(path.join(destination, "vendor/t3code/sync-inventory.json"), "utf8"));
  const patched = inventory.files.find((entry) => entry.patch);
  assert.ok(patched);
  assert.equal(sha(await readFile(path.join(pristine, patched.destination))), patched.upstreamSha256);
  assert.equal(sha(await readFile(path.join(destination, patched.destination))), patched.sha256);
  const adaptations = JSON.parse(await readFile(path.join(destination, "vendor/t3code/mcp-skills-adaptations.json"), "utf8"));
  assert.ok(adaptations.sources.some((entry) => entry.commit === "d53873b6a4799e87afd63c8d288ef0089f5a3748"));
  assert.ok(adaptations.sources.some((entry) => entry.commit === inventory.upstreamCommit));
  for (const entry of adaptations.outputs) {
    assert.equal(sha(await readFile(path.join(destination, entry.destination))), entry.sha256);
    if (!entry.destination.startsWith("vendor/t3code/")) await assert.rejects(lstat(path.join(pristine, entry.destination)), { code: "ENOENT" });
  }

  const copyHostInputs = async root => {
    for (const entry of inventory.runtimeResources.hostBuildInputs) {
      const target = path.join(root, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(repository, entry.path), target);
    }
  };
  const hostTool = path.join(temporary, "host-tool-drift");
  await cp(destination, hostTool, { recursive: true });
  await copyHostInputs(hostTool);
  const hostScript = path.join(hostTool, "vendor/t3code/scripts/sync.mjs");
  sync(destination, ["--check"], 0, source, hostScript);
  for (const entry of inventory.runtimeResources.hostBuildInputs) {
    const altered = path.join(hostTool, entry.path);
    const rejectedOutput = path.join(temporary, "host-tool-drift-output");
    await appendFile(altered, "\n// controlled unreviewed tool change\n");
    sync(rejectedOutput, [], 1, source, hostScript);
    await assert.rejects(lstat(rejectedOutput), { code: "ENOENT" });
    await cp(path.join(repository, entry.path), altered);
  }
  sync(destination, ["--check"], 0, source, hostScript);

  const groupWrite = path.join(temporary, "group-write");
  await cp(destination, groupWrite, { recursive: true });
  const groupWriteFile = path.join(groupWrite, "vendor/t3code/LICENSE");
  await chmod(groupWriteFile, 0o664);
  const groupWriteBefore = await snapshot(groupWrite);
  const groupWriteStatBefore = await lstat(groupWriteFile, { bigint: true });
  assert.equal(groupWriteStatBefore.mode & 0o7777n, 0o664n);
  assert.equal(JSON.parse(sync(groupWrite).stdout).created, 0);
  sync(groupWrite, ["--check"]);
  assert.deepEqual(await snapshot(groupWrite), groupWriteBefore);
  const groupWriteStatAfter = await lstat(groupWriteFile, { bigint: true });
  assert.deepEqual(
    [groupWriteStatAfter.mode, groupWriteStatAfter.ino, groupWriteStatAfter.mtimeNs, groupWriteStatAfter.ctimeNs],
    [groupWriteStatBefore.mode, groupWriteStatBefore.ino, groupWriteStatBefore.mtimeNs, groupWriteStatBefore.ctimeNs],
  );

  const nonExecutable = inventory.files.find((entry) => entry.mode === 0o644 && entry.destination !== "vendor/t3code/LICENSE");
  assert.ok(nonExecutable);
  const executableConflict = path.join(temporary, "executable-conflict");
  await cp(groupWrite, executableConflict, { recursive: true });
  await rm(path.join(executableConflict, "vendor/t3code/LICENSE"));
  await chmod(path.join(executableConflict, nonExecutable.destination), 0o744);
  const executableBefore = await snapshot(executableConflict);
  assert.match(sync(executableConflict, [], 1).stderr, /Destination conflict/);
  assert.deepEqual(await snapshot(executableConflict), executableBefore); // no partial missing-file creation

  const unsafeMode = path.join(temporary, "unsafe-special-mode");
  await cp(groupWrite, unsafeMode, { recursive: true });
  await rm(path.join(unsafeMode, "vendor/t3code/LICENSE"));
  for (const bits of [0o4000, 0o2000, 0o1000]) {
    const unsafeFile = path.join(unsafeMode, nonExecutable.destination);
    await chmod(unsafeFile, bits | 0o644);
    assert.equal((await lstat(unsafeFile)).mode & 0o7000, bits);
    const unsafeBefore = await snapshot(unsafeMode);
    assert.match(sync(unsafeMode, [], 1).stderr, /Unsafe special-mode destination/);
    assert.deepEqual(await snapshot(unsafeMode), unsafeBefore);
  }

  const conflict = path.join(temporary, "conflict");
  await cp(destination, conflict, { recursive: true });
  const missing = path.join(conflict, "vendor/t3code/LICENSE");
  await rm(missing);
  await appendFile(path.join(conflict, patched.destination), "\n// deliberate destination conflict\n");
  const conflicted = await snapshot(conflict);
  assert.match(sync(conflict, [], 1).stderr, /Destination conflict/);
  assert.deepEqual(await snapshot(conflict), conflicted); // missing LICENSE must not be partially restored
  const adaptedHost = adaptations.outputs.find((entry) => entry.provenance === "adapted-upstream" && !entry.destination.startsWith("vendor/t3code/"));
  assert.ok(adaptedHost);
  const hostConflict = path.join(temporary, "host-output-conflict");
  await cp(destination, hostConflict, { recursive: true });
  await rm(path.join(hostConflict, "vendor/t3code/LICENSE"));
  await appendFile(path.join(hostConflict, adaptedHost.destination), "\n// deliberate host adaptation conflict\n");
  const hostConflictBefore = await snapshot(hostConflict);
  assert.match(sync(hostConflict, [], 1).stderr, /Destination conflict/);
  assert.deepEqual(await snapshot(hostConflict), hostConflictBefore);

  const clone = path.join(temporary, "source-clone");
  command("git", ["clone", "--quiet", "--local", "--no-hardlinks", "--no-checkout", source, clone]);
  command("git", ["-C", clone, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", inventory.upstreamCommit]);
  await appendFile(path.join(clone, "LICENSE"), "\nwrong-source-hash\n");
  assert.match(sync(path.join(temporary, "wrong-hash"), [], 1, clone).stderr, /Wrong source hash\/blob/);
  await rm(path.join(clone, "LICENSE"));
  command("git", ["-C", clone, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--", "LICENSE"]);
  command("git", ["-C", clone, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=PM sync fixture", "-c", "user.email=sync-fixture@invalid", "commit", "--quiet", "--allow-empty", "-m", "wrong source commit fixture"]);
  assert.match(sync(path.join(temporary, "wrong-commit"), [], 1, clone).stderr, /Wrong source commit/);

  const badTool = path.join(temporary, "bad-patch-tool");
  await cp(destination, badTool, { recursive: true });
  await copyHostInputs(badTool);
  await appendFile(path.join(badTool, patched.patch.path), "\n");
  assert.match(sync(path.join(temporary, "wrong-patch"), [], 1, source, path.join(badTool, "vendor/t3code/scripts/sync.mjs")).stderr, /Wrong patch hash/);

  const badAdaptationTool = path.join(temporary, "bad-adaptation-tool");
  await cp(destination, badAdaptationTool, { recursive: true });
  await copyHostInputs(badAdaptationTool);
  const adaptationFile = path.join(badAdaptationTool, "vendor/t3code/mcp-skills-adaptations.json");
  const alteredAdaptations = JSON.parse(await readFile(adaptationFile, "utf8"));
  alteredAdaptations.outputs.find((entry) => entry.inputs.length).inputs[0].sha256 = "0".repeat(64);
  await writeFile(adaptationFile, JSON.stringify(alteredAdaptations));
  const badAdaptationDestination = path.join(temporary, "bad-adaptation-output");
  assert.match(sync(badAdaptationDestination, [], 1, source, path.join(badAdaptationTool, "vendor/t3code/scripts/sync.mjs")).stderr, /Adaptation original hash\/blob conflict/);
  await assert.rejects(lstat(badAdaptationDestination), { code: "ENOENT" });

  const symlinkRoot = path.join(temporary, "symlink-destination");
  await mkdir(symlinkRoot);
  await symlink(destination, path.join(symlinkRoot, "vendor"), process.platform === "win32" ? "junction" : "dir");
  assert.match(sync(symlinkRoot, [], 1).stderr, /Unsafe symlink\/non-directory/);
  assert.deepEqual(await snapshot(destination), before);
  console.log(JSON.stringify({ cleanOfflineReconstruction: true, repeatNoDiff: true, pristine: true, unrelatedPmPreserved: true, destinationConflictRefusedBeforeWrites: true, dualSourceAdaptations: true, hostAdaptationConflictRefusedBeforeWrites: true, adaptationOriginalHashRefusedBeforeWrites: true, groupWriteAcceptedUntouched: true, executableModeConflictRefusedBeforeWrites: true, unsafeSpecialModesRefusedBeforeWrites: true, wrongSourceHashRefused: true, wrongCommitRefused: true, wrongPatchRefused: true, hostToolDriftRefusedBeforeWrites: true, symlinkRefused: true, files: first.files }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
