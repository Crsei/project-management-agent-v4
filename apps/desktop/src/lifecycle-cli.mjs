import { lstat, mkdtemp, realpath, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LocalServer } from "./local-server.mjs";
import { ManagedPostgres, readManagedPostgresState } from "./managed-postgres.mjs";
import { assertPrivatePath, ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "./private-state.mjs";
import { assertProcessIdentity, ownedProcessIdentity } from "./process-identity.mjs";
import { assertSelfOwnedInstall } from "./install-stamp.mjs";
import { initialSetup, safeDesktopMessage } from "./policy.mjs";
import { createInstalledFixture, exerciseInstalledHealth, snapshotInstalledFixture } from "./lifecycle-fixtures.mjs";

const operations = new Set(["start-health", "health", "snapshot", "stop", "preinstall", "uninstall-plan", "uninstall"]);
const claimed = new Set();
const inside = (root, path) => { const part = relative(root, path); return part === "" || part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part); };
const equalPath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const absolute = value => { check(typeof value === "string" && isAbsolute(value) && !value.includes("\0"), "Lifecycle paths must be absolute."); return resolve(value); };

export function readLifecycleArguments(argv) {
  if (!argv.includes("--desktop-lifecycle")) return null;
  const flags = ["--desktop-lifecycle", "--request-file", "--response-file"];
  const result = {};
  for (const flag of flags) {
    const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
    check(indexes.length === 1 && typeof argv[indexes[0] + 1] === "string" && !argv[indexes[0] + 1].startsWith("--"), "Invalid packaged lifecycle command.");
    result[flag] = argv[indexes[0] + 1];
  }
  check(operations.has(result["--desktop-lifecycle"]), "Unsupported packaged lifecycle operation.");
  check(!argv.some(value => value.startsWith("--") && !flags.includes(value)), "Lifecycle operations cannot enable debugging, remote services or alternate runtimes.");
  return { operation: result["--desktop-lifecycle"], requestFile: absolute(result["--request-file"]), responseFile: absolute(result["--response-file"]) };
}

export async function loadLifecycleRequest(args, { packaged, installRoot, stamp }) {
  check(packaged && stamp, "Lifecycle operations require the installed packaged application.");
  assertSelfOwnedInstall(stamp);
  check(equalPath(dirname(args.requestFile), dirname(args.responseFile)) && args.requestFile !== args.responseFile, "Lifecycle response must be a new file beside its private request.");
  const directory = dirname(args.requestFile);
  check(equalPath(await realpath(directory), directory), "Lifecycle request directories must not contain redirected path components.");
  await assertPrivatePath(directory, true);
  try { await lstat(args.responseFile); throw new Error("Lifecycle response already exists; requests cannot be replayed."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const input = await readPrivateJson(args.requestFile, 32_768);
  check(input?.formatVersion === 1 && input.operation === args.operation && typeof input.requestId === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.requestId), "Invalid lifecycle request identity.");
  const expectedRoot = absolute(input.expectedInstallRoot);
  const actualRoot = await realpath(installRoot);
  check(equalPath(await realpath(expectedRoot), expectedRoot) && equalPath(actualRoot, expectedRoot), "Lifecycle request targets a different installation root.");
  check(input.expectedStamp?.commit === stamp.commit && input.expectedStamp?.sourceSha256 === stamp.source.sha256, "Lifecycle request source identity does not match the installed package.");
  const userDataDir = absolute(input.userDataDir);
  check(!inside(actualRoot, userDataDir) && !inside(userDataDir, actualRoot), "Lifecycle user data must not overlap installation files.");
  check(!inside(actualRoot, directory) && !inside(userDataDir, directory), "Lifecycle request/response files must stay outside installation and user-data deletion roots.");
  let userDataAbsent = false;
  try { await assertPrivatePath(userDataDir, true); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (args.operation === "start-health") await ensurePrivateDirectory(userDataDir);
    else {
      check(["stop", "preinstall", "uninstall-plan", "uninstall"].includes(args.operation) && (!["uninstall-plan", "uninstall"].includes(args.operation) || ["app-only", "app+runtime"].includes(input.mode)), "There is no initialized managed user-data instance. Full/data-only cleanup is refused; use Windows Settings or a code-only removal mode.");
      userDataAbsent = true;
      let ancestor = dirname(userDataDir);
      for (;;) {
        try {
          check(equalPath(await realpath(ancestor), ancestor), "Absent lifecycle data must have a nonredirected parent.");
          break;
        } catch (failure) {
          if (failure.code !== "ENOENT" || dirname(ancestor) === ancestor) throw failure;
          ancestor = dirname(ancestor);
        }
      }
    }
  }
  if (!userDataAbsent) check(equalPath(await realpath(userDataDir), userDataDir), "Lifecycle user data cannot be redirected through a link.");
  const saved = userDataAbsent ? null : await readPrivateJson(join(userDataDir, "connection.json"));
  const dataDir = absolute(input.dataDir ?? saved?.dataDir ?? join(userDataDir, "workspace"));
  const projectRoot = absolute(input.projectRoot ?? saved?.projectRoot ?? join(dataDir, "projects"));
  check(!inside(actualRoot, dataDir) && !inside(dataDir, actualRoot), "Lifecycle data cannot overlap the installation.");
  check(!inside(dataDir, directory), "Lifecycle request/response files must stay outside the managed data deletion root.");
  if (["start-health", "health", "snapshot"].includes(args.operation)) {
    check(inside(userDataDir, dataDir) && inside(dataDir, projectRoot), "Installed fixture operations require isolated, application-owned data and project roots.");
    check(typeof input.fixtureId === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.fixtureId), "Installed fixture identity is required.");
  } else {
    check(dataDir === resolve(saved?.dataDir ?? join(userDataDir, "workspace")), "Lifecycle cleanup must target the saved managed workspace, not an arbitrary path.");
    check(projectRoot === resolve(saved?.projectRoot ?? join(dataDir, "projects")), "Lifecycle cleanup must preserve the saved project root; an override cannot change its protection.");
    if (args.operation !== "uninstall-plan") check(input.consent?.stopLocalServices === true, "Explicit local-service shutdown consent is required.");
  }
  // Electron may create its userData during initialization/locking. Keep that
  // incidental state in the private request directory, not an absent removal
  // target: absence must remain real, never an invented empty-data snapshot.
  const controllerUserDataDir = userDataAbsent
    ? await ensurePrivateDirectory(await mkdtemp(join(directory, "desktop-lifecycle-controller-")), { newlyCreated: true })
    : userDataDir;
  return { ...args, request: { ...input, userDataDir, dataDir, projectRoot }, controllerUserDataDir, userDataAbsent, installRoot: actualRoot, stamp };
}

