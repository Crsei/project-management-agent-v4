import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { create as createTar } from "tar";
import { desktopRoot, hashFile } from "./runtime-manifest.mjs";
import { assertCanonicalAbsolute, fileStamp, GuardedDirectory, safeRelativePath, sameFileIdentity } from "../../../packages/pm-core/platform.ts";
import { assertNoWindowsReparsePath, cacheWindowsPathAttributes, getWindowsPathAttributeMetrics } from "../../../packages/pm-core/windows-reparse.ts";
import { inspectDeployment } from "./stage-workspace.mjs";

const execute = promisify(execFile);
export const repository = resolve(desktopRoot, "../..");
const publicRoots = ["apps", "packages", "vendor", "scripts", "tests", "patches", "deploy", "docs", ".github", ".agents"];
const publicFiles = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "LICENSE", "LICENSE.t3code", "THIRD_PARTY_NOTICES.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", ".node-version", ".gitattributes", ".gitignore", ".dockerignore", "eslint.config.mjs", "tsconfig.base.json", "tsconfig.backend.json", "tsconfig.check.json", "tsconfig.agent.json"];
// Explicitly reviewed new public files, not an archive of every untracked file.
const additions = [
  "apps/server/agent/scripts/external-agent-packages.mjs",
  "apps/desktop/scripts/external-agent-packages.test.mjs",
  "apps/desktop/scripts/packaged-application.mjs",
  "apps/desktop/scripts/release-materials.mjs",
  "apps/desktop/scripts/release-materials.test.mjs",
  "apps/desktop/scripts/source-capture-benchmark.mjs",
  "apps/desktop/scripts/verify-delivery.mjs",
  "docs/reference/desktop-release-alignment-2026-11-08.zh.md",
  "docs/reference/windows-build-runbook.zh.md",
];
const generated = new Set(["node_modules", "dist", "target", ".git", ".local", ".cache", ".runtime", ".ref", ".omp", ".tmp", ".astro", ".vite", "releases", "release", "test-results", "playwright-report", "storybook-static", "__pycache__"]);
export function publicSourcePath(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes(":") || path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || generated.has(part) || part.toLowerCase().startsWith(".env") || [".npmrc", ".pnpmfile.cjs", "credentials.json", ".credentials", ".token", "token", "id_rsa", "id_ed25519"].includes(part) || /\.(?:p12|pfx|pem|key)$/i.test(part))) return false;
  if (path === "docs/implementation" || path.startsWith("docs/implementation/")) return false;
  return publicFiles.includes(path) || publicRoots.includes(parts[0]);
}
export const contentDigest = (files) => createHash("sha256").update(JSON.stringify(files)).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const exists = async (path) => lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
async function git(root, args) {
  return (await execute("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
}
// Structured, path-free phase records are independent of release manifests:
// timing is diagnostic evidence, never a substitute for an integrity check.
export async function observePackagingPhase(phase, action, { onMetrics, counts } = {}) {
  const before = getWindowsPathAttributeMetrics();
  const started = performance.now();
  const context = { scope: "desktop-package", phase, platform: process.platform, arch: process.arch };
  console.log(JSON.stringify({ ...context, status: "start" }));
  let status = "failure";
  try {
    const result = await action();
    status = "end";
    return result;
  } finally {
    const after = getWindowsPathAttributeMetrics();
    const native = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    // Repeated guard checks count as lookups; the denominator is not unique files.
    const lookups = native.cacheHits + native.cacheMisses;
    const result = { ...context, status, elapsedMs: performance.now() - started, ...counts, nativeCallScope: "windows-path-attributes", ...native, cacheHitRate: lookups ? native.cacheHits / lookups : null };
    console.log(JSON.stringify(result));
    onMetrics?.(result);
  }
}

export function validateSource(source) {
  if (source?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(source.commit) || typeof source.dirty !== "boolean" || !Array.isArray(source.files) || !source.files.length)
    throw new Error("A complete desktop-source.json with the original Git identity is required.");
  const names = new Set();
  for (const file of source.files) {
    if (!publicSourcePath(file.path) || names.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || ![0o644, 0o755].includes(file.mode))
      throw new Error("Unsafe or incomplete corresponding-source inventory.");
    names.add(file.path);
  }
  if (contentDigest(source.files) !== source.sha256 || !names.has("apps/desktop/package.json") || !names.has("pnpm-lock.yaml"))
    throw new Error("Corresponding-source inventory digest or build closure is invalid.");
}

async function gitSourceSelection(root) {
  const tracked = (await git(root, ["ls-files", "--stage", "-z", "--cached", "--", ...publicRoots, ...publicFiles])).split("\0").filter(Boolean);
  const modes = new Map(tracked.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.startsWith("100755 ") ? 0o755 : 0o644]));
  const paths = [...modes.keys()].filter(publicSourcePath);
  const untracked = (await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...publicRoots, ...publicFiles])).split("\0").filter(publicSourcePath);
  for (const path of untracked) if (!additions.includes(path))
    throw new Error(`Unreviewed untracked public source must be explicitly reviewed before packaging: ${path}`);
  for (const path of additions) if (await exists(join(root, path))) paths.push(path);
  return { modes, paths: [...new Set(paths)].sort() };
}

