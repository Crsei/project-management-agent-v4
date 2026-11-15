import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { bindingsFor, collectTools, runtimeIdentity, toolRoot } from './core.mjs';
import { canonical, directory, encode, identity, inside, listTree, readBlob, relative, repository, resolveCommit, sha256, sourceRepository } from './io.mjs';
import { file, lock, makeDirectory, publish, walk } from './supplemental-fs.mjs';
import { applyTransaction, requiresReconstruction, stageExact } from './supplemental-transaction.mjs';
import { authenticateOriginalGeneration, loadProfile, planSupplementalGeneration, verifyGeneration } from './t3code.mjs';
import { externalHostOutputs, verifyExternalHostOutputs } from '../../vendor/cc-switch/scripts/provenance.mjs';

const production = '30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c';
const supplemental = 'd53873b6a4799e87afd63c8d288ef0089f5a3748';
const generated = ['source-manifest.json', 'sync-inventory.json', 'mcp-skills-adaptations.json', 'sync-imports.json'].map(name => `vendor/t3code/${name}`);
const maintenanceAssets = new Set(['vendor/t3code/scripts/mcp-skills-adaptations.mjs']);
const authorityLeaves = new Set(['source-manifest.json', 'sync-inventory.json', 'output-inventory.json', 'mcp-skills-adaptations.json', 'fork-policy.json', 'resource-closure.json', 'supplemental-inputs.json', 'mcp-skills-source.json', 'upstream-tree.json', 'dependency-notices.json']);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reasoned = entry => typeof entry.reason === 'string' && Boolean(entry.reason.trim());
const matches = (actual, expected) => actual && expected && !expected.deleted && sha256(actual.bytes) === expected.sha256 && actual.bytes.length === expected.bytes && actual.mode === expected.mode;
const same = (expected, actual, name) => { if (canonical(expected) !== canonical(actual)) throw new Error(`STALE_${name}`); };
const unique = values => [...new Set(values)].sort();
const fingerprint = (name, value) => value ? { path: name, sha256: sha256(value.bytes), bytes: value.bytes.length, mode: value.mode } : { path: name, deleted: true };
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const secret = name => name.split('/').some(part => ['.local', 'node_modules', '.ssh', '.aws', '.gnupg', '.netrc', 'credentials.toml', 'id_rsa', 'id_ed25519'].includes(part.toLowerCase()) || part === '.env' || part.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(part));

