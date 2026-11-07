import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHostBuildInputs } from "./host-inputs.mjs";
import { assertRetiredTargetsAbsent, planMcpSkillsAdaptations } from "./mcp-skills-adaptations.mjs";

const toolRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = path.resolve(toolRoot, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (["--check", "--pristine"].includes(key)) options.set(key, true);
  else if (["--source", "--destination"].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) options.set(key, process.argv[++index]);
  else throw new Error(`Unknown or incomplete option: ${key}`);
}
if (!options.has("--source") || !options.has("--destination")) {
  throw new Error("Usage: node vendor/t3code/scripts/sync.mjs --source PINNED_CHECKOUT --destination PM_ROOT [--check] [--pristine]");
}

function relativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe inventory path: ${value}`);
  }
  return value;
}
async function safePath(root, relative) {
  const pieces = relativePath(relative).split("/");
  let current = root;
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]);
    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink() || (info && index < pieces.length - 1 && !info.isDirectory())) throw new Error(`Unsafe symlink/non-directory: ${current}`);
    if (info && index === pieces.length - 1 && !info.isFile()) throw new Error(`Not a regular file: ${current}`);
  }
  return current;
}
async function destinationRoot(value) {
  const absolute = path.resolve(value);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Unsafe destination ancestor: ${current}`);
  }
  return absolute;
}
function overlaps(left, right) {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}
function applySplices(original, splices, name) {
  const lines = original.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output = [];
  let cursor = 0;
  for (const splice of splices) {
    if (!Number.isInteger(splice.start) || splice.start < cursor || splice.start > lines.length || !Array.isArray(splice.before) || !Array.isArray(splice.after)) throw new Error(`Invalid patch ranges: ${name}`);
    const end = splice.start + splice.before.length;
    if (end > lines.length || lines.slice(splice.start, end).join("") !== splice.before.join("")) throw new Error(`Patch preimage mismatch: ${name}`);
    output.push(...lines.slice(cursor, splice.start), ...splice.after);
    cursor = end;
  }
  output.push(...lines.slice(cursor));
  return Buffer.from(output.join(""));
}

const source = await realpath(path.resolve(options.get("--source")));
const destination = await destinationRoot(options.get("--destination"));
if (overlaps(source, destination)) throw new Error("Source and destination must not overlap.");
const manifestBytes = await readFile(path.join(toolRoot, "source-manifest.json"));
const manifest = JSON.parse(manifestBytes);
const inventoryBytes = await readFile(path.join(toolRoot, "sync-inventory.json"));
const inventory = JSON.parse(inventoryBytes);
if (inventory.version !== 1 || inventory.upstreamCommit !== manifest.upstream.commit || hash(manifestBytes) !== inventory.sourceManifestSha256) throw new Error("Source manifest/inventory identity mismatch.");
await verifyHostBuildInputs(repository, inventory);
const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
if (commit !== inventory.upstreamCommit) throw new Error(`Wrong source commit: expected ${inventory.upstreamCommit}, received ${commit}`);

// Read every pinned input (references included) and every patch before inspecting or writing the destination.
const originals = new Map();
for (const entry of manifest.files) {
  const bytes = await readFile(await safePath(source, entry.source_path));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes || blob !== entry.git_blob_sha1) throw new Error(`Wrong source hash/blob: ${entry.source_path}`);
  originals.set(entry.source_path, bytes);
}
const adaptationPlan = options.has("--pristine") ? { outputs: new Map(), retirements: [] } : await planMcpSkillsAdaptations(repository, source);
const adaptations = adaptationPlan.outputs;
const pending = [];
const seen = new Set();
function schedule(relative, bytes, mode) {
  relativePath(relative);
  if (!relative.startsWith("vendor/t3code/") && !adaptations.has(relative)) throw new Error(`Outside owned source/adaptation tree: ${relative}`);
  if (mode !== 0o644 && mode !== 0o755) throw new Error(`Noncanonical inventory mode: ${relative}`);
  if (seen.has(relative)) throw new Error(`Duplicate destination: ${relative}`);
  seen.add(relative);
  pending.push({ relative, bytes, mode });
}
for (const entry of inventory.files) {
  if (options.has("--pristine") && !entry.source) continue;
  let bytes;
  if (entry.source) {
    bytes = originals.get(entry.source);
    if (!bytes || hash(bytes) !== entry.upstreamSha256) throw new Error(`Uninventoried upstream input: ${entry.source}`);
    if (!options.has("--pristine") && entry.patch) {
      const patchBytes = await readFile(await safePath(repository, entry.patch.path));
      if (hash(patchBytes) !== entry.patch.sha256) throw new Error(`Wrong patch hash: ${entry.patch.path}`);
      const patch = JSON.parse(patchBytes);
      if (patch.version !== 1 || patch.source !== entry.source || patch.beforeSha256 !== entry.upstreamSha256 || patch.afterSha256 !== entry.sha256) throw new Error(`Patch identity mismatch: ${entry.source}`);
      bytes = applySplices(bytes, patch.splices, entry.source);
    }
  } else if (entry.adaptation) {
    const adaptation = adaptations.get(entry.destination);
    if (!adaptation || entry.adaptation !== "vendor/t3code/mcp-skills-adaptations.json") throw new Error(`Missing supplemental adaptation: ${entry.destination}`);
    bytes = adaptation.bytes;
  } else {
    bytes = await readFile(await safePath(repository, entry.asset));
  }
  const expected = options.has("--pristine") ? entry.upstreamSha256 : entry.sha256;
  if (hash(bytes) !== expected) throw new Error(`Wrong reconstructed hash: ${entry.destination}`);
  schedule(entry.destination, bytes, entry.mode);
}
for (const [relative, adaptation] of adaptations) {
  if (seen.has(relative)) {
    const existing = pending.find((entry) => entry.relative === relative);
    if (!existing.bytes.equals(adaptation.bytes) || existing.mode !== adaptation.mode) throw new Error(`Baseline/supplemental recipe conflict: ${relative}`);
  } else schedule(relative, adaptation.bytes, adaptation.mode);
}
if (!options.has("--pristine")) schedule("vendor/t3code/sync-inventory.json", inventoryBytes, 0o644);
pending.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
await assertRetiredTargetsAbsent(destination, adaptationPlan.retirements);
const creates = [];
for (const entry of pending) {
  const target = await safePath(destination, entry.relative);
  const existing = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    if (options.has("--check")) throw new Error(`Missing destination: ${entry.relative}`);
    creates.push({ ...entry, target });
  } else if ((existing.mode & 0o7000) !== 0) {
    throw new Error(`Unsafe special-mode destination; no files written: ${entry.relative}`);
  } else if (hash(await readFile(target)) !== hash(entry.bytes) || Boolean(existing.mode & 0o111) !== Boolean(entry.mode & 0o111)) {
    throw new Error(`Destination conflict; no files written: ${entry.relative}`);
  }
}
// No overwrite/update/force mode: even a concurrently created target is protected by wx.
for (const entry of creates) {
  await safePath(destination, entry.relative);
  await mkdir(path.dirname(entry.target), { recursive: true });
  await writeFile(entry.target, entry.bytes, { flag: "wx", mode: entry.mode });
  await chmod(entry.target, entry.mode);
}
console.log(JSON.stringify({ commit, mode: options.has("--pristine") ? "pristine" : "patched", files: pending.length, created: creates.length, unchanged: pending.length - creates.length, check: options.has("--check") }));
