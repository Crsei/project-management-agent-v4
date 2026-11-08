import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { inspectPackagedApplication } from "./packaged-application.mjs";
import { assertWindowsInstallFileLimit, inspectPayloadFiles } from "./payload-files.mjs";
import { hashFile, inside, portable } from "./runtime-manifest.mjs";
import { verifyFinalSignatures, verifyWindowsFile } from "./signatures.mjs";
import { verifyInstallationManifest } from "../src/uninstall.mjs";

// Archive paths are data, never shell arguments or filesystem paths until checked.
export function archiveMemberPath(value) {
  if (typeof value !== "string" || !value || /[\0\r\n:]/.test(value)) throw new Error("Unsafe final archive member path.");
  const path = value.replaceAll("\\", "/").replace(/\/$/, "");
  if (!path || posix.isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`Unsafe final archive member path: ${value}`);
  return path;
}

async function sevenZip() {
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      const candidate = join(root, "7-Zip", "7z.exe");
      const info = await lstat(candidate).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (info?.isFile() && !info.isSymbolicLink()) return candidate;
    }
  }
  // Full 7-Zip is required: standalone 7za does not guarantee NSIS support.
  return "7z";
}

function start(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let diagnostic = "";
  child.stderr.on("data", (bytes) => { if (diagnostic.length < 65536) diagnostic += bytes.toString(); });
  const closed = new Promise((accept, reject) => {
    child.once("error", (cause) => reject(new Error(`Final archive verification requires ${command}: ${cause.message}`, { cause })));
    child.once("close", (code, signal) => code === 0 ? accept() : reject(new Error(`Final archive command failed (${signal || code}): ${command}\n${diagnostic}`)));
  });
  // Parsing/piping and process exit run together; neither rejection is unhandled.
  closed.catch(() => {});
  return { child, closed };
}

async function archiveLinkTarget(archive, member) {
  if (member.startsWith("@")) throw new Error("Unsupported archive symbolic link member name.");
  const { child, closed } = start(await sevenZip(), ["x", "-so", "-bd", "-spd", "--", archive, member]);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > 16384) throw new Error(`Oversized final archive symbolic link: ${member}`);
      chunks.push(chunk);
    }
    await closed;
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (cause) {
    child.kill();
    await closed.catch(() => {});
    throw cause;
  }
}

export async function listArchive(archive, { windows = false } = {}) {
  const { child, closed } = start(await sevenZip(), ["l", "-slt", "-ba", "-sccUTF-8", "--", archive]);
  const members = [];
  const names = new Set();
  const components = new Map();
  let record = {};
  const finish = () => {
    if (!Object.keys(record).length) return;
    const path = archiveMemberPath(record.Path);
    const key = windows ? path.toLowerCase() : path;
    if (windows && path.split("/").some((part) => /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
      throw new Error(`Unsafe Windows final archive member: ${path}`);
    if (windows) {
      const parts = path.split("/");
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join("/");
        const folded = prefix.toLowerCase();
        if (components.has(folded) && components.get(folded) !== prefix) throw new Error(`Case-aliased Windows archive members: ${prefix}`);
        components.set(folded, prefix);
      }
    }
    if (names.has(key)) throw new Error(`Duplicate final archive member: ${path}`);
    names.add(key);
    members.push({ path, ...record });
    record = {};
  };
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line) finish();
      else {
        const separator = line.indexOf(" = ");
        if (separator < 1) throw new Error("Unsupported final archive listing; refusing unchecked extraction.");
        const key = line.slice(0, separator);
        if (key in record) throw new Error("Ambiguous final archive listing.");
        record[key] = line.slice(separator + 3);
      }
    }
    finish();
    await closed;
    if (!members.length) throw new Error("Final archive is empty or could not be enumerated.");
    for (const entry of members) {
      // ZIP exposes Unix symlink mode but not its target in the SLT listing.
      // Read that member's DATA before permitting any archive extraction.
      if (/(?:^|\s)l[rwxstST-]{9}(?:\s|$)/.test(entry.Attributes ?? "") && !("Symbolic Link" in entry))
        entry["Symbolic Link"] = await archiveLinkTarget(archive, entry.Path);
      if ("Hard Link" in entry) throw new Error(`Unsupported final archive hard link: ${entry.path}`);
      if (!("Symbolic Link" in entry)) continue;
      const target = entry["Symbolic Link"].replaceAll("\\", "/");
      const destination = posix.normalize(posix.join(posix.dirname(entry.path), target));
      if (windows || !target || /[\0\r\n:]/.test(target) || posix.isAbsolute(target)
        || destination === ".." || destination.startsWith("../"))
        throw new Error(`Escaping or unsupported final archive link: ${entry.path}`);
    }
    // A symlink member cannot be an ancestor of another extracted member.
    const links = new Set(members.filter((entry) => "Symbolic Link" in entry || "Hard Link" in entry).map((entry) => entry.path));
    for (const entry of members) {
      for (let parent = posix.dirname(entry.path); parent !== "."; parent = posix.dirname(parent)) {
        if (links.has(parent)) throw new Error(`Final archive writes through a link: ${entry.path}`);
      }
    }
    return members;
  } catch (cause) {
    child.kill();
    await closed.catch(() => {});
    throw cause;
  }
}

