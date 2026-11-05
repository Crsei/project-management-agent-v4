import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const vendor = fileURLToPath(new URL("../", import.meta.url));
export const repository = path.resolve(vendor, "../..");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
export const inside = (root, target) => target === root || target.startsWith(root + path.sep);
export function relative(value) {
  if (typeof value !== "string" || !value || /[\\\0:]/.test(value) || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe provenance path: ${value}`);
  return value;
}
export async function safePath(root, value) {
  const absolute = path.resolve(root);
  let current = path.parse(absolute).root;
  const parts = [...absolute.slice(current.length).split(path.sep).filter(Boolean), ...relative(value).split("/")];
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink() || info && index < parts.length - 1 && !info.isDirectory()) throw new Error(`Unsafe provenance ancestor: ${current}`);
    if (info && index === parts.length - 1 && (!info.isFile() || info.nlink !== 1 || info.mode & 0o7000)) throw new Error(`Unsafe provenance file: ${value}`);
  }
  return current;
}
export async function file(root, value) {
  const target = await safePath(root, value);
  const info = await lstat(target);
  return { bytes: await readFile(target), mode: info.mode & 0o111 ? 0o755 : 0o644 };
}
export async function walk(root, prefix, ignored = []) {
  const result = [];
  async function visit(current) {
    if (ignored.some((entry) => current === entry || current.startsWith(entry + "/"))) return;
    const target = path.join(root, relative(current));
    const info = await lstat(target);
    if (info.isSymbolicLink() || info.mode & 0o7000) throw new Error(`Unsafe tree member: ${current}`);
    if (info.isDirectory()) for (const name of (await readdir(target)).sort()) await visit(`${current}/${name}`);
    else { await safePath(root, current); result.push(current); }
  }
  await visit(prefix);
  return result.sort();
}
export async function publish(root, value, bytes, mode = 0o644) {
  const target = await safePath(root, value);
  const old = await readFile(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (old?.equals(bytes)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode });
  await chmod(target, mode);
}
export async function policyInputs(root = repository) {
  const manifestBytes = (await file(root, "vendor/cc-switch/source-manifest.json")).bytes;
  const policyBytes = (await file(root, "vendor/cc-switch/fork-policy.json")).bytes;
  const manifest = JSON.parse(manifestBytes), policy = JSON.parse(policyBytes);
  if (policy.version !== 1 || manifest.schemaVersion !== 1 || manifest.commit !== policy.upstreamCommit || sha256(manifestBytes) !== policy.sourceManifestSha256) throw new Error("Immutable cc-switch source manifest identity changed.");
  const paths = new Set();
  for (const entry of manifest.files) {
    relative(entry.path);
    if (paths.has(entry.path) || !["100644", "100755"].includes(entry.mode) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{40}$/.test(entry.blob)) throw new Error(`Invalid immutable source entry: ${entry.path}`);
    paths.add(entry.path);
  }
  return { manifest, manifestBytes, policy, policyBytes };
}
export async function originalsFrom(source, manifest) {
  const root = await realpath(path.resolve(source));
  if (inside(root, repository) || inside(repository, root)) throw new Error("Source and host repository must not overlap.");
  const options = { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], options).trim();
  if (head !== manifest.commit) throw new Error(`Wrong source commit: ${head}`);
  const expected = new Set(manifest.files.map((entry) => entry.path));
  const actual = new Set();
  for (const selection of manifest.selection) {
    const target = await lstat(path.join(root, relative(selection)));
    if (target.isDirectory()) for (const name of await walk(root, selection)) actual.add(name);
    else actual.add(selection);
  }
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name))) throw new Error("Unknown or missing file in selected upstream source tree.");
  const originals = new Map();
  for (const entry of manifest.files) {
    const input = await file(root, entry.path);
    const blob = createHash("sha1").update(`blob ${input.bytes.length}\0`).update(input.bytes).digest("hex");
    if (sha256(input.bytes) !== entry.sha256 || input.bytes.length !== entry.bytes || blob !== entry.blob || Boolean(input.mode & 0o111) !== (entry.mode === "100755")) throw new Error(`Changed source hash/blob/mode: ${entry.path}`);
    originals.set(entry.path, input.bytes);
  }
  return originals;
}
export function patchBytes(before, after, source) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return encode({ version: 1, source, beforeSha256: sha256(before), afterSha256: sha256(after), format: "exact-byte-splice-base64-no-fuzz", start, before: before.subarray(start, oldEnd).toString("base64"), after: after.subarray(start, newEnd).toString("base64") });
}
export function applyPatch(before, bytes, entry) {
  const patch = JSON.parse(bytes);
  if (patch.version !== 1 || patch.format !== "exact-byte-splice-base64-no-fuzz" || patch.source !== entry.source || patch.beforeSha256 !== entry.upstreamSha256 || patch.afterSha256 !== entry.sha256 || sha256(before) !== patch.beforeSha256 || !Number.isSafeInteger(patch.start) || patch.start < 0 || patch.start > before.length) throw new Error(`Patch identity mismatch: ${entry.destination}`);
  const removed = Buffer.from(patch.before, "base64"), inserted = Buffer.from(patch.after, "base64");
  if (removed.toString("base64") !== patch.before || inserted.toString("base64") !== patch.after || !before.subarray(patch.start, patch.start + removed.length).equals(removed)) throw new Error(`Patch preimage mismatch: ${entry.destination}`);
  const result = Buffer.concat([before.subarray(0, patch.start), inserted, before.subarray(patch.start + removed.length)]);
  if (sha256(result) !== entry.sha256) throw new Error(`Patch postimage mismatch: ${entry.destination}`);
  return result;
}
export async function loadInventory(root = repository) {
  const inputs = await policyInputs(root);
  const inventoryBytes = (await file(root, "vendor/cc-switch/output-inventory.json")).bytes;
  const inventory = JSON.parse(inventoryBytes);
  if (inventory.version !== 1 || inventory.upstreamCommit !== inputs.manifest.commit || inventory.sourceManifestSha256 !== sha256(inputs.manifestBytes) || inventory.policySha256 !== sha256(inputs.policyBytes)) throw new Error("cc-switch inventory identity changed; reviewed capture required.");
  const seen = new Set();
  for (const entry of inventory.files) {
    relative(entry.destination);
    if (seen.has(entry.destination) || !/^[a-f0-9]{64}$/.test(entry.sha256) || ![0o644, 0o755].includes(entry.mode)) throw new Error(`Invalid output entry: ${entry.destination}`);
    seen.add(entry.destination);
  }
  for (const patch of inventory.patches) {
    if (sha256((await file(root, relative(patch.path))).bytes) !== patch.sha256) throw new Error(`Unknown patch change: ${patch.path}`);
  }
  if (sha256((await file(root, "vendor/cc-switch/resource-closure.json")).bytes) !== inventory.closureSha256) throw new Error("Resource closure ledger changed.");
  if (sha256((await file(root, "vendor/cc-switch/upstream-tree.json")).bytes) !== inventory.upstreamTreeSha256) throw new Error("Pinned upstream path tree changed.");
  const hostInputs = inventory.hostBuildInputs ?? [];
  if (JSON.stringify(hostInputs.map((entry) => entry.path)) !== JSON.stringify(inputs.policy.hostBuildInputs ?? [])) throw new Error("Host build input enrollment changed.");
  for (const entry of hostInputs) {
    const current = await file(root, entry.path);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes) throw new Error(`Host build input changed: ${entry.path}`);
  }
  return { ...inputs, inventory, inventoryBytes };
}
export async function verifyOutputs(root = repository) {
  const loaded = await loadInventory(root);
  const expected = new Set(loaded.inventory.files.map((entry) => entry.destination));
  const metadata = new Set(["vendor/cc-switch/output-inventory.json", "vendor/cc-switch/resource-closure.json", "vendor/cc-switch/upstream-tree.json", ...loaded.inventory.patches.map((entry) => entry.path)]);
  for (const entry of loaded.inventory.files) {
    const current = await file(root, entry.destination);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes || current.mode !== entry.mode) throw new Error(`Unknown output change: ${entry.destination}`);
  }
  for (const tree of loaded.policy.ownedTrees ?? ["vendor/cc-switch"]) {
    for (const name of await walk(root, tree, loaded.policy.generatedTrees)) if (!expected.has(name) && !metadata.has(name)) throw new Error(`Unknown vendor output: ${name}`);
  }
  return loaded;
}
