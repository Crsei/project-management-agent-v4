import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { canonical, cleanEnvironment, directory, encode, file, git, identity, inside, listTree, mergeBytes, publish, readBlob, readObjects, relative, repository, resolveCommit, run, sha256, sourceRepository, walk } from './io.mjs';

export const toolRoot = fileURLToPath(new URL('../../', import.meta.url));
const profiles = new Set(['t3code', 'cc-switch']);
const metadataName = '.upstream-sync';
const stateVersion = 1;
const fullCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const unique = values => [...new Set(values)].sort();
const modeOf = entry => entry.mode === '100755' ? 0o755 : 0o644;
const under = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const secretPath = name => name.split('/').some(part => part === '.env' || part.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(part) || ['.ssh', '.aws', '.gnupg', '.netrc', 'credentials.toml', 'id_rsa', 'id_ed25519'].includes(part));
const fingerprintMatches = (actual, expected) => Boolean(actual) && sha256(actual.bytes) === expected.sha256 && (expected.bytes == null || actual.bytes.length === expected.bytes) && (expected.mode == null || actual.mode === expected.mode);
function validatePurpose(plan, purpose) {
  if (!['upstream-update', 'local-authoring'].includes(purpose)) throw new Error('INVALID_CANDIDATE_PURPOSE');
  if (purpose === 'local-authoring' && (plan.targetCommit !== plan.upstreamCommit || plan.changes.length || plan.pinAdvanceRequired)) throw new Error('LOCAL_AUTHORING_REQUIRES_SAME_PIN: target must equal the accepted pin with no upstream changes');
}
const blocked = (code, details) => ({ code, ...details });
export function assertIdentity(expected, actual, label = 'identity') {
  if (canonical(expected) !== canonical(actual)) throw new Error(`STALE_${label.toUpperCase()}: identity changed`);
}
async function profileModule(project) {
  if (!profiles.has(project)) throw new Error('Supported projects: t3code, cc-switch');
  return import(new URL(`./${project}.mjs`, import.meta.url));
}
async function profileFor(root, project) {
  const module = await profileModule(project);
  const profile = await module.loadProfile(root);
  if (profile.id !== project || !fullCommit(profile.upstreamCommit)) throw new Error('Invalid trusted profile identity');
  for (const input of profile.inputs) {
    relative(input.path);
    if (!fullCommit(input.commit) || !/^[a-f0-9]{64}$/.test(input.sha256) || !['100644', '100755'].includes(input.gitMode)) throw new Error(`Invalid profile source input: ${input.path}`);
  }
  for (const output of profile.outputs) {
    relative(output.path);
    if (!['pristine', 'patched', 'derived', 'local'].includes(output.kind) || ![0o644, 0o755].includes(output.mode)) throw new Error(`Invalid profile output: ${output.path}`);
  }
  return { module, profile };
}
async function fingerprint(root, paths) {
  const entries = [];
  for (const name of unique(paths)) {
    if (secretPath(name)) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: ${name}; no credential bytes were read`);
    const actual = await file(root, relative(name), { optional: true });
    entries.push(actual ? { path: name, sha256: sha256(actual.bytes), bytes: actual.bytes.length, mode: actual.mode } : { path: name, deleted: true });
  }
  return entries;
}
export async function workingTreeChanges(root) {
  const head = await resolveCommit(root, 'HEAD');
  const tree = await listTree(root, head), expected = new Map(tree.map(entry => [entry.path, entry]));
  const baseline = await immutableFiles(root, head);
  const tracked = differences(baseline, await fingerprint(root, tree.map(entry => entry.path)));
  const staged = (await git(root, ['ls-files', '--stage', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean);
  const indexed = new Set();
  for (const line of staged) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('UNSAFE_INDEX_RECORD');
    const name = relative(match[4]), entry = expected.get(name);
    indexed.add(name);
    if (match[3] !== '0' || !entry || entry.mode !== match[1] || entry.blob !== match[2]) tracked.push(name);
  }
  for (const entry of tree) if (!indexed.has(entry.path)) tracked.push(entry.path);
  const untracked = (await git(root, ['ls-files', '-z', '--others', '--exclude-standard'])).stdout.toString('utf8').split('\0').filter(Boolean);
  return unique([...tracked, ...untracked]).filter(name => !under(name, metadataName)).map(relative);
}
export async function snapshotTree(root) {
  const visible = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.toString('utf8').split('\0').filter(Boolean);
  const ignored = (await git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).stdout.toString('utf8').split('\0').filter(Boolean);
  const generated = name => name.split('/').some(part => ['node_modules', 'target', 'dist', 'build', '.cache', '.vite', '.turbo', 'coverage'].includes(part));
  const names = unique([...visible, ...ignored.filter(name => !generated(name))]).filter(name => !under(name, metadataName));
  return fingerprint(root, names);
}
async function collectTools() {
  const paths = ['scripts/upstream-sync.mjs'];
  for (const prefix of ['scripts/upstream-sync', 'vendor/t3code/scripts', 'vendor/cc-switch/scripts', 'vendor/openhands-extensions/scripts']) {
    const exists = await lstat(path.join(toolRoot, prefix)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (exists) paths.push(...(await walk(toolRoot, prefix)).filter(name => /\.(?:mjs|json|ts|py)$/.test(name) && !name.endsWith('.test.mjs')));
  }
  // check-ci's fixed entry and dependencies are trusted command identities as well.
  for (const name of await readdir(path.join(toolRoot, 'scripts'))) if (/\.(?:mjs|ts)$/.test(name) && !name.endsWith('.test.mjs')) paths.push(`scripts/${name}`);
  return fingerprint(toolRoot, paths);
}
async function runtimeIdentity() {
  const nodePath = await realpath(process.execPath);
  const runtime = { nodePath, nodeVersion: process.version, nodeSha256: sha256(await readFile(nodePath)), platform: process.platform, arch: process.arch, typescript: null };
  const require = createRequire(import.meta.url);
  try {
    const entry = await realpath(require.resolve('typescript'));
    const metadata = await realpath(require.resolve('typescript/package.json'));
    runtime.typescript = { entry, entrySha256: sha256(await readFile(entry)), metadataSha256: sha256(await readFile(metadata)) };
  } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  return runtime;
}
async function bindingsFor(root, project) {
  const bindings = [];
  for (const fork of ['t3code', 'cc-switch', 'openhands-extensions']) {
    if (fork === project) continue;
    for (const leaf of ['sync-inventory.json', 'output-inventory.json', 'mcp-skills-adaptations.json', 'fork-policy.json', 'resource-closure.json']) {
      const name = `vendor/${fork}/${leaf}`;
      const input = await file(root, name, { optional: true });
      if (!input) continue;
      const references = new Map();
      const visit = value => {
        if (Array.isArray(value)) { for (const item of value) visit(item); return; }
        if (!value || typeof value !== 'object') return;
        // Supplemental input/license paths are relative to an immutable source
        // commit, not PM files. Its destination records are still host outputs.
        const sourceIdentity = fullCommit(value.commit);
        const destination = typeof value.destination === 'string' ? value.destination : !sourceIdentity && typeof value.path === 'string' ? value.path : null;
        if (destination && value.sha256 != null) {
          if (!/^[a-f0-9]{64}$/.test(value.sha256) || value.bytes != null && (!Number.isSafeInteger(value.bytes) || value.bytes < 0) || value.mode != null && ![0o644, 0o755].includes(value.mode)) throw new Error(`INVALID_CROSS_FORK_FINGERPRINT: ${name}`);
          const next = { path: relative(destination), sha256: value.sha256, ...(value.bytes == null ? {} : { bytes: value.bytes }), ...(value.mode == null ? {} : { mode: value.mode }) };
          const previous = references.get(next.path);
          if (previous && ['sha256', 'bytes', 'mode'].some(key => previous[key] != null && next[key] != null && previous[key] !== next[key])) throw new Error(`CONTRADICTORY_CROSS_FORK_FINGERPRINT: ${name}: ${next.path}`);
          references.set(next.path, { ...previous, ...next });
        }
        if (sourceIdentity) return;
        for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
      };
      visit(JSON.parse(input.bytes));
      bindings.push({ path: name, sha256: sha256(input.bytes), references: [...references.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) });
    }
  }
  return bindings;
}
function selected(profile, name) {
  return profile.selection.files.includes(name) || profile.selection.trees.some(tree => under(name, tree));
}
function outputForAddition(profile, sourcePath) {
  // Only complete selected trees have a deterministic direct-copy destination.
  if (profile.selection.trees.some(tree => under(sourcePath, tree))) return `vendor/${profile.id}/${sourcePath}`;
  return null;
}
export async function analyzeChanges({ profile, source, targetCommit }) {
  const trees = new Map();
  const tree = async commit => {
    if (!trees.has(commit)) trees.set(commit, new Map((await listTree(source, commit)).map(entry => [entry.path, entry])));
    return trees.get(commit);
  };
  const target = await tree(targetCommit);
  const changes = [], blockers = [];
  const inputs = new Map(profile.inputs.map(input => [`${input.commit}:${input.path}`, input]));
  // Mapped originals include supplemental references and every derived input.
  for (const output of profile.outputs) for (const input of output.inputs ?? []) inputs.set(`${input.commit}:${input.path}`, input);
  for (const input of inputs.values()) if (secretPath(input.path)) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: ${input.path}`);
  for (const entry of target.values()) if (selected(profile, entry.path) && secretPath(entry.path)) blockers.push(blocked('UNSAFE_CREDENTIAL_SOURCE', { path: entry.path }));
  const neededBlobs = [];
  for (const input of inputs.values()) {
    const old = (await tree(input.commit)).get(input.path);
    if (old?.type === 'blob' && ['100644', '100755'].includes(old.mode)) neededBlobs.push(old.blob);
    const next = input.commit === profile.upstreamCommit ? target.get(input.path) : old;
    if (next?.type === 'blob' && ['100644', '100755'].includes(next.mode)) neededBlobs.push(next.blob);
  }
  for (const entry of target.values()) if (selected(profile, entry.path) && !secretPath(entry.path) && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)) neededBlobs.push(entry.blob);
  await readObjects(source, neededBlobs);
  for (const input of inputs.values()) {
    const oldTree = await tree(input.commit);
    const old = oldTree.get(input.path);
    if (!old || old.type !== 'blob' || !['100644', '100755'].includes(old.mode)) { blockers.push(blocked('MISSING_BASE_OBJECT', { path: input.path, commit: input.commit })); continue; }
    const oldBytes = await readBlob(source, input.commit, input.path);
    if (sha256(oldBytes) !== input.sha256 || oldBytes.length !== input.bytes || input.blob && old.blob !== input.blob || old.mode !== input.gitMode) blockers.push(blocked('SOURCE_BASELINE_DRIFT', { path: input.path, commit: input.commit }));
    // Supplemental pins are immutable unless they are explicitly the baseline pin.
    const nextCommit = input.commit === profile.upstreamCommit ? targetCommit : input.commit;
    const next = (await tree(nextCommit)).get(input.path);
    const outputs = profile.outputs.filter(output => output.sourcePath === input.path && (output.sourceCommit ?? profile.upstreamCommit) === input.commit || (output.inputs ?? []).some(item => item.path === input.path && item.commit === input.commit));
    if (next && (next.type !== 'blob' || !['100644', '100755'].includes(next.mode))) { blockers.push(blocked('UNSAFE_SOURCE_MODE', { path: input.path, mode: next.mode })); continue; }
    if (next?.blob === old.blob && next.mode === old.mode) continue;
    const nextBytes = next ? await readBlob(source, nextCommit, input.path) : null;
    for (const output of outputs.length ? outputs : [null]) changes.push({ sourcePath: input.path, sourceCommit: input.commit, targetSourceCommit: nextCommit, outputPath: output?.path ?? null, status: next ? 'modified' : 'deleted', oldSha256: input.sha256, newSha256: nextBytes ? sha256(nextBytes) : null, oldMode: modeOf(old), newMode: next ? modeOf(next) : null, kind: output?.kind ?? 'reference' });
  }
  const baselineTree = await tree(profile.upstreamCommit);
  for (const entry of baselineTree.values()) if (selected(profile, entry.path) && !inputs.has(`${profile.upstreamCommit}:${entry.path}`)) blockers.push(blocked('UNENROLLED_BASELINE_SOURCE', { path: entry.path, commit: profile.upstreamCommit }));
  for (const entry of target.values()) {
    if (!selected(profile, entry.path) || baselineTree.has(entry.path) || secretPath(entry.path)) continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) { blockers.push(blocked('UNSAFE_SOURCE_MODE', { path: entry.path, mode: entry.mode })); continue; }
    const bytes = await readBlob(source, targetCommit, entry.path);
    changes.push({ sourcePath: entry.path, sourceCommit: profile.upstreamCommit, targetSourceCommit: targetCommit, outputPath: outputForAddition(profile, entry.path), status: 'added', oldSha256: null, newSha256: sha256(bytes), oldMode: null, newMode: modeOf(entry), kind: outputForAddition(profile, entry.path) ? 'pristine' : 'reference' });
  }
  changes.sort((a, b) => {
    const left = `${a.sourceCommit}:${a.sourcePath}:${a.outputPath}`, right = `${b.sourceCommit}:${b.sourcePath}:${b.outputPath}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { changes, blockers };
}
export async function inspect({ root = toolRoot, project, source, target }) {
  root = await repository(root);
  source = await sourceRepository(source);
  if (inside(root, source) || inside(source, root)) throw new Error('Source and host repository must not overlap');
  const { profile } = await profileFor(root, project);
  const targetCommit = await resolveCommit(source, target);
  const baseCommit = await resolveCommit(root, 'HEAD');
  const tools = await collectTools();
  const baselinePaths = unique([...profile.metadataPaths, ...profile.outputs.map(entry => entry.path), ...profile.hostInputs.map(entry => entry.path)]);
  const baseline = await fingerprint(root, baselinePaths);
  const blockers = [...(profile.blockers ?? [])];
  const actual = new Map(baseline.map(entry => [entry.path, entry]));
  for (const entry of [...profile.outputs, ...profile.hostInputs]) {
    const found = actual.get(entry.path);
    if (!found || found.deleted || found.sha256 !== entry.sha256 || entry.bytes != null && found.bytes !== entry.bytes || entry.mode != null && found.mode !== entry.mode) blockers.push(blocked('BASELINE_DRIFT', { path: entry.path, expected: entry.sha256, actual: found?.sha256 ?? null }));
  }
  const maintenanceTool = name => ['scripts/upstream-sync.mjs', 'scripts/upstream-publish.mjs'].includes(name) || under(name, 'scripts/upstream-sync');
  const dirty = (await workingTreeChanges(root)).filter(name => !maintenanceTool(name));
  if (dirty.length) blockers.push(blocked('DIRTY_BASELINE', { paths: dirty }));
  let analysis;
  try { analysis = await analyzeChanges({ profile, source, targetCommit }); }
  catch (error) { analysis = { changes: [], blockers: [blocked('MISSING_SOURCE_OBJECT', { message: error.message })] }; }
  blockers.push(...analysis.blockers);
  const externalBindings = await bindingsFor(root, project);
  for (const binding of externalBindings) for (const input of binding.references) if (analysis.changes.some(change => change.outputPath === input.path)) blockers.push(blocked('BLOCKED_CROSS_FORK', { inventory: binding.path, path: input.path, reason: 'Selected upstream change affects another fork fingerprint; separate scope approval required' }));
  for (const binding of externalBindings) for (const input of binding.references) {
    const found = await file(root, input.path, { optional: true });
    if (!fingerprintMatches(found, input)) blockers.push(blocked('BLOCKED_CROSS_FORK', { inventory: binding.path, path: input.path, expected: input.sha256, actual: found ? sha256(found.bytes) : null }));
  }
  const plan = { schemaVersion: 1, project, root, source, baseCommit, upstreamUrl: profile.upstreamUrl, upstreamCommit: profile.upstreamCommit, targetCommit, oldCommit: profile.upstreamCommit, newCommit: targetCommit, baseline, tools, policyHash: identity(profile.policy), externalBindings, changes: analysis.changes, dirty, blockers, status: blockers.length ? 'blocked' : analysis.changes.length ? 'changes' : 'no-change', pinAdvanceRequired: targetCommit !== profile.upstreamCommit, integratedCommit: profile.upstreamCommit };
  plan.runtime = await runtimeIdentity();
  plan.planId = identity(plan);
  return plan;
}
async function readPlan(name) {
  const parent = await directory(path.dirname(path.resolve(name)));
  return JSON.parse((await file(parent, path.basename(name))).bytes);
}
async function validatePlan(plan, { allowBlocked = false } = {}) {
  if (plan.schemaVersion !== 1 || !profiles.has(plan.project) || !fullCommit(plan.baseCommit) || !fullCommit(plan.targetCommit) || typeof plan.root !== 'string' || typeof plan.source !== 'string') throw new Error('INVALID_PLAN');
  const fresh = await inspect({ root: plan.root, project: plan.project, source: plan.source, target: plan.targetCommit });
  assertIdentity(plan, fresh, 'plan');
  if (!allowBlocked && fresh.blockers.length) throw new Error(`BLOCKED_PLAN: ${fresh.blockers.map(item => item.code).join(', ')}`);
  return fresh;
}
async function metadata(candidate) {
  candidate = await repository(candidate);
  const root = path.join(candidate, metadataName);
  await directory(root);
  const input = await file(root, 'state.json');
  const state = JSON.parse(input.bytes);
  if (state.schemaVersion !== stateVersion || state.candidate !== candidate) throw new Error('INVALID_CANDIDATE_OWNERSHIP');
  return { candidate, metadata: root, state };
}
async function saveState(meta, state) { await publish(meta, 'state.json', encode(state)); }
async function validateState(candidate, { allowCommitted = false, expectedHead } = {}) {
  const context = await metadata(candidate);
  const { state } = context;
  await validatePlan(state.plan);
  validatePurpose(state.plan, state.purpose);
  const head = await resolveCommit(candidate, 'HEAD');
  if (expectedHead != null && (!fullCommit(expectedHead) || head !== expectedHead)) throw new Error('STALE_CANDIDATE_HEAD');
  if (head !== state.plan.baseCommit) {
    if (!allowCommitted || expectedHead !== head) throw new Error('STALE_CANDIDATE_BASE');
    const parents = (await git(candidate, ['rev-list', '--parents', '-n', '1', head])).stdout.toString().trim().split(' ');
    if (parents.length !== 2 || parents[1] !== state.plan.baseCommit) throw new Error('UNAUTHORIZED_COMMIT_ANCESTRY');
  }
  const snapshot = await fingerprint(path.join(context.metadata, 'tools'), state.plan.tools.map(entry => entry.path));
  assertIdentity(state.plan.tools, snapshot, 'snapshot_tools');
  return context;
}
function protectedPath(profile, name) {
  return (profile.protectedPaths ?? []).some(entry => under(name, entry)) || name.startsWith('.github/') || name.startsWith('scripts/') || name.startsWith('.agents/');
}
function allowedPaths(profile, plan) {
  return new Set([...profile.outputs.map(output => output.path), ...profile.metadataPaths, ...(profile.authoringPaths ?? []), ...plan.changes.map(change => change.outputPath).filter(Boolean), ...(plan.approvedSourcePaths ?? []).map(name => `vendor/${profile.id}/${relative(name)}`)]);
}
export function assertAllowedPaths(changed, profile, plan) {
  const allowed = allowedPaths(profile, plan);
  for (const name of changed) {
    relative(name);
    if (protectedPath(profile, name) || !allowed.has(name) && !(name.endsWith('.json') && (profile.authoringTrees ?? []).some(tree => under(name, tree)))) throw new Error(`UNAPPROVED_CANDIDATE_PATH: ${name}`);
  }
}
function differences(before, after) {
  const previous = new Map(before.map(entry => [entry.path, entry]));
  const next = new Map(after.map(entry => [entry.path, entry]));
  return unique([...previous.keys(), ...next.keys()]).filter(name => canonical(previous.get(name) ?? { path: name, deleted: true }) !== canonical(next.get(name) ?? { path: name, deleted: true }));
}
async function immutableFiles(root, commit) {
  const tree = await listTree(root, commit);
  for (const entry of tree) {
    if (secretPath(entry.path)) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: ${entry.path}; no credential bytes were read`);
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`UNSAFE_BASE_TREE: ${entry.path}`);
  }
  const objects = await readObjects(root, tree.map(entry => entry.blob));
  const base = tree.map(entry => {
    const bytes = objects.get(entry.blob);
    return { path: entry.path, sha256: sha256(bytes), bytes: bytes.length, mode: modeOf(entry) };
  });
  return base;
}
async function candidateChanges(candidate, plan) {
  const base = await immutableFiles(plan.root, plan.baseCommit);
  const files = await snapshotTree(candidate);
  return { files, changedPaths: differences(base, files), base };
}
export async function prepare({ plan: planInput, destination, purpose = 'upstream-update' }) {
  const plan = typeof planInput === 'string' ? await readPlan(planInput) : planInput;
  await validatePlan(plan);
  validatePurpose(plan, purpose);
  destination = await directory(destination, { absent: true });
  for (const root of [plan.root, plan.source]) if (inside(root, destination) || inside(destination, root)) throw new Error('Candidate must not overlap host/source');
  const exists = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (exists) {
    const context = await validateState(destination);
    assertIdentity(plan, context.state.plan, 'resumed_plan');
    assertIdentity(purpose, context.state.purpose, 'resumed_purpose');
    if (context.state.status === 'preparing') throw new Error('INCOMPLETE_PREPARE: retained owned directory; choose a new destination rather than overwriting possible manual edits');
    return { candidate: destination, planId: plan.planId, purpose, status: context.state.status, conflicts: context.state.conflicts, resumed: true };
  }
  if (purpose === 'upstream-update' && !plan.changes.length && !plan.pinAdvanceRequired) return { candidate: null, planId: plan.planId, purpose, status: 'no-change', conflicts: [], resumed: false };
  // --no-checkout prevents attributes, smudge filters and checkout hooks from running.
  await git(plan.root, ['worktree', 'add', '--no-checkout', '--detach', '--', destination, plan.baseCommit]);
  const meta = path.join(destination, metadataName);
  await mkdir(meta, { mode: 0o700 });
  const state = { schemaVersion: stateVersion, candidate: destination, plan, purpose, status: 'preparing', conflicts: [], notes: [], approvals: {}, verification: null };
  await saveState(meta, state);
  const tree = await listTree(plan.root, plan.baseCommit);
  const objects = await readObjects(plan.root, tree.map(entry => entry.blob));
  for (const entry of tree) {
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`UNSAFE_BASE_TREE: ${entry.path}`);
    await publish(destination, entry.path, objects.get(entry.blob), modeOf(entry));
  }
  // Populate the worktree index from immutable objects, without invoking checkout.
  await git(destination, ['read-tree', plan.baseCommit]);
  const snapshotRoot = path.join(meta, 'tools');
  await mkdir(snapshotRoot, { mode: 0o700 });
  for (const entry of plan.tools) await publish(snapshotRoot, entry.path, (await file(toolRoot, entry.path)).bytes, entry.mode);
  const { profile } = await profileFor(plan.root, plan.project);
  for (const change of plan.changes) {
    if (!change.outputPath || change.kind === 'reference') continue;
    const name = change.outputPath;
    if (protectedPath(profile, name)) { state.conflicts.push(blocked('PROTECTED_PATH', { path: name })); continue; }
    if (change.kind === 'derived') { state.conflicts.push(blocked('DERIVED_REVIEW_REQUIRED', { path: name, inputs: profile.outputs.find(output => output.path === name)?.inputs ?? [] })); continue; }
    if (change.kind === 'local') continue;
    if (change.status === 'added') { await publish(destination, name, await readBlob(plan.source, change.targetSourceCommit, change.sourcePath), change.newMode, { exclusive: true }); continue; }
    const local = await file(destination, name);
    const old = await readBlob(plan.source, change.sourceCommit, change.sourcePath);
    if (change.status === 'deleted') {
      state.conflicts.push(blocked(local.bytes.equals(old) ? 'REMOVAL_REVIEW_REQUIRED' : 'REMOVED_EDITED_FILE', { path: name, sourcePath: change.sourcePath }));
      continue;
    }
    const next = await readBlob(plan.source, change.targetSourceCommit, change.sourcePath);
    const merged = await mergeBytes(old, local.bytes, next);
    const originalMode = change.oldMode;
    const modeConflict = local.mode !== originalMode && change.newMode !== originalMode && local.mode !== change.newMode;
    const mode = local.mode === originalMode ? change.newMode : local.mode;
    await publish(destination, name, merged.bytes, mode);
    if (merged.conflict || modeConflict) state.conflicts.push(blocked(modeConflict ? 'MODE_CONFLICT' : merged.reason, { path: name, sourcePath: change.sourcePath, oldSha256: change.oldSha256, newSha256: change.newSha256 }));
  }
  const current = await candidateChanges(destination, plan);
  assertAllowedPaths(current.changedPaths, profile, plan);
  state.preparedFingerprint = identity(current.files);
  state.preparedFiles = current.files;
  state.status = state.conflicts.length ? 'needs-review' : 'prepared';
  await saveState(meta, state);
  return { candidate: destination, planId: plan.planId, purpose, status: state.status, conflicts: state.conflicts, resumed: false };
}
function validateApprovals(approvals, profile, plan) {
  const allowed = allowedPaths(profile, { ...plan, ...approvals });
  for (const name of [...(approvals.reviewedDerivedOutputs ?? []), ...Object.keys(approvals.approvedOutputHashes ?? {})]) if (!allowed.has(relative(name)) || protectedPath(profile, name)) throw new Error(`UNAPPROVED_REVIEW_PATH: ${name}`);
  for (const name of Object.keys(approvals.approvedOutputHashes ?? {})) if (profile.metadataPaths.includes(name) || (profile.authoringTrees ?? []).some(tree => under(name, tree))) throw new Error(`UNAPPROVABLE_GENERATION_METADATA: ${name}`);
  for (const name of approvals.approvedSourcePaths ?? []) relative(name);
  for (const review of approvals.reviews ?? []) {
    if (!allowed.has(relative(review.outputPath)) || protectedPath(profile, review.outputPath) || !['integrated', 'not-applicable', 'deferred'].includes(review.disposition) || typeof review.reason !== 'string' || !review.reason.trim() || !Array.isArray(review.inputs)) throw new Error('INVALID_REVIEW_DECISION');
    for (const input of review.inputs) if (!fullCommit(input.commit) || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('INVALID_REVIEW_INPUT');
  }
}
async function crossForkChanges(root, bindings, changedPaths) {
  const blockers = [];
  for (const binding of bindings) {
    const current = await file(root, binding.path, { optional: true });
    if (!current || sha256(current.bytes) !== binding.sha256) blockers.push(blocked('BLOCKED_CROSS_FORK', { inventory: binding.path, path: binding.path }));
    for (const input of binding.references) if (changedPaths.includes(input.path)) {
      const found = await file(root, input.path, { optional: true });
      if (!fingerprintMatches(found, input)) blockers.push(blocked('BLOCKED_CROSS_FORK', { inventory: binding.path, path: input.path, expected: input.sha256, actual: found ? sha256(found.bytes) : null }));
    }
  }
  return blockers;
}
async function authenticateGenerationMetadata(candidate, profile, plan, changedPaths) {
  const baseline = new Map(plan.baseline.map(entry => [entry.path, entry]));
  for (const current of await fingerprint(candidate, profile.metadataPaths)) if (canonical(current) !== canonical(baseline.get(current.path))) throw new Error(`UNREVIEWED_GENERATION_METADATA: ${current.path}; prepare baseline is authoritative`);
  for (const name of changedPaths) if ((profile.authoringTrees ?? []).some(tree => under(name, tree))) throw new Error(`UNREVIEWED_GENERATION_METADATA: ${name}; recipes may only be written by the trusted generation author`);
}
export async function record({ candidate, approvedSourcePaths = [], reviewedDerivedOutputs = [], approvedOutputHashes = {}, reviews = [] }) {
  const context = await validateState(candidate);
  const { state, metadata: meta } = context;
  const { module, profile } = await profileFor(state.plan.root, state.plan.project);
  const previousApprovals = state.approvals ?? {};
  const approvals = { approvedSourcePaths: unique(approvedSourcePaths.length ? approvedSourcePaths : previousApprovals.approvedSourcePaths ?? []), reviewedDerivedOutputs: unique(reviewedDerivedOutputs.length ? reviewedDerivedOutputs : previousApprovals.reviewedDerivedOutputs ?? []), approvedOutputHashes: Object.keys(approvedOutputHashes).length ? approvedOutputHashes : previousApprovals.approvedOutputHashes ?? {}, reviews: reviews.length ? reviews : previousApprovals.reviews ?? [] };
  ({ approvedSourcePaths, reviewedDerivedOutputs, approvedOutputHashes, reviews } = approvals);
  validateApprovals(approvals, profile, state.plan);
  for (const [name, hash] of Object.entries(approvedOutputHashes)) if (!/^[a-f0-9]{64}$/.test(hash) || sha256((await file(candidate, name)).bytes) !== hash) throw new Error(`STALE_OUTPUT_APPROVAL: ${name}`);
  for (const review of reviews) for (const input of review.inputs) if (sha256(await readBlob(state.plan.source, input.commit, relative(input.path))) !== input.sha256) throw new Error(`STALE_REVIEW_INPUT: ${input.path}`);
  const before = await candidateChanges(candidate, state.plan);
  assertAllowedPaths(before.changedPaths, profile, { ...state.plan, ...approvals });
  const reauthor = Boolean(state.generationRecorded);
  const initialLocalAuthoring = !reauthor && state.purpose === 'local-authoring';
  if (!reauthor) await authenticateGenerationMetadata(candidate, profile, state.plan, before.changedPaths);
  if (initialLocalAuthoring) {
    if (approvedSourcePaths.length) throw new Error('LOCAL_AUTHORING_SCOPE_EXPANSION: only existing mapped outputs may change');
    const outputs = new Map(profile.outputs.map(output => [output.path, output]));
    for (const name of before.changedPaths) {
      const output = outputs.get(name);
      const current = await file(candidate, name, { optional: true });
      if (!output || !current || current.mode !== output.mode || approvedOutputHashes[name] !== sha256(current.bytes)) throw new Error(`LOCAL_AUTHORING_REQUIRES_EXACT_OUTPUT_APPROVAL: ${name}`);
    }
    if (!before.changedPaths.length) return { status: 'no-change', candidate, changedPaths: [], notes: ['No local output changes; no generation was recorded.'], blockers: [] };
  }
  let generationProfile = profile;
  if (reauthor) {
    if (identity(before.files) === state.candidateFingerprint && canonical(approvals) === canonical(state.approvals) && ['recorded', 'verified'].includes(state.status)) return { status: state.status, changedPaths: state.changedPaths, candidateFingerprint: state.candidateFingerprint, notes: state.notes, blockers: [], resumed: true };
    const changedSinceRecord = differences(state.recordedFiles, before.files);
    for (const name of changedSinceRecord) {
      if (profile.metadataPaths.includes(name) || (profile.authoringTrees ?? []).some(tree => under(name, tree))) throw new Error(`UNREVIEWED_GENERATION_METADATA: ${name}`);
      const current = await file(candidate, name, { optional: true });
      if (!current || approvedOutputHashes[name] !== sha256(current.bytes)) throw new Error(`REAUTHOR_REQUIRES_EXACT_OUTPUT_APPROVAL: ${name}`);
    }
    generationProfile = await module.loadProfile(candidate);
  }
  // Unknown local-only edits are never recaptured as newly approved bytes.
  for (const output of generationProfile.outputs.filter(entry => entry.kind === 'local')) {
    const found = await file(candidate, output.path, { optional: true });
    if ((!found || sha256(found.bytes) !== output.sha256 || found.mode !== output.mode) && (!found || approvedOutputHashes[output.path] !== sha256(found.bytes))) throw new Error(`UNREVIEWED_LOCAL_OUTPUT: ${output.path}`);
  }
  const unresolved = [];
  for (const conflict of state.conflicts) {
    const found = await file(candidate, conflict.path, { optional: true });
    if (conflict.code === 'DERIVED_REVIEW_REQUIRED') {
      if (!reviewedDerivedOutputs.includes(conflict.path) && !reviews.some(review => review.outputPath === conflict.path && review.disposition === 'integrated')) unresolved.push(conflict);
    } else if (conflict.code.includes('REMOV')) {
      if (found) unresolved.push(conflict);
    } else if (conflict.code === 'PROTECTED_PATH' || !found || found.bytes.includes(Buffer.from('<<<<<<< accepted-local')) || found.bytes.includes(Buffer.from('||||||| old-upstream')) || found.bytes.includes(Buffer.from('>>>>>>> new-upstream')) || conflict.code === 'BINARY_REVIEW_REQUIRED' && approvedOutputHashes[conflict.path] !== sha256(found.bytes)) unresolved.push(conflict);
  }
  if (unresolved.length) { state.status = 'needs-review'; state.verification = null; await saveState(meta, state); return { status: state.status, blockers: unresolved, changedPaths: before.changedPaths }; }
  const crossBefore = await crossForkChanges(candidate, state.plan.externalBindings, before.changedPaths);
  if (crossBefore.length) return { status: 'blocked', blockers: crossBefore, changedPaths: before.changedPaths };
  const additions = [];
  const targetTree = new Map((await listTree(state.plan.source, state.plan.targetCommit)).map(entry => [entry.path, entry]));
  for (const sourcePath of reauthor || initialLocalAuthoring ? [] : approvedSourcePaths) {
    if (state.plan.changes.some(change => change.sourcePath === sourcePath && change.outputPath)) continue;
    const outputPath = `vendor/${profile.id}/${relative(sourcePath)}`;
    if (protectedPath(profile, outputPath) || profile.metadataPaths.includes(outputPath) || profile.outputs.some(output => output.path === outputPath)) throw new Error(`SOURCE_APPROVAL_COLLISION: ${sourcePath}`);
    const entry = targetTree.get(sourcePath);
    const bytes = await readBlob(state.plan.source, state.plan.targetCommit, sourcePath);
    const existing = await file(candidate, outputPath, { optional: true });
    if (existing && (!existing.bytes.equals(bytes) || existing.mode !== modeOf(entry))) throw new Error(`UNREVIEWED_NEW_SOURCE: ${outputPath}`);
    if (!existing) await publish(candidate, outputPath, bytes, modeOf(entry), { exclusive: true });
    additions.push({ sourcePath, sourceCommit: state.plan.upstreamCommit, targetSourceCommit: state.plan.targetCommit, outputPath, status: 'added', oldSha256: null, newSha256: sha256(bytes), oldMode: null, newMode: modeOf(entry), kind: 'pristine' });
  }
  const plan = { ...state.plan, ...approvals, purpose: state.purpose, ...(reauthor || initialLocalAuthoring ? { oldCommit: state.plan.targetCommit, upstreamCommit: state.plan.targetCommit, newCommit: state.plan.targetCommit, reauthorGeneration: true, initialLocalAuthoring, changes: [] } : { changes: [...state.plan.changes, ...additions] }) };
  const result = await module.recordGeneration({ root: candidate, source: state.plan.source, targetCommit: state.plan.targetCommit, plan, readBlob: (commit, name) => readBlob(state.plan.source, commit, name), listTree: commit => listTree(state.plan.source, commit) });
  if (!result || !Array.isArray(result.blockers) || !Array.isArray(result.changedPaths) || !Array.isArray(result.notes)) throw new Error('INVALID_TRUSTED_GENERATION_RESULT');
  const after = await candidateChanges(candidate, state.plan);
  // Reauthoring changes the generation preimage, not the original approved scope.
  assertAllowedPaths(after.changedPaths, profile, { ...state.plan, ...approvals, changes: [...state.plan.changes, ...(state.authoringChanges ?? []), ...additions] });
  const blockers = [...(result.blockers ?? []), ...await crossForkChanges(candidate, state.plan.externalBindings, after.changedPaths)];
  state.approvals = approvals;
  if (!reauthor) state.authoringChanges = additions;
  if (!blockers.length) {
    state.generationRecorded = true;
    state.recordedFiles = after.files;
    state.candidateFingerprint = identity(after.files);
    state.changedPaths = after.changedPaths;
  }
  state.notes = result.notes ?? [];
  state.blockers = blockers;
  state.verification = null;
  state.status = blockers.length ? 'blocked' : 'recorded';
  await saveState(meta, state);
  return { status: state.status, changedPaths: after.changedPaths, candidateFingerprint: state.candidateFingerprint, notes: state.notes, blockers };
}
async function dependencyMounts(candidate) {
  const mounts = [];
  async function visit(name = '') {
    for (const entry of await readdir(path.join(candidate, name), { withFileTypes: true })) {
      if (['.git', metadataName, 'target', 'dist', 'build', '.cache', '.vite', '.turbo', 'coverage'].includes(entry.name)) continue;
      const next = name ? `${name}/${entry.name}` : entry.name;
      if (entry.name === 'node_modules') {
        const absolute = await directory(path.join(candidate, next));
        mounts.push('--ro-bind', absolute, `/workspace/${next}`);
      } else if (entry.isDirectory()) await visit(next);
    }
  }
  await visit();
  return mounts;
}
export async function runIsolatedVerification(candidate, commands) {
  if (process.platform !== 'linux') throw new Error('ISOLATION_PREREQUISITE: Linux Bubblewrap required');
  const bwrap = '/usr/bin/bwrap';
  await lstat(bwrap).catch(() => { throw new Error('ISOLATION_PREREQUISITE: /usr/bin/bwrap required; no unsafe fallback'); });
  await snapshotTree(candidate); // Refuses credential names before reading their bytes.
  const mounts = [];
  for (const name of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/alternatives', '/etc/ld.so.cache', '/etc/ssl/certs']) if (await lstat(name).catch(() => null)) mounts.push('--ro-bind', name, name);
  const node = await realpath(process.execPath);
  mounts.push('--dir', '/opt', '--dir', '/opt/upstream-tools', '--ro-bind', node, '/opt/upstream-tools/node');
  const control = path.join(candidate, metadataName);
  const verificationOutput = path.join(control, 'verification-output');
  await directory(control);
  await directory(verificationOutput, { absent: true });
  await mkdir(verificationOutput, { recursive: true, mode: 0o700 });
  for (const name of ['credentials', 'credentials.toml']) if (await lstat(path.join(verificationOutput, 'cargo', name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error(`CREDENTIAL_FILE_NOT_ALLOWED: Cargo ${name}; use a credential-free preprovisioned cache`);
  // Only this candidate and explicit public system toolchains are exposed.
  // Dependency code and control receipts are read-only; build outputs have a
  // separate writable mount. No host Home, network, agents or service sockets.
  const args = [
    '--die-with-parent', '--new-session', '--unshare-all', ...mounts,
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home', '--dir', '/home/verify',
    '--bind', candidate, '/workspace', ...await dependencyMounts(candidate),
    '--ro-bind', control, '/workspace/.upstream-sync',
    '--bind', verificationOutput, '/workspace/.upstream-sync/verification-output',
    '--ro-bind', path.join(candidate, '.git'), '/workspace/.git', '--chdir', '/workspace',
    '--setenv', 'HOME', '/home/verify', '--setenv', 'XDG_CONFIG_HOME', '/home/verify/config',
    '--setenv', 'XDG_DATA_HOME', '/home/verify/data', '--setenv', 'XDG_CACHE_HOME', '/home/verify/cache',
    '--setenv', 'CARGO_HOME', '/workspace/.upstream-sync/verification-output/cargo',
    '--setenv', 'PATH', '/opt/upstream-tools:/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'CI', 'true', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'GIT_CONFIG_NOSYSTEM', '1', '--setenv', 'GIT_CONFIG_GLOBAL', '/dev/null',
  ];
  const results = [];
  for (const command of commands) {
    const started = new Date().toISOString();
    try {
      const executable = command.command === process.execPath || command.command === 'node' ? '/opt/upstream-tools/node' : command.command;
      // Empty spawn environment also supports older Bubblewrap without --clearenv.
      const result = await run(bwrap, [...args, executable, ...command.args], { env: {} });
      results.push({ id: command.id, command: command.command, args: command.args, started, status: 'passed', stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr) });
    } catch (error) {
      const prerequisite = /(?:bwrap:|execvp).*(?:No such file|Operation not permitted|namespace|Permission denied)/is.test(error.message);
      results.push({ id: command.id, command: command.command, args: command.args, started, status: prerequisite ? 'blocked' : 'failed', message: error.message });
      break;
    }
  }
  return results;
}
export async function verify({ candidate, scope = 'provenance' }) {
  if (!['provenance', 'full'].includes(scope)) throw new Error('Invalid verification scope');
  const { state, metadata: meta } = await validateState(candidate);
  if (state.status !== 'recorded' && state.status !== 'verified') throw new Error('Candidate must be recorded without blockers');
  const { module, profile } = await profileFor(state.plan.root, state.plan.project);
  const current = await candidateChanges(candidate, state.plan);
  assertAllowedPaths(current.changedPaths, profile, { ...state.plan, ...state.approvals });
  assertIdentity(state.recordedFiles, current.files, 'candidate');
  const checks = [];
  const cross = await crossForkChanges(candidate, state.plan.externalBindings, current.changedPaths);
  if (cross.length) checks.push({ id: 'cross-fork', status: 'failed', blockers: cross });
  try {
    if (typeof module.verifyGeneration !== 'function') throw new Error('Trusted profile lacks generation verifier');
    const result = await module.verifyGeneration({ root: candidate, source: state.plan.source, targetCommit: state.plan.targetCommit, readBlob: (commit, name) => readBlob(state.plan.source, commit, name), listTree: commit => listTree(state.plan.source, commit) });
    if (!result || !Array.isArray(result.blockers) || !Array.isArray(result.notes)) throw new Error('INVALID_TRUSTED_PROVENANCE_RESULT');
    checks.push({ id: 'provenance', status: result?.blockers?.length ? 'failed' : 'passed', blockers: result?.blockers ?? [], notes: result?.notes ?? [] });
  } catch (error) { checks.push({ id: 'provenance', status: 'failed', message: error.message }); }
  if (scope === 'full' && checks.every(check => check.status === 'passed')) {
    const commands = [...profile.verification];
    if (!commands.length) throw new Error('FULL_VERIFICATION_PREREQUISITE: trusted profile has no affected verification commands');
    // Commands come exclusively from the invocation's trusted module, never plan JSON.
    for (const command of commands) if (typeof command.command !== 'string' || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')) throw new Error('Invalid trusted verification command');
    try { checks.push(...await runIsolatedVerification(candidate, commands)); }
    catch (error) { checks.push({ id: 'isolation', status: 'blocked', message: error.message }); }
  }
  const after = await candidateChanges(candidate, state.plan);
  if (identity(after.files) !== state.candidateFingerprint) checks.push({ id: 'candidate-stability', status: 'failed', message: 'Verification changed candidate source/configuration' });
  try { await validateState(candidate); }
  catch (error) { checks.push({ id: 'control-stability', status: 'failed', message: error.message }); }
  state.verification = { scope, coverage: scope === 'full' ? 'affected-profile' : 'source-provenance-only', externalCi: 'not-run: all-repository Docker CI and PR HEAD CI require separate isolated trusted-run evidence', limitations: profile.verificationLimitations ?? ['Live Provider accounts, platform GUI/signing and GitHub authorization are not exercised'], status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed', candidateFingerprint: state.candidateFingerprint, planId: state.plan.planId, baseCommit: state.plan.baseCommit, targetCommit: state.plan.targetCommit, toolsHash: identity(state.plan.tools), isolation: scope === 'full' ? 'bubblewrap-no-network-no-host-home-readonly-controls' : 'trusted-data-only', checks, completed: new Date().toISOString() };
  if (checks.some(check => check.status === 'blocked') && !checks.some(check => check.status === 'failed')) state.verification.status = 'blocked';
  state.verification.runtimeHash = identity(state.plan.runtime);
  state.verification.purpose = state.purpose;
  state.status = state.verification.status === 'passed' ? 'verified' : 'recorded';
  await saveState(meta, state);
  return state.verification;
}
function description(state) {
  const plan = state.plan;
  const changes = [...plan.changes, ...(state.authoringChanges ?? [])];
  const compare = `${plan.upstreamUrl.replace(/\.git$/, '').replace(/\/$/, '')}/compare/${plan.upstreamCommit}...${plan.targetCommit}`;
  return `# Update ${plan.project} upstream source

- Upstream: ${plan.upstreamUrl}
- Purpose: ${state.purpose}
- Compare: ${compare}
- Old pin: \`${plan.upstreamCommit}\`
- Target: \`${plan.targetCommit}\`
- Host base: \`${plan.baseCommit}\`
- Plan/policy identity: \`${plan.planId}\` / \`${plan.policyHash}\`
- Candidate source fingerprint: \`${state.candidateFingerprint}\`
- Trusted runtime identity: \`${identity(plan.runtime)}\`
- Verification: **${state.verification?.scope ?? 'not-run'} / ${state.verification?.status ?? 'not-run'}**

## Exact changed files
${state.changedPaths.map(name => `- \`${name}\``).join('\n')}

## Original source, adapters, derived inputs and consumers
${changes.map(change => `- ${change.status}: ${change.sourcePath} → ${change.outputPath ?? '(reference input)'} (${change.kind}); ${change.oldSha256 ?? 'absent'} → ${change.newSha256 ?? 'deleted'}`).join('\n') || '- No selected source changes; pin identity processing only.'}

## Compatibility and patch dispositions
${(state.approvals.reviews ?? []).map(review => `- ${review.outputPath}: ${review.disposition} — ${review.reason}; inputs ${JSON.stringify(review.inputs)}`).join('\n') || '- No additional semantic decision recorded.'}
${(state.notes ?? []).map(note => `- ${typeof note === 'string' ? note : JSON.stringify(note)}`).join('\n')}
- Local-only outputs remain preserved unless individually approved by exact hash.
- Dependency, worker/resource, license, schema and continuation/API changes require the recorded scoped reviews; a successful textual merge is not semantic equivalence.

## Verification evidence
\`\`\`json
${JSON.stringify(state.verification, null, 2)}
\`\`\`

## Blockers and limits
${(state.blockers ?? []).map(item => `- ${JSON.stringify(item)}`).join('\n') || '- No unresolved provenance blockers.'}
- Full verification means the fixed affected-profile command set in a credential-free namespace, not all-repository acceptance.
- All-repository Docker CI and current PR HEAD CI have not run here and need separate trusted-run evidence.
- Live paid Provider accounts, cross-version native continuation, GUI/platform signing and GitHub publication permissions remain unverified.
- License completeness is not a distribution authorization; code rollback is not proof that persisted state can be downgraded.
- No automatic merge, deployment, service restart, or business-task completion.
`;
}
export async function candidateTree(candidate, baseCommit, changedPaths) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'upstream-index-'));
  const objectDirectory = path.join(temporary, 'objects');
  const env = cleanEnvironment({ GIT_INDEX_FILE: path.join(temporary, 'index'), GIT_OBJECT_DIRECTORY: objectDirectory });
  try {
    const originalObjects = (await git(candidate, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).stdout.toString().trim();
    await directory(originalObjects);
    await mkdir(path.join(objectDirectory, 'info'), { recursive: true });
    // Preview writes go only to this disposable object database, never the host
    // or candidate repository. Alternates are strictly read-only immutable data.
    await writeFile(path.join(objectDirectory, 'info/alternates'), originalObjects + '\n', { flag: 'wx', mode: 0o600 });
    await git(candidate, ['read-tree', baseCommit], { env });
    for (const name of changedPaths) {
      relative(name);
      const current = await file(candidate, name, { optional: true });
      if (!current) await git(candidate, ['update-index', '--force-remove', '--', name], { env });
      else {
        const blob = (await git(candidate, ['hash-object', '-w', '--no-filters', '--stdin'], { env, input: current.bytes })).stdout.toString().trim();
        await git(candidate, ['update-index', '-z', '--index-info'], { env, input: `${current.mode === 0o755 ? '100755' : '100644'} ${blob}\t${name}\0` });
      }
    }
    const treeHash = (await git(candidate, ['write-tree'], { env })).stdout.toString().trim();
    const diff = (await git(candidate, ['diff', '--binary', '--no-ext-diff', '--no-textconv', baseCommit, treeHash, '--'], { env })).stdout;
    return { treeHash, diff };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function handoff({ candidate, output }) {
  const { state } = await validateState(candidate);
  if (!state.recordedFiles || !state.verification || state.verification.status !== 'passed') throw new Error('Handoff requires a passed explicitly scoped verification');
  const { profile } = await profileFor(state.plan.root, state.plan.project);
  const current = await candidateChanges(candidate, state.plan);
  assertIdentity(state.recordedFiles, current.files, 'candidate');
  assertAllowedPaths(current.changedPaths, profile, { ...state.plan, ...state.approvals });
  if ((await crossForkChanges(candidate, state.plan.externalBindings, current.changedPaths)).length) throw new Error('BLOCKED_CROSS_FORK');
  if (!current.changedPaths.length) return { output: null, ready: false, status: 'no-change', files: 0 };
  output = await directory(output, { absent: true });
  for (const root of [candidate, state.plan.root, state.plan.source]) if (inside(root, output) || inside(output, root)) throw new Error('Handoff must not overlap repositories');
  await mkdir(output, { mode: 0o700 });
  const files = [];
  for (const name of current.changedPaths) {
    const input = await file(candidate, name, { optional: true });
    const contentPath = input ? `files/${name}` : null;
    if (input) await publish(output, contentPath, input.bytes, input.mode, { exclusive: true });
    const before = current.base.find(entry => entry.path === name);
    files.push({ path: name, status: !input ? 'deleted' : before ? 'modified' : 'added', deleted: !input, sha256: input ? sha256(input.bytes) : null, bytes: input?.bytes.length ?? 0, mode: input?.mode ?? before?.mode ?? 0o644, contentPath });
  }
  const body = description(state);
  await publish(output, 'PR.md', Buffer.from(body), 0o644, { exclusive: true });
  const { treeHash, diff } = await candidateTree(candidate, state.plan.baseCommit, current.changedPaths);
  await publish(output, 'changes.patch', diff, 0o644, { exclusive: true });
  const artifact = { schemaVersion: 1, project: state.plan.project, root: state.plan.root, candidate, baseCommit: state.plan.baseCommit, targetCommit: state.plan.targetCommit, oldCommit: state.plan.upstreamCommit, planId: state.plan.planId, candidateFingerprint: state.candidateFingerprint, toolFingerprints: state.plan.tools, changedPaths: current.changedPaths, files, verification: state.verification, title: `chore(upstream): update ${state.plan.project} to ${state.plan.targetCommit.slice(0, 12)}`, bodySha256: sha256(body), diffSha256: sha256(diff), ready: state.verification.scope === 'full' && state.verification.status === 'passed' };
  artifact.treeHash = treeHash;
  artifact.runtime = state.plan.runtime;
  artifact.purpose = state.purpose;
  artifact.handoffId = identity(artifact);
  await publish(output, 'handoff.json', encode(artifact), 0o644, { exclusive: true });
  return { output, handoffId: artifact.handoffId, ready: artifact.ready, verification: artifact.verification, files: files.length };
}
export async function validateHandoff({ handoff: handoffPath, expectedHead, allowCommitted = false, root: expectedRoot, candidate: expectedCandidate }) {
  handoffPath = path.resolve(handoffPath);
  if (path.basename(handoffPath) === 'handoff.json') handoffPath = path.dirname(handoffPath);
  await directory(handoffPath);
  const artifact = JSON.parse((await file(handoffPath, 'handoff.json')).bytes);
  const { handoffId, ...unsigned } = artifact;
  if (artifact.schemaVersion !== 1 || handoffId !== identity(unsigned)) throw new Error('INVALID_HANDOFF_IDENTITY');
  if (expectedRoot && artifact.root !== path.resolve(expectedRoot) || expectedCandidate && artifact.candidate !== path.resolve(expectedCandidate)) throw new Error('HANDOFF_REPOSITORY_MISMATCH');
  const { state } = await validateState(artifact.candidate, { expectedHead, allowCommitted: allowCommitted || expectedHead != null });
  if (artifact.purpose !== state.purpose || artifact.verification?.purpose !== state.purpose) throw new Error('HANDOFF_PURPOSE_MISMATCH');
  for (const key of ['project', 'root', 'baseCommit', 'targetCommit', 'planId']) if (artifact[key] !== state.plan[key]) throw new Error(`STALE_HANDOFF_${key}`);
  if (artifact.oldCommit !== state.plan.upstreamCommit) throw new Error('STALE_HANDOFF_OLD_COMMIT');
  assertIdentity(artifact.toolFingerprints, state.plan.tools, 'handoff_tools');
  assertIdentity(artifact.runtime, state.plan.runtime, 'handoff_runtime');
  assertIdentity(artifact.verification, state.verification, 'verification');
  if (!artifact.ready || artifact.verification.scope !== 'full' || artifact.verification.status !== 'passed' || artifact.verification.candidateFingerprint !== artifact.candidateFingerprint || artifact.verification.toolsHash !== identity(state.plan.tools) || artifact.verification.runtimeHash !== identity(state.plan.runtime) || artifact.verification.planId !== state.plan.planId || artifact.verification.baseCommit !== state.plan.baseCommit || artifact.verification.targetCommit !== state.plan.targetCommit) throw new Error('FULL_VERIFICATION_REQUIRED');
  const { profile } = await profileFor(state.plan.root, state.plan.project);
  const current = await candidateChanges(artifact.candidate, state.plan);
  assertIdentity(state.recordedFiles, current.files, 'candidate');
  if (identity(current.files) !== artifact.candidateFingerprint) throw new Error('STALE_HANDOFF_CANDIDATE');
  assertIdentity(artifact.changedPaths, current.changedPaths, 'handoff_paths');
  assertAllowedPaths(current.changedPaths, profile, { ...state.plan, ...state.approvals });
  if ((await crossForkChanges(artifact.candidate, state.plan.externalBindings, current.changedPaths)).length) throw new Error('BLOCKED_CROSS_FORK');
  if (!Array.isArray(artifact.files) || artifact.files.length !== current.changedPaths.length) throw new Error('INVALID_HANDOFF_FILES');
  const seen = new Set();
  for (const entry of artifact.files) {
    relative(entry.path);
    if (seen.has(entry.path) || !current.changedPaths.includes(entry.path)) throw new Error('DUPLICATE_OR_UNAPPROVED_HANDOFF_PATH');
    seen.add(entry.path);
    const actual = await file(artifact.candidate, entry.path, { optional: true });
    const previous = current.base.find(item => item.path === entry.path);
    const expectedStatus = !actual ? 'deleted' : previous ? 'modified' : 'added';
    if (entry.status !== expectedStatus || entry.deleted !== !actual || !actual && (entry.bytes !== 0 || entry.mode !== previous.mode)) throw new Error(`HANDOFF_FILE_METADATA_MISMATCH: ${entry.path}`);
    if (entry.deleted) { if (actual || entry.sha256 !== null || entry.contentPath !== null) throw new Error(`HANDOFF_DELETE_MISMATCH: ${entry.path}`); }
    else {
      if (entry.contentPath !== `files/${entry.path}` || !actual || sha256(actual.bytes) !== entry.sha256 || actual.mode !== entry.mode || actual.bytes.length !== entry.bytes) throw new Error(`HANDOFF_CONTENT_MISMATCH: ${entry.path}`);
      const delivered = await file(handoffPath, entry.contentPath);
      if (!delivered.bytes.equals(actual.bytes) || delivered.mode !== entry.mode) throw new Error(`HANDOFF_ARTIFACT_MISMATCH: ${entry.path}`);
    }
  }
  const body = (await file(handoffPath, 'PR.md')).bytes;
  if (sha256(body) !== artifact.bodySha256 || sha256((await file(handoffPath, 'changes.patch')).bytes) !== artifact.diffSha256) throw new Error('HANDOFF_DESCRIPTION_OR_DIFF_MISMATCH');
  if (body.toString('utf8') !== description(state) || artifact.title !== `chore(upstream): update ${state.plan.project} to ${state.plan.targetCommit.slice(0, 12)}`) throw new Error('HANDOFF_REVIEW_DESCRIPTION_MISMATCH');
  const { treeHash: computedTree, diff: computedDiff } = await candidateTree(artifact.candidate, artifact.baseCommit, artifact.changedPaths);
  if (computedTree !== artifact.treeHash) throw new Error('HANDOFF_TREE_MISMATCH');
  if (sha256(computedDiff) !== artifact.diffSha256) throw new Error('HANDOFF_DIFF_MISMATCH');
  if (expectedHead) {
    const changes = (await git(artifact.candidate, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', artifact.baseCommit, expectedHead, '--'])).stdout.toString().split('\0').filter(Boolean).sort();
    assertIdentity(changes, artifact.changedPaths, 'committed_paths');
    const worktreeDirty = await workingTreeChanges(artifact.candidate);
    if (worktreeDirty.some(name => !under(name, metadataName))) throw new Error('COMMITTED_CANDIDATE_DIRTY');
    const committed = new Map((await listTree(artifact.candidate, expectedHead)).map(entry => [entry.path, entry]));
    for (const entry of artifact.files) {
      const actual = committed.get(entry.path);
      if (entry.deleted ? actual != null : !actual || modeOf(actual) !== entry.mode || sha256((await git(artifact.candidate, ['cat-file', 'blob', actual.blob])).stdout) !== entry.sha256) throw new Error('COMMITTED_CONTENT_MISMATCH');
    }
  }
  const treeHash = expectedHead ? (await git(artifact.candidate, ['rev-parse', `${expectedHead}^{tree}`])).stdout.toString().trim() : computedTree;
  if (treeHash !== artifact.treeHash) throw new Error('COMMITTED_TREE_MISMATCH');
  return { ...artifact, artifact, handoff: handoffPath, body: body.toString('utf8'), treeHash, files: artifact.files };
}
