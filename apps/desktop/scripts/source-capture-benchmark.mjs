import assert from "node:assert/strict";
import childProcess, { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), "../../..");
const frozenPaths = ["apps/desktop/scripts/release-materials.mjs", "packages/pm-core/windows-reparse.ts"];
// Static local import closure shared by the frozen and candidate capture modules.
// Keep this explicit: a provenance file must not quietly omit a changed helper.
const sharedPaths = [
  "package.json",
  "packages/pm-core/platform.ts", "packages/pm-core/private-path.ts",
  "apps/desktop/scripts/runtime-manifest.mjs", "apps/desktop/scripts/stage-workspace.mjs",
  "apps/desktop/scripts/license-notices.mjs", "apps/desktop/scripts/dependency-layout.mjs",
  "apps/server/agent/scripts/cc-switch.mjs", "apps/server/agent/scripts/external-agent-packages.mjs",
  "vendor/openhands-extensions/scripts/web-build.mjs", "vendor/openhands-extensions/scripts/provenance.mjs",
  "vendor/cc-switch/scripts/closure.mjs", "vendor/cc-switch/scripts/provenance.mjs",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (files) => sha256(JSON.stringify(files));
const sumBytes = (files) => files.reduce((total, file) => total + file.bytes, 0);
const portablePath = (value) => typeof value === "string" && value.length > 0 && !isAbsolute(value)
  && !/[\\:\0]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");

async function provenanceFor(baselineRoot, currentRoot, filename) {
  const source = JSON.parse(await readFile(filename, "utf8"));
  if (source.schemaVersion !== 1 || typeof source.origin !== "string" || !source.origin.trim()
    || !Array.isArray(source.frozenFiles) || !Array.isArray(source.sharedFiles) || !source.sharedFiles.length)
    throw new Error("Baseline provenance requires schemaVersion 1, origin, frozenFiles and sharedFiles.");
  if (JSON.stringify(source.frozenFiles.map((file) => file.path).sort()) !== JSON.stringify([...frozenPaths].sort()))
    throw new Error("Baseline frozenFiles must identify the exact pre-edit capture and Windows attribute modules.");
  if (JSON.stringify(source.sharedFiles.map((file) => file.path).sort()) !== JSON.stringify([...sharedPaths].sort()))
    throw new Error("Baseline sharedFiles must cover the exact unchanged local import closure.");
  const names = new Set();
  for (const file of [...source.frozenFiles, ...source.sharedFiles]) {
    if (!portablePath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || names.has(file.path))
      throw new Error("Invalid or duplicate baseline provenance file.");
    names.add(file.path);
    const baselineBytes = await readFile(join(baselineRoot, file.path));
    if (sha256(baselineBytes) !== file.sha256) throw new Error(`Frozen baseline provenance mismatch: ${file.path}`);
  }
  for (const file of source.sharedFiles) {
    if (sha256(await readFile(join(currentRoot, file.path))) !== file.sha256)
      throw new Error(`Baseline and candidate must use identical shared helper bytes: ${file.path}`);
  }
  const sharedDependencies = [];
  for (const [specifier, from] of [["tar", frozenPaths[0]], ["yaml", "apps/desktop/scripts/stage-workspace.mjs"], ["esbuild", "apps/server/agent/scripts/cc-switch.mjs"]]) {
    const baselineEntry = await realpath(createRequire(join(baselineRoot, from)).resolve(specifier));
    const candidateEntry = await realpath(createRequire(join(currentRoot, from)).resolve(specifier));
    if (baselineEntry !== candidateEntry) throw new Error(`Both module trees must use the same installed dependency: ${specifier}`);
    sharedDependencies.push({ specifier, from, entrySha256: sha256(await readFile(baselineEntry)) });
  }
  // Record candidate module bytes too; neither side gets a runtime disable switch.
  const candidateFiles = await Promise.all(frozenPaths.map(async (path) => ({ path, sha256: sha256(await readFile(join(currentRoot, path))) })));
  return { ...source, candidateFiles, sharedDependencies };
}

async function syntheticInput(root) {
  const entries = {
    "README.md": "Synthetic source-capture smoke; not a repository performance sample.\n",
    "apps/desktop/package.json": JSON.stringify({ name: "@agent-workspace/desktop", version: "0.1.0" }) + "\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
      `apps/example/group-${index % 3}/file-${index}.ts`,
      `export const fixture${index} = ${JSON.stringify(`public fixture ${index}\n`)};\n`,
    ])),
  };
  const files = [];
  for (const path of Object.keys(entries).sort()) {
    const bytes = Buffer.from(entries[path]);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes, { mode: 0o644 });
    files.push({ path, bytes: bytes.length, mode: 0o644, sha256: sha256(bytes) });
  }
  const source = { schemaVersion: 1, commit: "a".repeat(40), dirty: true, files, sha256: digest(files) };
  await writeFile(join(root, "desktop-source.json"), JSON.stringify(source, null, 2) + "\n");
}