async function assertNoSavedListeners(dataDir) {
  const ports = await readPrivateJson(join(dataDir, "service-ports.json"));
  if (!ports) return;
  for (const port of [ports.public, ports.pm, ports.agent]) {
    check(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid managed service port ownership.");
    const probe = createServer();
    try { await new Promise((done, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", done); }); }
    catch { throw new Error("A saved local service listener is still active without this controller's ownership. Close its owning application normally; no process will be selected by port or image name."); }
    finally { if (probe.listening) await new Promise(done => probe.close(done)); }
  }
}

export async function stopRecoveredInstance({ dataDir, runtimeRoot }) {
  // A dead controller may leave its private database alive. No arbitrary Node
  // process is adopted: an active listener without the original handle refuses.
  await assertNoSavedListeners(dataDir);
  const metadata = await readPrivateJson(join(dataDir, "managed-postgres.json"));
  if (!metadata) return { stopped: true, remainingProcesses: 0 };
  const state = await readManagedPostgresState(dataDir);
  const postgres = new ManagedPostgres({ dataDir, binariesDir: join(runtimeRoot, "postgres") });
  postgres.state = state;
  await postgres.acquireLock();
  check(await postgres.clusterComplete(postgres.clusterDir), "Managed PostgreSQL cluster ownership is missing; refusing cleanup.");
  await postgres.recoverOwnedServer({ cancelable: false });
  await postgres.stop();
  return { stopped: true, remainingProcesses: postgres.ownedProcessCount };
}

export function ownedLifecycleProcesses(server) {
  const records = [];
  for (const [role, child] of server?.children ?? []) {
    const identity = ownedProcessIdentity(child);
    if (identity && assertProcessIdentity(identity)) records.push({ role, ...identity });
  }
  const postgres = server?.postgres;
  if (postgres?.serverIdentity && assertProcessIdentity(postgres.serverIdentity)) records.push({ role: "postgres", ...postgres.serverIdentity });
  return records;
}

export async function runLifecycleRequest(context, host) {
  const { request: input, stamp } = context;
  check(!claimed.has(input.requestId), "Lifecycle request has already been consumed.");
  claimed.add(input.requestId);
  let result;
  let success = false;
  const stop = async () => {
    await host.stop(); // Includes the existing draft/flush/window close guard.
    check(!host.getServer()?.running && !(host.getServer()?.processCount > 0), "Owned local processes are still running.");
    return stopRecoveredInstance({ dataDir: input.dataDir, runtimeRoot: host.runtimeRoot });
  };
  try {
    switch (context.operation) {
      case "start-health": {
        check(!host.getServer()?.running, "The installed lifecycle controller is already running; use health or snapshot.");
        const setup = initialSetup(input.setup);
        if (input.createFixture === true) {
          const entries = await readdir(input.dataDir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
          check(entries.length === 0, "Fixture creation requires a new empty managed workspace; existing data is never reseeded.");
        }
        const server = new LocalServer({ serverRoot: host.serverRoot, runtimeRoot: host.runtimeRoot, webRoot: join(host.serverRoot, "apps/web/dist"), onExit: () => host.onUnexpectedExit?.() });
        host.setServer(server);
        const connection = await server.start({ mode: "local", dataDir: input.dataDir, projectRoot: input.projectRoot, ...(input.createFixture === true ? { setup } : {}) });
        host.setConnection(connection);
        const health = await exerciseInstalledHealth(connection, setup);
        if (input.createFixture === true) await createInstalledFixture({ request: input, connection, health });
        const snapshot = await snapshotInstalledFixture({ request: input, server, connection });
        result = { ...health, origin: connection.origin, instanceId: connection.instanceId, processes: ownedLifecycleProcesses(server), snapshot };
        break;
      }
      case "health": {
        check(host.getServer()?.ready && host.getConnection(), "Installed managed services are not running.");
        result = { ...(await exerciseInstalledHealth(host.getConnection(), initialSetup(input.setup))), origin: host.getConnection().origin, processes: ownedLifecycleProcesses(host.getServer()) };
        break;
      }
      case "snapshot": result = await snapshotInstalledFixture({ request: input, server: host.getServer(), connection: host.getConnection() }); break;
      case "stop": result = await stop(); break;
      case "preinstall":
        check(input.candidateCompatibility?.dataSchema === stamp.compatibility.dataSchema && input.candidateCompatibility?.postgresMajor === stamp.compatibility.postgresMajor && input.candidateCompatibility?.migrationsSha256 === stamp.compatibility.migrationsSha256, "The candidate changes PM/Agent data compatibility. Automatic replacement is refused before stopping the current app; use a reviewed migration and verified backup instead.");
        result = await stop();
        break;
      case "uninstall-plan": case "uninstall": {
        check(context.operation !== "uninstall" || process.platform === "win32", "Native self-removal is supported by the Windows installer only. Use Finder or your macOS/package manager removal instructions; no installation or data was deleted.");
        const { planUninstall, executeUninstall } = await import("./uninstall.mjs");
        const options = { stamp, installRoot: context.installRoot, userDataDir: input.userDataDir, dataDir: input.dataDir, mode: input.mode, consent: input.consent, externalRoots: [input.projectRoot], deferInstallation: true, stop };
        result = await (context.operation === "uninstall-plan" ? planUninstall : executeUninstall)(options);
        break;
      }
    }
    success = true;
    await writePrivateJson(context.responseFile, { formatVersion: 1, requestId: input.requestId, operation: context.operation, ok: true, installStamp: stamp, result }, { exclusive: true });
  } catch (error) {
    // No service logs, password, cookie, access token or database URL enters the
    // installer receipt. Native failures remain failures, never fake passes.
    await writePrivateJson(context.responseFile, { formatVersion: 1, requestId: input.requestId, operation: context.operation, ok: false, installStamp: stamp, error: safeDesktopMessage(error, [input.setup?.password]) }, { exclusive: true });
  } finally { if (input.setup) input.setup.password = ""; }
  if (success && context.operation === "uninstall" && input.deferInstallation !== true && process.platform === "win32") {
    try {
      const { launchNativeUninstall } = await import("./uninstall.mjs");
      await launchNativeUninstall({ installRoot: context.installRoot, requestFile: context.requestFile, responseFile: context.responseFile, mode: input.mode, controllerPid: process.pid });
    } catch (error) {
      success = false;
      await writePrivateJson(`${context.responseFile}.cleanup.json`, { formatVersion: 1, requestId: input.requestId, operation: "uninstall", ok: false, error: safeDesktopMessage(error) }, { exclusive: true });
    }
  }
  if (success && ["stop", "preinstall", "uninstall"].includes(context.operation)) await host.quit();
  return { success, keepAlive: ["start-health", "health", "snapshot"].includes(context.operation) || Boolean(host.getServer()?.running) };
}
