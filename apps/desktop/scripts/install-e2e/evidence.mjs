import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isDeepStrictEqual } from "node:util";
export const INSTALL_E2E_SCENARIOS = Object.freeze([
  "silent-install", "installed-start-health", "overwrite-install", "baseline-install",
  "version-upgrade", "interrupted-upgrade-recovery", "stop-owned-processes",
  "uninstall-app-only", "uninstall-app-runtime", "uninstall-full", "uninstall-data-only",
]);
export const DATA_COMPONENTS = Object.freeze(["postgres", "markdown", "agent", "userData"]);
export const INSTALL_E2E_HARNESS = Object.freeze([
  "apps/desktop/scripts/install-e2e/windows.mjs", "apps/desktop/scripts/install-e2e/evidence.mjs",
  "apps/desktop/scripts/install-e2e/native-evidence.ps1", "apps/desktop/scripts/install-e2e/provision-windows.ps1",
  "apps/desktop/src/private-state.mjs",
]);
export const INSTALL_E2E_UNINSTALL_MATRIX = Object.freeze({
  "uninstall-app-only": Object.freeze({ installationRoot: true, app: false, runtime: true, dataRoot: true, userDataRoot: true, ownedData: true, ownedUserState: true, registry: false, shortcuts: false, projects: true, userOwnedFile: true, external: true }),
  "uninstall-app-runtime": Object.freeze({ installationRoot: false, app: false, runtime: false, dataRoot: true, userDataRoot: true, ownedData: true, ownedUserState: true, registry: false, shortcuts: false, projects: true, userOwnedFile: true, external: true }),
  "uninstall-full": Object.freeze({ installationRoot: false, app: false, runtime: false, dataRoot: true, userDataRoot: true, ownedData: false, ownedUserState: false, registry: false, shortcuts: false, projects: true, userOwnedFile: true, external: true }),
  "uninstall-data-only": Object.freeze({ installationRoot: true, app: true, runtime: true, dataRoot: true, userDataRoot: true, ownedData: false, ownedUserState: false, registry: true, shortcuts: true, projects: true, userOwnedFile: true, external: true }),
});
const hashPattern = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(`Invalid install E2E evidence: ${message}`); };
const same = isDeepStrictEqual;
export function safeMaterialPath(path) {
  return typeof path === "string" && path.startsWith("evidence/") && !path.includes("\\")
    && !/[:\0\r\n<>"|?*]/.test(path) && !isAbsolute(path)
    && path.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function materialRecord(root, path) {
  if (!safeMaterialPath(path)) fail("unsafe material path");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("unsafe material root");
  const file = resolve(root, path);
  for (let current = file; current !== resolve(root); current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current === file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()))
      fail("material must have real, unaliased file/directory ancestors");
    if (relative(root, current).startsWith(`..${sep}`)) fail("escaping material");
  }
  const info = await lstat(file);
  return { path, bytes: info.size, sha256: await sha256File(file) };
}
function sourceIdentity(source) {
  return source && /^[a-f0-9]{40}$/.test(source.commit) && typeof source.dirty === "boolean" && hashPattern.test(source.sha256);
}
function artifactIdentity(artifact) {
  return artifact && typeof artifact.path === "string" && /^[^\\/:]+\.exe$/.test(artifact.path)
    && hashPattern.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0;
}
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value ?? "");
    if (!match) fail("versions must be exact semantic versions");
    return { numbers: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") };
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export function validateSnapshot(snapshot) {
  if (snapshot?.kind !== "data-snapshot" || snapshot.schemaVersion !== 1 || typeof snapshot.fixtureId !== "string" || !snapshot.fixtureId)
    fail("missing data snapshot identity");
  for (const component of DATA_COMPONENTS) {
    const entries = snapshot.components?.[component]?.entries;
    if (!Array.isArray(entries) || !entries.length) fail(`empty ${component} snapshot`);
    const names = new Set();
    for (const entry of entries) {
      if (typeof entry.path !== "string" || !entry.path || names.has(entry.path) || !hashPattern.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) fail(`invalid ${component} snapshot entry`);
      names.add(entry.path);
    }
  }
  return snapshot;
}
export function assertDataPreserved(before, after) {
  validateSnapshot(before); validateSnapshot(after);
  if (before.fixtureId !== after.fixtureId) fail("fixture identity changed");
  for (const component of DATA_COMPONENTS) {
    const normalize = (snapshot) => [...snapshot.components[component].entries].sort((a, b) => a.path.localeCompare(b.path));
    if (!same(normalize(before), normalize(after))) fail(`${component} data was not preserved`);
  }
  return true;
}
export function validateReceiptIdentity(receipt, manifest) {
  if (!manifest || receipt?.schemaVersion !== 1 || receipt.kind !== "desktop-windows-install-e2e" || receipt.status !== "passed") fail("receipt did not pass");
  if (receipt.target !== "win32-x64" || receipt.target !== manifest.target || receipt.version !== manifest.version || receipt.signing !== manifest.signing)
    fail("release target/version/signing mismatch");
  if (!sourceIdentity(receipt.source) || !same(receipt.source, { commit: manifest.source.commit, dirty: manifest.source.dirty, sha256: manifest.source.sha256 }))
    fail("commit/dirty source digest mismatch");
  if (!artifactIdentity(receipt.artifact) || !manifest.artifacts.some((entry) => same(entry, receipt.artifact))) fail("installer artifact mismatch");
  const run = receipt.run;
  if (!run || !/^\d+$/.test(run.id) || !/^[1-9]\d*$/.test(run.attempt) || !/^[^/\s]+\/[^/\s]+$/.test(run.repository) || run.commit !== receipt.source.commit)
    fail("missing native run/attempt identity");
  if (manifest.ci && (run.id !== manifest.ci.runId || run.attempt !== manifest.ci.attempt || run.repository !== manifest.ci.repository || run.commit !== manifest.ci.commit))
    fail("native receipt belongs to another build run/attempt");
  if (receipt.native?.platform !== "win32" || receipt.native.arch !== "x64" || receipt.native.isolatedAccount !== true
    || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(receipt.native.accountSid ?? "") || receipt.native.administrator !== false)
    fail("missing real native isolated account boundary");
  if (receipt.controller?.scope !== "installed-electron-app-asar" || !hashPattern.test(receipt.controller.appAsarSha256)) fail("checkout controller is not installer evidence");
  if (!receipt.baseline || !sourceIdentity(receipt.baseline.source) || !artifactIdentity(receipt.baseline.artifact) || !hashPattern.test(receipt.baseline.appAsarSha256)
    || compareVersions(receipt.baseline.version, receipt.version) >= 0 || receipt.baseline.artifact.sha256 === receipt.artifact.sha256
    || !/^\d+$/.test(receipt.baseline.run?.id ?? "") || !/^[1-9]\d*$/.test(receipt.baseline.run?.attempt ?? ""))
    fail("true upgrade requires a supplied exact older baseline artifact");
  if (receipt.compatibility?.dataSchema !== 1 || receipt.compatibility?.postgresMajor !== 16 || !hashPattern.test(receipt.compatibility?.migrationsSha256)
    || !same(receipt.compatibility, manifest.installStamp?.compatibility) || !same(receipt.baseline.compatibility, receipt.compatibility))
    fail("changed data/migration compatibility cannot be accepted as installer-only recovery");
  if (receipt.harness?.sourceSha256 !== receipt.source.sha256 || !Array.isArray(receipt.harness.files)
    || !same(receipt.harness.files.map((entry) => entry.path).sort(), [...INSTALL_E2E_HARNESS].sort())
    || receipt.harness.files.some((entry) => !hashPattern.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0))
    fail("execution harness is not bound to the exact source inventory");
  if (!Array.isArray(receipt.scenarios) || !same(receipt.scenarios.map((entry) => entry.name).sort(), [...INSTALL_E2E_SCENARIOS].sort())
    || receipt.scenarios.some((entry) => entry.status !== "passed")) fail("required native scenarios are missing, duplicated or failed");
  return receipt;
}
async function listMaterials(root, directory = join(root, "evidence")) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe evidence directory");
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("linked evidence");
    if (entry.isDirectory()) paths.push(...await listMaterials(root, file));
    else if (entry.isFile()) paths.push(relative(root, file).split(sep).join("/"));
    else fail("unsupported evidence entry");
  }
  return paths.sort();
}
export async function verifyInstallE2EReceipt(receiptPath, { output, manifest, finalArtifacts } = {}) {
  const root = dirname(resolve(receiptPath));
  const actualRoot = await realpath(root);
  if ((process.platform === "win32" ? actualRoot.toLowerCase() !== root.toLowerCase() : actualRoot !== root)) fail("receipt directory has a redirected ancestor");
  const receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.nlink !== 1) fail("unsafe receipt");
  const receipt = validateReceiptIdentity(JSON.parse(await readFile(receiptPath, "utf8")), manifest);
  const checked = finalArtifacts?.artifacts?.find((entry) => entry.path === receipt.artifact.path);
  if (finalArtifacts?.status !== "passed" || !checked || checked.sha256 !== receipt.artifact.sha256 || checked.bytes !== receipt.artifact.bytes || checked.application?.sha256 !== receipt.controller.appAsarSha256)
    fail("installed app.asar does not match the verified final installer");
  if (output && await sha256File(join(output, receipt.artifact.path)) !== receipt.artifact.sha256) fail("installer bytes changed");
  if (output) {
    const source = JSON.parse(await readFile(join(output, "desktop-source.json"), "utf8"));
    if (source.sha256 !== receipt.source.sha256 || source.commit !== receipt.source.commit || source.dirty !== receipt.source.dirty
      || receipt.harness.files.some((entry) => !source.files?.some((file) => file.path === entry.path && file.sha256 === entry.sha256 && file.bytes === entry.bytes)))
      fail("execution harness differs from corresponding source material");
  }
  if (!Array.isArray(receipt.materials) || !receipt.materials.length) fail("missing native logs/materials");
  const names = receipt.materials.map((entry) => entry.path);
  if (new Set(names.map((path) => path.toLowerCase())).size !== names.length || names.some((path) => !safeMaterialPath(path)) || !same([...names].sort(), await listMaterials(root)))
    fail("material inventory must be exact");
  const documents = new Map();
  for (const expected of receipt.materials) {
    const actual = await materialRecord(root, expected.path);
    if (!same(actual, expected)) fail(`material hash/size changed: ${expected.path}`);
    if (expected.path.endsWith(".json")) documents.set(expected.path, JSON.parse(await readFile(join(root, expected.path), "utf8")));
  }
  const get = (path, kind) => {
    const value = documents.get(path);
    if (!value || value.schemaVersion !== 1 || value.kind !== kind) fail(`missing ${kind} material`);
    return value;
  };
  for (const scenario of receipt.scenarios) {
    if (!Array.isArray(scenario.materials) || !scenario.materials.length || scenario.materials.some((path) => !names.includes(path))) fail("unbound scenario evidence");
    const proof = get(scenario.proof, "scenario-proof");
    if (proof.name !== scenario.name || proof.status !== "passed" || !scenario.materials.includes(scenario.proof)) fail("scenario proof mismatch");
    if (!Array.isArray(proof.commands) || !proof.commands.length) fail("scenario has no executed commands");
    for (const path of proof.commands) {
      const command = get(path, "command");
      const expectedFault = scenario.name === "interrupted-upgrade-recovery" && command.interrupted === true && command.executableScope === "installer" && same(command.artifact, receipt.artifact)
        && (command.exitCode === null && command.signal === "SIGKILL" || Number.isInteger(command.exitCode) && command.exitCode > 0);
      if (!scenario.materials.includes(path) || command.timedOut || (command.exitCode !== 0 || command.signal) && !expectedFault
        || !scenario.materials.includes(command.stdout) || !scenario.materials.includes(command.stderr) || !command.executable || !command.startedAt || !command.finishedAt)
        fail("failed, missing or unhashed command/log evidence");
    }
    const commands = proof.commands.map((path) => get(path, "command"));
    const requiresInstaller = ["silent-install", "overwrite-install", "baseline-install", "version-upgrade", "interrupted-upgrade-recovery"].includes(scenario.name);
    if (requiresInstaller) {
      const expected = scenario.name === "baseline-install" ? receipt.baseline.artifact : receipt.artifact;
      if (!commands.some((command) => command.executableScope === "installer" && same(command.artifact, expected)))
        fail("scenario does not execute its exact installer artifact");
    }
    if (!["silent-install"].includes(scenario.name) && !commands.some((command) => command.executableScope === "installed-controller" && hashPattern.test(command.controllerAsarSha256)))
      fail("scenario did not execute an installed controller");
    if (scenario.name.startsWith("uninstall-") && !commands.some((command) => command.executableScope === "installed-uninstaller"))
      fail("uninstall matrix must execute the installed native NSIS uninstaller");
    const state = get(proof.state, "native-state");
    if (!scenario.materials.includes(proof.state) || state.accountSid !== receipt.native.accountSid || !Array.isArray(state.registry)
      || !Array.isArray(state.shortcuts) || !Array.isArray(state.runtimeRegistry) || !Array.isArray(state.processes) || !Array.isArray(state.paths) || !state.paths.length
      || state.paths.some((entry) => entry.exists && (entry.reparse !== false || entry.aclVerified !== true))) fail("missing ACL/reparse/registry/shortcut/process evidence");
    const observed = new Map(state.paths.map((entry) => [entry.label, entry]));
    if (observed.size !== state.paths.length || ["app", "runtime", "workspaceRuntime", "data", "userData", "external"].some((label) => !observed.has(label))
      || state.administrator !== false || !state.installRoot || !state.userDataDir
      || state.processes.some((process) => !Number.isSafeInteger(process.pid) || process.pid <= 0 || !process.creationTime || !process.executable || process.ownerSid !== receipt.native.accountSid))
      fail("incomplete observed root or owned PID/birth/image evidence");
    const expectedControllerAsar = ["baseline-install", "interrupted-upgrade-recovery"].includes(scenario.name) ? receipt.baseline.appAsarSha256 : receipt.controller.appAsarSha256;
    for (const command of commands.filter((entry) => entry.executableScope === "installed-controller")) {
      if (command.installRoot !== state.installRoot || !command.executable.toLowerCase().startsWith(`${state.installRoot.toLowerCase()}\\`)
        || command.controllerAsarSha256 !== expectedControllerAsar)
        fail("controller command is not bound to the observed installed root/payload");
    }
    const responses = scenario.materials.map((path) => documents.get(path)).filter((entry) => entry?.kind === "installed-controller");
    if (scenario.name === "stop-owned-processes") {
      if (!responses.some((entry) => entry.operation === "stop" && entry.ok === true && entry.result?.stopped === true && entry.result.remainingProcesses === 0))
        fail("stop criterion lacks successful installed-controller shutdown result");
    } else if (scenario.name !== "silent-install") {
      const expected = ["baseline-install", "interrupted-upgrade-recovery"].includes(scenario.name) ? receipt.baseline : receipt;
      const started = responses.find((entry) => entry.operation === "start-health" && entry.ok === true && entry.installStamp?.version === expected.version
        && entry.installStamp.commit === expected.source.commit && entry.installStamp.source?.sha256 === expected.source.sha256 && entry.installStamp.source?.dirty === expected.source.dirty);
      if (!started || ["ready", "database", "storage", "worker", "core", "pmPasswordLogin", "agentAuthenticated", "anonymousAgentDenied"].some((key) => started.result?.[key] !== true)
        || !/^http:\/\/127\.0\.0\.1:\d+$/.test(started.result.origin ?? "") || !Array.isArray(started.result.processes) || !started.result.processes.length)
        fail("scenario lacks actual installed PM/Agent/database health result");
      validateSnapshot({ schemaVersion: 1, kind: "data-snapshot", ...started.result.snapshot });
    }
    if (scenario.name === "installed-start-health") {
      const controller = get(proof.controller, "installed-controller");
      if (!controller.ok || controller.operation !== "start-health" || controller.result?.ready !== true
        || controller.installStamp?.version !== receipt.version || !state.processes.length || !state.registry.length || !state.shortcuts.length)
        fail("installed startup lacks real health/process/registration evidence");
      validateSnapshot(get(proof.snapshot, "data-snapshot"));
    }
    if (proof.preservation) {
      const before = validateSnapshot(get(proof.preservation.before, "data-snapshot"));
      const after = validateSnapshot(get(proof.preservation.after, "data-snapshot"));
      if (!scenario.materials.includes(proof.preservation.before) || !scenario.materials.includes(proof.preservation.after)) fail("unbound data snapshots");
      assertDataPreserved(before, after);
    }
    if (["overwrite-install", "version-upgrade", "interrupted-upgrade-recovery", "uninstall-app-only", "uninstall-app-runtime"].includes(scenario.name) && !proof.preservation)
      fail("missing nonempty four-component preservation assertion");
    if (scenario.name === "version-upgrade" && (proof.fromVersion !== receipt.baseline.version || proof.toVersion !== receipt.version)) fail("same-version reinstall is not upgrade");
    if (scenario.name === "overwrite-install" && (proof.fromVersion !== receipt.version || proof.toVersion !== receipt.version)) fail("overwrite must remain a separately named same-version reinstall");
    if (scenario.name === "interrupted-upgrade-recovery") {
      if (proof.mutationObserved !== true || proof.recoveredVersion !== receipt.baseline.version || proof.interruptedPidIdentityVerified !== true
        || proof.recoveryCompatibility !== "unchanged-pre-upgrade-tree-no-candidate-start" || proof.recoveryScope !== "installer-interruption-only"
        || proof.migrationRollbackExecuted !== false || proof.originalDataIdentityPreserved !== true)
        fail("interruption must preserve original pre-upgrade identity; migration rollback cannot be inferred");
      const mutation = get(proof.payloadMutation, "payload-mutation");
      if (mutation.beforeSha256 !== receipt.baseline.appAsarSha256 || !mutation.observedAt || !mutation.after
        || mutation.after.exists !== false && (!hashPattern.test(mutation.after.sha256) || mutation.after.sha256 === mutation.beforeSha256))
        fail("interruption lacks an observed payload content mutation");
      const fault = get(proof.interruption, "interruption");
      const interrupted = commands.find((command) => command.interrupted === true && command.executableScope === "installer");
      if (!interrupted || fault.identityVerified !== true || fault.pid !== interrupted.pid || fault.creationTime !== interrupted.creationTime || fault.executable !== interrupted.executable)
        fail("interruption fault lacks exact installer PID/birth/image identity");
      if (fault.heldHandle !== true || fault.termination?.killReturned !== true || fault.termination.signal !== "SIGKILL"
        || fault.termination.exitCode !== interrupted.exitCode || fault.termination.exitSignal !== interrupted.signal)
        fail("fault injection was not bound to the original spawned installer process handle");
      const quiescence = get(proof.installerTree, "installer-tree-quiescence");
      if (quiescence.rootPid !== fault.pid || quiescence.identityVerified !== true || quiescence.stopped !== true || quiescence.remainingProcesses !== 0
        || !Array.isArray(quiescence.processes) || !quiescence.processes.some((entry) => entry.pid === fault.pid && entry.creationTime === fault.creationTime && entry.executable === fault.executable)
        || quiescence.processes.some((entry) => entry.ownerSid !== receipt.native.accountSid || !entry.creationTime || !entry.executable))
        fail("installer descendants did not reach identity-bound quiescence before restoration");
      const copy = get(proof.recoveryCopy, "pre-upgrade-copy");
      if (!copy.verified || !copy.fileFsync || copy.source === copy.destination || !Array.isArray(copy.files) || !copy.files.length
        || copy.startupSource !== "original-inode-tree" || copy.copyPurpose !== "diagnostic-only-never-started")
        fail("missing verified independent pre-upgrade diagnostic copy");
      const restoration = get(proof.restoration, "rollback-restoration");
      if (restoration.status !== "passed" || restoration.originalRoot !== state.installRoot || restoration.dataMigrated !== false
        || !same(restoration.baselineSource, receipt.baseline.source) || !hashPattern.test(restoration.recordSha256) || !hashPattern.test(restoration.helperSha256))
        fail("persistent native rollback restoration is missing or not bound to exact baseline");
    }
    if (["stop-owned-processes", "uninstall-app-only", "uninstall-app-runtime", "uninstall-full", "uninstall-data-only"].includes(scenario.name) && state.processes.length !== 0)
      fail("owned processes remain after stop/uninstall");
    if (scenario.name.startsWith("uninstall-")) {
      const expected = INSTALL_E2E_UNINSTALL_MATRIX[scenario.name];
      if (!same(proof.remaining, expected)) fail("uninstall golden preservation/deletion matrix mismatch");
      validateSnapshot(get(proof.beforeSnapshot, "data-snapshot"));
      const before = get(proof.beforeState, "native-state");
      if (["data", "userData", "runtime", "workspaceRuntime", "app"].some((label) => !before.paths?.some((entry) => entry.label === label && entry.exists && entry.files > 0))
        || !proof.externalPreservation || !hashPattern.test(proof.externalPreservation.sha256Before)
        || proof.externalPreservation.sha256Before !== proof.externalPreservation.sha256After)
        fail("uninstall lacks nonempty pre-deletion roots or external preservation proof");
      const actual = {
        installationRoot: observed.get("installation")?.exists === true,
        app: observed.get("app").exists, runtime: observed.get("runtime").exists && observed.get("workspaceRuntime").exists,
        dataRoot: observed.get("data").exists, userDataRoot: observed.get("userData").exists,
        ownedData: ["managedPostgres", "agentData", "managedMarkdown"].some((label) => observed.get(label)?.files > 0),
        ownedUserState: observed.get("connection")?.exists === true,
        registry: state.registry.length > 0, shortcuts: state.shortcuts.length > 0,
        projects: observed.get("projects")?.exists === true, userOwnedFile: observed.get("userOwnedFile")?.exists === true, external: observed.get("external").exists,
      };
      if (!same(actual, expected)) fail("observed uninstall roots/registry/shortcuts differ from golden matrix");
      if (scenario.name === "uninstall-app-only" ? state.runtimeRegistry.length !== 1 || state.runtimeRegistry[0].installLocation !== state.installRoot : state.runtimeRegistry.length !== 0)
        fail("retained runtime registration differs from uninstall mode");
      const cleanup = get(proof.cleanup, "uninstall-cleanup");
      const mode = scenario.name === "uninstall-app-runtime" ? "app+runtime" : scenario.name.slice("uninstall-".length);
      if (cleanup.mode !== mode || cleanup.status !== "complete" || cleanup.deletionExecuted !== true || cleanup.sourceSha256 !== receipt.source.sha256)
        fail("native uninstall cleanup receipt is incomplete/unbound");
      if (["installation", "managedPostgres", "agentData", "managedMarkdown", "connection", "projects", "userOwnedFile"].some((label) => !observed.has(label)))
        fail("uninstall lacks named owned-component and protected-root observations");
      const controllerPlan = get(proof.plan, "installed-controller");
      const plan = controllerPlan.result;
      const outcome = get(proof.fileOutcome, "uninstall-file-outcome");
      if (controllerPlan.ok !== true || controllerPlan.operation !== "uninstall" || plan?.mode !== mode || plan.status !== "prepared" || plan.deletionExecuted !== false
        || plan.stopped?.stopped !== true || plan.stopped?.remainingProcesses !== 0 || plan.stamp?.source?.sha256 !== receipt.source.sha256
        || !same(plan.roots, outcome.roots) || plan.roots.installation !== state.installRoot || plan.roots.instance !== observed.get("data").path || plan.roots.userData !== state.userDataDir
        || !Array.isArray(plan.delete) || !plan.delete.length || !Array.isArray(plan.preserve) || !plan.preserve.length)
        fail("uninstall outcome lacks its exact stopped installed-controller plan");
      const fileKey = (entry) => {
        if (!["installation", "instance", "userData"].includes(entry.scope) || typeof entry.path !== "string" || /[\\:\0]/.test(entry.path)
          || entry.path.split("/").some((part) => !part || part === "." || part === "..")) fail("unsafe uninstall file outcome path");
        return `${entry.scope}\0${entry.path}`;
      };
      const keys = (entries) => {
        if (!Array.isArray(entries)) fail("missing uninstall file outcomes");
        const result = entries.map(fileKey).sort();
        if (new Set(result).size !== result.length) fail("duplicate uninstall file outcomes");
        return result;
      };
      if (!same(keys(plan.delete), keys(cleanup.deleted)) || !same(keys(plan.delete), keys(outcome.deleted)) || outcome.deleted.some((entry) => entry.exists !== false)
        || !same(keys(plan.preserve), keys(outcome.preserved)) || !same(plan.preserve, cleanup.preserve))
        fail("selected owned files were not all deleted or preserved with exact native outcomes");
      if (!same(keys(plan.deleteDirectories), keys(cleanup.deletedDirectories)) || !same(keys(plan.deleteDirectories), keys(outcome.deletedDirectories))
        || outcome.deletedDirectories.some((entry) => entry.exists !== false))
        fail("selected owned directories were not all removed with exact native outcomes");
      const preserved = new Map(outcome.preserved.map((entry) => [fileKey(entry), entry]));
      for (const entry of plan.preserve) {
        const actualFile = preserved.get(fileKey(entry));
        if (!hashPattern.test(actualFile.sha256) || !Number.isSafeInteger(actualFile.bytes) || actualFile.bytes < 0
          || (entry.transition ? entry.transition !== "retained-runtime-ownership-manifest" || entry.scope !== "installation" || entry.path !== "resources/desktop-install-files.json" || actualFile.transitionVerified !== true
            : actualFile.sha256 !== entry.sha256 || actualFile.bytes !== entry.bytes))
          fail("preserved project/native/client/runtime file bytes changed");
      }
      const destructive = ["full", "data-only"].includes(mode);
      if (destructive ? !["postgres/", "agent-data/"].every((prefix) => plan.delete.some((entry) => entry.scope === "instance" && entry.path.startsWith(prefix)))
        || !plan.delete.some((entry) => entry.scope === "userData" && entry.path === "connection.json")
        : plan.delete.some((entry) => entry.scope !== "installation"))
        fail("uninstall deletion scopes do not match the selected mode");
      if (mode === "data-only" && plan.delete.some((entry) => entry.scope === "installation")) fail("data-only deleted installation files");
      if (plan.delete.some((entry) => entry.scope === "instance" && (entry.path === "projects" || entry.path.startsWith("projects/"))))
        fail("uninstall selected protected project content");
      const protectedFiles = get(proof.protectedFiles, "protected-files");
      if (!Array.isArray(protectedFiles.projects?.before) || !protectedFiles.projects.before.length || !same(protectedFiles.projects.before, protectedFiles.projects.after)
        || !hashPattern.test(protectedFiles.userOwnedFile?.before) || protectedFiles.userOwnedFile.before !== protectedFiles.userOwnedFile.after)
        fail("protected project tree or unknown userData file was changed");
    }
  }
  return { receipt, materials: receipt.materials, summary: {
    status: "passed", scope: "native-windows-installed-controller-lifecycle", installationExecuted: true,
    electronGuiExecuted: false, versionUpgradeExecuted: true, scenarios: receipt.scenarios.map(({ name }) => name),
    artifact: receipt.artifact, source: receipt.source, run: receipt.run,
    recoveryScope: "Installer interruption before any candidate data migration; migration-failure rollback is not exercised.",
    dataPreservationScope: "Nonempty PM/Markdown/Agent fixture records and saved desktop userData; not arbitrary real user data or Provider accounts.",
  } };
}