async function sourceInventory(root) {
  if (await lstat(join(root, ".git")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }))
    throw new Error("Benchmark input must be a reviewed gitless desktop-source snapshot, not a mutable Git checkout.");
  const bytes = await readFile(join(root, "desktop-source.json"));
  const source = JSON.parse(bytes);
  if (!Array.isArray(source.files) || !source.files.length || digest(source.files) !== source.sha256)
    throw new Error("Input inventory digest is invalid.");
  return { source, manifestSha256: sha256(bytes) };
}

// Instrument real child_process entry points, not a replacement attribute helper.
// execFileSync/spawnSync use internal native spawn paths; async APIs converge on
// ChildProcess.spawn. Sync builtin exports before loading either implementation.
function instrumentLaunches() {
  const counts = { totalCalls: 0, powershellCalls: 0, pathAttributeCalls: 0, pathAttributeElapsedMs: 0 };
  const observe = (command, args) => {
    counts.totalCalls++;
    const powershell = /^(?:powershell|pwsh)(?:\.exe)?$/i.test(basename(String(command)));
    if (powershell) counts.powershellCalls++;
    const attributes = powershell && Array.isArray(args) && args.some((arg) => String(arg).includes("PmNativePathAttributes"));
    if (attributes) counts.pathAttributeCalls++;
    return attributes;
  };
  for (const name of ["execFileSync", "spawnSync"]) {
    const original = childProcess[name];
    childProcess[name] = function (command, args, ...options) {
      const attributes = observe(command, args);
      const start = performance.now();
      try { return original.call(this, command, args, ...options); }
      finally { if (attributes) counts.pathAttributeElapsedMs += performance.now() - start; }
    };
  }
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (options) {
    observe(options.file, options.args);
    return originalSpawn.call(this, options);
  };
  syncBuiltinESMExports();
  return () => ({ ...counts });
}
const difference = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));

async function worker({ moduleRoot, input, output }) {
  const launches = instrumentLaunches();
  const importStart = performance.now();
  const implementation = await import(pathToFileURL(join(moduleRoot, frozenPaths[0])).href);
  const importElapsedMs = performance.now() - importStart;
  const expected = (await sourceInventory(input)).source;
  implementation.validateSource(expected);
  const metrics = [];
  const before = launches();
  const start = performance.now();
  const source = await implementation.captureSource(output, input, { onMetrics: (event) => metrics.push(event) });
  const elapsedMs = performance.now() - start;
  const after = launches();
  const captureLaunches = difference(after, before);
  for (const event of metrics) {
    if (event.nativeCallScope === "windows-path-attributes")
      assert.equal(event.nativeCalls, captureLaunches.pathAttributeCalls, "Reported native calls differ from actual helper launches");
  }
  assert.deepEqual(source.files, expected.files, "capture inventory differs from its reviewed input");
  assert.equal(source.sha256, expected.sha256);
  assert.equal(source.commit, expected.commit);
  assert.equal(source.dirty, expected.dirty);
  assert.deepEqual(JSON.parse(await readFile(join(output, "desktop-source.json"), "utf8")), source);
  for (const file of source.files) {
    const filename = join(output, file.path);
    const stat = await lstat(filename);
    const bytes = await readFile(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), file.path);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
    if (process.platform !== "win32") assert.equal(stat.mode & 0o111 ? 0o755 : 0o644, file.mode, file.path);
  }
  const checkBefore = launches();
  const checkStart = performance.now();
  await implementation.requireUnchangedSource(source, input);
  const requireUnchangedElapsedMs = performance.now() - checkStart;
  return {
    platform: process.platform, arch: process.arch, node: process.version,
    importElapsedMs, elapsedMs, files: source.files.length, bytes: sumBytes(source.files),
    sourceSha256: source.sha256, commit: source.commit, dirty: source.dirty,
    inventory: source.files, launches: captureLaunches,
    launchScope: "actual child_process launches during capture; PowerShell includes scratch ACL setup",
    metrics: metrics.length ? metrics : null,
    requireUnchangedElapsedMs, requireUnchangedLaunches: difference(launches(), checkBefore),
  };
}

