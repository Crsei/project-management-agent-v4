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

const hostOutputOwner = "vendor/t3code/mcp-skills-adaptations.json";
const hostOwnerManifest = "vendor/t3code/source-manifest.json";
const hostOwnerInventory = "vendor/t3code/sync-inventory.json";
const hostOwnerSourceInventory = "vendor/t3code/mcp-skills-source.json";
const hostOwnerLicense = "vendor/t3code/LICENSE";
const localHostPaths = new Set([
  "apps/server/agent/src/app.ts",
  "apps/server/agent/src/maintenance/agent-backup.test.ts",
  "apps/server/agent/src/maintenance/agent-backup.ts",
  "apps/server/agent/src/providers/skills.test.ts",
  "apps/server/pm/src/app.ts",
  "apps/web/src/features/agent/src/app.tsx",
  "apps/web/src/features/agent/src/settings/settings-layout.tsx",
  "packages/agent-contracts/package.json",
]);
const composerHostPath = "apps/web/src/features/agent/src/chat/provider-skills-composer.tsx";
const composerSourcePaths = [
  "apps/web/src/components/chat/ChatComposer.tsx",
  "apps/web/src/components/chat/useComposerMenuItems.ts",
  "apps/web/src/components/chat/useComposerCommandKey.ts",
  "apps/web/src/components/chat/SkillInlineText.tsx",
  "apps/web/src/components/chat/useProviderWorkspaceSnapshotRefresh.ts",
];
const transferredHostPaths = new Set([
  "apps/server/agent/src/providers/t3code/management.ts",
  "packages/agent-contracts/src/provider.ts",
  ...localHostPaths,
  composerHostPath,
]);

// These are consumer references, never a second byte/recipe authority. Keep the
// allowlist here as well as in the reviewed policy: arbitrary ownership exemptions
// must not be authorable through capture or candidate metadata.
export function externalHostOutputs(policy, inventory, closure) {
  const references = policy.externalHostOutputs ?? [];
  if (!Array.isArray(references)) throw new Error("Invalid external host output references.");
  const seen = new Set();
  for (const entry of references) {
    if (!entry || Object.keys(entry).sort().join(",") !== "owner,path" || !transferredHostPaths.has(entry.path) || entry.owner !== hostOutputOwner || seen.has(entry.path)) throw new Error(`Invalid external host output owner: ${entry?.path}`);
    seen.add(entry.path);
  }
  if (inventory && JSON.stringify(inventory.externalHostOutputs ?? []) !== JSON.stringify(references)) throw new Error("External host output enrollment changed.");
  for (const entry of [...(inventory?.files ?? []).map((entry) => ({ path: entry.destination })), ...(inventory?.hostBuildInputs ?? []), ...(policy.hostBuildInputs ?? []).map((path) => ({ path })), ...(policy.derivedOutputs ?? []).map((entry) => ({ path: entry.destination })), ...(closure?.inputs ?? []), ...[...(closure?.hostIntegrationOutputs ?? []), ...(closure?.snapshotOnly ?? [])].map((path) => ({ path }))]) {
    if (transferredHostPaths.has(entry.path)) throw new Error(`Externally owned host output cannot be replayed or fingerprinted by CC: ${entry.path}`);
  }
  for (const entry of inventory?.patches ?? []) {
    if ([...transferredHostPaths].some((name) => entry.path === `vendor/cc-switch/integration-patches/local/${name}.json`)) throw new Error(`Retired external host recipe is still enrolled: ${entry.path}`);
  }
  return references;
}