async function extractArchive(archive, destination, windows) {
  await listArchive(archive, { windows });
  await mkdir(destination);
  const { child, closed } = start(await sevenZip(), ["x", "-y", "-bd", `-o${destination}`, "--", archive]);
  child.stdout.resume();
  await closed;
}

export const NSIS_UNINSTALLER_BYTE_LIMIT = 64 * 1024 * 1024;
export function nsisUninstallerMember(members) {
  // NSIS sets this exact installed filename; SLT may retain the $INSTDIR root.
  // Neither spelling admits private plugins or a suffix/path wildcard.
  const selected = members.filter((entry) => ["Uninstall PM Agent v4.exe", "$INSTDIR/Uninstall PM Agent v4.exe"].includes(entry.path));
  if (selected.length !== 1 || !/^[0-9]+$/.test(selected[0].Size ?? "")
    || Number(selected[0].Size) < 1 || Number(selected[0].Size) > NSIS_UNINSTALLER_BYTE_LIMIT
    || selected[0].Folder === "+" || /(?:^|\s)D/.test(selected[0].Attributes ?? "")
    || "Symbolic Link" in selected[0] || "Hard Link" in selected[0])
    throw new Error("Final NSIS installer requires exactly one bounded regular installed uninstaller member.");
  return selected[0];
}

async function extractNsisPayload(installer, directory, options) {
  const members = await listArchive(installer, { windows: true });
  const payloads = members.filter((entry) => entry.path === "$PLUGINSDIR/app-64.7z");
  if (payloads.length !== 1 || !/^\d+$/.test(payloads[0].Size) || Number(payloads[0].Size) === 0)
    throw new Error("Final NSIS installer must contain exactly one nonempty $PLUGINSDIR/app-64.7z payload.");
  let uninstaller;
  if (options.signing === "signed") {
    const member = nsisUninstallerMember(members);
    const path = join(directory, "installed-uninstaller.exe");
    const { child, closed } = start(await sevenZip(), ["x", "-so", "-bd", "-spd", "--", installer, member.Path]);
    let bytes = 0;
    try {
      await Promise.all([pipeline(child.stdout, async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > Number(member.Size)) throw new Error("Installed uninstaller exceeds its bounded archive member size.");
          yield chunk;
        }
      }, createWriteStream(path, { flags: "wx" })), closed]);
    } catch (cause) { child.kill(); await closed.catch(() => {}); throw cause; }
    if (bytes !== Number(member.Size)) throw new Error("Installed uninstaller extraction size differs from its exact archive member.");
    uninstaller = { member: member.path, ...await verifyWindowsFile(path, options.signer),
      scope: "Separately embedded native executable installed as Uninstall PM Agent v4.exe; private NSIS plugins are not subject to this per-file publisher check." };
  }
  const archive = join(directory, "app-64.7z");
  const { child, closed } = start(await sevenZip(), ["x", "-so", "-bd", "--", installer, payloads[0].Path]);
  try {
    await Promise.all([pipeline(child.stdout, createWriteStream(archive, { flags: "wx" })), closed]);
  } catch (cause) {
    child.kill();
    await closed.catch(() => {});
    throw cause;
  }
  if ((await lstat(archive)).size !== Number(payloads[0].Size)) throw new Error("NSIS payload extraction size differs from its actual archive member.");
  const application = join(directory, "application");
  await extractArchive(archive, application, true);
  return { resources: join(application, "resources"), payload: { member: "$PLUGINSDIR/app-64.7z", bytes: Number(payloads[0].Size), sha256: await hashFile(archive) }, ...(uninstaller ? { uninstaller } : {}) };
}