async function coldCapture(payload, timeoutMs) {
  return new Promise((accept, reject) => {
    const child = fork(script, ["--worker"], {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--inspect")),
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    let report;
    let error;
    // Phase stdout is not the benchmark protocol, and is deliberately bounded.
    let diagnostic = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { diagnostic = (diagnostic + bytes).slice(-16_384); });
    const timer = setTimeout(() => { error = new Error(`Cold capture exceeded ${timeoutMs}ms; full-input benchmarks require an explicit larger --timeout-ms.`); child.kill(); }, timeoutMs);
    child.on("error", (cause) => { error = cause; });
    child.on("message", (message) => {
      if (message.error) error = new Error(message.error);
      else report = message;
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0 || !report) reject(new Error(`Cold capture failed (${code ?? signal}): ${diagnostic}`));
      else accept(report);
    });
    child.send(payload);
  });
}

async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (!["--baseline-root", "--baseline-provenance", "--current-root", "--input", "--timeout-ms"].includes(option)
      || !process.argv[index + 1] || process.argv[index + 1].startsWith("--") || options[option] !== undefined)
      throw new Error(`Invalid benchmark argument: ${option}`);
    options[option] = process.argv[++index];
  }
  if (!options["--baseline-root"] || !options["--baseline-provenance"])
    throw new Error("Usage: node apps/desktop/scripts/source-capture-benchmark.mjs --baseline-root FROZEN_RUNNABLE_TREE --baseline-provenance PROVENANCE_JSON [--input REVIEWED_GITLESS_SNAPSHOT] [--timeout-ms 180000]");
  const timeoutMs = Number(options["--timeout-ms"] ?? 180_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("--timeout-ms must be between 1 and 3600000.");
  const baselineRoot = await realpath(resolve(options["--baseline-root"]));
  const currentRoot = await realpath(resolve(options["--current-root"] ?? repository));
  if (baselineRoot === currentRoot) throw new Error("Baseline and candidate must be separate module trees.");
  const provenance = await provenanceFor(baselineRoot, currentRoot, resolve(options["--baseline-provenance"]));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "pm-source-capture-benchmark-")));
  try {
    const input = options["--input"] ? await realpath(resolve(options["--input"])) : join(scratch, "input");
    if (!options["--input"]) await syntheticInput(input);
    const expected = await sourceInventory(input);
    const baseline = await coldCapture({ moduleRoot: baselineRoot, input, output: join(scratch, "baseline") }, timeoutMs);
    const candidate = await coldCapture({ moduleRoot: currentRoot, input, output: join(scratch, "candidate") }, timeoutMs);
    if ((await sourceInventory(input)).manifestSha256 !== expected.manifestSha256)
      throw new Error("Input manifest changed between captures; refusing a cross-input timing comparison.");
    assert.deepEqual(await provenanceFor(baselineRoot, currentRoot, resolve(options["--baseline-provenance"])), provenance,
      "Module provenance changed during measurement; refusing a cross-version comparison");
    assert.deepEqual(baseline.inventory, candidate.inventory, "Cross-input comparison refused: source inventories differ");
    for (const field of ["platform", "arch", "node", "files", "bytes", "sourceSha256", "commit", "dirty"])
      assert.equal(baseline[field], candidate[field], `Cross-input comparison refused: ${field} differs`);
    delete baseline.inventory; delete candidate.inventory;
    const nativeWindowsMeasured = process.platform === "win32";
    console.log(JSON.stringify({
      schemaVersion: 1, benchmark: "desktop-source-capture", nativeWindowsMeasured,
      evidenceScope: nativeWindowsMeasured ? "Windows native capture, not installer/build/GUI timing" : `${process.platform} smoke only; NOT Windows native timing`,
      processScope: "separate cold Node processes; filesystem/OS caches are not reset; baseline runs first",
      input: { kind: options["--input"] ? "reviewed-snapshot" : "synthetic-smoke", files: expected.source.files.length, bytes: sumBytes(expected.source.files), sha256: expected.source.sha256, manifestSha256: expected.manifestSha256 },
      provenance, baseline, candidate, inventoriesEqual: true,
      captureElapsedRatio: baseline.elapsedMs / candidate.elapsedMs,
    }, null, 2));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[2] === "--worker") {
  process.once("message", async (payload) => {
    try { process.send(await worker(payload)); process.disconnect(); }
    catch (error) { process.send({ error: error.message }); process.exitCode = 1; process.disconnect(); }
  });
} else {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
