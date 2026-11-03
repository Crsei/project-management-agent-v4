// Offline provenance only. Never imports, executes, or overwrites upstream/production code.
// Copy:  node vendor/t3code/scripts/mcp-skills-source.mjs --source LOCAL_GIT_CHECKOUT
// Check: node vendor/t3code/scripts/mcp-skills-source.mjs --source LOCAL_GIT_CHECKOUT --check
// --destination PM_ROOT reconstructs only .ref/t3code-mcp-skills/<commit>/ there.
// --capture authors the new manifest once; refuses an existing manifest.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = "d53873b6a4799e87afd63c8d288ef0089f5a3748";
const TREE = "1ab9c39907a33049077eb675add6aec4ac53b560";
const VENDOR_COMMIT = "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c";
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const manifestPath = path.join(repository, "vendor/t3code/mcp-skills-source.json");
const snapshotRelative = `.ref/t3code-mcp-skills/${COMMIT}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blobHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (options.has(key)) throw new Error(`Duplicate option: ${key}`);
  if (["--check", "--capture"].includes(key)) options.set(key, true);
  else if (["--source", "--destination"].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) options.set(key, process.argv[++index]);
  else throw new Error(`Unknown or incomplete option: ${key}`);
}
if (!options.has("--source") || (options.has("--capture") && options.has("--check"))) {
  throw new Error("Usage: node vendor/t3code/scripts/mcp-skills-source.mjs --source LOCAL_GIT_CHECKOUT [--destination PM_ROOT] [--check | --capture]");
}
function relativePath(value) {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe path: ${value}`);
  return value;
}
function stat(value) {
  try { return lstatSync(value); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function safeDirectory(value) {
  const absolute = path.resolve(value);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = stat(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Unsafe directory/symlink: ${current}`);
  }
  return absolute;
}
function safeFile(root, relative) {
  const target = path.join(root, relativePath(relative));
  safeDirectory(path.dirname(target));
  const info = stat(target);
  if (info && (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o7000))) throw new Error(`Unsafe file/symlink/mode: ${target}`);
  return target;
}
const source = safeDirectory(options.get("--source"));
const destination = safeDirectory(options.get("--destination") ?? repository);
const snapshot = safeDirectory(path.join(destination, snapshotRelative));
if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) throw new Error("Source and destination must not overlap.");
const git = (args, extra = {}) => execFileSync("git", ["-C", source, ...args], {
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.allow", GIT_CONFIG_VALUE_0: "never" },
  maxBuffer: 64 * 1024 * 1024, ...extra,
});
if (git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== COMMIT || git(["rev-parse", `${COMMIT}^{tree}`], { encoding: "utf8" }).trim() !== TREE) throw new Error("Source HEAD/tree does not match pinned commit.");
const tree = git(["ls-tree", "-rz", "--long", COMMIT], { encoding: "utf8" }).split("\0").filter(Boolean).map((line) => {
  const separator = line.indexOf("\t");
  const [mode, type, blob, size] = line.slice(0, separator).trim().split(/\s+/);
  return { path: relativePath(line.slice(separator + 1)), mode, type, blob, bytes: size === "-" ? 0 : Number(size) };
});
const exclusions = new Map([
  [".claude/skills", { mode: "120000", blob: "2b7a412b8fa0fb7e985b0793321bd4e698f2b6cd", reason: "Symlink refused; canonical .agents/skills regular files are copied instead." }],
  [".repos/alchemy-effect/submodules/distilled", { mode: "160000", blob: "e02e9d405b8848909f4f746b61b12a663f631c7c", reason: "Unrelated reference-repository gitlink has no committed file bytes; no submodule/network access or runtime dependency." }],
  [".repos/alchemy-effect/submodules/floci", { mode: "160000", blob: "493909133db04153348eabc503f4e30cf0033d96", reason: "Unrelated reference-repository gitlink has no committed file bytes; no submodule/network access or runtime dependency." }],
]);
const regular = [];
const excluded = [];
for (const entry of tree) {
  const exclusion = exclusions.get(entry.path);
  if (exclusion) {
    if (entry.mode !== exclusion.mode || entry.blob !== exclusion.blob) throw new Error(`Changed exclusion: ${entry.path}`);
    excluded.push({ ...entry, reason: exclusion.reason });
  } else {
    if (!["100644", "100755"].includes(entry.mode) || entry.type !== "blob") throw new Error(`Unapproved symlink/gitlink: ${entry.path}`);
    if (entry.path.split("/").some((part) => [".git", ".local", ".env", ".env.local", "credentials.json", "access.json"].includes(part))) throw new Error(`Runtime/secret path refused: ${entry.path}`);
    regular.push(entry);
  }
}
if (excluded.length !== exclusions.size) throw new Error("Missing pinned exclusions.");
// Bounded batches read raw Git objects, never the dirty working tree (including its lockfile).
function visitBlobs(entries, visitor) {
  for (let start = 0; start < entries.length;) {
    let end = start;
    let size = 0;
    while (end < entries.length && end - start < 128 && (size < 16 * 1024 * 1024 || end === start)) size += entries[end++].bytes;
    const batch = entries.slice(start, end);
    const bytes = git(["cat-file", "--batch"], { input: batch.map((entry) => entry.blob + "\n").join(""), maxBuffer: size + batch.length * 128 + 1024 });
    let cursor = 0;
    for (const entry of batch) {
      const newline = bytes.indexOf(10, cursor);
      if (newline < 0 || bytes.subarray(cursor, newline).toString() !== `${entry.blob} blob ${entry.bytes}`) throw new Error(`Invalid Git object response: ${entry.path}`);
      cursor = newline + 1;
      const content = bytes.subarray(cursor, cursor + entry.bytes);
      cursor += entry.bytes;
      if (bytes[cursor++] !== 10 || blobHash(content) !== entry.blob) throw new Error(`Git blob mismatch: ${entry.path}`);
      visitor(entry, content);
    }
    if (cursor !== bytes.length) throw new Error("Unexpected Git object bytes.");
    start = end;
  }
}
const groupDefinitions = [
  { id: "C1", roots: ["apps/server/src/mcp/"], match: (p) => p.startsWith("apps/server/src/mcp/") },
  { id: "C2", roots: ["apps/server/src/auth/", "MCP OAuth client/consent routes"], match: (p) => p.startsWith("apps/server/src/auth/") || (p.startsWith("apps/web/") && /mcp.*(oauth|client)|oauth.*mcp/i.test(p)) },
  { id: "C3", roots: ["apps/server/src/mcpApps/", "App attachment/resource/migration references"], match: (p) => p.startsWith("apps/server/") && /mcpApp|attachment|resource|migration/i.test(p) },
  { id: "C4", roots: ["packages/contracts/", "packages/shared/"], match: (p) => /^(packages\/(contracts|shared)\/)/.test(p) },
  { id: "C5", roots: ["packages/provider-*/", "packages/effect-acp/", "packages/effect-codex-app-server/", "apps/server/src/provider/", "apps/server/src/orchestration-v2/Adapters/", "apps/server/src/textGeneration/"], match: (p) => /^packages\/(provider-[^/]+|effect-acp|effect-codex-app-server)\//.test(p) || /^apps\/server\/src\/(provider\/|orchestration-v2\/Adapters\/|textGeneration\/)/.test(p) || /^apps\/server\/src\/.*(codex|claude|antigravity|skill)/i.test(p) },
  { id: "C6", roots: ["packages/client-runtime/src/providerSkills*", "packages/client-runtime/src/mcpApps/", "packages/client-runtime/src/state/mcpApps.ts"], match: (p) => /^packages\/client-runtime\/src\/(providerSkills|mcpApps\/|state\/mcpApps)/.test(p) },
  { id: "C7", roots: ["apps/web/src/components/chat/", "apps/web/src/providerSkillSearch*", "apps/web/src/state/mcpApps.ts", "Web connection/settings/auth/menu/editor/timeline/styles"], match: (p) => p.startsWith("apps/web/") && /components\/chat\/|providerSkill|mcpApp|connection|settings|oauth|authorize|menu|editor|timeline|\.(css|scss)$/i.test(p) },
  { id: "C8", roots: ["LICENSE", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package manifests/configs", "docs/", "patches/", "scripts/", "assets/", "tracked fixtures/resources/schema"], match: (p) => !p.startsWith(".repos/") && (/^(docs|patches|scripts|assets)\//.test(p) || /(^|\/)(LICENSE[^/]*|NOTICE[^/]*|package\.json|[^/]*lock[^/]*|[^/]*config[^/]*|pnpm-workspace\.yaml)$/.test(p) || /(^|\/)(fixtures?|resources?|schema)\//.test(p)) },
];
let manifest;
if (options.has("--capture")) {
  safeFile(repository, "vendor/t3code/mcp-skills-source.json");
  if (existsSync(manifestPath)) throw new Error("Capture refuses an existing manifest; provenance is immutable.");
  const oldManifestBytes = readFileSync(safeFile(repository, "vendor/t3code/source-manifest.json"));
  const oldInventoryBytes = readFileSync(safeFile(repository, "vendor/t3code/sync-inventory.json"));
  const oldManifest = JSON.parse(oldManifestBytes);
  const oldInventory = JSON.parse(oldInventoryBytes);
  if (oldManifest.upstream.commit !== VENDOR_COMMIT || oldInventory.upstreamCommit !== VENDOR_COMMIT) throw new Error("Unexpected existing vendor baseline.");
  const oldFiles = new Map(oldManifest.files.map((entry) => [entry.source_path, entry]));
  const outputs = new Map(oldInventory.files.filter((entry) => entry.source).map((entry) => [entry.source, entry]));
  const files = [];
  visitBlobs(regular, (entry, content) => {
    const digest = sha256(content);
    const old = oldFiles.get(entry.path);
    const output = outputs.get(entry.path);
    const vendorPath = output?.destination ?? `vendor/t3code/${entry.path}`;
    const target = safeFile(repository, vendorPath);
    const current = stat(target);
    const currentHash = current ? sha256(readFileSync(target)) : null;
    const currentMode = current ? ((current.mode & 0o111) ? "100755" : "100644") : null;
    files.push({ ...entry, sha256: digest,
      seedGroups: groupDefinitions.filter((group) => group.match(entry.path)).map((group) => group.id),
      disposition: "source-reference-only",
      consumer: entry.path.startsWith(".repos/") ? "unrelated-upstream-reference-tree; never production dependency" : "MCP/Skills adaptation owners after parent source-gate acceptance",
      vendor: { path: vendorPath, status: !current ? "absent-retain-snapshot" : currentHash === digest && currentMode === entry.mode ? "identical-reuse-existing" : "different-preserve-newer-or-host-patched", sha256: currentHash, mode: currentMode,
        baselineOriginalSha256: old?.sha256 ?? null, baselineRelation: !old ? "not-in-existing-source-inventory" : old.sha256 === digest ? "same-upstream-bytes" : "upstream-revision-differs", existingProvenance: output?.provenance ?? null, patch: output?.patch ?? null },
    });
  });
  const license = files.find((entry) => entry.path === "LICENSE");
  const countBy = (selector) => Object.fromEntries([...new Set(files.map(selector))].sort().map((key) => [key, files.filter((entry) => selector(entry) === key).length]));
  manifest = {
    version: 1, stage: "T1/T3-immutable-source-input; production adaptation requires parent acceptance",
    upstream: { commit: COMMIT, tree: TREE, bytesSource: "git cat-file committed blobs; worktree is never read", license: { spdx: "MIT", path: "LICENSE", sha256: license.sha256 }, existingVendorCommit: VENDOR_COMMIT },
    snapshot: { path: snapshotRelative, policy: "Every regular tracked blob, original relative paths/bytes/canonical Git modes; symlinks/gitlinks explicitly excluded. No .git or untracked runtime/user files.", runtimeUse: "Forbidden: ignored local adaptation input only; no imports, workspace membership, packaging or production execution.", closure: "Whole regular tracked tree is a conservative source/resource/test superset, not a claimed AST-minimal closure. Static/type/dynamic imports, createRequire, import.meta resources, styles, workers and fixtures retain all tracked targets. Generated/untracked outputs and external dependencies remain described by committed scripts/manifests/lock; nothing is installed or fetched.", computedPaths: "Whole tracked tree retained for computed resources; host absolute paths, user HOME, databases, runtime sessions and generated/external assets are not copied or resolved.", modePolicy: "Exact canonical 0644/0755 for created and checked regular files. Existing conflicts, extra files, symlinks/nonregular entries rejected; no overwrite/chmod of existing files." },
    provenance: { existingSourceManifestSha256: sha256(oldManifestBytes), existingSyncInventorySha256: sha256(oldInventoryBytes), comparison: "Point-in-time existing vendor bytes plus recorded newer upstream originals/patches; this tool never changes or continuously validates production. Every input remains source-reference-only until explicitly adapted. Identical files preserve existing production; differing files require explicit merge, never downgrade." },
    usage: { copy: "node vendor/t3code/scripts/mcp-skills-source.mjs --source LOCAL_GIT_CHECKOUT [--destination PM_ROOT]", check: "node vendor/t3code/scripts/mcp-skills-source.mjs --source LOCAL_GIT_CHECKOUT [--destination PM_ROOT] --check", adaptation: "Read originals under snapshot.path/<original path>; copy/extract only into assigned in-repository production paths after parent acceptance. Keep snapshot immutable. Reuse identical newer vendor; explicitly merge differences and retain PM authorization/persistence. Never import .ref or the external checkout at runtime." },
    groups: groupDefinitions.map(({ id, roots }) => ({ id, roots, selectedAdaptationSeeds: files.filter((entry) => entry.seedGroups.includes(id)).map((entry) => entry.path) })),
    toolkitLedger: files.filter((entry) => /^apps\/server\/src\/mcp\/toolkits\/[^/]+\/tools\.ts$/.test(entry.path)).map((entry) => ({ path: entry.path, disposition: "source-reference-only", productionRegistration: "none-by-copy", reason: "Parent host capability map controls registration; no automatic upstream business-service activation." })),
    excluded,
    summary: { trackedEntries: tree.length, copiedRegularFiles: files.length, copiedBytes: files.reduce((sum, entry) => sum + entry.bytes, 0), excludedEntries: excluded.length, selectedSeedFiles: files.filter((entry) => entry.seedGroups.length).length, vendorDispositions: countBy((entry) => entry.vendor.status) },
    files,
  };
  manifest.inventorySha256 = sha256(JSON.stringify({ files: manifest.files, excluded: manifest.excluded }));
} else {
  manifest = JSON.parse(readFileSync(safeFile(repository, "vendor/t3code/mcp-skills-source.json")));
}
if (manifest.version !== 1 || manifest.upstream.commit !== COMMIT || manifest.upstream.tree !== TREE || manifest.snapshot.path !== snapshotRelative) throw new Error("Manifest identity mismatch.");
if (manifest.inventorySha256 !== sha256(JSON.stringify({ files: manifest.files, excluded: manifest.excluded }))) throw new Error("Manifest inventory digest mismatch.");
if (JSON.stringify(manifest.excluded) !== JSON.stringify(excluded) || manifest.files.length !== regular.length) throw new Error("Manifest/tree membership mismatch.");
for (let index = 0; index < regular.length; index++) {
  const entry = manifest.files[index];
  const original = regular[index];
  for (const key of ["path", "mode", "type", "blob", "bytes"]) if (entry[key] !== original[key]) throw new Error(`Manifest/tree mismatch: ${original.path}`);
}
visitBlobs(manifest.files, (entry, content) => { if (sha256(content) !== entry.sha256) throw new Error(`Source SHA256 mismatch: ${entry.path}`); });
// Preflight the entire destination before creating anything, including unexpected files/links.
const allowed = new Set(manifest.files.map((entry) => entry.path));
const directories = new Set();
for (const entry of manifest.files) {
  let parent = path.posix.dirname(entry.path);
  while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
}
function checkExtra(directory, prefix = "") {
  if (!stat(directory)) return;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Destination symlink: ${relative}`);
    if (item.isDirectory() && directories.has(relative)) checkExtra(path.join(directory, item.name), relative + "/");
    else if (!item.isFile() || !allowed.has(relative)) throw new Error(`Unexpected snapshot entry: ${relative}`);
  }
}
checkExtra(snapshot);
const missing = [];
for (const entry of manifest.files) {
  const target = safeFile(snapshot, entry.path);
  const info = stat(target);
  if (!info) {
    if (options.has("--check")) throw new Error(`Missing snapshot file: ${entry.path}`);
    missing.push(entry);
  } else if ((info.mode & 0o7777) !== Number.parseInt(entry.mode.slice(3), 8) || info.size !== entry.bytes || sha256(readFileSync(target)) !== entry.sha256) throw new Error(`Snapshot conflict; no files written: ${entry.path}`);
}
visitBlobs(missing, (entry, content) => {
  if (sha256(content) !== entry.sha256) throw new Error(`Source changed: ${entry.path}`);
  const target = safeFile(snapshot, entry.path);
  mkdirSync(path.dirname(target), { recursive: true });
  safeFile(snapshot, entry.path);
  const mode = Number.parseInt(entry.mode.slice(3), 8);
  writeFileSync(target, content, { flag: "wx", mode });
  chmodSync(target, mode);
});
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
if (options.has("--capture")) writeFileSync(manifestPath, manifestBytes, { flag: "wx", mode: 0o644 });
console.log(JSON.stringify({ status: options.has("--check") ? "checked" : "copied", commit: COMMIT, snapshot: snapshotRelative, ...manifest.summary, created: missing.length, inventorySha256: manifest.inventorySha256, manifestSha256: sha256(manifestBytes), licenseSha256: manifest.upstream.license.sha256 }));