async function headSourceFiles(root, commit) {
  const entries = (await git(root, ["ls-tree", "-r", "-z", commit, "--", ...publicRoots, ...publicFiles])).split("\0").filter(Boolean);
  return new Map(entries.map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, , blob] = entry.slice(0, tab).split(" ");
    return [entry.slice(tab + 1), { mode, blob }];
  }).filter(([path]) => publicSourcePath(path)));
}

const sourceMode = (info, recorded) => process.platform === "win32" && recorded !== undefined ? recorded : info.mode & 0o111n ? 0o755 : 0o644;
// Prewarming is only a cache hint. Every guarded traversal and per-file before/
// after check still runs, and a changed identity/stamp still forces a native query.
function prewarmSourcePaths(root, paths = []) {
  if (process.platform !== "win32") return;
  // Apply the same platform gates as guarded traversal before even metadata I/O.
  assertCanonicalAbsolute(root);
  if (paths.some((path) => !safeRelativePath(path))) throw new Error("Unsafe source path component.");
  const directories = new Set();
  const ancestors = (location) => {
    for (let current = location; ; current = dirname(current)) {
      if (directories.has(current)) break;
      directories.add(current);
      if (dirname(current) === current) break;
    }
  };
  ancestors(root);
  const filenames = paths.map((path) => join(root, path));
  for (const filename of filenames) ancestors(dirname(filename));
  const ordered = [...directories].sort((left, right) => left.length - right.length || left.localeCompare(right));
  cacheWindowsPathAttributes(ordered);
  for (const directory of ordered) {
    const info = lstatSync(directory, { bigint: true });
    assertNoWindowsReparsePath(directory, info);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Source ancestor must be a real directory without a symlink or junction.");
  }
  cacheWindowsPathAttributes(filenames);
}

async function withSourceFile(root, path, consume) {
  const directories = [root];
  let fd;
  const assertDirectories = () => { for (const directory of directories) directory.assertCurrent(); };
  try {
    const components = path.split("/");
    let directory = root;
    for (const component of components.slice(0, -1)) {
      assertDirectories();
      directory = new GuardedDirectory(directory.path(component));
      directories.push(directory);
    }
    const filename = directory.path(components.at(-1));
    const before = lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Source must be a regular file without a symlink or junction.");
    assertNoWindowsReparsePath(filename, before);
    assertDirectories();
    // Source is read-only: pnpm file: dependencies may legitimately share this
    // inode. Private PM storage's single-link writable-file policy does not apply.
    fd = openSync(filename, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened) || fileStamp(before) !== fileStamp(opened))
      throw new Error("Source file identity changed before reading.");
    assertDirectories();
    const result = await consume(fd, opened);
    assertDirectories();
    const current = lstatSync(filename, { bigint: true });
    assertNoWindowsReparsePath(filename, current);
    if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current)
      || fileStamp(opened) !== fileStamp(current) || fileStamp(opened) !== fileStamp(fstatSync(fd, { bigint: true })))
      throw new Error("Source file identity or contents changed while reading.");
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
    for (const directory of directories.slice(1).reverse()) directory.close();
  }
}