function verifyOwnerRecipe(entry, output) {
  const recipe = entry.recipe, input = entry.inputs[0];
  if (!input) {
    if (recipe?.kind !== "local-bytes" || Object.keys(recipe).sort().join(",") !== "base64,kind" || typeof recipe.base64 !== "string") throw new Error(`Invalid external owner local recipe: ${entry.destination}`);
    const bytes = Buffer.from(recipe.base64, "base64");
    if (bytes.toString("base64") !== recipe.base64 || !bytes.equals(output) || sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`External owner local recipe mismatch: ${entry.destination}`);
    return;
  }
  if (recipe?.kind !== "exact-line-splices" || Object.keys(recipe).sort().join(",") !== "kind,primaryInput,splices" || recipe.primaryInput !== 0 || !Array.isArray(recipe.splices)) throw new Error(`Invalid external owner recipe: ${entry.destination}`);
  const text = output.toString("utf8");
  if (!Buffer.from(text).equals(output)) throw new Error(`External owner recipe postimage mismatch: ${entry.destination}`);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const original = [];
  let cursor = 0, previousEnd = 0, delta = 0;
  for (const splice of recipe.splices) {
    if (!splice || Object.keys(splice).sort().join(",") !== "after,before,start" || !Number.isSafeInteger(splice.start) || splice.start < previousEnd || !Array.isArray(splice.before) || !Array.isArray(splice.after) || ![...splice.before, ...splice.after].every((line) => typeof line === "string")) throw new Error(`Invalid external owner splice: ${entry.destination}`);
    const start = splice.start + delta, end = start + splice.after.length;
    if (start < cursor || end > lines.length || lines.slice(start, end).join("") !== splice.after.join("")) throw new Error(`External owner recipe postimage mismatch: ${entry.destination}`);
    original.push(...lines.slice(cursor, start), ...splice.before);
    cursor = end;
    previousEnd = splice.start + splice.before.length;
    delta += splice.after.length - splice.before.length;
  }
  original.push(...lines.slice(cursor));
  const bytes = Buffer.from(original.join(""));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (sha256(bytes) !== input.sha256 || bytes.length !== input.bytes || blob !== input.gitBlobSha1) throw new Error(`External owner recipe preimage mismatch: ${entry.destination}`);
  // Inversion authenticates the original; forward replay also rejects malformed
  // line boundaries that could otherwise describe a different splice operation.
  const sourceLines = bytes.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [], replayed = [];
  cursor = 0;
  for (const splice of recipe.splices) {
    const end = splice.start + splice.before.length;
    if (end > sourceLines.length || sourceLines.slice(splice.start, end).join("") !== splice.before.join("")) throw new Error(`External owner recipe preimage mismatch: ${entry.destination}`);
    replayed.push(...sourceLines.slice(cursor, splice.start), ...splice.after);
    cursor = end;
  }
  replayed.push(...sourceLines.slice(cursor));
  if (!Buffer.from(replayed.join("")).equals(output)) throw new Error(`External owner recipe postimage mismatch: ${entry.destination}`);
}

function ownerSourceRecord(files, name, supplemental = false) {
  const entries = files.filter((entry) => entry && (supplemental ? entry.path : entry.source_path) === name);
  const source = entries[0];
  if (entries.length !== 1) return null;
  const result = { sha256: source.sha256, bytes: source.bytes, gitBlobSha1: supplemental ? source.blob : source.git_blob_sha1, gitMode: supplemental ? source.mode : source.git_mode };
  if (!/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || !/^[a-f0-9]{40}$/.test(result.gitBlobSha1) || !["100644", "100755"].includes(result.gitMode) || supplemental && source.type !== "blob") return null;
  return result;
}

