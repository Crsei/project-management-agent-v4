import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resourceClosure } from "../../vendor/cc-switch/scripts/closure.mjs";
import { applyPatch, encode, externalHostOutputs, file, patchBytes, policyInputs, publish, relative, safePath, sha256, verifyExternalHostOutputs, walk } from "../../vendor/cc-switch/scripts/provenance.mjs";

const prefix = "vendor/cc-switch/";
const manifestPath = prefix + "source-manifest.json";
const inventoryPath = prefix + "output-inventory.json";
const forkPolicyPath = prefix + "fork-policy.json";
const closurePath = prefix + "resource-closure.json";
const treePath = prefix + "upstream-tree.json";
const maintenancePolicyPath = "scripts/upstream-sync/cc-switch-policy.json";
const sharedHelpers = [prefix + "scripts/provenance.mjs", prefix + "scripts/closure.mjs"];
const protectedTools = [...sharedHelpers, prefix + "scripts/capture.mjs", prefix + "scripts/sync.mjs", prefix + "scripts/provenance.test.mjs"];
const otherMetadata = ["vendor/openhands-extensions/output-inventory.json", "vendor/openhands-extensions/resource-closure.json", "vendor/openhands-extensions/fork-policy.json"];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unique = (values) => [...new Set(values)].sort(compare);
const blobHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const blocker = (code, message, details = {}) => ({ code, message, ...details });
const canonicalMode = (mode) => mode === "100755" ? 0o755 : 0o644;
const trustedRequire = createRequire(import.meta.url);
const trustedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function optionalFile(root, name) {
  try { return await file(root, relative(name)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function json(root, name) { return JSON.parse((await file(root, name)).bytes); }
function checkedInput(entry, commit) {
  relative(entry.path);
  if (!/^[a-f\d]{40}$/.test(commit) || !["100644", "100755"].includes(entry.mode) || !/^[a-f\d]{40}$/.test(entry.blob) || !/^[a-f\d]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`Invalid CC source identity: ${entry.path}`);
  return { path: entry.path, commit, sha256: entry.sha256, bytes: entry.bytes, gitMode: entry.mode, blob: entry.blob };
}
function selections(manifest) {
  const exact = new Set(manifest.files.map((entry) => entry.path));
  return { trees: manifest.selection.filter((name) => !exact.has(relative(name))), files: manifest.selection.filter((name) => exact.has(name)) };
}
function validateTree(entries) {
  const result = new Map();
  for (const entry of entries) {
    relative(entry.path);
    if (result.has(entry.path)) throw new Error(`Duplicate upstream tree path: ${entry.path}`);
    result.set(entry.path, { ...entry, mode: String(entry.mode) });
  }
  return result;
}
function selectedPaths(manifest, tree, approved = []) {
  const selection = selections(manifest);
  const paths = [...tree.keys()].filter((name) => selection.files.includes(name) || selection.trees.some((directory) => name.startsWith(directory + "/")));
  for (const name of approved) {
    relative(name);
    if (!tree.has(name)) throw new Error(`Approved source does not exist at target: ${name}`);
    paths.push(name);
  }
  return unique(paths);
}
function validateRecipePath(name) {
  relative(name);
  if (!name.startsWith(prefix + "integration-patches/") || !name.endsWith(".json")) throw new Error(`Outside CC exact recipe directory: ${name}`);
}

async function loadData(root) {
  const data = await policyInputs(root);
  const inventoryBytes = (await file(root, inventoryPath)).bytes;
  const inventory = JSON.parse(inventoryBytes);
  if (inventory.version !== 1 || inventory.upstreamCommit !== data.manifest.commit || inventory.sourceManifestSha256 !== sha256(data.manifestBytes) || inventory.policySha256 !== sha256(data.policyBytes)) throw new Error("CC generation identity is inconsistent.");
  const closureBytes = (await file(root, closurePath)).bytes;
  const treeBytes = (await file(root, treePath)).bytes;
  if (sha256(closureBytes) !== inventory.closureSha256 || sha256(treeBytes) !== inventory.upstreamTreeSha256) throw new Error("CC closure/upstream tree identity is inconsistent.");
  const closure = JSON.parse(closureBytes), tree = JSON.parse(treeBytes);
  if (closure.version !== 1 || tree.version !== 1 || closure.upstreamCommit !== data.manifest.commit || tree.upstreamCommit !== data.manifest.commit) throw new Error("Wrong CC closure/upstream tree pin.");
  externalHostOutputs(data.policy, inventory, closure);
  const externalHost = await verifyExternalHostOutputs(root, data.policy);
  const inputs = new Map(data.manifest.files.map((entry) => [entry.path, checkedInput(entry, data.manifest.commit)]));
  const outputs = new Set(), recipes = new Map();
  for (const recipe of inventory.patches) {
    validateRecipePath(recipe.path);
    if (recipes.has(recipe.path)) throw new Error(`Duplicate CC recipe: ${recipe.path}`);
    const bytes = (await file(root, recipe.path)).bytes;
    if (sha256(bytes) !== recipe.sha256) throw new Error(`Unknown CC recipe change: ${recipe.path}`);
    recipes.set(recipe.path, bytes);
  }
  for (const entry of inventory.files) {
    relative(entry.destination);
    if (outputs.has(entry.destination) || ![0o644, 0o755].includes(entry.mode) || !/^[a-f\d]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`Invalid CC output: ${entry.destination}`);
    outputs.add(entry.destination);
    if (entry.source && (!inputs.has(entry.source) || inputs.get(entry.source).sha256 !== entry.upstreamSha256)) throw new Error(`Wrong CC output source: ${entry.destination}`);
    const recipe = entry.patch ?? entry.asset;
    if (recipe && (!recipes.has(recipe.path) || sha256(recipes.get(recipe.path)) !== recipe.sha256)) throw new Error(`Unenrolled CC recipe: ${entry.destination}`);
    if (!entry.source && !entry.asset) throw new Error(`Missing CC local asset: ${entry.destination}`);
  }
  for (const input of inputs.values()) if (!inventory.files.some((entry) => entry.destination === prefix + input.path && entry.source === input.path)) throw new Error(`Unmapped selected CC source: ${input.path}`);
  if (JSON.stringify(inventory.hostBuildInputs.map((entry) => entry.path)) !== JSON.stringify(data.policy.hostBuildInputs ?? [])) throw new Error("CC host input enrollment changed.");
  for (const name of tree.paths) relative(name);
  return { ...data, inventory, inventoryBytes, closure, closureBytes, tree, treeBytes, inputs, recipes, externalHost };
}

async function otherFork(root, policy = {}) {
  const inventory = await optionalFile(root, otherMetadata[0]);
  if (!inventory) {
    if ((policy.independentForkRoots ?? []).includes("vendor/openhands-extensions")) throw new Error("Missing required read-only OpenHands inventory; cross-fork impact cannot be determined.");
    return { paths: [], inputs: [] };
  }
  const closureBytes = (await file(root, otherMetadata[1])).bytes;
  const policyBytes = (await file(root, otherMetadata[2])).bytes;
  const parsed = JSON.parse(inventory.bytes), closure = JSON.parse(closureBytes);
  if (parsed.version !== 1 || closure.version !== 1 || sha256(closureBytes) !== parsed.closureSha256 || sha256(policyBytes) !== parsed.policySha256) throw new Error("OpenHands read-only inventory identity is inconsistent.");
  return { paths: otherMetadata, inputs: [...(parsed.hostBuildInputs ?? []), ...(closure.inputs ?? [])] };
}
async function crossForkBlockers(root, pending = new Map(), policy = {}) {
  const other = await otherFork(root, policy), failures = [];
  for (const input of other.inputs) {
    relative(input.path);
    const current = pending.has(input.path) ? pending.get(input.path) : await optionalFile(root, input.path);
    if (!current || sha256(current.bytes) !== input.sha256 || input.bytes !== undefined && current.bytes.length !== input.bytes || input.mode !== undefined && current.mode !== input.mode) failures.push(blocker("BLOCKED_CROSS_FORK", `OpenHands fingerprints changed CC/shared input: ${input.path}`, { path: input.path, consumer: "openhands-extensions", expectedSha256: input.sha256, actualSha256: current ? sha256(current.bytes) : null }));
  }
  return failures.filter((entry, index) => failures.findIndex((other) => other.path === entry.path) === index);
}

export async function loadProfile(root) {
  const data = await loadData(root);
  const policy = await json(trustedRoot, maintenancePolicyPath);
  const other = await otherFork(root, data.policy);
  const ownerPaths = data.externalHost.metadata.map((entry) => entry.path);
  const metadataPaths = unique([manifestPath, inventoryPath, forkPolicyPath, closurePath, treePath, ...protectedTools, ...data.inventory.patches.map((entry) => entry.path), ...other.paths, ...ownerPaths]);
  const host = new Map([...data.inventory.hostBuildInputs, ...data.externalHost.inputs].map((entry) => [entry.path, entry]));
  for (const input of data.closure.inputs) if (!data.inventory.files.some((entry) => entry.destination === input.path)) host.set(input.path, { path: input.path, sha256: input.sha256, bytes: input.bytes });
  const derived = new Set((data.policy.derivedOutputs ?? []).map((entry) => entry.destination));
  return {
    id: "cc-switch", upstreamUrl: data.manifest.upstream, upstreamCommit: data.manifest.commit,
    manifestPath, inventoryPath, metadataPaths, inputs: [...data.inputs.values()],
    outputs: data.inventory.files.map((entry) => ({ path: entry.destination, sourcePath: entry.source ?? null, sourceCommit: entry.source ? data.manifest.commit : null, sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode, kind: !entry.source ? "local" : derived.has(entry.destination) ? "derived" : entry.patch ? "patched" : "pristine", ...(derived.has(entry.destination) ? { inputs: [data.inputs.get(entry.source)] } : {}) })),
    hostInputs: [...host.values()], selection: selections(data.manifest),
    crossForkInputs: other.inputs.map((entry) => ({ ...entry, consumer: "openhands-extensions" })),
    protectedPaths: ["vendor/openhands-extensions", ...protectedTools, ...ownerPaths, ...data.externalHost.inputs.map((entry) => entry.path)],
    authoringPaths: unique([manifestPath, inventoryPath, forkPolicyPath, closurePath, treePath, ...data.inventory.patches.map((entry) => entry.path)]),
    authoringTrees: [prefix + "integration-patches"],
    verification: [
      { id: "cc-host-tests", command: "node", args: ["--conditions=development", "--test", "apps/server/agent/src/extensions/secrets.test.ts", "apps/server/agent/src/extensions/routes.test.ts", "apps/server/agent/src/extensions/external-targets.test.ts", "apps/server/agent/src/extensions/provider-bindings.test.ts", "apps/server/agent/src/extensions/storage.test.ts", "apps/server/agent/src/extensions/service.integration.test.ts"] },
      { id: "cc-provider-skills-contracts", command: "node", args: ["--conditions=development", "--test", "apps/server/agent/src/providers/t3code/management.test.ts"] },
      { id: "cc-headless-tests", command: "cargo", args: ["test", "--locked", "--offline", "--manifest-path", "apps/server/cc-switch-host/Cargo.toml"] },
      { id: "cc-native-build", command: "cargo", args: ["build", "--locked", "--offline", "--release", "--manifest-path", "apps/server/cc-switch-host/Cargo.toml"] },
      { id: "cc-web-typecheck", command: "pnpm", args: ["--filter", "@pm/web", "typecheck"] },
      { id: "cc-web-build", command: "pnpm", args: ["--filter", "@pm/web", "build"] },
      { id: "cc-agent-typecheck", command: "pnpm", args: ["typecheck:agent"] },
    ], policy, blockers: await crossForkBlockers(root, new Map(), data.policy),
  };
}

async function originalBytes(commit, entries, readBlob, tree) {
  const originals = new Map();
  for (const entry of entries) {
    const bytes = Buffer.from(await readBlob(commit, entry.path));
    const object = tree?.get(entry.path);
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes || blobHash(bytes) !== entry.blob || object && (object.mode !== entry.mode || object.blob !== entry.blob || object.type !== "blob")) throw new Error(`CC original hash/blob/mode mismatch: ${commit}:${entry.path}`);
    originals.set(entry.path, bytes);
  }
  return originals;
}
function replay(entry, originals, recipes) {
  let bytes;
  if (entry.source) {
    bytes = originals.get(entry.source);
    if (!bytes || sha256(bytes) !== entry.upstreamSha256) throw new Error(`Wrong CC replay preimage: ${entry.destination}`);
    if (entry.patch) bytes = applyPatch(bytes, recipes.get(entry.patch.path), entry);
  } else {
    const asset = JSON.parse(recipes.get(entry.asset.path));
    bytes = Buffer.from(asset.content, "base64");
    if (asset.version !== 1 || asset.destination !== entry.destination || asset.encoding !== "base64" || asset.mode !== entry.mode || asset.sha256 !== entry.sha256 || bytes.toString("base64") !== asset.content) throw new Error(`Wrong CC exact local asset: ${entry.destination}`);
  }
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`CC replay postimage mismatch: ${entry.destination}`);
  return bytes;
}

// Run only the trusted old closure implementation and its trusted parser. The
// candidate is projected as plain bytes; its node_modules and scripts never run.
async function closureFor(root, data, policy, outputs, upstreamPaths, pending) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cc-upstream-closure-"));
  try {
    const names = unique([...outputs.map((entry) => entry.destination), ...data.closure.inputs.map((entry) => entry.path), ...(policy.hostBuildInputs ?? [])]);
    for (const name of names) {
      const input = pending.has(name) ? pending.get(name) : await optionalFile(root, name);
      if (input) await publish(scratch, name, input.bytes, input.mode);
    }
    const parser = path.dirname(await realpath(trustedRequire.resolve("typescript/package.json")));
    await mkdir(path.join(scratch, "node_modules"), { recursive: true });
    await symlink(parser, path.join(scratch, "node_modules/typescript"), "dir");
    return await resourceClosure(scratch, policy, outputs, upstreamPaths);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

const invariantGroups = [
  ["src-tauri/src/config.rs", ["host_context::home_dir", "host_context::"]],
  ["src-tauri/src/database/dao/mcp.rs", ["secret_codec::open", "secret_codec::seal"]],
  ["src-tauri/src/services/mcp.rs", ["mcp_management::validate_mutation", "host_context::require_app", "validate_target_paths", "effective_mcp_spec", "save_mcp_assignment"]],
  ["src-tauri/src/mcp/mod.rs", ["mod overrides", "mod snapshot"]],
  ["apps/server/cc-switch-host/src/host_context.rs", ["validate_root", "validate_claude_mcp_file", "require_app", "require_native_read_path", "validate_read_path", "uploaded_zip"]],
  ["apps/server/cc-switch-host/src/secret_codec.rs", ["Aes256Gcm", "override_aad", "Payload", "aad: binding", "encrypt", "decrypt"]],
  ["apps/server/cc-switch-host/src/database/mcp_assignments.rs", ["save_mcp_assignment", "effective_mcp_spec", "commit_mcp_import", "mcp_agent_overrides"]],
  ["apps/server/cc-switch-host/src/mcp_management.rs", ["validate_mutation", "native_projection_patch", "set_agent_configuration", "native_equal"]],
  ["apps/server/cc-switch-host/src/settings.rs", ["deny_unknown_fields", "host_context::app_dir", "write_json_file_private"]],
];
function invariantBlockers(entry, oldBytes, newBytes) {
  const group = invariantGroups.find(([source]) => source === (entry.source ?? entry.destination));
  if (!group) return [];
  const before = oldBytes.toString("utf8"), after = newBytes.toString("utf8");
  return group[1].filter((token) => before.includes(token) && !after.includes(token)).map((token) => blocker("BLOCKED_HOST_INVARIANT", `CC headless protection removed: ${entry.destination}: ${token}`, { path: entry.destination, invariant: token }));
}
async function unchangedInputs(root, data) {
  const failures = [];
  const outputs = new Set(data.inventory.files.map((entry) => entry.destination));
  for (const entry of [...data.inventory.hostBuildInputs, ...data.closure.inputs.filter((input) => !outputs.has(input.path))]) {
    const current = await optionalFile(root, entry.path);
    if (!current || sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes) failures.push(blocker("BLOCKED_BASELINE_DRIFT", `Unapproved host/resource input changed: ${entry.path}`, { path: entry.path }));
  }
  const currentOwner = await verifyExternalHostOutputs(root, data.policy);
  if (JSON.stringify(currentOwner) !== JSON.stringify(data.externalHost)) failures.push(blocker("BLOCKED_EXTERNAL_OWNER_DRIFT", "External host owner generation changed during CC recording."));
  return failures;
}

export async function recordGeneration({ root, source: _source, targetCommit, plan, readBlob, listTree }) {
  const data = await loadData(root), notes = [], blockers = [];
  const observations = new Map([
    [manifestPath, { bytes: data.manifestBytes }], [forkPolicyPath, { bytes: data.policyBytes }],
    [inventoryPath, { bytes: data.inventoryBytes }], [closurePath, { bytes: data.closureBytes }],
    [treePath, { bytes: data.treeBytes }], ...[...data.recipes].map(([name, content]) => [name, { bytes: content }]),
  ]);
  const oldCommit = plan.oldCommit ?? plan.upstreamCommit ?? plan.baseline?.upstreamCommit;
  const plannedTarget = plan.newCommit ?? plan.targetCommit;
  if (oldCommit !== data.manifest.commit || plannedTarget !== targetCommit || !/^[a-f\d]{40}$/.test(targetCommit)) throw new Error("CC record plan pin mismatch.");
  const oldTree = validateTree(await listTree(data.manifest.commit));
  const newTree = validateTree(await listTree(targetCommit));
  const originals = await originalBytes(data.manifest.commit, data.manifest.files, readBlob, oldTree);
  const oldSelection = selectedPaths(data.manifest, oldTree);
  if (JSON.stringify(oldSelection) !== JSON.stringify([...data.inputs.keys()].sort(compare))) throw new Error("CC old manifest omits selected tree members.");
  const targetPaths = selectedPaths(data.manifest, newTree, plan.approvedSourcePaths ?? []);
  const targetEntries = [], targetOriginals = new Map();
  for (const name of targetPaths) {
    const object = newTree.get(name);
    if (object.type !== "blob" || !["100644", "100755"].includes(object.mode) || !/^[a-f\d]{40}$/.test(object.blob)) {
      blockers.push(blocker("BLOCKED_SOURCE_MODE", `Unsupported selected upstream object: ${name}`, { path: name, mode: object.mode }));
      continue;
    }
    const bytes = Buffer.from(await readBlob(targetCommit, name));
    if (blobHash(bytes) !== object.blob) throw new Error(`Wrong target blob bytes: ${name}`);
    targetOriginals.set(name, bytes);
    targetEntries.push({ path: name, mode: object.mode, blob: object.blob, sha256: sha256(bytes), bytes: bytes.length });
  }
  blockers.push(...await unchangedInputs(root, data));
  const changes = new Map((plan.changes ?? []).filter((entry) => entry.outputPath).map((entry) => [relative(entry.outputPath), entry]));
  const approvals = plan.approvedOutputHashes ?? {};
  const ownerPaths = new Set([...data.externalHost.inputs, ...data.externalHost.metadata].map((entry) => entry.path));
  for (const name of Object.keys(approvals)) if (ownerPaths.has(name)) throw new Error(`CC cannot approve an external owner generation: ${name}`);
  const reviewedDerived = new Set((plan.reviewedDerivedOutputs ?? []).map(relative));
  const derived = new Map((data.policy.derivedOutputs ?? []).map((entry) => [relative(entry.destination), entry]));
  for (const name of reviewedDerived) if (!derived.has(name)) throw new Error(`Reviewed derivation is not enrolled in CC fork policy: ${name}`);
  const oldFiles = new Map(data.inventory.files.map((entry) => [entry.destination, entry]));
  const pending = new Map(), files = [], recipes = new Map(), deletions = new Set();
  const reason = `Candidate generation ${targetCommit}; semantic/runtime acceptance is recorded separately.`;
  const manifest = { ...data.manifest, commit: targetCommit, selection: data.manifest.selection.filter((selection) => targetPaths.some((name) => name === selection || name.startsWith(selection + "/"))), files: targetEntries };
  for (const name of plan.approvedSourcePaths ?? []) if (!targetPaths.includes(name)) throw new Error(`Unselected approved source: ${name}`);
  for (const name of plan.approvedSourcePaths ?? []) if (!data.manifest.selection.some((selection) => name === selection || selections(data.manifest).trees.includes(selection) && name.startsWith(selection + "/"))) manifest.selection.push(name);
  const packageBytes = targetOriginals.get("package.json");
  if (packageBytes) {
    const upstreamPackage = JSON.parse(packageBytes);
    if (typeof upstreamPackage.version !== "string" || !upstreamPackage.version) throw new Error("Target CC package version is missing.");
    manifest.version = upstreamPackage.version;
  }
  if (data.inputs.has("LICENSE") && !targetOriginals.has("LICENSE")) blockers.push(blocker("BLOCKED_LICENSE_REMOVAL", "Selected upstream license was removed; legal/source selection review is required.", { path: prefix + "LICENSE" }));
  for (const name of ["package.json", "pnpm-lock.yaml", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs"]) {
    const next = targetOriginals.get(name), previous = originals.get(name);
    if (next && previous && !next.equals(previous)) notes.push(`Dependency/build input changed: ${name}; host locks and native/platform compatibility require full isolated review.`);
  }
  const manifestBytes = encode(manifest);
  const policy = { ...data.policy, upstreamCommit: targetCommit, sourceManifestSha256: sha256(manifestBytes) };
  pending.set(manifestPath, { bytes: manifestBytes, mode: 0o644 });
  pending.set(forkPolicyPath, { bytes: encode(policy), mode: 0o644 });

  async function capture(destination, source, input, previous) {
    const before = source ? targetOriginals.get(source) : null;
    const entry = { destination, sha256: sha256(input.bytes), bytes: input.bytes.length, mode: input.mode, provenance: source ? "pristine-upstream" : destination.startsWith(prefix) ? "local-fork-integration" : "host-owned-integration", reason: previous?.reason ?? reason };
    if (source) {
      entry.source = source; entry.upstreamSha256 = sha256(before);
      const extraction = derived.get(destination);
      if (extraction) { entry.provenance = "extracted-upstream"; entry.reason = extraction.reason; }
      if (!before.equals(input.bytes)) {
        entry.provenance = extraction ? "adapted-upstream-extraction" : "patched-upstream";
        const recipe = patchBytes(before, input.bytes, source);
        const name = extraction ? `${prefix}integration-patches/derived/${destination}.json` : `${prefix}integration-patches/${source}.json`;
        entry.patch = { path: name, sha256: sha256(recipe) }; recipes.set(name, recipe);
      }
    } else {
      const name = `${prefix}integration-patches/local/${destination}.json`;
      const asset = encode({ version: 1, destination, sha256: entry.sha256, mode: input.mode, encoding: "base64", content: input.bytes.toString("base64") });
      entry.asset = { path: name, sha256: sha256(asset) }; recipes.set(name, asset);
    }
    files.push(entry);
  }

  for (const original of targetEntries) {
    const destination = prefix + original.path, previous = oldFiles.get(destination);
    if (previous && previous.source !== original.path) {
      blockers.push(blocker("BLOCKED_SOURCE_COLLISION", `New upstream path collides with a local/derived output: ${destination}`, { path: destination }));
      continue;
    }
    const expected = targetOriginals.get(original.path);
    let input = await optionalFile(root, destination);
    if (!previous) {
      observations.set(destination, input);
      if (input && (!input.bytes.equals(expected) || input.mode !== canonicalMode(original.mode))) blockers.push(blocker("BLOCKED_ADDITION_CONFLICT", `New selected source already differs: ${destination}`, { path: destination }));
      input = { bytes: expected, mode: canonicalMode(original.mode) };
      pending.set(destination, input);
    } else if (!input) blockers.push(blocker("BLOCKED_MISSING_OUTPUT", `Selected output missing: ${destination}`, { path: destination }));
    else {
      const oldBytes = replay(previous, originals, data.recipes);
      const changed = sha256(input.bytes) !== previous.sha256 || input.mode !== previous.mode;
      const upstreamChanged = original.sha256 !== previous.upstreamSha256 || original.mode !== oldTree.get(original.path).mode;
      const planned = changes.get(destination);
      if (changed && !(planned?.sourcePath === original.path && (!planned.sourceCommit || planned.sourceCommit === data.manifest.commit)) && approvals[destination] !== sha256(input.bytes)) blockers.push(blocker("BLOCKED_UNAPPROVED_OUTPUT", `Output change has no approved source operation: ${destination}`, { path: destination }));
      if (upstreamChanged && !changed && !input.bytes.equals(expected) && approvals[destination] !== sha256(input.bytes)) blockers.push(blocker("BLOCKED_UNPORTED_SOURCE", `Changed source still has old output: ${destination}`, { path: destination }));
      blockers.push(...invariantBlockers(previous, oldBytes, input.bytes));
    }
    if (input) await capture(destination, original.path, input, previous);
  }
  for (const previous of data.inventory.files) {
    const destination = previous.destination;
    if (previous.source && destination === prefix + previous.source) {
      if (!targetOriginals.has(previous.source)) {
        if (previous.patch) blockers.push(blocker("BLOCKED_DELETED_ADAPTATION", `Removed upstream source contains a local adaptation; review its consumers and port before removal: ${destination}`, { path: destination }));
        const remaining = await optionalFile(root, destination);
        if (remaining) blockers.push(blocker("BLOCKED_DELETED_OUTPUT", `Deleted upstream source still exists; resolve removal explicitly: ${destination}`, { path: destination }));
        else deletions.add(destination);
      }
      continue;
    }
    const input = pending.get(destination) ?? await optionalFile(root, destination);
    if (!input) { blockers.push(blocker("BLOCKED_MISSING_OUTPUT", `Local/derived output cannot disappear: ${destination}`, { path: destination })); continue; }
    const generated = destination === manifestPath || destination === forkPolicyPath;
    if (!generated && (sha256(input.bytes) !== previous.sha256 || input.mode !== previous.mode) && approvals[destination] !== sha256(input.bytes) && !reviewedDerived.has(destination)) blockers.push(blocker("BLOCKED_UNAPPROVED_OUTPUT", `Local/derived edit requires exact approval: ${destination}`, { path: destination }));
    if (!previous.source) blockers.push(...invariantBlockers(previous, replay(previous, originals, data.recipes), input.bytes));
    if (previous.source) {
      const extraction = derived.get(destination);
      if (!extraction || extraction.source !== previous.source || !targetOriginals.has(previous.source)) { blockers.push(blocker("BLOCKED_DERIVED_SOURCE", `Derived input removed or remapped: ${destination}`, { path: destination })); continue; }
      if (sha256(targetOriginals.get(previous.source)) !== previous.upstreamSha256 && !reviewedDerived.has(destination)) blockers.push(blocker("BLOCKED_DERIVED_REVIEW", `Review upstream derivation before recording: ${destination}`, { path: destination, inputs: [{ path: previous.source, commit: targetCommit, sha256: sha256(targetOriginals.get(previous.source)) }] }));
      blockers.push(...invariantBlockers(previous, replay(previous, originals, data.recipes), input.bytes));
    }
    if (protectedTools.includes(destination) && sha256(input.bytes) !== previous.sha256) blockers.push(blocker("BLOCKED_PROTECTED_TOOL", `Shared provenance implementation cannot change: ${destination}`, { path: destination }));
    await capture(destination, previous.source ?? null, input, previous);
  }
  const expectedOwned = new Set([...files.map((entry) => entry.destination), ...data.inventory.patches.map((entry) => entry.path), inventoryPath, closurePath, treePath]);
  for (const tree of policy.ownedTrees ?? ["vendor/cc-switch"]) for (const name of await walk(root, tree, policy.generatedTrees)) if (!expectedOwned.has(name)) blockers.push(blocker("BLOCKED_UNKNOWN_OUTPUT", `Unenrolled owned output: ${name}`, { path: name }));
  blockers.push(...await crossForkBlockers(root, pending, data.policy));
  if (blockers.length) return { changedPaths: [], notes, blockers };
  let closure;
  try { closure = await closureFor(root, data, policy, files, [...newTree.keys()].sort(compare), pending); }
  catch (error) { return { changedPaths: [], notes, blockers: [blocker("BLOCKED_RESOURCE_CLOSURE", error.message)] }; }
  externalHostOutputs(policy, { ...data.inventory, files }, JSON.parse(closure));
  const upstreamTree = encode({ version: 1, upstreamCommit: targetCommit, paths: [...newTree.keys()].sort(compare) });
  const result = encode({ ...data.inventory, upstreamCommit: targetCommit, sourceManifestSha256: sha256(manifestBytes), policySha256: sha256(pending.get(forkPolicyPath).bytes), closureSha256: sha256(closure), upstreamTreeSha256: sha256(upstreamTree), files: files.sort((a, b) => compare(a.destination, b.destination)), patches: [...recipes].map(([name, bytes]) => ({ path: name, sha256: sha256(bytes) })).sort((a, b) => compare(a.path, b.path)), summary: { originalInputs: targetEntries.length, pristine: files.filter((entry) => entry.provenance === "pristine-upstream").length, adapted: files.filter((entry) => entry.provenance === "patched-upstream").length, extracted: files.filter((entry) => derived.has(entry.destination)).length, local: files.filter((entry) => !entry.source).length } });
  pending.set(closurePath, { bytes: closure, mode: 0o644 });
  pending.set(treePath, { bytes: upstreamTree, mode: 0o644 });
  pending.set(inventoryPath, { bytes: result, mode: 0o644 });
  for (const [name, bytes] of recipes) pending.set(name, { bytes, mode: 0o644 });
  for (const previous of data.inventory.patches) if (!recipes.has(previous.path)) deletions.add(previous.path);
  for (const name of recipes.keys()) if (!observations.has(name)) observations.set(name, null);
  // Preflight all destinations and reread accepted inputs before publishing any pin.
  for (const name of [...pending.keys(), ...deletions]) await safePath(root, name);
  for (const entry of files) {
    const input = pending.get(entry.destination) ?? await file(root, entry.destination);
    if (sha256(input.bytes) !== entry.sha256 || input.mode !== entry.mode) throw new Error(`CC output changed while recording: ${entry.destination}`);
  }
  for (const [name, observed] of observations) {
    const current = await optionalFile(root, name);
    if (Boolean(current) !== Boolean(observed) || current && (!current.bytes.equals(observed.bytes) || observed.mode !== undefined && current.mode !== observed.mode)) throw new Error(`CC generation input changed while recording: ${name}`);
  }
  const drift = await unchangedInputs(root, data);
  if (drift.length) return { changedPaths: [], notes, blockers: drift };
  const changedPaths = [];
  for (const [name, input] of [...pending].sort(([a], [b]) => compare(a, b))) {
    const current = await optionalFile(root, name);
    if (!current || !current.bytes.equals(input.bytes) || current.mode !== input.mode) {
      await publish(root, name, input.bytes, input.mode);
      await chmod(await safePath(root, name), input.mode);
      changedPaths.push(name);
    }
  }
  for (const name of [...deletions].sort(compare)) if (await optionalFile(root, name)) { await unlink(await safePath(root, name)); changedPaths.push(name); }
  notes.push("Recorded exact-byte CC generation; runtime and security acceptance still require isolated full verification.");
  return { changedPaths: unique(changedPaths), notes, blockers: [] };
}

export async function verifyGeneration({ root, readBlob, listTree }) {
  const data = await loadData(root), blockers = [];
  const tree = validateTree(await listTree(data.manifest.commit));
  const originals = await originalBytes(data.manifest.commit, data.manifest.files, readBlob, tree);
  if (JSON.stringify(selectedPaths(data.manifest, tree)) !== JSON.stringify([...data.inputs.keys()].sort(compare))) throw new Error("CC selected tree membership changed.");
  if (JSON.stringify([...tree.keys()].sort(compare)) !== JSON.stringify(data.tree.paths)) throw new Error("CC pinned upstream tree is not exact.");
  for (const entry of data.inventory.files) {
    const current = await file(root, entry.destination), reconstructed = replay(entry, originals, data.recipes);
    if (!current.bytes.equals(reconstructed) || current.mode !== entry.mode) blockers.push(blocker("BLOCKED_OUTPUT_DRIFT", `CC exact replay differs: ${entry.destination}`, { path: entry.destination }));
  }
  const expected = new Set([...data.inventory.files.map((entry) => entry.destination), ...data.inventory.patches.map((entry) => entry.path), inventoryPath, closurePath, treePath]);
  for (const directory of data.policy.ownedTrees ?? ["vendor/cc-switch"]) for (const name of await walk(root, directory, data.policy.generatedTrees)) if (!expected.has(name)) blockers.push(blocker("BLOCKED_UNKNOWN_OUTPUT", `Uninventoried CC output: ${name}`, { path: name }));
  blockers.push(...await unchangedInputs(root, data), ...await crossForkBlockers(root, new Map(), data.policy));
  if (!blockers.length) {
    const closure = await closureFor(root, data, data.policy, data.inventory.files, data.tree.paths, new Map());
    if (!closure.equals(data.closureBytes)) blockers.push(blocker("BLOCKED_RESOURCE_CLOSURE", "CC reachable resource closure differs from exact ledger."));
  }
  return { blockers, notes: ["Exact provenance replay only; not a compiler, behavioral, or security acceptance result."] };
}