async function jsonInput(name, expectedHash) {
  if (!digest(expectedHash)) throw new Error('Explicit expected SHA256 is required');
  name = path.resolve(name);
  const value = await file(await directory(path.dirname(name)), path.basename(name));
  if (sha256(value.bytes) !== expectedHash) throw new Error(`STALE_REVIEW_OR_BASELINE: ${name}`);
  return { bytes: value.bytes, value: JSON.parse(value.bytes) };
}
function entries(values, key, label) {
  if (!Array.isArray(values)) throw new Error(`Missing explicit ${label} array`);
  const names = new Set();
  for (const entry of values) {
    if (!entry || typeof entry !== 'object' || !reasoned(entry)) throw new Error(`Reasoned ${label} approval required`);
    const name = key(entry);
    if (names.has(name)) throw new Error(`Duplicate ${label} approval: ${name}`);
    names.add(name);
  }
  return names;
}
function validateReviews(reviews, baselineHash, target) {
  if (reviews.version !== 1 || reviews.baselineSha256 !== baselineHash || reviews.sourceCommit !== target) throw new Error('Review identity does not match exact baseline and supplemental source');
  if (!digest(reviews.toolsSha256) || !digest(reviews.runtimeSha256)) throw new Error('Exact independently reviewed trusted-tool and runtime identities are required');
  for (const category of ['authorities', 'crossForkAuthorities', 'outputs', 'hostInputs']) entries(reviews.baseline?.[category], entry => relative(entry.path), `baseline ${category}`);
  entries(reviews.baseline?.crossForkHostInputs, entry => `${relative(entry.inventory)}:${relative(entry.path)}`, 'cross-fork host-input');
  entries(reviews.toolAssets, entry => relative(entry.path), 'maintenance asset');
  for (const entry of reviews.toolAssets) if (!maintenanceAssets.has(entry.path) || !['recordedSha256', 'recordedRecipeSha256', 'snapshotSha256', 'reviewedSha256'].every(key => digest(entry[key])) || ![0o644, 0o755].includes(entry.mode)) throw new Error(`Unapprovable maintenance asset: ${entry.path}`);
  entries(reviews.sources, entry => relative(entry.path), 'source');
  entries(reviews.outputs, entry => relative(entry.path), 'output');
  entries(reviews.dependencies, entry => JSON.stringify([relative(entry.path), entry.kind, entry.specifier, entry.expression ?? null]), 'dependency');
  if (!reviews.sources.length || !reviews.outputs.length || !reviews.sources.some(entry => entry.path === 'LICENSE')) throw new Error('Explicit LICENSE, source inputs and selected outputs are required');
  for (const entry of reviews.sources) if (!digest(entry.sha256) || secret(entry.path)) throw new Error(`Invalid source approval: ${entry.path}`);
  const used = new Set(['LICENSE']);
  for (const entry of reviews.outputs) {
    if (!digest(entry.sha256) || ![0o644, 0o755].includes(entry.mode) || !['local', 'derived'].includes(entry.kind) || !Array.isArray(entry.inputs) || (entry.kind === 'local' ? entry.inputs.length !== 0 : entry.inputs.length === 0)) throw new Error(`Invalid output review: ${entry.path}`);
    const inputs = new Set();
    for (const input of entry.inputs) {
      relative(input.path);
      const key = `${input.commit}:${input.path}`;
      if (inputs.has(key) || !digest(input.sha256) || !/^[a-f0-9]{40}$/.test(input.commit)) throw new Error(`Invalid or duplicate mapped input: ${key}`);
      inputs.add(key);
      if (input.commit === target) {
        if (!reviews.sources.some(source => source.path === input.path && source.sha256 === input.sha256)) throw new Error(`Unapproved source input: ${key}`);
        used.add(input.path);
      } else if (![production, supplemental].includes(input.commit)) throw new Error(`Unapproved supplemental source identity: ${key}`);
    }
    entries(entry.removedInputs ?? [], input => `${input.commit}:${relative(input.path)}`, 'removed mapped input');
    for (const input of entry.removedInputs ?? []) if (input.disposition !== 'no-longer-derived' || !digest(input.sha256) || ![production, supplemental].includes(input.commit) || inputs.has(`${input.commit}:${input.path}`)) throw new Error(`Invalid mapped-input removal: ${entry.path}`);
  }
  if (reviews.sources.some(entry => !used.has(entry.path))) throw new Error('Unselected source approval');
  for (const entry of reviews.dependencies) if (!reviews.outputs.some(output => output.path === entry.path) || typeof entry.kind !== 'string' || entry.specifier !== null && typeof entry.specifier !== 'string') throw new Error('Unselected or malformed dependency approval');
}
function validateSnapshot(baseline, candidate) {
  if (baseline.kind !== 'unapproved-authoring-snapshot-not-publication-evidence' || baseline.candidate !== candidate || baseline.sourceCommit == null || baseline.snapshot?.version !== 1 || !Array.isArray(baseline.snapshot.files) || !/^[a-f0-9]{40}$/.test(baseline.baseCommit)) throw new Error('An independent preserved authoring baseline is required; diagnostic candidates are not promotable');
  const names = new Set();
  for (const entry of baseline.snapshot.files) {
    relative(entry.path);
    if (secret(entry.path) || names.has(entry.path) || !entry.deleted && (!digest(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || ![0o644, 0o755].includes(entry.mode))) throw new Error(`Invalid preserved snapshot entry: ${entry.path}`);
    names.add(entry.path);
  }
  return new Map(baseline.snapshot.files.map(entry => [entry.path, entry]));
}
function assertOutputPath(profile, review, adaptations, baselineOutputs) {
  const name = relative(review.path);
  const pinnedAttachmentBridge = name === 'apps/server/agent/src/providers/t3code/execution.ts' || name === 'apps/server/agent/src/providers/t3code/execution.test.ts';
  const frozenPmHost = name === 'apps/server/pm/src/app.ts';
  if (secret(name) || !/^(?:apps\/web\/|apps\/server\/agent\/|apps\/desktop\/|packages\/)/.test(name) && !frozenPmHost || name.startsWith('apps/server/agent/src/providers/t3code/') && !pinnedAttachmentBridge || /(?:^|\/)(?:scripts|AGENTS\.md)(?:\/|$)/.test(name) || profile.metadataPaths.includes(name) || profile.protectedPaths.some(prefix => name === prefix || name.startsWith(prefix + '/'))) throw new Error(`PROTECTED_SUPPLEMENTAL_OUTPUT: ${name}`);
  if (frozenPmHost) {
    const prior = adaptations.outputs.find(entry => entry.destination === name), approval = baselineOutputs.find(entry => entry.path === name);
    if (!prior || Object.hasOwn(prior, 'retirement') || !approval || prior.provenance !== 'local-integration' || prior.recipe.kind !== 'local-bytes' ||
        prior.inputs.length || review.kind !== 'local' || review.inputs.length || review.removedInputs?.length || review.mode !== prior.mode ||
        approval.recordedSha256 !== prior.sha256 || review.sha256 !== approval.snapshotSha256) {
      throw new Error(`Frozen PM host preservation requires its existing local owner and exact independently reviewed snapshot, never feature edits: ${name}`);
    }
    return;
  }
  if (!pinnedAttachmentBridge) return;
  const prior = adaptations.outputs.find(entry => entry.destination === name);
  if (!prior || Object.hasOwn(prior, 'retirement') || prior.provenance !== 'adapted-upstream' || prior.recipe.kind !== 'exact-line-splices' || prior.recipe.primaryInput !== 0 ||
      review.kind !== 'derived' || review.removedInputs?.length || !prior.inputs.length || review.inputs.length !== prior.inputs.length ||
      review.inputs.some((input, index) => input.path !== prior.inputs[index].path || input.commit !== prior.inputs[index].commit || input.sha256 !== prior.inputs[index].sha256)) {
    throw new Error(`Pinned attachment bridge must retain its complete ordered historical inputs and primary recipe: ${name}`);
  }
}
async function candidateFiles(candidate) {
  const result = [];
  for (const name of await walk(candidate, '', { omit: ['.git', '.upstream-sync', '.local', 'node_modules'] })) {
    if (secret(name)) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: ${name}`);
    result.push(fingerprint(name, await file(candidate, name)));
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function authenticateCandidate(candidate, snapshots, reviews, allowedMetadata = []) {
  const selected = new Map(reviews.outputs.map(entry => [entry.path, entry]));
  const files = await candidateFiles(candidate);
  const actual = new Map(files.map(entry => [entry.path, entry]));
  for (const name of unique([...snapshots.keys(), ...actual.keys()])) {
    const before = snapshots.get(name) ?? { path: name, deleted: true }, after = actual.get(name) ?? { path: name, deleted: true };
    if (allowedMetadata.includes(name)) continue;
    const review = selected.get(name);
    if (review) {
      if (after.deleted || after.sha256 !== review.sha256 || after.mode !== review.mode || before.mode != null && before.mode !== after.mode) throw new Error(`STALE_OUTPUT_APPROVAL: ${name}`);
    } else if (canonical(before) !== canonical(after)) throw new Error(`UNAPPROVED_SNAPSHOT_CHANGE: ${name}`);
  }
  return files;
}
async function authorityApprovals({ hostRoot, baseCommit, snapshots, paths, approvals, originalRoot, label }) {
  const head = new Map((await listTree(hostRoot, baseCommit)).map(entry => [entry.path, entry]));
  const used = new Set();
  for (const name of paths) {
    const snapshot = snapshots.get(name);
    if (!snapshot || snapshot.deleted) throw new Error(`Missing original authority: ${name}`);
    const expected = head.has(name) ? sha256(await readBlob(hostRoot, baseCommit, name)) : null;
    if (snapshot.sha256 !== expected) {
      const review = approvals.find(entry => entry.path === name);
      if (!review || review.headSha256 !== expected || review.snapshotSha256 !== snapshot.sha256) throw new Error(`UNAPPROVED_${label}_AUTHORITY: ${name}`);
      used.add(name);
    }
    if (!matches(await file(originalRoot, name), snapshot)) throw new Error(`STALE_ORIGINAL_AUTHORITY: ${name}`);
  }
  if (approvals.some(entry => !used.has(entry.path))) throw new Error(`Unselected or stale ${label} authority approval`);
}
async function crossForkBaseline({ hostRoot, baseCommit, originalRoot, paths, approvals }) {
  const head = new Set((await listTree(hostRoot, baseCommit)).map(entry => entry.path)), used = new Set();
  for (const name of paths) {
    const currentBytes = (await file(originalRoot, name)).bytes;
    if (!head.has(name)) throw new Error(`UNAPPROVED_CROSS_FORK_ENROLLMENT: ${name}`);
    const previousBytes = await readBlob(hostRoot, baseCommit, name);
    if (previousBytes.equals(currentBytes)) continue;
    const before = JSON.parse(previousBytes), after = JSON.parse(currentBytes);
    if (!Array.isArray(before.hostBuildInputs) || !Array.isArray(after.hostBuildInputs)) throw new Error(`UNAPPROVED_CROSS_FORK_NON_HOST_CHANGE: ${name}`);
    const withoutFingerprints = document => ({ ...document, hostBuildInputs: document.hostBuildInputs.map(entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !['sha256', 'bytes'].includes(key)))) });
    same(withoutFingerprints(before), withoutFingerprints(after), 'CROSS_FORK_NON_HOST_IDENTITY');
    for (let index = 0; index < after.hostBuildInputs.length; index++) {
      const previous = before.hostBuildInputs[index], current = after.hostBuildInputs[index];
      if (canonical(previous) === canonical(current)) continue;
      const approval = approvals.find(entry => entry.inventory === name && entry.path === current.path);
      if (!approval || approval.recordedSha256 !== previous.sha256 || approval.snapshotSha256 !== current.sha256 || approval.recordedBytes !== previous.bytes || approval.snapshotBytes !== current.bytes || approval.mode !== current.mode) throw new Error(`UNAPPROVED_CROSS_FORK_HOST_INPUT: ${name}: ${current.path}`);
      used.add(`${name}:${current.path}`);
    }
  }
  if (approvals.some(entry => !used.has(`${entry.inventory}:${entry.path}`))) throw new Error('Unselected or stale cross-fork host-input approval');
}

function driftApprovals(expected, snapshots, approvals, selected, label) {
  const used = new Set();
  for (const entry of expected) {
    const actual = snapshots.get(entry.path);
    if (!actual || actual.deleted) throw new Error(`Missing baseline ${label}: ${entry.path}`);
    if (entry.sha256 !== actual.sha256 || entry.bytes != null && entry.bytes !== actual.bytes || entry.mode != null && entry.mode !== actual.mode) {
      const review = approvals.find(approval => approval.path === entry.path);
      if (!review || review.recordedSha256 !== entry.sha256 || review.snapshotSha256 !== actual.sha256 || entry.mode != null && entry.mode !== actual.mode || selected && !selected.has(entry.path)) throw new Error(`UNAPPROVED_BASELINE_${label}: ${entry.path}`);
      used.add(entry.path);
    }
  }
  if (approvals.some(entry => !used.has(entry.path))) throw new Error(`Unselected or stale baseline ${label} approval`);
}
async function checkBindings(candidate, expectedBindings) {
  const bindings = await bindingsFor(candidate, 't3code', file);
  if (expectedBindings) same(expectedBindings, bindings, 'CROSS_FORK_AUTHORITY');
  for (const binding of bindings) for (const reference of binding.references) {
    const actual = await file(candidate, reference.path, { optional: true });
    if (!actual || sha256(actual.bytes) !== reference.sha256 || reference.bytes != null && actual.bytes.length !== reference.bytes || reference.mode != null && actual.mode !== reference.mode) throw new Error(`BLOCKED_CROSS_FORK: ${binding.path}: ${reference.path}`);
  }
  return bindings;
}
async function sourceInputs(source, target, reviews) {
  if (await resolveCommit(source, 'HEAD') !== target || await resolveCommit(source, target) !== target) throw new Error('STALE_SUPPLEMENTAL_SOURCE');
  for (const entry of reviews.sources) if (sha256(await readBlob(source, target, entry.path)) !== entry.sha256) throw new Error(`STALE_SOURCE_APPROVAL: ${entry.path}`);
}
async function save(control, state) {
  const bytes = encode(state);
  await publish(control, 'state.json', bytes, 0o600);
  return sha256(bytes);
}

/** Read-only identity disclosure; a hash is not independent review or approval. */
export async function supplementalTools() {
  const tools = await collectTools(), runtime = await runtimeIdentity();
  return { status: 'identity-only-not-approved', toolsSha256: identity(tools), runtimeSha256: identity(runtime), tools, runtime };
}

async function reviewedToolAssets({ reviews, snapshots, inventory, originalRoot, hostRoot, baseCommit }) {
  const result = [];
  for (const review of reviews.toolAssets) {
    const entry = inventory.files.find(value => value.destination === review.path), snapshot = snapshots.get(review.path);
    const current = await file(toolRoot, review.path), preserved = await file(originalRoot, review.path);
    if (!entry || entry.asset !== review.path || entry.provenance !== 'local-addition' || identity(entry) !== review.recordedRecipeSha256 || entry.sha256 !== review.recordedSha256 || !matches(preserved, snapshot) || snapshot.sha256 !== review.snapshotSha256 || sha256(current.bytes) !== review.reviewedSha256 || current.mode !== review.mode || entry.mode !== review.mode || snapshot.mode !== review.mode) throw new Error(`STALE_MAINTENANCE_ASSET_APPROVAL: ${review.path}`);
    let original = preserved;
    if (sha256(original.bytes) !== entry.sha256) {
      const bytes = await readBlob(hostRoot, baseCommit, review.path);
      original = { bytes, mode: entry.mode };
    }
    if (sha256(original.bytes) !== entry.sha256 || original.bytes.length !== entry.bytes) throw new Error(`MISSING_IMMUTABLE_TOOL_PREIMAGE: ${review.path}`);
    if (review.snapshotSha256 === review.reviewedSha256 && review.recordedSha256 === review.reviewedSha256) throw new Error(`Unnecessary maintenance asset approval: ${review.path}`);
    result.push({ ...review, original, snapshot: preserved, reviewed: current });
  }
  if (reviews.outputs.some(entry => entry.path.startsWith('apps/desktop/')) && !result.some(entry => entry.path === 'vendor/t3code/scripts/mcp-skills-adaptations.mjs')) {
    const expected = inventory.files.find(entry => entry.destination === 'vendor/t3code/scripts/mcp-skills-adaptations.mjs');
    const actual = await file(toolRoot, 'vendor/t3code/scripts/mcp-skills-adaptations.mjs');
    if (!expected || expected.sha256 !== sha256(actual.bytes)) throw new Error('MAINTENANCE_ASSET_APPROVAL_REQUIRED: desktop structural validator must be independently bound, not silently refreshed');
  }
  return result;
}

async function loadReviewedTools(control, reviews) {
  const result = [];
  for (const review of reviews.toolAssets) {
    const value = await file(control, `reviewed-tools/${review.path}`);
    const trusted = await file(toolRoot, review.path);
    if (sha256(value.bytes) !== review.reviewedSha256 || !value.bytes.equals(trusted.bytes) || value.mode !== review.mode) throw new Error(`STALE_MAINTENANCE_ASSET: ${review.path}`);
    result.push({ ...review, content: value.bytes });
  }
  return result;
}

async function checkOwnerPlan({ candidate, control, originalRoot, plannedFiles }) {
  const policyInput = await file(originalRoot, 'vendor/cc-switch/fork-policy.json', { optional: true });
  if (!policyInput) return [];
  const policy = JSON.parse(policyInput.bytes), planned = new Map(plannedFiles.map(entry => [entry.path, entry]));
  const stage = await makeDirectory(path.join(control, 'owner-preflight'));
  const names = unique(['vendor/t3code/mcp-skills-adaptations.json', 'vendor/t3code/source-manifest.json', 'vendor/t3code/sync-inventory.json', 'vendor/t3code/mcp-skills-source.json', 'vendor/t3code/LICENSE', ...externalHostOutputs(policy).map(entry => entry.path)]);
  try {
    for (const name of names) {
      const value = planned.has(name) ? { bytes: planned.get(name).content, mode: planned.get(name).mode } : await file(candidate, name);
      await stageExact(stage, name, value.bytes, value.mode);
    }
    await verifyExternalHostOutputs(stage, policy);
    return [];
  } catch (error) {
    return [{ code: 'BLOCKED_CROSS_FORK', inventory: 'vendor/cc-switch/fork-policy.json', message: error.message, reason: 'Existing external-owner source/recipe semantics must authenticate the planned generation; no CC scope expansion is authorized' }];
  }
}

async function stageCurrentGeneration(candidate, control, state, originalRoot, reviews) {
  const original = await loadProfile(originalRoot);
  const stage = await makeDirectory(path.join(control, `replay-${state.candidateFingerprint}`));
  const expected = new Map(state.recordedFiles.map(entry => [entry.path, entry]));
  const names = unique([...state.originals.map(entry => entry.path), ...original.outputs.map(entry => entry.path), ...reviews.outputs.map(entry => entry.path)]);
  for (const name of names) {
    const value = await file(candidate, name);
    if (!matches(value, expected.get(name))) throw new Error(`STALE_CANDIDATE_REPLAY_INPUT: ${name}`);
    await stageExact(stage, name, value.bytes, value.mode);
  }
  return stage;
}

/** Adopt an independently preserved snapshot, not an upstream-sync diagnostic state. */
export async function prepareSupplemental({ candidate, baseline: baselinePath, baselineSha256, originalRoot, source, target, reviews: reviewsPath, reviewsSha256, control }) {
  candidate = await directory(candidate);
  originalRoot = await directory(originalRoot);
  source = await sourceRepository(source);
  control = await directory(control, { absent: true });
  const baselineInput = await jsonInput(baselinePath, baselineSha256), baseline = baselineInput.value;
  const snapshots = validateSnapshot(baseline, candidate);
  const reviewInput = await jsonInput(reviewsPath, reviewsSha256), reviews = reviewInput.value;
  if (target !== baseline.sourceCommit || !/^[a-f0-9]{40}$/.test(target) || [production, supplemental].includes(target)) throw new Error('Exact independent supplemental target required');
  validateReviews(reviews, baselineSha256, target);
  const tools = await collectTools(), runtime = await runtimeIdentity();
  same(reviews.toolsSha256, identity(tools), 'REVIEWED_TOOL');
  same(reviews.runtimeSha256, identity(runtime), 'REVIEWED_RUNTIME');
  const hostRoot = await repository(baseline.hostRoot);
  for (const root of [candidate, originalRoot, source, hostRoot]) if (inside(root, control) || inside(control, root)) throw new Error('Controls must be external to candidate, original inputs, host and source');
  if (inside(candidate, toolRoot) || inside(candidate, source) || inside(source, candidate) || inside(candidate, hostRoot) || inside(hostRoot, candidate)) throw new Error('Trusted tool, source and candidate must be independent');
  if (await lstat(control).catch(missing)) throw new Error('Control directory must be new');
  if (await lstat(path.join(candidate, '.upstream-sync')).catch(missing)) throw new Error('Existing diagnostic/maintenance state cannot be promoted');
  if (await resolveCommit(hostRoot, 'HEAD') !== baseline.baseCommit) throw new Error('STALE_HOST_BASE');
  // Parse only descriptor-read authenticated copies, never raceable candidate or
  // original-root path reads inside the reusable modern profile.
  await makeDirectory(control, { exclusive: true });
  const originalsRoot = await makeDirectory(path.join(control, 'originals'));
  for (const name of [...generated, 'vendor/t3code/mcp-skills-source.json']) {
    const expected = snapshots.get(name);
    if (!expected || expected.deleted) throw new Error(`Missing original authority: ${name}`);
    const value = await file(originalRoot, name);
    if (!matches(value, expected)) throw new Error(`STALE_ORIGINAL_AUTHORITY: ${name}`);
    await stageExact(originalsRoot, name, value.bytes, value.mode);
  }
  const profile = await loadProfile(originalsRoot);
  if (profile.upstreamCommit !== production) throw new Error('Production pin must remain unchanged');
  const inventory = JSON.parse((await file(originalsRoot, 'vendor/t3code/sync-inventory.json')).bytes);
  const adaptations = JSON.parse((await file(originalsRoot, 'vendor/t3code/mcp-skills-adaptations.json')).bytes);
  for (const entry of reviews.outputs) assertOutputPath(profile, entry, adaptations, reviews.baseline.outputs);
  const assets = await reviewedToolAssets({ reviews, snapshots, inventory, originalRoot, hostRoot, baseCommit: baseline.baseCommit });
  const assetNames = new Set(assets.map(entry => entry.path));
  const externalPaths = [...snapshots.keys()].filter(name => /^vendor\/(?:cc-switch|openhands-extensions)\/[^/]+$/.test(name) && authorityLeaves.has(path.posix.basename(name)));
  await authorityApprovals({ hostRoot, baseCommit: baseline.baseCommit, snapshots, paths: profile.metadataPaths.filter(name => !maintenanceAssets.has(name)), approvals: reviews.baseline.authorities, originalRoot, label: 'T3' });
  await authorityApprovals({ hostRoot, baseCommit: baseline.baseCommit, snapshots, paths: externalPaths, approvals: reviews.baseline.crossForkAuthorities, originalRoot, label: 'CROSS_FORK' });
  await crossForkBaseline({ hostRoot, baseCommit: baseline.baseCommit, originalRoot, paths: externalPaths, approvals: reviews.baseline.crossForkHostInputs });
  driftApprovals(profile.outputs.filter(entry => !assetNames.has(entry.path)), snapshots, reviews.baseline.outputs, new Set(reviews.outputs.map(entry => entry.path)), 'OUTPUT');
  driftApprovals(profile.hostInputs, snapshots, reviews.baseline.hostInputs, null, 'HOST_INPUT');
  const files = await authenticateCandidate(candidate, snapshots, reviews);
  const bindings = await checkBindings(candidate);
  await sourceInputs(source, target, reviews);
  const originalPaths = unique([...profile.metadataPaths, ...externalPaths, ...inventory.files.map(entry => entry.asset).filter(Boolean), ...profile.hostInputs.map(entry => entry.path), ...adaptations.sources.map(entry => entry.license.distributedPath)]);
  const originals = [];
  for (const name of originalPaths) {
    relative(name);
    const expected = snapshots.get(name);
    if (secret(name) || !expected || expected.deleted) throw new Error(`UNAPPROVED_ORIGINAL_INPUT: ${name}`);
    const asset = assets.find(entry => entry.path === name);
    let value;
    if (asset) value = asset.original;
    else {
      value = await file(originalRoot, name);
      if (!matches(value, expected)) throw new Error(`STALE_ORIGINAL_INPUT: ${name}`);
    }
    await stageExact(originalsRoot, name, value.bytes, value.mode);
    originals.push(fingerprint(name, value));
  }
  const toolPreimages = [];
  for (const asset of assets) {
    await publish(control, `tool-preimages/${asset.path}`, asset.snapshot.bytes, asset.snapshot.mode, { exclusive: true });
    await publish(control, `reviewed-tools/${asset.path}`, asset.reviewed.bytes, asset.reviewed.mode, { exclusive: true });
    toolPreimages.push(fingerprint(asset.path, asset.snapshot));
  }
  const replay = await authenticateOriginalGeneration({ root: originalsRoot, readBlob: (commit, name) => readBlob(source, commit, name), listTree: commit => listTree(source, commit) });
  if (replay.blockers.length) throw new Error(`ORIGINAL_REPLAY_BLOCKED: ${JSON.stringify(replay.blockers)}`);
  same(tools, await collectTools(), 'REVIEWED_TOOL_DURING_PREPARE');
  same(runtime, await runtimeIdentity(), 'REVIEWED_RUNTIME_DURING_PREPARE');
  same(files, await authenticateCandidate(candidate, snapshots, reviews), 'CANDIDATE_DURING_PREPARE');
  await checkBindings(candidate, bindings);
  await sourceInputs(source, target, reviews);
  await publish(control, 'baseline.json', baselineInput.bytes, 0o600, { exclusive: true });
  await publish(control, 'reviews.json', reviewInput.bytes, 0o600, { exclusive: true });
  const state = { version: 1, kind: 'reviewed-supplemental-ui-authoring-not-publication', status: 'prepared', candidate, hostRoot, baseCommit: baseline.baseCommit, source, target, baselineSha256, reviewsSha256, originals, toolPreimages, tools, runtime, bindings, preparedFingerprint: identity(files), generated: [], recordedFiles: null };
  const controlSha256 = await save(control, state);
  return { status: 'prepared', candidate, control, controlSha256, sourceCommit: target, productionCommit: production, coverage: 'authenticated-explicit-supplemental-authoring-only; candidate bytes unchanged; historical index bound by reviewed baseline hash, not current host index; no publication readiness' };
}
async function context({ candidate, control, controlSha256 }, stateFile = 'state.json') {
  candidate = await directory(candidate);
  control = await directory(control);
  if (inside(candidate, toolRoot) || inside(candidate, control) || inside(control, candidate)) throw new Error('Candidate cannot own validating tools or controls');
  if (await lstat(path.join(candidate, '.upstream-sync')).catch(missing)) throw new Error('Existing diagnostic/maintenance state cannot be promoted');
  const input = await jsonInput(path.join(control, stateFile), controlSha256), state = input.value;
  if (state.version !== 1 || state.kind !== 'reviewed-supplemental-ui-authoring-not-publication' || state.candidate !== candidate) throw new Error('Invalid supplemental control identity');
  same(state.tools, await collectTools(), 'TRUSTED_TOOL');
  same(state.runtime, await runtimeIdentity(), 'TRUSTED_RUNTIME');
  if (await resolveCommit(await repository(state.hostRoot), 'HEAD') !== state.baseCommit) throw new Error('STALE_HOST_BASE');
  const baseline = (await jsonInput(path.join(control, 'baseline.json'), state.baselineSha256)).value;
  const reviews = (await jsonInput(path.join(control, 'reviews.json'), state.reviewsSha256)).value;
  const snapshots = validateSnapshot(baseline, candidate);
  validateReviews(reviews, state.baselineSha256, state.target);
  same(reviews.toolsSha256, identity(state.tools), 'REVIEWED_TOOL');
  same(reviews.runtimeSha256, identity(state.runtime), 'REVIEWED_RUNTIME');
  const originalRoot = await directory(path.join(control, 'originals'));
  for (const expected of state.originals) if (!matches(await file(originalRoot, expected.path), expected)) throw new Error(`STALE_ORIGINAL_INPUT: ${expected.path}`);
  for (const expected of state.toolPreimages ?? []) if (!matches(await file(control, `tool-preimages/${expected.path}`), expected)) throw new Error(`STALE_TOOL_PREIMAGE: ${expected.path}`);
  await sourceInputs(await sourceRepository(state.source), state.target, reviews);
  await checkBindings(candidate, state.bindings);
  return { candidate, control, state, baseline, snapshots, reviews, originalRoot };
}
function exactApproval(actual, expected, label) {
  const selected = Object.fromEntries(expected.map(entry => [entry.path, entry.sha256]));
  same(selected, actual, `${label}_ALLOWLIST`);
}
export async function recordSupplemental(options) {
  const control = await directory(options.control), release = await lock(control);
  try {
    const resumed = await file(control, 'transaction/prepared-state.json', { optional: true });
    const stateFile = resumed ? 'transaction/prepared-state.json' : 'state.json';
    const contextOptions = { ...options, control };
    const { candidate, state, snapshots, reviews, originalRoot } = await context(contextOptions, stateFile);
    exactApproval(options.approvedSourceHashes ?? {}, reviews.sources, 'SOURCE');
    exactApproval(options.approvedOutputHashes ?? {}, reviews.outputs, 'OUTPUT');
    if (state.status !== 'prepared') throw new Error('Supplemental generation already recorded; no recapture or implicit reapproval');
    if (!resumed) {
      const initial = await authenticateCandidate(candidate, snapshots, reviews);
      same(state.preparedFingerprint, identity(initial), 'CANDIDATE');
    }
    const toolAssets = await loadReviewedTools(control, reviews);
    const result = await planSupplementalGeneration({ root: candidate, originalRoot, targetCommit: state.target, reviews, toolAssets, readBlob: (commit, name) => readBlob(state.source, commit, name), listTree: commit => listTree(state.source, commit) });
    if (result.blockers.length) return { status: 'blocked', ...result };
    const plannedFiles = result.plannedFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const plannedPaths = plannedFiles.map(entry => entry.path);
    same(unique([...generated, ...reviews.toolAssets.map(entry => entry.path)]), [...plannedPaths].sort(), 'GENERATED_METADATA_SCOPE');
    const preimages = new Map();
    for (const entry of plannedFiles) {
      const preimage = reviews.toolAssets.some(asset => asset.path === entry.path) ? await file(control, `tool-preimages/${entry.path}`) : await file(originalRoot, entry.path);
      if (!matches(preimage, snapshots.get(entry.path))) throw new Error(`STALE_TRANSACTION_PREIMAGE: ${entry.path}`);
      preimages.set(entry.path, preimage);
    }
    const normalizedBefore = async () => {
      const current = await authenticateCandidate(candidate, snapshots, reviews, plannedPaths);
      return current.map(entry => {
        const planned = plannedFiles.find(value => value.path === entry.path);
        if (!planned) return entry;
        const before = fingerprint(entry.path, preimages.get(entry.path));
        const after = { path: planned.path, sha256: planned.sha256, bytes: planned.bytes, mode: planned.mode };
        if (canonical(entry) !== canonical(before) && canonical(entry) !== canonical(after)) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${entry.path}`);
        return before;
      });
    };
    const before = await normalizedBefore();
    same(state.preparedFingerprint, identity(before), 'CANDIDATE');
    const after = before.map(entry => {
      const planned = plannedFiles.find(value => value.path === entry.path);
      return planned ? { path: planned.path, sha256: planned.sha256, bytes: planned.bytes, mode: planned.mode } : entry;
    });
    const cross = await checkOwnerPlan({ candidate, control, originalRoot, plannedFiles });
    if (cross.length) return { status: 'blocked', blockers: cross, changedPaths: [] };
    const nextState = { ...state, status: 'recorded', generated: plannedPaths, recordedFiles: after, candidateFingerprint: identity(after) };
    const validate = async phase => {
      await context(contextOptions, stateFile);
      same(state.preparedFingerprint, identity(await normalizedBefore()), 'CANDIDATE_DURING_RECORD');
      if (phase === 'after') same(after, await candidateFiles(candidate), 'CANDIDATE_AFTER_RECORD');
      same(state.runtime, await runtimeIdentity(), 'TRUSTED_RUNTIME_DURING_RECORD');
    };
    const transaction = await applyTransaction({ candidate, control, inputReceipt: options.controlSha256, preparedState: state, nextState, plannedFiles, preimages, validate });
    const changedPaths = unique([...reviews.outputs.map(entry => entry.path), ...plannedPaths]);
    return { status: 'recorded', ...transaction, candidateFingerprint: nextState.candidateFingerprint, changedPaths, integrationPreimages: changedPaths.map(name => snapshots.get(name) ?? { path: name, deleted: true }), integrationPolicy: 'Never overwrite a differing destination. Freeze a fresh current host baseline, independently review the exact three-way feature diff, and record new authority rather than copying stale ledgers.', coverage: 'source-authoring-only; same-receipt recovery limited to complete identifiable pre/post layouts', notes: result.notes };
  } catch (error) {
    const journal = await file(control, 'transaction/manifest.json', { optional: true }).catch(() => null);
    if (journal && requiresReconstruction(error) && error.code !== 'SUPPLEMENTAL_RECONSTRUCTION_REQUIRED') {
      const failure = new Error(`SUPPLEMENTAL_RECONSTRUCTION_REQUIRED: ${control}/transaction/manifest.json; interrupted layout cannot be fully identified as complete pre/post. Preserve all backup/temp files and inodes; no automatic cleanup or forward retry is authorized. Rebuild NEW candidate/control from the independent preimage plus explicitly reviewed feature outputs. Cause: ${error.message}`, { cause: error });
      failure.code = 'SUPPLEMENTAL_RECONSTRUCTION_REQUIRED';
      failure.details = { transaction: `${control}/transaction/manifest.json`, recovery: 'fresh-candidate-and-control-required' };
      throw failure;
    }
    throw error;
  } finally { await release(); }
}
export async function verifySupplemental(options) {
  const control = await directory(options.control), release = await lock(control);
  try {
    const { candidate, state, snapshots, reviews, originalRoot } = await context(options);
    if (state.status !== 'recorded') throw new Error('Exact supplemental generation must be recorded first');
    const permitted = [...generated, ...reviews.toolAssets.map(entry => entry.path)];
    const before = await authenticateCandidate(candidate, snapshots, reviews, permitted);
    same(state.recordedFiles, before, 'CANDIDATE');
    const stage = await stageCurrentGeneration(candidate, control, state, originalRoot, reviews);
    const replay = await verifyGeneration({ root: stage, readBlob: (commit, name) => readBlob(state.source, commit, name), listTree: commit => listTree(state.source, commit) });
    const cross = await checkOwnerPlan({ candidate, control, originalRoot, plannedFiles: [] });
    same(state.recordedFiles, await candidateFiles(candidate), 'CANDIDATE_DURING_REPLAY');
    await context(options);
    const profile = await loadProfile(stage);
    if (profile.upstreamCommit !== production || !profile.inputs.some(entry => entry.commit === supplemental)) throw new Error('Independent production/supplemental identity changed');
    const blockers = [...replay.blockers, ...cross];
    return { status: blockers.length ? 'blocked' : 'passed', scope: 'provenance', coverage: 'current-generation-immutable-input-and-byte-identical-recipe-replay-only', candidateFingerprint: state.candidateFingerprint, productionCommit: production, sourceCommit: state.target, blockers, notes: replay.notes, notRun: ['tests', 'lint', 'types', 'build', 'browser', 'Provider accounts', 'deployment', 'full verification', 'publication handoff'], publicationEligible: false };
  } finally { await release(); }
}
