import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { safeEvidenceBytes } from '../benchmarks/dovspace/evaluation/archive.ts';
import { evaluationDigest } from '../benchmarks/dovspace/evaluation/review.ts';
import { PolicyApprovalRegistrySchema } from '../benchmarks/dovspace/evaluation/release.ts';
import { readReleaseMaterial, resolveMaterialPath, validateReleaseMaterial } from '../benchmarks/dovspace/evaluation/release-material.ts';
import { validateSource } from '../apps/desktop/scripts/release-materials.mjs';
import { projectProductSourceInventory } from '../benchmarks/dovspace/isolation/source.ts';

export const APPROVAL_REGISTRY_PATH = 'benchmarks/dovspace/evaluation/release-policy-registry.json';
const metadataDirectories = new Set(['events', 'fences', 'online-fences']);

async function sourceJson(client, sourcePath, commit) {
  const response = await client.get(`contents/${sourcePath}?ref=${commit}`);
  if (response.type !== 'file' || response.encoding !== 'base64' || response.size > 4 * 1024 * 1024 || typeof response.content !== 'string') throw new Error('Live evaluation approval authority is missing or oversized');
  const bytes = Buffer.from(response.content, 'base64');
  if (bytes.length !== response.size) throw new Error('Live evaluation approval authority byte size mismatch');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Malformed live evaluation approval authority (content withheld)'); }
}

