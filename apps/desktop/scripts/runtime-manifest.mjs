import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultRuntimeRoot = join(desktopRoot, ".runtime", "desktop-runtime");
export const NODE_VERSION = "24.21.0";
export const POSTGRES_VERSION = "16.15";
export const POSTGRES_RELEASE = "16.15.0";
export const POSTGRES_COMMIT = "2954f800589f74265f136cdb490b87749e209e7c";
// SHA256 values are pinned from Node's official SHASUMS256.txt and the PG release's
// published asset digests. Never resolve a latest tag or trust a fresh hash alone.
export const runtimeTargets = Object.freeze({
  "win32-x64": {
    nodeArchive: `node-v${NODE_VERSION}-win-x64.zip`,
    nodeSha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    postgresTarget: "x86_64-pc-windows-msvc",
    postgresSha256: "157bd7322f8c653f06b0373d1b2280e9cb238b6a6d3bd05541aeb8f33885a8ad",
  },
  "darwin-arm64": {
    nodeArchive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeSha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    postgresTarget: "aarch64-apple-darwin",
    postgresSha256: "46f6382024d9b633d1f4b4903ffef8c2404e00ae83098d628c00591048cb0512",
  },
  "darwin-x64": {
    nodeArchive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    nodeSha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
    postgresTarget: "x86_64-apple-darwin",
    postgresSha256: "dfae21b2b931f1d8d1103afb6e8e108fdd94c6f407ce24d35b6cd0ad34f286d1",
  },
  // Linux is a runtime/smoke host only. There is deliberately no Linux installer.
  "linux-x64": {
    nodeArchive: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    nodeSha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    postgresTarget: "x86_64-unknown-linux-gnu",
    postgresSha256: "77dd669eda3985ea8be26256f6af28d3c8414152ada713797555bb7423b4486a",
  },
});

export const inside = (root, path) => {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
};
export const portable = (value) => value.split(sep).join("/");
export const targetName = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
export function requireNativeTarget(platform = process.platform, arch = process.arch, product = false) {
  const target = targetName(platform, arch);
  if (!runtimeTargets[target] || (product && platform === "linux"))
    throw new Error(product
      ? "Desktop installers support native Windows x64 and macOS arm64/x64 only. Linux is runtime/smoke-only."
      : `Unsupported runtime target ${target}; supported: ${Object.keys(runtimeTargets).join(", ")}.`);
  if (platform !== process.platform || arch !== process.arch)
    throw new Error(`Use a matching native ${target} runner; cross-packaging native Node dependencies is not supported.`);
  return target;
}
export function requirePinnedNode() {
  if (process.versions.node !== NODE_VERSION)
    throw new Error(`Use Node ${NODE_VERSION} for reproducible desktop preparation and packaging (current ${process.versions.node}).`);
}
export function runtimeSources(target) {
  const pin = runtimeTargets[target];
  if (!pin) throw new Error(`Unsupported runtime target: ${target}`);
  const postgresArchive = `postgresql-${POSTGRES_RELEASE}-${pin.postgresTarget}.tar.gz`;
  return {
    node: { version: NODE_VERSION, archive: pin.nodeArchive, url: `https://nodejs.org/dist/v${NODE_VERSION}/${pin.nodeArchive}`, sha256: pin.nodeSha256 },
    postgres: {
      version: POSTGRES_VERSION, release: POSTGRES_RELEASE, upstreamCommit: POSTGRES_COMMIT,
      archive: postgresArchive,
      url: `https://github.com/theseus-rs/postgresql-binaries/releases/download/${POSTGRES_RELEASE}/${postgresArchive}`,
      sha256: pin.postgresSha256,
    },
  };
}
export async function hashFile(path, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export async function inventoryTree(root, directory = root) {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    const location = portable(relative(root, path));
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !inside(root, resolve(dirname(path), link)) || !inside(root, await realpath(path)))
        throw new Error(`Runtime contains an escaping or absolute symlink: ${location}`);
      entries.push({ path: location, link: portable(link) });
    } else if (info.isDirectory()) entries.push(...await inventoryTree(root, path));
    else if (info.isFile()) entries.push({ path: location, bytes: info.size, mode: info.mode & 0o777, sha256: await hashFile(path) });
    else throw new Error(`Unsupported runtime resource: ${location}`);
  }
  return entries;
}

export const RUNTIME_MANIFEST_VERSION = 2;
export const NODE_DISTRIBUTION_PROFILE = "execution-only-v1";

// Only these official-archive paths are omitted. Everything else, including
// headers, shared resources and Node's complete LICENSE, stays byte-for-byte.
export function nodeToolingPaths(target) {
  if (!runtimeTargets[target]) throw new Error(`Unsupported runtime target: ${target}`);
  return target.startsWith("win32-")
    ? ["node_modules/npm", "node_modules/corepack", "npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1",
      "corepack", "corepack.cmd", "corepack.ps1", "install_tools.bat", "nodevars.bat"]
    : ["lib/node_modules/npm", "lib/node_modules/corepack", "bin/npm", "bin/npx", "bin/corepack"];
}
const legalMaterial = (path) => !/\.(?:[cm]?[jt]sx?|json|exe|dll|node|bat|cmd|ps1|sh|py)$/i.test(path)
  && path.split("/").some((part) => /^(?:licen[cs]es?|copying|notices?|copyright)(?:[._-].*)?$/i.test(part));
