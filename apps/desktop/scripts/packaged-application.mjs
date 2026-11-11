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
import { readInstallStamp } from "../src/install-stamp.mjs";
import { verifyWindowsFile } from "./signatures.mjs";
import { computeMigrationsSha256 } from "./install-stamp.mjs";
import { verifyPackagedUpdateConfiguration } from "./delivery-assets.mjs";

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

export async function inspectPackagedApplication(resources, expectedVersion, { signedMachO = false, target, signing, signer, source, installStamp: expectedInstallStamp, updateConfiguration = true } = {}) {
  const signedPE = signing === "signed" && target === "win32-x64";
  let installStamp;
  let workspaceVersion;
  let updaterConfiguration;
  if (target) {
    const [platform, arch] = target.split("-");
    installStamp = await readInstallStamp(resources, { platform, arch, version: expectedVersion });
    if (signing && installStamp.signing !== signing || source && (installStamp.commit !== source.commit
      || installStamp.source.sha256 !== source.sha256 || installStamp.source.dirty !== source.dirty))
      throw new Error("Packaged install stamp differs from exact final source/signing identity.");
    if (expectedInstallStamp && JSON.stringify(installStamp) !== JSON.stringify(expectedInstallStamp))
      throw new Error("Final packaged install stamp differs from the complete immutable release stamp.");
    if (await computeMigrationsSha256(join(resources, "workspace-runtime")) !== installStamp.compatibility.migrationsSha256)
      throw new Error("Final installed migration/state-code bytes differ from immutable compatibility fingerprint.");
    const path = join(resources, "workspace-runtime/apps/desktop/package.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Final workspace desktop version metadata must be a regular file.");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    if (metadata.version !== expectedVersion) throw new Error("Final workspace desktop version metadata differs from the release version.");
    workspaceVersion = { status: "passed", path: "workspace-runtime/apps/desktop/package.json", version: metadata.version, sha256: await hashFile(path) };
    if (updateConfiguration) updaterConfiguration = await verifyPackagedUpdateConfiguration(resources, installStamp);
  }
  if (signedMachO) {
    if (process.platform !== "darwin") throw new Error("Final Mach-O signature verification requires native macOS.");
    await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(resources, "../..")]);
  }
  // CLI package identity applies to every loose dependency tree, including the
  // runtime. Private checkout rules belong to application/workspace trees;
  // runtime resources and relocated notices have their own exact inventory.
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
    const asarSignatures = [];
    if (signedPE) {
      async function visit(directory, prefix = "") {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name), location = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(path, location);
          else if (entry.isFile() && /\.(?:exe|dll|node)$/i.test(entry.name))
            asarSignatures.push({ path: location, ...await verifyWindowsFile(path, signer) });
        }
      }
      await visit(extracted);
      asarSignatures.sort((a, b) => a.path.localeCompare(b.path, "en"));
    }
    const dependencyLayouts = {
      electron: await verifyDependencyLayout(extracted, { signedMachO, signedPE, signer }),
      workspace: await verifyDependencyLayout(join(resources, "workspace-runtime"), { signedMachO, signedPE, signer }),
    };
    const runtimeRoot = join(resources, "desktop-runtime");
    const runtimeInfo = await lstat(runtimeRoot).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const runtimeInventory = runtimeInfo ? await verifyFinalRuntime(resources,
      target ?? JSON.parse(await readFile(join(runtimeRoot, "runtime-manifest.json"), "utf8")).target, { signedMachO, signedPE, signer }) : null;
    return {
      status: "passed", version: metadata.version, archive: "app.asar", sha256: await hashFile(archive),
      scope: ["app.asar extracted content", "app.asar.unpacked including orphaned files", "workspace-runtime", "desktop-runtime"],
      dependencyLayouts,
      runtimeInventory,
      ...(updaterConfiguration ? { updaterConfiguration } : {}),
      ...(installStamp ? { installStamp: { status: "passed", path: "desktop-install-stamp.json", sha256: await hashFile(join(resources, "desktop-install-stamp.json")), value: installStamp } } : {}),
      ...(signedPE ? { asarSignatures } : {}),
      ...(workspaceVersion ? { workspaceVersion } : {}),
      privateFileScope: ["app.asar extracted content", "app.asar.unpacked including orphaned files", "workspace-runtime"],
      externalClaudePlatformCli: "absent by package identity; communication SDK and other native engines are not pruned",
    };
  } finally {
    asar.uncache(archive);
    await rm(extracted, { recursive: true, force: true });
  }
}