export async function verifyExternalHostOutputs(root, policy, { allowAbsent = false } = {}) {
  const references = externalHostOutputs(policy);
  const inputs = [], metadata = [];
  if (!references.length) return { references, inputs, metadata };
  const evidencePaths = [hostOutputOwner, hostOwnerManifest, hostOwnerInventory, hostOwnerSourceInventory, hostOwnerLicense];
  if (allowAbsent) {
    const present = await Promise.all([...references.map((entry) => entry.path), ...evidencePaths].map(async (name) => {
      try { await file(root, name); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }));
    // A standalone selected-source CC replay does not install T3 or host outputs.
    // A partial host, however, must supply its real owner's complete evidence.
    if (!present.some(Boolean)) return { references, inputs, metadata };
  }
  for (const name of evidencePaths) {
    const current = await file(root, name);
    if (current.mode !== 0o644) throw new Error(`Invalid external owner evidence mode: ${name}`);
    metadata.push({ path: name, sha256: sha256(current.bytes), bytes: current.bytes.length, mode: current.mode, content: current.bytes });
  }
  const [owner, manifest, inventory, supplemental] = metadata.slice(0, 4).map((entry) => JSON.parse(entry.content));
  const productionCommit = owner.baselineCommit, supplementalCommit = supplemental.upstream?.commit;
  if (owner.version !== 1 || !/^[a-f0-9]{40}$/.test(productionCommit) || manifest.upstream?.commit !== productionCommit || inventory.version !== 1 || inventory.upstreamCommit !== productionCommit || inventory.sourceManifestSha256 !== metadata[1].sha256 || owner.baselineInventory !== hostOwnerInventory || owner.sourceInventory !== hostOwnerSourceInventory || !Array.isArray(owner.outputs) || !Array.isArray(owner.sources) || !Array.isArray(manifest.files) || !Array.isArray(inventory.files) || supplemental.version !== 1 || !/^[a-f0-9]{40}$/.test(supplementalCommit) || supplementalCommit === productionCommit || !Array.isArray(supplemental.files)) throw new Error("Invalid external host owner generation.");
  for (const record of metadata.filter((entry) => entry.path !== hostOwnerInventory)) {
    const registered = inventory.files.filter((entry) => entry.destination === record.path);
    if (registered.length !== 1 || registered[0].sha256 !== record.sha256 || registered[0].bytes !== record.bytes || registered[0].mode !== record.mode) throw new Error(`Unregistered external owner evidence: ${record.path}`);
  }
  const licensed = new Set();
  for (const source of owner.sources) {
    if (!source || !/^[a-f0-9]{40}$/.test(source.commit) || licensed.has(source.commit) || typeof source.role !== "string" || !source.role.trim() || source.license?.spdx !== "MIT" || source.license.path !== "LICENSE" || source.license.distributedPath !== hostOwnerLicense || source.license.sha256 !== metadata[4].sha256) throw new Error("Invalid external owner source license.");
    licensed.add(source.commit);
    // A modern owner may retain historical sources for retired records. Those
    // licenses carry their full original identity; active shared inputs below
    // still have to belong to the registered production or supplemental tree.
    const original = source.commit === productionCommit ? ownerSourceRecord(manifest.files, "LICENSE") : source.commit === supplementalCommit ? ownerSourceRecord(supplemental.files, "LICENSE", true) : source.license;
    const license = metadata[4], blob = createHash("sha1").update(`blob ${license.bytes}\0`).update(license.content).digest("hex");
    if (!original || original.sha256 !== license.sha256 || original.bytes !== license.bytes || original.gitBlobSha1 !== blob || original.gitMode !== "100644") throw new Error("Unregistered external owner source license.");
    for (const key of ["bytes", "gitBlobSha1", "gitMode"]) if (Object.hasOwn(source.license, key) && source.license[key] !== original[key]) throw new Error("Unregistered external owner source license.");
  }
  if (!licensed.has(productionCommit) || !licensed.has(supplementalCommit) || manifest.upstream.distribution_license?.spdx !== "MIT" || manifest.upstream.distribution_license.path !== "LICENSE" || supplemental.upstream.license?.spdx !== "MIT" || supplemental.upstream.license.path !== "LICENSE" || supplemental.upstream.license.sha256 !== metadata[4].sha256) throw new Error("Invalid external owner source license.");
  for (const reference of references) {
    const registered = owner.outputs.filter((entry) => entry.destination === reference.path);
    const entry = registered[0], local = localHostPaths.has(reference.path);
    if (registered.length !== 1 || Object.hasOwn(entry, "retirement") || entry.provenance !== (local ? "local-integration" : "adapted-upstream") || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || ![0o644, 0o755].includes(entry.mode) || typeof entry.reason !== "string" || !entry.reason.trim() || typeof entry.license !== "string" || !entry.license.trim() || !Array.isArray(entry.inputs) || (local ? entry.inputs.length !== 0 : entry.inputs.length === 0) || inventory.files.some((record) => record.destination === reference.path)) throw new Error(`Invalid external host owner output: ${reference.path}`);
    if (reference.path === composerHostPath && (entry.inputs.length !== composerSourcePaths.length || entry.inputs.some((input, index) => !input || input.commit !== supplementalCommit || input.path !== composerSourcePaths[index]))) throw new Error(`Unregistered external owner source: ${reference.path}`);
    const seen = new Set();
    for (const input of entry.inputs) {
      if (!input) throw new Error(`Unregistered external owner source: ${reference.path}`);
      relative(input.path);
      const source = input.commit === productionCommit ? ownerSourceRecord(manifest.files, input.path) : input.commit === supplementalCommit ? ownerSourceRecord(supplemental.files, input.path, true) : null;
      const key = `${input.commit}:${input.path}`;
      if (!source || seen.has(key) || source.sha256 !== input.sha256 || source.bytes !== input.bytes || source.gitBlobSha1 !== input.gitBlobSha1 || source.gitMode !== input.gitMode) throw new Error(`Unregistered external owner source: ${reference.path}`);
      seen.add(key);
    }
    const current = await file(root, reference.path);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes || current.mode !== entry.mode) throw new Error(`External host output differs from owner generation: ${reference.path}`);
    verifyOwnerRecipe(entry, current.bytes);
    inputs.push({ path: reference.path, sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode });
  }
  return { references, inputs, metadata: metadata.map(({ content: _content, ...entry }) => entry) };
}

