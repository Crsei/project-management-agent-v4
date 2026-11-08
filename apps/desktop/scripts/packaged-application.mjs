import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { verifyDependencyLayout } from "./dependency-layout-verifier.mjs";
import { verifyFinalRuntime } from "./runtime-inventory-verifier.mjs";
import { inspectDeployment } from "./stage-workspace.mjs";
import { hashFile } from "./runtime-manifest.mjs";
import { enforceExternalAgentBoundary } from "../../server/agent/scripts/external-agent-packages.mjs";

// Use electron-builder's already locked dependency, not a second ASAR version.
export function asarTools() {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  return createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
}

function inspectHeader(directory, prefix = "", unpacked = false, loose = new Set()) {
  if (!directory || typeof directory.files !== "object" || directory.files === null)
    throw new Error("Invalid packaged ASAR directory.");
  for (const [name, entry] of Object.entries(directory.files)) {
    if (!name || name === "." || name === ".." || /[\\/:\0]/.test(name))
      throw new Error("Unsafe packaged ASAR member name.");
    const member = prefix ? `${prefix}/${name}` : name;
    if ("link" in entry) {
      if (typeof entry.link !== "string" || /[\\:\0]/.test(entry.link) || posix.isAbsolute(entry.link)
        || posix.normalize(entry.link) === ".." || posix.normalize(entry.link).startsWith("../"))
        throw new Error(`Unsafe packaged ASAR link: ${member}`);
    } else if ("files" in entry) inspectHeader(entry, member, unpacked || entry.unpacked === true, loose);
    else if (unpacked || entry.unpacked === true) loose.add(member);
  }
  return loose;
}

export async function inspectPackagedApplication(resources, expectedVersion, { signedMachO = false, target } = {}) {
  if (signedMachO) {
    if (process.platform !== "darwin") throw new Error("Final Mach-O signature verification requires native macOS.");
    await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(resources, "../..")]);
  }
  // CLI package identity applies to every loose resource, including the pinned
  // runtime. Private checkout rules belong only to application/workspace trees:
  // the complete official Node distribution legitimately contains npm config.
  await enforceExternalAgentBoundary(resources);
  for (const name of ["app.asar.unpacked", "workspace-runtime"]) {
    const directory = join(resources, name);
    const info = await lstat(directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Packaged application resource roots must be real directories.");
    // Includes orphaned unpacked files, not just ASAR-referenced members.
    await inspectDeployment(directory, resources);
  }
  // afterPack and unsigned delivery verification separately enforce the complete
  // pinned runtime inventory. Do not replace that guard with a filename exemption.
  const archive = join(resources, "app.asar");
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Final app.asar must be a real file.");
  const asar = asarTools();
  asar.uncache(archive);
  const loose = inspectHeader(asar.getRawHeader(archive).header);
  async function inspectLoose(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const member = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspectLoose(path, member);
      else if (!entry.isFile() || !loose.delete(member))
        throw new Error(`Unrecorded or linked ASAR unpacked resource: ${member}`);
    }
  }
  const looseRoot = join(resources, "app.asar.unpacked");
  if (await lstat(looseRoot).catch((error) => { if (error.code === "ENOENT") return null; throw error; })) await inspectLoose(looseRoot);
  if (loose.size) throw new Error("Final ASAR is missing unpacked resources.");
  const extracted = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-asar-")));
  try {
    asar.extractAll(archive, extracted);
    await inspectDeployment(extracted);
    const metadata = JSON.parse(await readFile(join(extracted, "package.json"), "utf8"));
    if (metadata.version !== expectedVersion || metadata.name !== "pm-agent-v4-desktop" || metadata.main !== "dist/main.mjs")
      throw new Error("Final Electron application identity/version differs from the desktop release.");
    await lstat(join(extracted, metadata.main));
    const dependencyLayouts = {
      electron: await verifyDependencyLayout(extracted, { signedMachO }),
      workspace: await verifyDependencyLayout(join(resources, "workspace-runtime"), { signedMachO }),
    };
    const runtimeRoot = join(resources, "desktop-runtime");
    const runtimeInfo = await lstat(runtimeRoot).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const runtimeInventory = runtimeInfo ? await verifyFinalRuntime(resources,
      target ?? JSON.parse(await readFile(join(runtimeRoot, "runtime-manifest.json"), "utf8")).target, { signedMachO }) : null;
    return {
      status: "passed", version: metadata.version, archive: "app.asar", sha256: await hashFile(archive),
      scope: ["app.asar extracted content", "app.asar.unpacked including orphaned files", "workspace-runtime", "desktop-runtime"],
      dependencyLayouts,
      runtimeInventory,
      privateFileScope: ["app.asar extracted content", "app.asar.unpacked including orphaned files", "workspace-runtime"],
      externalClaudePlatformCli: "absent by package identity; communication SDK and other native engines are not pruned",
    };
  } finally {
    asar.uncache(archive);
    await rm(extracted, { recursive: true, force: true });
  }
}