async function snapshotFiles(directory, prefix = "") {
  const result = [];
  directory.assertCurrent();
  const names = (await readdir(directory.path())).sort().filter((name) => publicSourcePath(prefix ? `${prefix}/${name}` : name));
  if (process.platform === "win32") cacheWindowsPathAttributes(names.map((name) => directory.path(name)));
  for (const name of names) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(directory.path(name), { bigint: true });
    if (info.isSymbolicLink()) throw new Error("Source directory contains a symlink or junction.");
    if (info.isDirectory()) {
      const child = new GuardedDirectory(directory.path(name));
      try { result.push(...await snapshotFiles(child, path)); }
      finally { child.close(); }
    } else if (info.isFile()) result.push(path);
    else throw new Error("Source directory contains an unsupported filesystem resource.");
    directory.assertCurrent();
  }
  directory.assertCurrent();
  return result;
}

export async function captureSource(destination, root = repository, { onMetrics } = {}) {
  const counts = { files: 0, bytes: 0 };
  return observePackagingPhase("captureSource", async () => {
    root = resolve(root);
    prewarmSourcePaths(root);
    return captureSourceFiles(destination, root, counts);
  }, { onMetrics, counts });
}

async function captureSourceFiles(destination, root, counts) {
  const directory = new GuardedDirectory(root);
  try {
    const hasGit = await exists(join(root, ".git"));
    let source;
    let paths;
    let modes = new Map();
    let head;
    if (hasGit) {
      if (await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim()) !== await realpath(root))
        throw new Error("Desktop source identity must belong to this repository, not a parent checkout.");
      ({ modes, paths } = await gitSourceSelection(root));
      const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
      head = await headSourceFiles(root, commit);
      source = { schemaVersion: 1, commit, dirty: JSON.stringify([...head.keys()].sort()) !== JSON.stringify(paths), identityOrigin: "local Git HEAD objects compared with exact public-source bytes, paths and modes" };
    } else {
      source = await withSourceFile(directory, "desktop-source.json", (fd) => JSON.parse(readFileSync(fd, "utf8")));
      validateSource(source);
      paths = source.files.map((file) => file.path);
      modes = new Map(source.files.map((file) => [file.path, file.mode]));
      if (JSON.stringify((await snapshotFiles(directory)).sort()) !== JSON.stringify([...paths].sort()))
        throw new Error("Snapshot contains missing or unrecorded public source files; refusing an ambiguous build identity.");
    }
    directory.assertCurrent();
    prewarmSourcePaths(root, paths);
    await mkdir(destination, { recursive: true });
    const files = [];
    for (const path of paths) {
      const output = join(destination, path);
      let created = false;
      try {
        const { record, blob } = await withSourceFile(directory, path, async (fd, info) => {
          await mkdir(dirname(output), { recursive: true });
          const mode = sourceMode(info, modes.get(path));
          const writer = createWriteStream(output, { flags: "wx", mode });
          writer.once("open", () => { created = true; });
          await pipeline(createReadStream(null, { fd, autoClose: false }), writer);
          await chmod(output, mode);
          const sha256 = createHash("sha256");
          const gitBlob = hasGit ? createHash("sha1").update(`blob ${info.size}\0`) : null;
          for await (const bytes of createReadStream(output)) {
            sha256.update(bytes);
            gitBlob?.update(bytes);
          }
          return { record: { path, bytes: Number(info.size), mode, sha256: sha256.digest("hex") }, blob: gitBlob?.digest("hex") };
        });
        files.push(record);
        counts.files++;
        counts.bytes += record.bytes;
        if (hasGit && (head.get(path)?.blob !== blob || head.get(path)?.mode !== (record.mode === 0o755 ? "100755" : "100644")))
          source.dirty = true;
      } catch (cause) {
        if (created) await rm(output, { force: true });
        throw cause;
      }
    }
    if (!hasGit && JSON.stringify(files) !== JSON.stringify(source.files))
      throw new Error("Snapshot source bytes differ from desktop-source.json.");
    source = { ...source, files, sha256: contentDigest(files) };
    validateSource(source);
    directory.assertCurrent();
    await writeFile(join(destination, "desktop-source.json"), json(source));
    return source;
  } finally { directory.close(); }
}

