import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../vendor/cc-switch/scripts/provenance.mjs';
import { verifyHostBuildInputs } from '../vendor/t3code/scripts/host-inputs.mjs';
import { assertNoRetiredImportEdges, assertRetiredTargetsAbsent, validateAdaptationManifest } from '../vendor/t3code/scripts/mcp-skills-adaptations.mjs';
import { verifyOutputs as verifyOpenHands, offlineOriginals } from '../vendor/openhands-extensions/scripts/provenance.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));

async function input(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe provenance input path');
  let current = root;
  const pieces = relative.split('/');
  for (const [index, piece] of pieces.entries()) {
    current = path.join(current, piece);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < pieces.length - 1 ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o7000)) throw new Error(`Unsafe provenance input: ${relative}`);
  }
  return { bytes: await readFile(current), mode: (await lstat(current)).mode & 0o777 };
}

async function verifyEntry(entry, relative = entry.destination) {
  if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || ![0o644, 0o755].includes(entry.mode)) throw new Error(`Invalid provenance record: ${relative}`);
  const actual = await input(relative);
  if (sha256(actual.bytes) !== entry.sha256 || actual.bytes.length !== entry.bytes || Boolean(actual.mode & 0o111) !== Boolean(entry.mode & 0o111)) throw new Error(`Pinned source output drift: ${relative}`);
  return actual.bytes;
}

async function verifyT3Code() {
  const manifestInput = await input('vendor/t3code/source-manifest.json');
  const manifest = JSON.parse(manifestInput.bytes);
  const inventory = JSON.parse((await input('vendor/t3code/sync-inventory.json')).bytes);
  if (inventory.version !== 1 || inventory.upstreamCommit !== manifest.upstream?.commit || sha256(manifestInput.bytes) !== inventory.sourceManifestSha256 || !Array.isArray(inventory.files) || !inventory.files.length) throw new Error('T3 Code source manifest/inventory identity mismatch');
  await verifyHostBuildInputs(root, inventory);
  const originals = new Map(manifest.files.map(entry => [entry.source_path, entry]));
  const seen = new Set();
  for (const entry of inventory.files) {
    if (!entry.destination?.startsWith('vendor/t3code/') || seen.has(entry.destination)) throw new Error('Duplicate or out-of-tree T3 Code output');
    seen.add(entry.destination);
    const output = await verifyEntry(entry);
    if (entry.source) {
      const original = originals.get(entry.source);
      if (!original || entry.upstreamSha256 !== original.sha256) throw new Error(`Unmapped T3 Code original: ${entry.destination}`);
      if (entry.patch) {
        const patchInput = await input(entry.patch.path);
        if (sha256(patchInput.bytes) !== entry.patch.sha256) throw new Error(`T3 Code patch drift: ${entry.patch.path}`);
        const patch = JSON.parse(patchInput.bytes);
        if (patch.version !== 1 || patch.source !== entry.source || patch.beforeSha256 !== original.sha256 || patch.afterSha256 !== entry.sha256) throw new Error(`T3 Code patch identity mismatch: ${entry.destination}`);
      } else if (sha256(output) !== original.sha256 || output.length !== original.bytes || createHash('sha1').update(`blob ${output.length}\0`).update(output).digest('hex') !== original.git_blob_sha1) throw new Error(`Pristine T3 Code original changed: ${entry.destination}`);
    }
  }
  const adaptations = JSON.parse((await input('vendor/t3code/mcp-skills-adaptations.json')).bytes);
  if (adaptations.version !== 1 || adaptations.baselineCommit !== inventory.upstreamCommit || !Array.isArray(adaptations.outputs)) throw new Error('T3 Code supplemental source identity mismatch');
  const retirements = validateAdaptationManifest(adaptations);
  await assertRetiredTargetsAbsent(root, retirements);
  assertNoRetiredImportEdges(JSON.parse((await input('vendor/t3code/sync-imports.json')).bytes), retirements);
  const retired = new Set(retirements.map(entry => entry.destination));
  if (inventory.files.some(entry => retired.has(entry.destination))) throw new Error('Retired T3 Code output still has a baseline reconstruction owner');
  const adapted = new Set();
  for (const entry of adaptations.outputs) {
    if (adapted.has(entry.destination)) throw new Error('Duplicate T3 Code supplemental output');
    adapted.add(entry.destination);
    if (Object.hasOwn(entry, 'retirement')) {
      if (entry.recipe.kind === 'local-bytes') {
        const decoded = Buffer.from(entry.recipe.base64, 'base64');
        if (sha256(decoded) !== entry.sha256 || decoded.length !== entry.bytes) throw new Error(`T3 Code retired local recipe drift: ${entry.destination}`);
      }
      continue;
    }
    const bytes = await verifyEntry(entry);
    if (entry.recipe?.kind === 'local-bytes') {
      const decoded = Buffer.from(entry.recipe.base64, 'base64');
      if (decoded.toString('base64') !== entry.recipe.base64 || !decoded.equals(bytes)) throw new Error(`T3 Code embedded local recipe drift: ${entry.destination}`);
    } else if (entry.recipe?.kind !== 'exact-line-splices' || !Array.isArray(entry.inputs) || !entry.inputs.length) throw new Error(`Unmapped T3 Code adaptation recipe: ${entry.destination}`);
  }
  console.log(`[sources] T3 Code: ${seen.size} pinned outputs, ${adapted.size} supplemental outputs, host tools and patch identities`);
}

if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-sources.mjs');
await verifyT3Code();
const openHands = await verifyOpenHands(root);
await offlineOriginals(openHands, root);
execFileSync(process.execPath, ['vendor/t3code/scripts/imports.mjs', '--check'], { cwd: root, stdio: 'inherit' });
console.log(`[sources] OpenHands: ${openHands.inventory.files.length} pinned outputs, archived originals and source/resource closure`);
console.log('[sources] Offline distributed-output verification only; upstream checkout reconstruction and native/Provider behavior remain separate acceptance gates.');