export async function reviewedHostTransfers(root, policy, previous, approved = new Map()) {
  const references = externalHostOutputs(policy), retired = new Set();
  for (const name of approved.keys()) if (!references.some((entry) => entry.path === name)) throw new Error(`Unenrolled host ownership transfer: ${name}`);
  const owner = await verifyExternalHostOutputs(root, policy);
  for (const reference of references) {
    const entries = (previous?.files ?? []).filter((entry) => entry.destination === reference.path);
    if (!entries.length) {
      if (approved.has(reference.path)) throw new Error(`Host output has no replay ownership to transfer: ${reference.path}`);
      continue;
    }
    const entry = entries[0], recipePath = `vendor/cc-switch/integration-patches/local/${reference.path}.json`;
    const patches = (previous.patches ?? []).filter((patch) => patch.path === recipePath);
    if (entries.length !== 1 || entry.provenance !== "host-owned-integration" || Object.hasOwn(entry, "source") || Object.hasOwn(entry, "patch") || Object.hasOwn(entry, "retirement") || entry.asset?.path !== recipePath || !/^[a-f0-9]{64}$/.test(entry.asset.sha256) || approved.get(reference.path) !== entry.asset.sha256 || patches.length !== 1 || patches[0].sha256 !== entry.asset.sha256 || (previous.externalHostOutputs ?? []).some((record) => record.path === reference.path)) throw new Error(`Host ownership transfer requires --transfer-host-output ${reference.path}=${entry.asset?.sha256}`);
    const recipe = await file(root, recipePath);
    const asset = JSON.parse(recipe.bytes), current = await file(root, reference.path);
    if (recipe.mode !== 0o644 || sha256(recipe.bytes) !== entry.asset.sha256 || asset.version !== 1 || asset.destination !== reference.path || asset.encoding !== "base64" || typeof asset.content !== "string" || asset.sha256 !== entry.sha256 || asset.mode !== entry.mode || sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes || current.mode !== entry.mode || Buffer.from(asset.content, "base64").toString("base64") !== asset.content || !Buffer.from(asset.content, "base64").equals(current.bytes)) throw new Error(`Host ownership transfer preimage differs: ${reference.path}`);
    retired.add(reference.path);
  }
  return { ...owner, retired };
}
export async function loadInventory(root = repository, { allowAbsentExternalHost = false } = {}) {
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
  const closureBytes = (await file(root, "vendor/cc-switch/resource-closure.json")).bytes;
  externalHostOutputs(inputs.policy, inventory, JSON.parse(closureBytes));
  if (sha256(closureBytes) !== inventory.closureSha256) throw new Error("Resource closure ledger changed.");
  if (sha256((await file(root, "vendor/cc-switch/upstream-tree.json")).bytes) !== inventory.upstreamTreeSha256) throw new Error("Pinned upstream path tree changed.");
  const hostInputs = inventory.hostBuildInputs ?? [];
  if (JSON.stringify(hostInputs.map((entry) => entry.path)) !== JSON.stringify(inputs.policy.hostBuildInputs ?? [])) throw new Error("Host build input enrollment changed.");
  for (const entry of hostInputs) {
    const current = await file(root, entry.path);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes) throw new Error(`Host build input changed: ${entry.path}`);
  }
  const externalHost = await verifyExternalHostOutputs(root, inputs.policy, { allowAbsent: allowAbsentExternalHost });
  return { ...inputs, inventory, inventoryBytes, externalHost };
}
export async function verifyOutputs(root = repository, { allowAbsentExternalHost = false } = {}) {
  const loaded = await loadInventory(root, { allowAbsentExternalHost });
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