async function execute(command, args) {
  const { child, closed } = start(command, args);
  child.stdout.resume();
  await closed;
}

export async function inspectInstalledApplication(resources, options) {
  const { target, version } = options;
  if (!/^[a-f0-9]{40}$/.test(options.source?.commit ?? "") || !/^[a-f0-9]{64}$/.test(options.source?.sha256 ?? "") || typeof options.source?.dirty !== "boolean")
    throw new Error("Final application verification requires the exact corresponding-source commit, SHA256 and dirty identity.");
  resources = resolve(resources);
  const info = await lstat(resources);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resources) !== resources)
    throw new Error("Final application resources must be a real nonescaping directory.");
  const application = await inspectPackagedApplication(resources, version, { ...options, signedMachO: target.startsWith("darwin-") });
  if (!application.runtimeInventory) throw new Error("Final application is missing its complete pinned runtime.");
  let ownership;
  if (target === "win32-x64") {
    const verified = await verifyInstallationManifest(dirname(resources), application.installStamp.value);
    ownership = { status: "passed", manifest: "resources/desktop-install-files.json", sha256: await hashFile(join(resources, "desktop-install-files.json")),
      files: verified.fileCount, logicalBytes: verified.bytes, scope: "Exact complete final Windows installation-owned file bytes; original archive expansion, not installation execution." };
  }
  const installRoot = target.startsWith("darwin-") ? resolve(resources, "../..") : dirname(resources);
  const tree = await applicationTree(installRoot);
  const { root: _root, ...payloadReport } = await inspectPayloadFiles(installRoot, { allowContainedSymlinks: target.startsWith("darwin-") });
  if (payloadReport.files !== tree.files || payloadReport.bytes !== tree.logicalBytes || payloadReport.links !== tree.links)
    throw new Error("Final artifact payload component report differs from exact complete application tree.");
  assertWindowsInstallFileLimit(target, tree.files);
  const resourcesTree = await applicationTree(resources, { digest: true, modes: target.startsWith("darwin-") });
  return { status: "passed", application, tree, resourcesTree, runtime: application.runtimeInventory, payloadReport, ...(ownership ? { ownership } : {}) };
}

export async function verifyInstalledApplication(resources, expectedPayload, options) {
  if (!expectedPayload || !/^[a-f0-9]{64}$/.test(expectedPayload.sha256) || !Number.isSafeInteger(expectedPayload.bytes))
    throw new Error("Installed-tree verification requires the current inspected final artifact digest.");
  const checked = await inspectInstalledApplication(resources, options).catch((cause) => {
    throw new Error(`Supplied installed application differs from the current final distributable: ${cause.message}`, { cause });
  });
  if (JSON.stringify(checked.application) !== JSON.stringify(expectedPayload.application)
    || JSON.stringify(checked.resourcesTree) !== JSON.stringify(expectedPayload.resourcesTree))
    throw new Error("Supplied installed application differs from the current final distributable.");
  return { ...checked, sourceArtifact: { path: expectedPayload.path, sha256: expectedPayload.sha256, bytes: expectedPayload.bytes }, installationExecutedByThisCommand: false };
}