export async function requireUnchangedSource(source, root = repository, { onMetrics } = {}) {
  const counts = { files: 0, bytes: 0 };
  return observePackagingPhase("requireUnchangedSource", async () => {
    validateSource(source);
    root = resolve(root);
    prewarmSourcePaths(root);
    return checkUnchangedSource(source, root, counts);
  }, { onMetrics, counts });
}

async function checkUnchangedSource(source, root, counts) {
  const directory = new GuardedDirectory(root);
  try {
    const hasGit = await exists(join(root, ".git"));
    if (hasGit && (await git(root, ["rev-parse", "HEAD"])).trim() !== source.commit)
      throw new Error("Source commit changed while packaging.");
    const checkSelection = async () => {
      let paths;
      let modes = new Map();
      try {
        if (hasGit) ({ paths, modes } = await gitSourceSelection(root));
        else paths = (await snapshotFiles(directory)).sort();
      } catch (cause) { throw new Error("Source selection changed while packaging.", { cause }); }
      if (JSON.stringify(paths) !== JSON.stringify(source.files.map((file) => file.path).sort()))
        throw new Error("Source selection changed while packaging.");
      return modes;
    };
    const modes = await checkSelection();
    prewarmSourcePaths(root, source.files.map((file) => file.path));
    for (const file of source.files) {
      try {
        await withSourceFile(directory, file.path, async (fd, info) => {
          const hash = createHash("sha256");
          for await (const bytes of createReadStream(null, { fd, autoClose: false })) hash.update(bytes);
          if (Number(info.size) !== file.bytes || sourceMode(info, hasGit ? modes.get(file.path) : file.mode) !== file.mode || hash.digest("hex") !== file.sha256)
            throw new Error("Source content changed.");
        });
        counts.files++;
        counts.bytes += file.bytes;
      } catch (cause) { throw new Error(`Source changed while packaging: ${file.path}`, { cause }); }
    }
    await checkSelection();
    directory.assertCurrent();
  } finally { directory.close(); }
}

