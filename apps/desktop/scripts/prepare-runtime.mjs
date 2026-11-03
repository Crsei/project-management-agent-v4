import { createWriteStream } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import extractZip from "extract-zip";
import { x as extractTar } from "tar";
import {
  defaultRuntimeRoot, desktopRoot, hashFile, inventoryTree, requireNativeTarget,
  requirePinnedNode, runtimeSources, runtimeTargets, verifyRuntime,
} from "./runtime-manifest.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (!["--output", "--cache", "--platform", "--arch"].includes(name) || !process.argv[index + 1] || process.argv[index + 1].startsWith("--"))
    throw new Error("Usage: prepare-runtime.mjs [--output DIRECTORY] [--cache DIRECTORY] [--platform PLATFORM] [--arch ARCH]");
  options.set(name, process.argv[++index]);
}
requirePinnedNode();
const target = requireNativeTarget(options.get("--platform"), options.get("--arch"));
const output = resolve(options.get("--output") ?? defaultRuntimeRoot);
const cache = resolve(options.get("--cache") ?? join(desktopRoot, ".cache", "runtime-downloads"));
const sources = runtimeSources(target);
const exists = (path) => lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });

async function safeAncestors(path) {
  for (let current = path; ; current = dirname(current)) {
    const info = await exists(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Refusing a non-directory/symlink runtime ancestor: ${current}`);
    if (dirname(current) === current) break;
  }
}
async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Runtime source download failed (${response.status}): ${new URL(url).hostname}`);
  return response;
}
async function download(source) {
  const destination = join(cache, source.archive);
  if (await exists(destination)) {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink() || await hashFile(destination) !== source.sha256)
      throw new Error(`Cached archive fails its pinned SHA256: ${source.archive}. Remove only that corrupt cache entry and prepare again.`);
    return destination;
  }
  const temporary = await mkdtemp(join(cache, ".download-"));
  try {
    const file = join(temporary, "archive");
    const response = await fetchBytes(source.url);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: "wx", mode: 0o600 }));
    if (await hashFile(file) !== source.sha256) throw new Error(`Downloaded archive fails its pinned SHA256: ${source.archive}`);
    await rename(file, destination);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function untar(archive, destination, prefix) {
  await mkdir(destination, { recursive: true });
  await extractTar({
    file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false,
    filter(path, entry) {
      const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
      if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) throw new Error("Runtime archive contains an unexpected root.");
      if (posix.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error("Runtime archive contains an unsafe path.");
      if (entry.type === "SymbolicLink" || entry.type === "Link") {
        const link = entry.linkpath.replaceAll("\\", "/");
        const resolved = entry.type === "Link" ? posix.normalize(link) : posix.join(posix.dirname(normalized), link);
        if (isAbsolute(link) || (resolved !== prefix && !resolved.startsWith(`${prefix}/`))) throw new Error("Runtime archive contains an escaping link.");
      }
      return true;
    },
  });
}

await safeAncestors(dirname(output));
await safeAncestors(cache);
if (await exists(output)) {
  await verifyRuntime(output, target);
  console.log(JSON.stringify({ runtimeRoot: output, target, verified: true, reused: true }));
} else {
  await mkdir(dirname(output), { recursive: true });
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".prepare-runtime-"));
  try {
    // Cross-check Node's official release checksum against the reviewed pin, not
    // against an unpinned checksum downloaded beside an arbitrary binary.
    const checksums = await (await fetchBytes(`https://nodejs.org/dist/v${sources.node.version}/SHASUMS256.txt`)).text();
    if (!checksums.split(/\r?\n/).some((line) => line.trim() === `${sources.node.sha256}  ${sources.node.archive}`))
      throw new Error("Official Node release checksum does not match the desktop runtime pin.");
    const [nodeArchive, postgresArchive] = await Promise.all([download(sources.node), download(sources.postgres)]);
    const prepared = join(temporary, "desktop-runtime");
    await mkdir(prepared);
    const nodePrefix = sources.node.archive.replace(/(?:\.tar\.gz|\.zip)$/, "");
    if (sources.node.archive.endsWith(".zip")) {
      const extracted = join(temporary, "node-archive");
      await extractZip(nodeArchive, { dir: extracted });
      await cp(join(extracted, nodePrefix), join(prepared, "node"), { recursive: true, verbatimSymlinks: true });
    } else await untar(nodeArchive, join(prepared, "node"), nodePrefix);
    await untar(postgresArchive, join(prepared, "postgres"), `postgresql-${sources.postgres.release}-${runtimeTargets[target].postgresTarget}`);
    await access(join(prepared, "node", "LICENSE"));
    await access(join(prepared, "postgres", "LICENSE"));
    await writeFile(join(prepared, "THIRD-PARTY-NOTICES.json"), JSON.stringify({
      node: { version: sources.node.version, notice: "node/LICENSE", source: sources.node.url },
      postgres: { version: sources.postgres.version, notice: "postgres/LICENSE", source: sources.postgres.url, upstreamCommit: sources.postgres.upstreamCommit },
      distribution: "Complete binary distributions retained, including shipped libraries, share data and dependency notices. No executable is downloaded at application startup.",
      linuxVerification: "Linux GNU runtime requires a Debian 12/glibc 2.36-or-newer compatible host and its OS libraries; Linux is not a desktop product target.",
    }, null, 2) + "\n");
    const files = await inventoryTree(prepared);
    await writeFile(join(prepared, "runtime-manifest.json"), JSON.stringify({ version: 1, target, sources, files }, null, 2) + "\n");
    await verifyRuntime(prepared, target);
    // Never replace a caller-owned or previously prepared directory.
    if (await exists(output)) throw new Error("Runtime output appeared during preparation; refusing to replace it.");
    await rename(prepared, output);
    console.log(JSON.stringify({ runtimeRoot: output, target, verified: true, reused: false }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
