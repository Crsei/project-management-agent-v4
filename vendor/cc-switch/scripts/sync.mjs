import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resourceClosure } from "./closure.mjs";
import { applyPatch, file, inside, originalsFrom, relative, repository, safePath, sha256, verifyExternalHostOutputs, verifyOutputs, walk } from "./provenance.mjs";

export async function replayOutputs({ root = repository, source, destination, check = false }) {
  const { manifest, policy, inventory, inventoryBytes } = await verifyOutputs(root, { allowAbsentExternalHost: true });
  const originals = await originalsFrom(source, manifest);
  const closure = await resourceClosure(root, policy, inventory.files);
  if (sha256(closure) !== inventory.closureSha256) throw new Error("Reachable Rust/TS/CSS resource closure changed; reviewed capture required.");
  destination = path.resolve(destination);
  source = path.resolve(source);
  if (inside(source, destination) || inside(destination, source)) throw new Error("Source and destination must not overlap.");
  // No external output or T3 evidence is scheduled. Existing host implementations
  // are checked against their own current generation, never an old CC snapshot.
  await verifyExternalHostOutputs(destination, policy, { allowAbsent: true });
  const pending = new Map();
  function schedule(name, bytes, mode) {
    relative(name);
    if (pending.has(name)) throw new Error(`Duplicate replay target: ${name}`);
    pending.set(name, { bytes, mode });
  }
  for (const entry of inventory.files) {
    let bytes;
    if (entry.source) {
      bytes = originals.get(entry.source);
      if (!bytes || sha256(bytes) !== entry.upstreamSha256) throw new Error(`Uninventoried original: ${entry.source}`);
      if (entry.patch) bytes = applyPatch(bytes, (await file(root, entry.patch.path)).bytes, entry);
    } else {
      const assetBytes = (await file(root, entry.asset.path)).bytes;
      if (sha256(assetBytes) !== entry.asset.sha256) throw new Error(`Unknown local asset recipe: ${entry.asset.path}`);
      const asset = JSON.parse(assetBytes);
      if (asset.version !== 1 || asset.destination !== entry.destination || asset.encoding !== "base64" || asset.sha256 !== entry.sha256 || asset.mode !== entry.mode) throw new Error(`Wrong local asset identity: ${entry.destination}`);
      bytes = Buffer.from(asset.content, "base64");
      if (bytes.toString("base64") !== asset.content) throw new Error(`Noncanonical local asset: ${entry.destination}`);
    }
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Reconstructed output mismatch: ${entry.destination}`);
    schedule(entry.destination, bytes, entry.mode);
  }
  for (const patch of inventory.patches) schedule(patch.path, (await file(root, patch.path)).bytes, 0o644);
  schedule("vendor/cc-switch/resource-closure.json", closure, 0o644);
  schedule("vendor/cc-switch/upstream-tree.json", (await file(root, "vendor/cc-switch/upstream-tree.json")).bytes, 0o644);
  schedule("vendor/cc-switch/output-inventory.json", inventoryBytes, 0o644);
  for (const tree of policy.ownedTrees ?? ["vendor/cc-switch"]) {
    const exists = await lstat(path.join(destination, tree)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (exists) for (const name of await walk(destination, tree, policy.generatedTrees)) if (!pending.has(name)) throw new Error(`Unknown destination file; no writes performed: ${name}`);
  }
  const creates = [];
  for (const [name, entry] of [...pending].sort(([a], [b]) => a < b ? -1 : 1)) {
    const target = await safePath(destination, name);
    const info = await lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) {
      if (check) throw new Error(`Missing destination file: ${name}`);
      creates.push({ target, ...entry });
    } else if (sha256(await readFile(target)) !== sha256(entry.bytes) || Boolean(info.mode & 0o111) !== Boolean(entry.mode & 0o111)) throw new Error(`Destination conflict; no writes performed: ${name}`);
  }
  // No overwrite/force/update mode. wx protects against a concurrently created file.
  for (const entry of creates) {
    await safePath(destination, path.relative(destination, entry.target).split(path.sep).join("/"));
    await mkdir(path.dirname(entry.target), { recursive: true });
    await writeFile(entry.target, entry.bytes, { flag: "wx", mode: entry.mode });
    await chmod(entry.target, entry.mode);
  }
  return { commit: manifest.commit, outputs: pending.size, created: creates.length, check };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index];
    if (key === "--check") options.set(key, true);
    else if (["--source", "--destination"].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) options.set(key, process.argv[++index]);
    else throw new Error(`Unknown/incomplete replay option: ${key}`);
  }
  if (!options.get("--source") || !options.get("--destination")) throw new Error("Usage: node vendor/cc-switch/scripts/sync.mjs --source PINNED_CHECKOUT --destination HOST_ROOT [--check]. Existing differing files are never overwritten.");
  console.log(JSON.stringify(await replayOutputs({ source: options.get("--source"), destination: options.get("--destination"), check: options.has("--check") })));
}
