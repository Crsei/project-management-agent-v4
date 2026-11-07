import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { applyPatch, archivePath, blobPath, closure, encode, file, fixedFiles, inputs, loadInventory, offlineOriginals, originalsFrom, outputPath, patchBytes, prefix, publish, relative, repository, safePath, sha256, walk } from "./provenance.mjs";

const options = new Map(), accepted = new Map(), additions = new Set();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (["--review", "--record-local"].includes(key)) {
    if (options.has(key)) throw new Error(`Duplicate option: ${key}`);
    options.set(key, true);
  }
  else if (["--source", "--extensions-tarball", "--reason", "--accept-change", "--allow-local"].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    const value = process.argv[++index];
    if (key === "--allow-local") additions.add(outputPath(value));
    else if (key === "--accept-change") {
      const separator = value.lastIndexOf("=");
      if (separator < 0 || !/^[a-f0-9]{64}$/.test(value.slice(separator + 1))) throw new Error("--accept-change requires PATH=SHA256.");
      const name = relative(value.slice(0, separator));
      if (accepted.has(name)) throw new Error(`Duplicate approval: ${name}`);
      accepted.set(name, value.slice(separator + 1));
    } else if (options.has(key)) throw new Error(`Duplicate option: ${key}`);
    else options.set(key, value);
  } else throw new Error(`Unknown/incomplete authoring option: ${key}`);
}
if (options.get("--record-local")) {
  if (!options.get("--review") || !options.get("--reason")?.trim() || !accepted.size || additions.size || options.has("--source") || options.has("--extensions-tarball")) throw new Error("Narrow authoring requires --record-local --review --reason RATIONALE and exact --accept-change PATH=SHA256 approvals only.");
  const loaded = await loadInventory(), inventory = loaded.inventory;
  const originals = await offlineOriginals(loaded);
  const payloads = new Map(), snapshots = new Map();
  for (const [name, digest] of accepted) {
    outputPath(name);
    const matches = inventory.files.filter((entry) => entry.destination === name);
    const recipePath = `${prefix}integration-patches/local/${name.slice(prefix.length)}.json`;
    const bindings = inventory.patches.filter((entry) => entry.path === recipePath);
    if (matches.length !== 1 || matches[0].source || matches[0].asset?.path !== recipePath || bindings.length !== 1 || matches[0].asset.sha256 !== bindings[0].sha256 || ["source-manifest.json", "supplemental-inputs.json", "fork-policy.json"].some((entry) => name === prefix + entry)) throw new Error(`Not an existing mutable local output: ${name}`);
    const entry = matches[0], current = await file(repository, name);
    if (sha256(current.bytes) !== digest || current.mode !== entry.mode) throw new Error(`Wrong exact local hash/mode approval: ${name}`);
    const bytes = encode({ version: 1, destination: name, sha256: digest, mode: current.mode, encoding: "base64", content: current.bytes.toString("base64") });
    const recipeHash = sha256(bytes);
    if (digest === entry.sha256 && current.bytes.length === entry.bytes && recipeHash === entry.asset.sha256) throw new Error(`Stale/unnecessary local approval: ${name}`);
    entry.sha256 = digest; entry.bytes = current.bytes.length; entry.reason = options.get("--reason");
    entry.asset.sha256 = recipeHash;
    bindings[0].sha256 = recipeHash; bindings[0].bytes = bytes.length;
    payloads.set(recipePath, bytes);
  }
  // Authenticate untouched outputs without regenerating or approving their recipes.
  for (const entry of inventory.files) {
    const current = await file(repository, entry.destination);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes || current.mode !== entry.mode) throw new Error(`Unapproved output drift during narrow authoring: ${entry.destination}`);
    snapshots.set(entry.destination, current);
    if (entry.source) {
      const original = loaded.entries.find((input) => input.destination === entry.source);
      const bytes = originals.get(entry.source);
      if (!original || entry.origin !== original.origin || entry.sourcePath !== original.source || entry.upstreamSha256 !== original.sha256 || entry.mode !== original.mode) throw new Error(`Misclassified source original: ${entry.destination}`);
      const replayed = entry.patch ? applyPatch(bytes, (await file(repository, entry.patch.path)).bytes, entry) : bytes;
      if (!current.bytes.equals(replayed)) throw new Error(`Unapproved original recipe drift: ${entry.destination}`);
    }
    if (!accepted.has(entry.destination) && entry.asset) {
      const bytes = encode({ version: 1, destination: entry.destination, sha256: entry.sha256, mode: entry.mode, encoding: "base64", content: current.bytes.toString("base64") });
      if (sha256(bytes) !== entry.asset.sha256) throw new Error(`Unapproved local recipe drift: ${entry.destination}`);
    }
  }
  const known = new Set([`${prefix}output-inventory.json`, `${prefix}resource-closure.json`, ...inventory.files.map((entry) => entry.destination), ...inventory.patches.map((entry) => entry.path), ...inventory.inputArtifacts.map((entry) => entry.path)]);
  for (const name of await walk(repository, prefix.slice(0, -1), loaded.policy.generatedTrees)) if (!known.has(name)) throw new Error(`Unknown OpenHands file is preserved; no writes performed: ${name}`);
  if (sha256(await closure(repository, loaded.policy, inventory.files)) !== inventory.closureSha256) throw new Error("Narrow local authoring cannot change production closure.");
  const current = await loadInventory();
  if (!current.inventoryBytes.equals(loaded.inventoryBytes)) throw new Error("Inventory changed during narrow authoring.");
  for (const [name, snapshot] of snapshots) {
    const current = await file(repository, name);
    if (!current.bytes.equals(snapshot.bytes) || current.mode !== snapshot.mode) throw new Error(`Concurrent narrow authoring edit: ${name}`);
  }
  for (const [name, bytes] of payloads) await publish(repository, name, bytes);
  await publish(repository, `${prefix}output-inventory.json`, encode(inventory));
  console.log(JSON.stringify({ operation: "reviewed-local-recipes-only", outputs: [...accepted.keys()].sort() }));
  process.exit(0);
}
if (!options.get("--source") || !options.get("--extensions-tarball") || !options.get("--review") || !options.get("--reason")?.trim()) throw new Error("Authoring only, after all writers settle: capture.mjs --source PINNED_CHECKOUT --extensions-tarball VERIFIED_TGZ --review --reason RATIONALE [--allow-local EXACT_PATH] [--accept-change PATH=SHA256]. No force/wildcard approval.");
const loaded = await inputs(), { manifest, manifestBytes, supplementalBytes, policy, policyBytes, entries } = loaded;
const archiveSource = path.resolve(options.get("--extensions-tarball"));
const archiveInfo = await lstat(archiveSource);
if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.mode & 0o7000) throw new Error("Registry input must be a regular tarball, not a link/special file.");
const archive = await readFile(archiveSource), originals = await originalsFrom(options.get("--source"), archive, loaded);
const old = await readFile(path.join(repository, `${prefix}output-inventory.json`)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const previous = old ? JSON.parse(old) : null;
if (previous && (previous.version !== 1 || previous.upstreamCommit !== policy.upstreamCommit || previous.sourceManifestSha256 !== sha256(manifestBytes) || previous.supplementalSha256 !== sha256(supplementalBytes))) throw new Error("Previous immutable input generation changed; review a separate upstream update instead of recapturing originals.");
function approve(name, digest, mode, before, always = false) {
  if ((always || before && (before.sha256 !== digest || before.mode !== mode)) && accepted.get(name) !== digest) throw new Error(`Exact review required: --accept-change ${name}=${digest}`);
}
if (previous) {
  approve(`${prefix}fork-policy.json`, sha256(policyBytes), 0o644, { sha256: previous.policySha256, mode: 0o644 });
  if (sha256((await file(repository, `${prefix}resource-closure.json`)).bytes) !== previous.closureSha256) throw new Error("Existing generated closure was edited; never bless generated edits by recapturing.");
  for (const entry of [...previous.patches, ...previous.inputArtifacts]) {
    const current = await file(repository, entry.path);
    if (sha256(current.bytes) !== entry.sha256 || current.mode !== entry.mode || current.bytes.length !== entry.bytes) throw new Error(`Existing generated input/recipe was edited: ${entry.path}`);
  }
}
const hostBuildInputs = [];
for (const name of policy.hostBuildInputs) {
  const current = await file(repository, name), digest = sha256(current.bytes);
  approve(name, digest, current.mode, previous?.hostBuildInputs.find((entry) => entry.path === name));
  hostBuildInputs.push({ path: name, sha256: digest, bytes: current.bytes.length, mode: current.mode });
}
const originalNames = new Set(entries.map((entry) => entry.destination));
const fixed = new Set(fixedFiles.map((name) => prefix + name));
const enrolled = new Set(policy.reviewedLocalOutputs.map((name) => prefix + name));
for (const entry of previous?.files ?? []) if (!entry.source) additions.add(entry.destination);
for (const name of additions) if (!fixed.has(name) && !enrolled.has(name)) throw new Error(`New local output needs exact policy enrollment first: ${name}`);
for (const name of fixed) additions.add(name);
const files = [], patches = [], inputArtifacts = [], payloads = new Map();
const previousFiles = new Map((previous?.files ?? []).map((entry) => [entry.destination, entry]));
function payload(name, bytes, collection) {
  const entry = { path: name, sha256: sha256(bytes), bytes: bytes.length, mode: 0o644 };
  if (payloads.has(name)) { if (!payloads.get(name).equals(bytes)) throw new Error(`Colliding content address: ${name}`); return; }
  payloads.set(name, bytes); collection.push(entry);
}
for (const entry of entries) payload(blobPath(entry), originals.get(entry.destination), inputArtifacts);
payload(archivePath, archive, inputArtifacts);
async function capture(destination, source, snapshot = false) {
  const current = await file(repository, destination), digest = sha256(current.bytes), before = previousFiles.get(destination);
  const input = source ? entries.find((entry) => entry.destination === source) : null;
  const changedOriginal = input && !current.bytes.equals(originals.get(source));
  if (snapshot && changedOriginal) throw new Error(`Immutable generated locale input changed: ${destination}`);
  if (changedOriginal && !policy.reviewedAdaptations.includes(source)) throw new Error(`Adaptation needs an exact reviewed source path first: ${source}`);
  if (!source && !fixed.has(destination) && !enrolled.has(destination)) throw new Error(`Unreviewed local output: ${destination}`);
  if (input && current.mode !== input.mode) throw new Error(`Original mode changes are not permitted: ${destination}`);
  approve(destination, digest, current.mode, before, !before && (changedOriginal || !source && !fixed.has(destination)));
  const entry = { destination, sha256: digest, bytes: current.bytes.length, mode: current.mode, provenance: input ? snapshot ? "immutable-generated-input" : changedOriginal ? "adapted-original" : "pristine-original" : "local-fork-integration", reason: accepted.has(destination) ? options.get("--reason") : before?.reason ?? options.get("--reason") };
  if (input) {
    entry.source = source; entry.sourcePath = input.source; entry.origin = input.origin; entry.upstreamSha256 = input.sha256;
    if (input.blob) entry.blob = input.blob;
    if (changedOriginal) {
      const recipe = patchBytes(originals.get(source), current.bytes, source), recipePath = `${prefix}integration-patches/original/${source}.json`;
      payload(recipePath, recipe, patches); entry.patch = { path: recipePath, sha256: sha256(recipe) };
    }
  } else {
    const assetPath = `${prefix}integration-patches/local/${destination.slice(prefix.length)}.json`;
    const asset = encode({ version: 1, destination, sha256: digest, mode: current.mode, encoding: "base64", content: current.bytes.toString("base64") });
    payload(assetPath, asset, patches); entry.asset = { path: assetPath, sha256: sha256(asset) };
  }
  const previousRecipe = before?.patch ?? before?.asset, nextRecipe = entry.patch ?? entry.asset;
  if (before && (previousRecipe?.path !== nextRecipe?.path || previousRecipe?.sha256 !== nextRecipe?.sha256)) approve(destination, digest, current.mode, before, true);
  files.push(entry);
}
for (const entry of entries) await capture(prefix + entry.destination, entry.destination);
for (const entry of entries.filter((entry) => entry.snapshot)) await capture(prefix + entry.snapshot, entry.destination, true);
for (const name of [...additions].sort()) {
  if (originalNames.has(name.slice(prefix.length))) throw new Error(`Original cannot be enrolled as local: ${name}`);
  await capture(name, null);
}
const expected = new Set([...files.map((entry) => entry.destination), ...payloads.keys(), ...(previous?.patches ?? []).map((entry) => entry.path), `${prefix}output-inventory.json`, `${prefix}resource-closure.json`]);
for (const name of await walk(repository, prefix.slice(0, -1), policy.generatedTrees)) if (!expected.has(name)) throw new Error(`Unknown/obsolete OpenHands file is preserved; no capture writes performed: ${name}. Review exact enrollment/removal instead of blessing a tree.`);
const resourceClosure = await closure(repository, policy, files);
const inventoryBytes = encode({ version: 1, upstreamCommit: policy.upstreamCommit, sourceManifestSha256: sha256(manifestBytes), supplementalSha256: sha256(supplementalBytes), policySha256: sha256(policyBytes), closureSha256: sha256(resourceClosure), modePolicy: "Canonical 0644/0755 executable class, regular nonlinked files; original modes fixed. Exact pre/postimage and exclusive nonoverwriting replay.", hostBuildInputs, files: files.sort((a, b) => a.destination.localeCompare(b.destination, "en")), patches: patches.sort((a, b) => a.path.localeCompare(b.path, "en")), inputArtifacts: inputArtifacts.sort((a, b) => a.path.localeCompare(b.path, "en")), summary: { initialGit: 169, generatedLocales: 3, npmFiles: 88, supplementalGit: entries.length - manifest.files.length, adapted: files.filter((entry) => entry.patch).length, local: files.filter((entry) => !entry.source).length } });
// Refuse a mixed generation before any authoring writes. Input archives/blobs are
// immutable content-addressed artifacts; generated recipes are never edited by hand.
for (const entry of [...files.map((entry) => ({ ...entry, path: entry.destination })), ...hostBuildInputs]) {
  const current = await file(repository, entry.path);
  if (sha256(current.bytes) !== entry.sha256 || current.mode !== entry.mode) throw new Error(`Concurrent capture edit: ${entry.path}`);
}
for (const [name, bytes] of payloads) {
  const current = await readFile(path.join(repository, name)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (current && !current.equals(bytes) && inputArtifacts.some((entry) => entry.path === name)) throw new Error(`Immutable offline input changed: ${name}`);
}
for (const [name, bytes] of [...payloads].sort(([a], [b]) => a.localeCompare(b, "en"))) await publish(repository, name, bytes);
for (const entry of previous?.patches ?? []) if (!payloads.has(entry.path)) await unlink(await safePath(repository, entry.path));
await publish(repository, `${prefix}resource-closure.json`, resourceClosure);
await publish(repository, `${prefix}output-inventory.json`, inventoryBytes);
console.log(JSON.stringify({ operation: "reviewed-authoring-not-verification", outputs: files.length, originals: entries.length, recipes: patches.length, inputArtifacts: inputArtifacts.length }));
