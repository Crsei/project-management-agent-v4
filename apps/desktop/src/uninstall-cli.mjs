import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPrivatePath, readPrivateJson, writePrivateJson } from "./private-state.mjs";
import { readInstallStamp } from "./install-stamp.mjs";
import { executeUninstall } from "./uninstall.mjs";

// Invoked only by the native helper after checking the independent HKCU retained
// runtime registration. This remains runnable after app-only removed Electron.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--request-file" || args[2] !== "--response-file") throw new Error("Use --request-file ABS --response-file ABS.");
const requestPath = resolve(args[1]), responsePath = resolve(args[3]);
if (dirname(requestPath) !== dirname(responsePath)) throw new Error("Maintenance request and response must share their private directory.");
const request = await readPrivateJson(requestPath, 64 * 1024);
const resources = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installRoot = resolve(resources, "..");
const stamp = await readInstallStamp(resources);
if (request?.formatVersion !== 1 || request.operation !== "uninstall" || request.expectedInstallRoot !== installRoot || request.expectedStamp?.commit !== stamp.commit || request.expectedStamp?.sourceSha256 !== stamp.source.sha256 || process.execPath.toLowerCase() !== join(resources, "desktop-runtime", "node", "node.exe").toLowerCase()) throw new Error("Retained runtime request does not identify this installed controller.");
await assertPrivatePath(request.userDataDir, true);
const saved = await readPrivateJson(join(request.userDataDir, "connection.json"));
const dataDir = resolve(saved?.dataDir ?? join(request.userDataDir, "workspace"));
const projectRoot = resolve(saved?.projectRoot ?? join(dataDir, "projects"));
if (request.dataDir !== dataDir || request.projectRoot && request.projectRoot !== projectRoot || request.consent?.stopLocalServices !== true) throw new Error("Retained runtime cleanup must target the saved instance and preserve its project root.");
const result = await executeUninstall({
  stamp, installRoot, userDataDir: request.userDataDir, dataDir,
  mode: request.mode, consent: request.consent, externalRoots: [projectRoot],
  deferInstallation: true,
  // The external helper verified process identities before starting this one
  // controller and rechecks after it exits. Never infer permission to stop a PID.
  stop: async () => ({ stopped: true, remainingProcesses: 0, scope: "retained-runtime-controller" }),
});
await writePrivateJson(responsePath, { formatVersion: 1, requestId: request.requestId, operation: "uninstall", ok: true, installStamp: stamp, result }, { exclusive: true });