const sourcePath = (path) => typeof path === "string" && path && !/[\\:\0\r\n]/.test(path)
  && !posix.isAbsolute(path) && path.split("/").every((part) => part && part !== "." && part !== "..");
const comparableFiles = (files, target) => files.map(({ mode, ...entry }) => target.startsWith("win32-") ? entry : { ...entry, mode });

export function transformedNodeFiles(sourceFiles, target) {
  const omitted = nodeToolingPaths(target), seen = new Set(), files = [];
  for (const file of sourceFiles) {
    if (!sourcePath(file.path) || seen.has(file.path)) throw new Error("Invalid Node source archive inventory path.");
    seen.add(file.path);
    if (file.link !== undefined) {
      if (typeof file.link !== "string" || file.link.includes("\\") || posix.isAbsolute(file.link)
        || !sourcePath(posix.normalize(posix.join(posix.dirname(file.path), file.link))))
        throw new Error("Invalid Node source archive inventory link.");
    } else if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? ""))
      throw new Error("Invalid Node source archive inventory bytes.");
    const removed = omitted.some((path) => file.path === path || file.path.startsWith(`${path}/`));
    if (!removed && file.path.split("/").includes("node_modules"))
      throw new Error(`Unexpected package-manager contents in Node source: ${file.path}`);
    if (!removed) files.push({ ...file, path: `node/${file.path}` });
    else if (legalMaterial(file.path)) {
      if (file.link !== undefined) throw new Error("Node tooling legal material must be a regular archive file.");
      files.push({ ...file, path: `node-tooling-notices/${file.path}` });
    }
  }
  for (const required of [target.startsWith("win32-") ? "node.exe" : "bin/node", "LICENSE"])
    if (!sourceFiles.some((file) => file.path === required && file.link === undefined))
      throw new Error(`Node source archive lacks required resource: ${required}`);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function prepareNodeDistribution(root, target) {
  const sourceFiles = await inventoryTree(join(root, "node"));
  const expected = transformedNodeFiles(sourceFiles, target);
  for (const file of expected.filter((entry) => entry.path.startsWith("node-tooling-notices/"))) {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, "node", file.path.slice("node-tooling-notices/".length)), destination, { preserveTimestamps: true, errorOnExist: true, force: false });
  }
  for (const path of nodeToolingPaths(target)) await rm(join(root, "node", path), { recursive: true, force: true });
  // Empty node_modules parents are not runtime resources either.
  await rm(join(root, "node", target.startsWith("win32-") ? "node_modules" : "lib/node_modules"), { recursive: true, force: true });
  return { profile: NODE_DISTRIBUTION_PROFILE, sourceArchiveSha256: runtimeSources(target).node.sha256, sourceFiles };
}

export function validateRuntimeManifest(manifest, target) {
  if (manifest.version !== RUNTIME_MANIFEST_VERSION || manifest.target !== target
    || JSON.stringify(manifest.sources) !== JSON.stringify(runtimeSources(target))
    || manifest.nodeDistribution?.profile !== NODE_DISTRIBUTION_PROFILE
    || manifest.nodeDistribution.sourceArchiveSha256 !== runtimeSources(target).node.sha256
    || !Array.isArray(manifest.nodeDistribution.sourceFiles) || !Array.isArray(manifest.files))
    throw new Error("Prepared runtime version/target/profile does not match the pinned desktop runtime; prepare a new empty output directory.");
  const expected = transformedNodeFiles(manifest.nodeDistribution.sourceFiles, target);
  const shipped = manifest.files.filter((file) => file.path.startsWith("node/") || file.path.startsWith("node-tooling-notices/"))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(comparableFiles(shipped, target)) !== JSON.stringify(comparableFiles(expected, target)))
    throw new Error("Runtime Node inventory differs from the exact declared official-archive transformation.");
}

export async function assertNoNodeTooling(root, target) {
  for (const path of [...nodeToolingPaths(target), target.startsWith("win32-") ? "node_modules" : "lib/node_modules"]) {
    const info = await lstat(join(root, "node", path)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info) throw new Error(`Execution-only Node runtime contains forbidden tooling: ${path}`);
  }
}

export async function verifyRuntime(root, target = requireNativeTarget()) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Prepared runtime must be an owned real directory.");
  const manifest = JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8"));
  validateRuntimeManifest(manifest, target);
  await assertNoNodeTooling(root, target);
  const actual = (await inventoryTree(root)).filter((entry) => entry.path !== "runtime-manifest.json");
  // Executable permission bits on Windows are a filesystem property, not archive data.
  const comparable = (files) => files.map(({ mode, ...entry }) => process.platform === "win32" ? entry : { ...entry, mode });
  if (JSON.stringify(comparable(actual)) !== JSON.stringify(comparable(manifest.files)))
    throw new Error("Prepared runtime files changed or are incomplete. Refusing to package unverified executable resources.");
  const suffix = target.startsWith("win32-") ? ".exe" : "";
  await access(join(root, "node", suffix ? "node.exe" : "bin/node"));
  for (const name of ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"])
    await access(join(root, "postgres", "bin", `${name}${suffix}`));
  return manifest;
}