export async function applicationTree(root, { digest = false, modes = false } = {}) {
  const hash = digest ? createHash("sha256") : null;
  const record = (value) => hash?.update(`${JSON.stringify(value)}\n`);
  const summary = { files: 0, logicalBytes: 0, links: 0 };
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      const location = portable(relative(root, path));
      if (info.isSymbolicLink()) {
        const link = await readlink(path);
        if (isAbsolute(link) || !inside(root, resolve(dirname(path), link)) || !inside(root, await realpath(path)))
          throw new Error(`Final application contains an escaping resource: ${portable(path)}`);
        summary.links++;
        record({ path: location, link: portable(link) });
      } else if (info.isDirectory()) {
        record({ path: location, directory: true });
        await visit(path);
      } else if (info.isFile()) {
        summary.files++;
        summary.logicalBytes += info.size;
        if (hash) record({ path: location, bytes: info.size, sha256: await hashFile(path), ...(modes ? { mode: info.mode & 0o777 } : {}) });
      }
      else throw new Error("Final application contains an unsupported filesystem resource.");
    }
  }
  await visit(root);
  return { ...summary, ...(hash ? { sha256: hash.digest("hex") } : {}) };
}

// The callback runs while validated FINAL distributable resources are available.
// Extraction is not installation, and neither this API nor its report claims it is.
export async function inspectFinalArtifacts(output, artifacts, options, onArtifact) {
  const archives = artifacts.filter((record) => /\.(?:exe|dmg|zip)$/.test(record.path));
  const required = options.target === "win32-x64" ? [".exe"] : [".dmg", ".zip"];
  if (!archives.length || required.some((suffix) => !archives.some((record) => record.path.endsWith(suffix))))
    throw new Error("Final artifact verification requires every configured native distributable.");
  const results = [];
  for (const record of archives) {
    if (record.path !== posix.basename(record.path) || /[\\\0\r\n:]/.test(record.path)) throw new Error("Final artifacts must have safe flat paths.");
    const archive = resolve(output, record.path);
    const info = await lstat(archive);
    if (!inside(output, archive) || !info.isFile() || info.isSymbolicLink() || info.size !== record.bytes || await hashFile(archive) !== record.sha256)
      throw new Error(`Final artifact differs from its recorded hash/size: ${record.path}`);
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-final-")));
    let mounted;
    try {
      let resources;
      let payload;
      let uninstaller;
      if (record.path.endsWith(".exe")) {
        if (options.target !== "win32-x64") throw new Error("NSIS payload is only valid for Windows x64 delivery.");
        ({ resources, payload, uninstaller } = await extractNsisPayload(archive, temporary, options));
      } else {
        if (!options.target.startsWith("darwin-")) throw new Error("DMG/ZIP payload is only valid for macOS delivery.");
        const application = join(temporary, "application");
        if (record.path.endsWith(".dmg")) {
          if (process.platform !== "darwin") throw new Error("Final DMG verification requires native macOS hdiutil; extraction on another OS is not installation evidence.");
          mounted = join(temporary, "volume");
          await mkdir(mounted);
          await execute("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mounted, archive]);
          resources = join(mounted, "PM Agent v4.app", "Contents", "Resources");
        } else {
          if (process.platform === "darwin") {
            await listArchive(archive);
            await mkdir(application);
            await execute("/usr/bin/ditto", ["-x", "-k", archive, application]);
          } else await extractArchive(archive, application, false);
          resources = join(application, "PM Agent v4.app", "Contents", "Resources");
        }
      }
      const checked = await inspectInstalledApplication(resources, options);
      const signatures = await verifyFinalSignatures(resources, archive, options);
      results.push({ path: record.path, bytes: record.bytes, sha256: record.sha256, ...(payload ? { payload } : {}), ...checked,
        signatures: { ...signatures, ...(uninstaller ? { uninstaller } : {}) } });
      if (onArtifact) await onArtifact(resources, record, results.at(-1));
      if ((await lstat(archive)).size !== record.bytes || await hashFile(archive) !== record.sha256)
        throw new Error(`Final artifact changed during payload/signature verification: ${record.path}`);
    } finally {
      try {
        if (mounted) await execute("/usr/bin/hdiutil", ["detach", mounted]);
      } finally {
        // Never recurse into a mounted volume if detach failed.
        if (!mounted || !(await readdir(mounted)).length) await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  return { status: "passed", scope: "Expanded final distributables, not win-unpacked staging and not installer execution", installationExecuted: false, artifacts: results };
}