/** Compare only approved metadata. Private feedback content is never read, uploaded, or required in source control. */
export async function verifyLiveRegistryMetadata(client, registryRoot, sourcePath, commit) {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(sourcePath) || sourcePath.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe authoritative dataset registry source path');
  let tree = await client.get(`git/trees/${commit}`);
  for (const segment of sourcePath.split('/')) {
    if (tree.truncated) throw new Error('Truncated authority tree cannot prove live registry fences');
    const entry = tree.tree?.find(item => item.path === segment && item.type === 'tree' && item.mode === '040000');
    if (!entry) throw new Error('Live authoritative dataset registry metadata path is missing');
    tree = await client.get(`git/trees/${entry.sha}`);
  }
  const expected = new Map();
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete authority tree');
  for (const entry of tree.tree) {
    if (!metadataDirectories.has(entry.path)) continue;
    if (entry.type !== 'tree' || entry.mode !== '040000') throw new Error('Registry metadata must use regular source-controlled directories');
    const children = await client.get(`git/trees/${entry.sha}`);
    if (children.truncated || !Array.isArray(children.tree)) throw new Error('Incomplete authority metadata tree');
    for (const child of children.tree) {
      if (child.type !== 'blob' || child.mode !== '100644' || !/^[A-Za-z0-9._-]+\.json$/.test(child.path)) throw new Error('Authority registry metadata contains non-JSON, nested or executable entries');
      expected.set(`${entry.path}/${child.path}`, child.sha);
    }
  }
  if (![...expected.keys()].some(name => name.startsWith('events/'))) throw new Error('Empty authority registry cannot authorize a dataset');
  if (await realpath(registryRoot) !== path.resolve(registryRoot)) throw new Error('Redirected local registry authority');
  const actual = new Map();
  for (const directory of metadataDirectories) {
    const location = path.join(registryRoot, directory);
    const info = await lstat(location).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Redirected local registry metadata directory');
    for (const entry of await readdir(location, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[A-Za-z0-9._-]+\.json$/.test(entry.name)) throw new Error('Unsafe local registry metadata entry');
      const bytes = await safeEvidenceBytes(path.join(location, entry.name));
      actual.set(`${directory}/${entry.name}`, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
    }
  }
  if (actual.size !== expected.size || [...expected].some(([name, digest]) => actual.get(name) !== digest)) throw new Error('Bundled registry is stale or differs from live authoritative deletion/revocation metadata');
}

/** Distribution and benchmark identities have different representations; compare the verified server-closure projection. */
export function projectDesktopProductSource(source, expected) {
  validateSource(source);
  if (source.commit !== expected.commit || source.sha256 !== expected.sha256 || source.dirty !== false || expected.dirty !== false) throw new Error('Actual desktop source inventory differs from native source identity');
  return projectProductSourceInventory(source.files);
}

export async function readDesktopProductSource({ client, request, manifest, directory, remoteAssets }) {
  if (!Array.isArray(manifest?.sources) || manifest.sources.length !== request.targets.length
    || JSON.stringify(manifest.sources.map(source => source.target).sort()) !== JSON.stringify(request.targets.slice().sort())) throw new Error('Actual native target source inventory coverage is missing');
  if (manifest.sources.some(source => source.sha256 !== manifest.sources[0].sha256)) throw new Error('Native targets were not built from identical complete public source inventories');
  let productSha256 = null;
  for (const source of manifest.sources) {
    if (source.commit !== request.sha || source.inventory !== 'desktop-source.json') throw new Error('Native source inventory has no exact commit/representation identity');
    const expected = manifest.assets.find(asset => asset.target === source.target && asset.original === source.inventory);
    if (!expected || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(expected.name)) throw new Error('Actual desktop source inventory asset is missing');
    let bytes;
    if (directory) bytes = await safeEvidenceBytes(path.join(directory, expected.name));
    else {
      const actual = remoteAssets?.find(asset => asset.name === expected.name);
      if (!actual || actual.size !== expected.bytes) throw new Error('Exact remote desktop source inventory is unavailable');
      bytes = await client.readAsset(actual, { maximumBytes: 32 * 1024 * 1024 });
    }
    if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Actual desktop source inventory bytes differ from the staged/remote release asset');
    let inventory;
    try { inventory = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Malformed desktop source inventory (input withheld)'); }
    const projected = projectDesktopProductSource(inventory, source);
    if (productSha256 !== null && productSha256 !== projected.sourceHash) throw new Error('Native targets were built from different benchmark server closures');
    productSha256 = projected.sourceHash;
  }
  return productSha256;
}

/** Required even for a draft: no missing policy/evidence fallback and no publication authority added. */
export async function validateDesktopEvaluation({ client, request, manifest, directory, remoteAssets, env = process.env, now }) {
  if (!env.DESKTOP_EVALUATION_MATERIAL || !/^[a-f0-9]{64}$/.test(env.DESKTOP_EVALUATION_SHA256 ?? '')) throw new Error('Draft/publish requires exact evaluation material and independently supplied SHA256; build-only remains available');
  const loaded = await readReleaseMaterial(env.DESKTOP_EVALUATION_MATERIAL, env.DESKTOP_EVALUATION_SHA256);
  const repository = await client.get('');
  const head = await client.get(`git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
  if (head.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(head.object.sha)) throw new Error('Live evaluation approval authority has no exact commit identity');
  const approvals = PolicyApprovalRegistrySchema.parse(await sourceJson(client, APPROVAL_REGISTRY_PATH, head.object.sha));
  const policySha256 = evaluationDigest(loaded.material.decisionRequest.policy);
  const approval = approvals.policies.find(entry => entry.policySha256 === policySha256
    && entry.experimentSha256 === evaluationDigest(loaded.material.reviewRequest.experiment));
  if (!approval || approval.datasetRegistrySourcePath !== loaded.material.registrySourcePath) throw new Error('No live source-approved policy/experiment/dataset authority registration');
  const registered = PolicyApprovalRegistrySchema.parse(await sourceJson(client, APPROVAL_REGISTRY_PATH, approval.preregistrationCommit));
  const registrationCommit = await client.get(`commits/${approval.preregistrationCommit}`);
  const registeredTime = Date.parse(registrationCommit.commit?.committer?.date ?? '');
  const registration = registered.preregistrations.find(entry => entry.policySha256 === policySha256 && entry.experimentSha256 === approval.experimentSha256
    && approval.reviewerIds.includes(entry.approvedBy) && entry.ledgerId === approval.ledgerId
    && evaluationDigest(entry.captureKey) === evaluationDigest(approval.captureKey));
  if (!registration || !Number.isFinite(registeredTime)) throw new Error('Capture key/ledger and threshold policy lack an independently recorded source preregistration');
  const registryRoot = resolveMaterialPath(loaded.root, loaded.material.registryDirectory);
  await verifyLiveRegistryMetadata(client, registryRoot, approval.datasetRegistrySourcePath, head.object.sha);
  const productSha256 = await readDesktopProductSource({ client, request, manifest, directory, remoteAssets });
  const artifactSetSha256 = evaluationDigest(manifest.assets.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en')));
  const checked = await validateReleaseMaterial({ ...loaded, registryRoot, approvals, expectedCandidateSourceSha: request.sha,
    expectedProductSha256: productSha256, expectedArtifactSetSha256: artifactSetSha256, now });
  if (!checked.review.attempts.length || checked.review.attempts.some(attempt => !attempt.admittedAt
    || Date.parse(attempt.admittedAt) < registeredTime || Date.parse(attempt.admittedAt) < Date.parse(registration.approvedAt))) throw new Error('Source capture-key/ledger registration must precede every signed admission, including failed or pending attempts');
  if (checked.decision.status === 'blocked') throw new Error(`Evaluation release gate blocked: ${checked.decision.gates.filter(gate => ['failed', 'unknown'].includes(gate.status)).map(gate => gate.gateId).join(', ')}`);
  // Detect authority movement during a potentially long archive check, without accepting a stale snapshot.
  const after = await client.get(`git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
  if (after.object?.sha !== head.object.sha) throw new Error('Evaluation authority changed during gate validation; re-read current fences before any mutation');
  if (Date.parse(checked.decision.expiresAt) <= (now?.getTime() ?? Date.now())) throw new Error('Evaluation decision or approved exception expired while checking evidence; no mutation is authorized');
  return checked.decision;
}
