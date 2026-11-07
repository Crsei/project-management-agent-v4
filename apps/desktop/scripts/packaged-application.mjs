import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { inspectDeployment } from "./stage-workspace.mjs";
import { hashFile } from "./runtime-manifest.mjs";
import { enforceExternalAgentBoundary } from "../../server/agent/scripts/external-agent-packages.mjs";

// Use electron-builder's already locked dependency, not a second ASAR version.
export function asarTools() {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  return createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
}

function inspectHeader(directory, prefix = "") {
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
    } else if ("files" in entry) inspectHeader(entry, member);
  }
}

export async function inspectPackagedApplication(resources, expectedVersion) {
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
  inspectHeader(asar.getRawHeader(archive).header);
  const extracted = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-asar-")));
  try {
    asar.extractAll(archive, extracted);
    await inspectDeployment(extracted);
    const metadata = JSON.parse(await readFile(join(extracted, "package.json"), "utf8"));
    if (metadata.version !== expectedVersion || metadata.name !== "pm-agent-v4-desktop" || metadata.main !== "dist/main.mjs")
      throw new Error("Final Electron application identity/version differs from the desktop release.");
    await lstat(join(extracted, metadata.main));
    return {
      status: "passed", version: metadata.version, archive: "app.asar", sha256: await hashFile(archive),
      scope: ["app.asar extracted content", "app.asar.unpacked including orphaned files", "workspace-runtime", "desktop-runtime"],
      privateFileScope: ["app.asar extracted content", "app.asar.unpacked including orphaned files", "workspace-runtime"],
      externalClaudePlatformCli: "absent by package identity; communication SDK and other native engines are not pruned",
    };
  } finally {
    asar.uncache(archive);
    await rm(extracted, { recursive: true, force: true });
  }
}
