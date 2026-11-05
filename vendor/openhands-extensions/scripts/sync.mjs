import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyPatch, file, inside, offlineOriginals, prefix, relative, repository, safePath, sha256, verifyOutputs, walk } from "./provenance.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (["--check", "--pristine"].includes(key)) options.set(key, true);
  else if (key === "--destination" && process.argv[index + 1] && !process.argv[index + 1].startsWith("--") && !options.has(key)) options.set(key, process.argv[++index]);
  else throw new Error(`Unknown/incomplete replay option: ${key}`);
}
if (!options.get("--destination")) throw new Error("Usage: sync.mjs --destination HOST_ROOT [--check] [--pristine]. Fully offline; originals come only from pinned archived inputs. Differing/unknown destination files are never overwritten.");
const loaded = await verifyOutputs(), originals = await offlineOriginals(loaded);
const resourceClosure = loaded.closureBytes;
const destination = path.resolve(options.get("--destination"));
if (destination !== repository && inside(repository, destination)) throw new Error("Replay destination cannot be nested inside its authoring checkout.");
const pending = new Map();
function schedule(name, bytes, mode) {
  relative(name);
  if (pending.has(name)) throw new Error(`Duplicate replay target: ${name}`);
  pending.set(name, { bytes, mode });
}
for (const entry of loaded.inventory.files) {
  if (options.has("--pristine") && !entry.source && ![`${prefix}source-manifest.json`, `${prefix}supplemental-inputs.json`].includes(entry.destination)) continue;
  let bytes;
  if (entry.source) {
    const original = loaded.entries.find((input) => input.destination === entry.source);
    bytes = originals.get(entry.source);
    if (!original || entry.origin !== original.origin || entry.sourcePath !== original.source || entry.upstreamSha256 !== original.sha256 || entry.mode !== original.mode || sha256(bytes) !== entry.upstreamSha256) throw new Error(`Misclassified source original: ${entry.destination}`);
    if (entry.patch && !options.has("--pristine")) bytes = applyPatch(bytes, (await file(repository, entry.patch.path)).bytes, entry);
  } else {
    const assetBytes = (await file(repository, entry.asset.path)).bytes;
    if (sha256(assetBytes) !== entry.asset.sha256) throw new Error(`Changed local recipe: ${entry.destination}`);
    const asset = JSON.parse(assetBytes);
    if (asset.version !== 1 || asset.destination !== entry.destination || asset.sha256 !== entry.sha256 || asset.mode !== entry.mode || asset.encoding !== "base64") throw new Error(`Wrong local recipe identity: ${entry.destination}`);
    bytes = Buffer.from(asset.content, "base64");
    if (bytes.toString("base64") !== asset.content) throw new Error(`Noncanonical local recipe: ${entry.destination}`);
  }
  if ((!options.has("--pristine") || !entry.source) && (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes)) throw new Error(`Reconstruction mismatch: ${entry.destination}`);
  schedule(entry.destination, bytes, entry.mode);
}
for (const entry of [...(options.has("--pristine") ? [] : loaded.inventory.patches), ...loaded.inventory.inputArtifacts]) schedule(entry.path, (await file(repository, entry.path)).bytes, entry.mode);
if (!options.has("--pristine")) {
  schedule(`${prefix}resource-closure.json`, resourceClosure, 0o644);
  schedule(`${prefix}output-inventory.json`, loaded.inventoryBytes, 0o644);
}
const tree = prefix.slice(0, -1), existing = await lstat(path.join(destination, tree)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
if (existing) for (const name of await walk(destination, tree, loaded.policy.generatedTrees)) if (!pending.has(name)) throw new Error(`Unknown destination file is preserved; no writes performed: ${name}`);
const creates = [];
for (const [name, entry] of [...pending].sort(([a], [b]) => a.localeCompare(b, "en"))) {
  const target = await safePath(destination, name), info = await lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) {
    if (options.has("--check")) throw new Error(`Missing replay target: ${name}`);
    creates.push({ target, ...entry });
  } else if (sha256(await readFile(target)) !== sha256(entry.bytes) || Boolean(info.mode & 0o111) !== Boolean(entry.mode & 0o111)) throw new Error(`Destination conflict is preserved; no writes performed: ${name}`);
}
// Preflight the complete destination before exclusive creates. Never overwrite,
// force, fuzzy-apply, erase unknown files or read a sibling checkout at runtime.
for (const entry of creates) {
  await safePath(destination, path.relative(destination, entry.target).split(path.sep).join("/"));
  await mkdir(path.dirname(entry.target), { recursive: true });
  await writeFile(entry.target, entry.bytes, { flag: "wx", mode: entry.mode });
  await chmod(entry.target, entry.mode);
}
console.log(JSON.stringify({ operation: "offline-exact-replay", commit: loaded.policy.upstreamCommit, outputs: pending.size, created: creates.length, pristine: options.has("--pristine"), check: options.has("--check") }));
