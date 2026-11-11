// Synthetic evidence for non-native validator tests only. Nothing in this
// module starts Electron, PostgreSQL, an installer, or an uninstaller.
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_COMPONENTS, INSTALL_E2E_HARNESS, INSTALL_E2E_SCENARIOS, INSTALL_E2E_UNINSTALL_MATRIX, materialRecord } from "./evidence.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function createReceiptFixture(directory) {
  await mkdir(directory, { recursive: true });
  directory = await realpath(directory);
  const root = join(directory, "receipt"), output = join(directory, "delivery");
  await mkdir(join(root, "evidence"), { recursive: true }); await mkdir(output, { recursive: true });
  const artifactBytes = Buffer.from("synthetic candidate installer identity; not an executable\n");
  const artifact = { path: "candidate.exe", bytes: artifactBytes.length, sha256: hash(artifactBytes) };
  const source = { commit: "1".repeat(40), dirty: true, sha256: "2".repeat(64) };
  const appAsarSha256 = "3".repeat(64), baselineAsar = "4".repeat(64);
  const baseline = { version: "1.0.0", source: { commit: "5".repeat(40), dirty: false, sha256: "6".repeat(64) }, artifact: { path: "baseline.exe", bytes: 20, sha256: "7".repeat(64) }, appAsarSha256: baselineAsar, run: { id: "99", attempt: "1" } };
  const run = { id: "100", attempt: "2", repository: "example/repository", commit: source.commit };
  const harnessFiles = INSTALL_E2E_HARNESS.map((path) => ({ path, bytes: 10, sha256: hash(path) }));
  const compatibility = { dataSchema: 1, postgresMajor: 16, migrationsSha256: "8".repeat(64) };
  const manifest = { schemaVersion: 3, target: "win32-x64", signing: "unsigned", version: "1.1.0", source, artifacts: [artifact], materials: [], ci: { repository: run.repository, commit: run.commit, runId: run.id, attempt: run.attempt },
    installStamp: { formatVersion: 1, appId: "com.projectmanagementagent.v4", commit: source.commit, version: "1.1.0", platform: "win32", arch: "x64", distribution: "nsis", payload: "bundled", updateMechanism: "github-releases", ownership: { installation: "self", scope: "per-user" }, source: { sha256: source.sha256, dirty: source.dirty }, signing: "unsigned", runtime: { node: "24.21.0", postgres: "16.15" }, compatibility },
  };
  const fixtureDataPath = "\\workspace";
  const finalArtifacts = { status: "passed", artifacts: [{ ...artifact, application: { sha256: appAsarSha256 } }] };
  const accountSid = "S-1-5-21-1-2-3-1001";
  const installRoot = "C:\\dovspace-e2e-test\\work\\installed", userDataDir = "C:\\dovspace-e2e-test\\work\\userData";
  const creationTime = "2026-11-09T00:00:00.0000000Z";
  const documents = new Map(), logs = new Map();
  const document = (path, kind, value) => { documents.set(path, { schemaVersion: 1, kind, ...value }); return path; };
  const snapshot = document("evidence/snapshot-before.json", "data-snapshot", { fixtureId: "fixture-synthetic-only", components: Object.fromEntries(DATA_COMPONENTS.map((component) => [component, { entries: [{ path: `${component}/actual-record`, bytes: 10, sha256: hash(component) }] }])) });
  const snapshotAfter = document("evidence/snapshot-after.json", "data-snapshot", structuredClone(documents.get(snapshot)));
  const state = (name, flags, healthy = false) => document(`evidence/${name}-state.json`, "native-state", {
    root: "C:\\dovspace-e2e-test\\work", installRoot, userDataDir, accountSid, administrator: false,
    registry: flags.registry ? [{ key: "HKEY_CURRENT_USER\\Uninstall\\Dovspace", version: manifest.version, installLocation: installRoot }] : [],
    runtimeRegistry: name === "uninstall-app-only" ? [{ installLocation: installRoot, sourceSha256: source.sha256 }] : [],
    shortcuts: flags.shortcuts ? [{ path: "C:\\Users\\dov-e2e-12345678\\Desktop\\PM Agent v4.lnk", target: `${installRoot}\\PM Agent v4.exe` }] : [],
    processes: healthy ? [{ pid: 88, parentPid: 77, creationTime, executable: `${installRoot}\\PM Agent v4.exe`, ownerSid: accountSid }] : [],
    paths: Object.entries({ installation: flags.installationRoot ?? true, app: flags.app, runtime: flags.runtime, workspaceRuntime: flags.runtime, data: flags.dataRoot, userData: flags.userDataRoot, managedPostgres: flags.ownedData, agentData: flags.ownedData, managedMarkdown: flags.ownedData, connection: flags.ownedUserState, projects: flags.projects, userOwnedFile: flags.userOwnedFile, external: flags.external }).map(([label, present]) => ({
      label, path: label === "installation" ? installRoot : label === "userData" ? userDataDir : label === "data" ? userDataDir + fixtureDataPath : `${installRoot}\\${label}`, exists: present, reparse: false, aclVerified: true, files: present ? 1 : 0, bytes: present ? 10 : 0, aclScope: "root", acl: present ? [{ sddl: "synthetic ACL contract only" }] : [],
    })),
  });
  const allPresent = { app: true, runtime: true, dataRoot: true, userDataRoot: true, ownedData: true, ownedUserState: true, registry: true, shortcuts: true, projects: true, userOwnedFile: true, external: true };
  const matrix = INSTALL_E2E_UNINSTALL_MATRIX;
  const scenarios = [];
  for (const name of INSTALL_E2E_SCENARIOS) {
    const materialPaths = [], commands = [];
    const command = (scope, expectedArtifact = artifact, interrupted = false) => {
      const id = `${name}-${commands.length}`;
      const stdout = `evidence/${id}.stdout.log`, stderr = `evidence/${id}.stderr.log`;
      logs.set(stdout, "synthetic contract fixture; no native process was executed\n"); logs.set(stderr, "");
      const path = document(`evidence/${id}-command.json`, "command", {
        executableScope: scope, executable: scope === "installer" ? `C:\\input\\${expectedArtifact.path}` : `${installRoot}\\${scope === "installed-uninstaller" ? "Uninstall PM Agent v4.exe" : "PM Agent v4.exe"}`,
        installRoot, controllerAsarSha256: ["baseline-install", "interrupted-upgrade-recovery"].includes(name) ? baselineAsar : appAsarSha256,
        ...(scope === "installer" ? { artifact: structuredClone(expectedArtifact) } : {}),
        pid: 123, creationTime, arguments: [], startedAt: "2026-11-09T00:00:00.000Z", finishedAt: "2026-11-09T00:00:01.000Z", exitCode: interrupted ? 197 : 0, signal: null, timedOut: false, interrupted, stdout, stderr,
      });
      materialPaths.push(path, stdout, stderr); commands.push(path); return path;
    };
    if (["silent-install", "overwrite-install", "baseline-install", "version-upgrade", "interrupted-upgrade-recovery"].includes(name)) command("installer", name === "baseline-install" ? baseline.artifact : artifact, name === "interrupted-upgrade-recovery");
    if (name !== "silent-install") command("installed-controller");
    if (name.startsWith("uninstall-")) command("installed-uninstaller");
    const statePath = state(name, matrix[name] ?? allPresent, name === "installed-start-health");
    materialPaths.push(statePath);
    const proof = { name, status: "passed", commands, state: statePath };
    const expected = ["baseline-install", "interrupted-upgrade-recovery"].includes(name) ? baseline : { version: manifest.version, source };
    const healthReply = {
      formatVersion: 1, ok: true, operation: "start-health",
      installStamp: { ...structuredClone(manifest.installStamp), version: expected.version, commit: expected.source.commit, source: { sha256: expected.source.sha256, dirty: expected.source.dirty } },
      result: { ready: true, database: true, storage: true, worker: true, core: true, pmPasswordLogin: true, agentAuthenticated: true, anonymousAgentDenied: true,
        origin: "http://127.0.0.1:49152", instanceId: "12345678-1234-4234-8234-123456789abc",
        processes: [{ pid: 88, creationTime, executable: `${installRoot}\\PM Agent v4.exe` }], snapshot: structuredClone(documents.get(snapshot)) },
    };
    if (!["silent-install", "installed-start-health", "stop-owned-processes"].includes(name))
      materialPaths.push(document(`evidence/${name}-health-controller.json`, "installed-controller", healthReply));
    if (name === "stop-owned-processes")
      materialPaths.push(document("evidence/stop-controller.json", "installed-controller", { formatVersion: 1, operation: "stop", ok: true, result: { stopped: true, remainingProcesses: 0 } }));
    if (["overwrite-install", "version-upgrade", "interrupted-upgrade-recovery", "uninstall-app-only", "uninstall-app-runtime"].includes(name)) {
      proof.preservation = { before: snapshot, after: snapshotAfter }; materialPaths.push(snapshot, snapshotAfter);
    }
    if (name === "installed-start-health") {
      proof.controller = document("evidence/healthy-controller.json", "installed-controller", healthReply);
      proof.snapshot = snapshot; materialPaths.push(proof.controller, snapshot);
    }
    if (name === "overwrite-install") Object.assign(proof, { fromVersion: manifest.version, toVersion: manifest.version });
    if (name === "version-upgrade") Object.assign(proof, { fromVersion: baseline.version, toVersion: manifest.version });
    if (name === "interrupted-upgrade-recovery") {
      proof.interruption = document("evidence/interruption.json", "interruption", { pid: 123, creationTime, executable: `C:\\input\\${artifact.path}`, identityVerified: true, heldHandle: true, termination: { signal: "SIGKILL", killReturned: true, exitCode: 197, exitSignal: null }, fault: "terminate-original-spawned-installer-handle-after-payload-mutation" });
      proof.recoveryCopy = document("evidence/pre-upgrade-copy.json", "pre-upgrade-copy", { source: userDataDir, destination: "C:\\dovspace-e2e-test\\copy", files: [{ path: "data", bytes: 10, sha256: hash("data") }], verified: true, fileFsync: true, directoryFsync: false, startupSource: "original-inode-tree", copyPurpose: "diagnostic-only-never-started" });
      proof.payloadMutation = document("evidence/payload-mutation.json", "payload-mutation", { beforeSha256: baselineAsar, after: { exists: false, sha256: null }, observedAt: creationTime });
      proof.restoration = document("evidence/rollback-restoration.json", "rollback-restoration", { status: "passed", originalRoot: installRoot, baselineSource: structuredClone(baseline.source), recordSha256: hash("record"), helperSha256: hash("helper"), dataMigrated: false });
      proof.installerTree = document("evidence/installer-tree-quiescence.json", "installer-tree-quiescence", { rootPid: 123, identityVerified: true, stopped: true, remainingProcesses: 0, processes: [{ pid: 123, creationTime, executable: `C:\\input\\${artifact.path}`, ownerSid: accountSid }] });
      Object.assign(proof, { mutationObserved: true, interruptedPidIdentityVerified: true, recoveredVersion: baseline.version, recoveryCompatibility: "unchanged-pre-upgrade-tree-no-candidate-start", recoveryScope: "installer-interruption-only", migrationRollbackExecuted: false, originalDataIdentityPreserved: true });
      materialPaths.push(proof.interruption, proof.recoveryCopy, proof.payloadMutation, proof.restoration, proof.installerTree);
    }
    if (matrix[name]) {
      const mode = name === "uninstall-app-runtime" ? "app+runtime" : name.slice("uninstall-".length);
      const destructive = ["full", "data-only"].includes(mode);
      const record = (scope, path) => ({ scope, path, bytes: 10, sha256: hash(path) });
      const ownedData = [record("instance", "postgres/base/record"), record("instance", "agent-data/chat.sqlite"), record("instance", "pm-workspaces/workspace.md"), record("instance", "blobs/blob"), record("instance", "chat-spaces/chat"), record("userData", "connection.json"), record("userData", "Network/Cookies")];
      const removed = [...(mode === "data-only" ? [] : [record("installation", "PM Agent v4.exe")]), ...(destructive ? ownedData : [])];
      const removedDirectories = [...(mode === "data-only" ? [] : [{ scope: "installation", path: "locales" }]), ...(destructive ? [{ scope: "instance", path: "postgres/base" }, { scope: "userData", path: "Network" }] : [])];
      const preserved = [record("instance", "projects/project/.pm/core/PROJECT.md"), record("userData", "user-owned-must-survive.txt"), ...(destructive ? [] : ownedData),
        ...(mode === "data-only" ? [record("installation", "PM Agent v4.exe")] : []),
        ...(mode === "app-only" ? [{ scope: "installation", path: "resources/desktop-install-files.json", transition: "retained-runtime-ownership-manifest" }] : [])];
      const roots = { installation: installRoot, instance: userDataDir + fixtureDataPath, userData: userDataDir };
      const selected = { mode, status: "prepared", deletionExecuted: false, stopped: { stopped: true, remainingProcesses: 0 }, stamp: structuredClone(manifest.installStamp), roots, delete: removed, deleteDirectories: removedDirectories, preserve: preserved };
      proof.remaining = structuredClone(matrix[name]); proof.beforeSnapshot = snapshot; proof.beforeState = state(`${name}-before`, allPresent);
      proof.externalPreservation = { sha256Before: hash("external"), sha256After: hash("external") };
      proof.cleanup = document(`evidence/${name}-cleanup.json`, "uninstall-cleanup", { formatVersion: 1, mode, status: "complete", deletionExecuted: true, sourceSha256: source.sha256, deleted: removed.map(({ scope, path }) => ({ scope, path })), deletedDirectories: structuredClone(removedDirectories), preserve: structuredClone(preserved) });
      proof.plan = document(`evidence/${name}-plan.json`, "installed-controller", { operation: "uninstall", ok: true, result: selected });
      proof.fileOutcome = document(`evidence/${name}-file-outcome.json`, "uninstall-file-outcome", { roots: structuredClone(roots), deleted: removed.map(({ scope, path }) => ({ scope, path, exists: false })), deletedDirectories: removedDirectories.map((entry) => ({ ...entry, exists: false })), preserved: preserved.map((entry) => entry.transition ? { ...entry, bytes: 10, sha256: hash("retained-manifest"), transitionVerified: true } : structuredClone(entry)) });
      const projectEntries = [{ path: "project/.pm/core/PROJECT.md", bytes: 10, sha256: hash("project") }];
      proof.protectedFiles = document(`evidence/${name}-protected-files.json`, "protected-files", { projects: { before: projectEntries, after: structuredClone(projectEntries) }, userOwnedFile: { before: hash("unknown"), after: hash("unknown") } });
      materialPaths.push(snapshot, proof.beforeState, proof.cleanup, proof.plan, proof.fileOutcome, proof.protectedFiles);
    }
    const proofPath = document(`evidence/${name}-proof.json`, "scenario-proof", proof); materialPaths.push(proofPath);
    scenarios.push({ name, status: "passed", proof: proofPath, materials: [...new Set(materialPaths)] });
  }
  const receipt = {
    schemaVersion: 1, kind: "desktop-windows-install-e2e", status: "passed", target: manifest.target, signing: manifest.signing, version: manifest.version,
    source: structuredClone(source), artifact: structuredClone(artifact), baseline: structuredClone(baseline), run: structuredClone(run), native: { platform: "win32", arch: "x64", isolatedAccount: true, accountSid, administrator: false },
    controller: { scope: "installed-electron-app-asar", appAsarSha256 }, harness: { sourceSha256: source.sha256, files: harnessFiles }, scenarios, materials: [],
  };
  receipt.compatibility = structuredClone(compatibility);
  receipt.baseline.compatibility = structuredClone(compatibility);
  const receiptPath = join(root, "install-e2e-receipt.json");
  const persist = async () => {
    for (const [path, value] of documents) await writeFile(join(root, path), `${JSON.stringify(value)}\n`);
    for (const [path, value] of logs) await writeFile(join(root, path), value);
    receipt.materials = [];
    for (const file of (await readdir(join(root, "evidence"))).sort()) receipt.materials.push(await materialRecord(root, `evidence/${file}`));
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  };
  await writeFile(join(output, artifact.path), artifactBytes);
  await writeFile(join(output, "desktop-source.json"), JSON.stringify({ schemaVersion: 1, ...source, files: harnessFiles }));
  await persist();
  return { receiptPath, receipt, manifest, finalArtifacts, output, root, documents, logs, persist };
}