export async function fileRecord(output, name) {
  if (typeof name !== "string" || name !== basename(name) || !name || /[\\:\r\n\0]/.test(name) || name === "." || name === "..")
    throw new Error("Release files must have safe flat filenames.");
  const path = join(output, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Missing or invalid release file: ${name}`);
  return { path: name, bytes: info.size, sha256: await hashFile(path) };
}

export async function collectLegal(resources, platform, destination) {
  await mkdir(destination, { recursive: true });
  const legalRoot = platform === "darwin" ? resources : dirname(resources);
  const required = [
    [join(resources, "workspace-runtime/licenses"), "workspace/licenses"],
    [join(resources, "workspace-runtime/apps/web/dist/licenses"), "web/licenses"],
    [join(resources, "desktop-runtime/node/LICENSE"), "runtime/node-LICENSE"],
    [join(resources, "desktop-runtime/postgres/LICENSE"), "runtime/postgres-LICENSE"],
    [join(resources, "desktop-runtime/THIRD-PARTY-NOTICES.json"), "runtime/THIRD-PARTY-NOTICES.json"],
    [join(legalRoot, "LICENSE.electron.txt"), "electron/LICENSE.electron.txt"],
    [join(legalRoot, "LICENSES.chromium.html"), "electron/LICENSES.chromium.html"],
  ];
  // Require the final app's copies, not an npm wrapper's unrelated LICENSE.
  for (const [input, name] of required) {
    const info = await lstat(input);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.size === 0)))
      throw new Error(`Missing, linked or empty final legal resource: ${name}`);
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await cp(input, join(destination, name), { recursive: true, verbatimSymlinks: true });
  }
  const fonts = join(resources, "workspace-runtime/apps/web/dist/fonts");
  for (const name of (await readdir(fonts)).sort()) {
    if (!/(?:license|notice|copying)/i.test(name)) continue;
    await mkdir(join(destination, "web/fonts"), { recursive: true });
    await copyFile(join(fonts, name), join(destination, "web/fonts", name));
  }
  await inspectDeployment(destination);
}

export async function checksumDelivery(output, manifest) {
  const names = [...manifest.artifacts, ...manifest.materials].map((file) => file.path);
  names.push("desktop-package.json");
  if (new Set(names).size !== names.length) throw new Error("Duplicate release file in delivery manifest.");
  const records = [];
  for (const name of names.sort()) records.push(await fileRecord(output, name));
  await writeFile(join(output, "SHA256SUMS"), records.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
  return records;
}

export async function refreshVerification(output, manifest, verification) {
  await writeFile(join(output, "desktop-verification.json"), json(verification));
  manifest.materials = manifest.materials.filter((file) => file.path !== "desktop-verification.json");
  manifest.materials.push(await fileRecord(output, "desktop-verification.json"));
  manifest.materials.sort((left, right) => left.path.localeCompare(right.path, "en"));
  await writeFile(join(output, "desktop-package.json"), json(manifest));
  await observePackagingPhase("checksumDelivery", () => checksumDelivery(output, manifest));
}

export async function writeReleaseMaterials({ output, resources, platform, sourceRoot, source, legalRoot, manifest, verification }) {
  await mkdir(output, { recursive: true });
  await observePackagingPhase("archiveSource", () => createTar({ cwd: sourceRoot, gzip: true, portable: true, file: join(output, "desktop-source.tar.gz") }, [...source.files.map((file) => file.path), "desktop-source.json"]));
  await writeFile(join(output, "desktop-source.json"), json(source));
  await observePackagingPhase("collectLegal", () => collectLegal(resources, platform, legalRoot));
  await observePackagingPhase("archiveLegal", () => createTar({ cwd: legalRoot, gzip: true, portable: true, file: join(output, "desktop-legal.tar.gz") }, ["."]));
  const notices = await readFile(join(repository, "THIRD_PARTY_NOTICES.md"), "utf8");
  const openBlockers = [...notices.matchAll(/^\| ([A-Z][A-Z-]+) \| OPEN \|/gm)].map((match) => match[1]);
  const result = {
    schemaVersion: 2, ...manifest,
    source: { commit: source.commit, dirty: source.dirty, sha256: source.sha256, inventory: "desktop-source.json", archive: "desktop-source.tar.gz" },
    toolchain: {
      node: process.versions.node,
      pnpm: /^pnpm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? null,
      pnpmDeclared: JSON.parse(await readFile(join(repository, "package.json"), "utf8")).packageManager,
      electron: JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")).devDependencies.electron,
    },
    ci: process.env.GITHUB_ACTIONS === "true" ? {
      repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      runnerOS: process.env.RUNNER_OS, runnerArch: process.env.RUNNER_ARCH,
      imageOS: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null,
    } : null,
    releaseAuthorization: { status: "not-authorized", openBlockers, published: false, note: "Test delivery only. Checksums and source/legal materials do not grant public distribution or close third-party license/source obligations." },
    materials: await observePackagingPhase("recordReleaseMaterials", () => Promise.all(["desktop-source.tar.gz", "desktop-source.json", "desktop-legal.tar.gz"].map((name) => fileRecord(output, name)))),
  };
  if (result.ci && result.ci.commit !== source.commit) throw new Error("Actions checkout identity does not match the packaged source commit.");
  await refreshVerification(output, result, verification);
  return result;
}
