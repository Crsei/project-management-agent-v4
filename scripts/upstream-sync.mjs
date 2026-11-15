#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, prepare, record, verify, handoff } from './upstream-sync/core.mjs';
import { directory, encode, file, publish } from './upstream-sync/io.mjs';
import { prepareSupplemental, recordSupplemental, supplementalTools, verifySupplemental } from './upstream-sync/supplemental-ui.mjs';

const usage = `Usage:
  node scripts/upstream-sync.mjs inspect --project t3code|cc-switch --source ABS --target REF [--root ROOT] [--output NEW_JSON] [--purpose local-authoring]
  node scripts/upstream-sync.mjs prepare --plan PLAN_JSON --destination NEW_ABS [--purpose upstream-update|local-authoring]
  node scripts/upstream-sync.mjs record --candidate DIR [--approve-source PATH] [--reviewed-derived PATH] [--accept-output PATH=SHA256] [--accept-existing-output PATH=RECORDED_SHA256:SNAPSHOT_SHA256] [--reviews JSON]
  node scripts/upstream-sync.mjs verify --candidate DIR [--scope provenance|full]
  node scripts/upstream-sync.mjs handoff --candidate DIR --output NEW_DIR
  node scripts/upstream-sync.mjs supplemental-prepare --candidate ABS --baseline JSON --baseline-sha256 SHA256 --original-root ABS --source ABS --target FULL_COMMIT --reviews JSON --reviews-sha256 SHA256 --control NEW_ABS
  node scripts/upstream-sync.mjs supplemental-record --candidate ABS --control ABS --control-sha256 SHA256 --accept-source PATH=SHA256 [repeat, including LICENSE] --accept-output PATH=SHA256 [repeat]
  node scripts/upstream-sync.mjs supplemental-verify --candidate ABS --control ABS --control-sha256 SHA256
  node scripts/upstream-sync.mjs supplemental-tools

inspect is read-only except an explicitly requested new report. prepare never changes host source.
record review flags are explicit data approvals, never executable commands. Full verification requires
Bubblewrap isolation and all affected-profile prerequisites; provenance is not full verification.
Explicit inspect --purpose local-authoring creates a T3 same-pin current-worktree snapshot plan.
It preserves inherited dirty/drifting bytes without accepting them. Existing drifting outputs
need both exact recorded:snapshot preimage approval and ordinary postimage approval. Snapshot
candidates are diagnostic authoring only: no full-passed verification or publication handoff.
Supplemental UI enrollment preserves production and prior supplemental pins. It requires exact,
independently reviewed baseline/authority/output/host-input/cross-fork approvals and immutable
original replay assets. Controls live outside the candidate; each later command requires the
previous control receipt hash. Every selected upstream input and host output is explicitly approved.
Reviews JSON: {version:1,baselineSha256,sourceCommit,toolsSha256,runtimeSha256,toolAssets:[],baseline:{authorities:[],crossForkAuthorities:[],
outputs:[],hostInputs:[],crossForkHostInputs:[]},sources:[{path,sha256,reason}],outputs:[{path,sha256,mode,kind,reason,inputs}],
dependencies:[]}. kind is derived (exact commit/path/sha256 inputs) or genuine local (inputs=[]).
Removing an existing mapped input requires outputs[].removedInputs entries with exact commit/path/
sha256, disposition=no-longer-derived and a reason; omission never silently discards provenance.
Authority approvals bind path/headSha256/snapshotSha256/reason; baseline output/host-input approvals
bind path/recordedSha256/snapshotSha256/reason. No duplicate, extra, stale or blanket approvals.
Cross-fork host approvals additionally bind inventory/recordedBytes/snapshotBytes/mode; only existing
hostBuildInputs SHA/byte fields may differ. Foreign outputs, sources, policies and modes stay fixed.
New dependency/resource reviews bind path/kind/specifier/expression/reason exactly.
toolAssets may bind only the existing enrolled mcp-skills-adaptations.mjs maintenance asset:
{path,recordedRecipeSha256,recordedSha256,snapshotSha256,reviewedSha256,mode,reason}.
recordedRecipeSha256 is the canonical identity of its complete original inventory record.
Final bytes come only from the independently reviewed PRIMARY tool; original assets still replay.
Tools/runtime hashes do not approve this asset binding. No host output enters vendor-only inventory.
Record stages exact pre/post metadata and the proposed state outside the candidate, with a single
writer lock. SAME-receipt forward retry is limited to complete identifiable pre/post layouts with
no missing leaf, extra backup/temp, or nlink residue. Stale tool/runtime/source refuse even that.
SIGKILL between move/link or link/unlink may leave preserved inodes outside that limited model:
SUPPLEMENTAL_RECONSTRUCTION_REQUIRED means keep every artifact and build NEW candidate/control
from the independent preimage plus explicitly reviewed feature outputs; do not retry or auto-clean.
The held-parent writer moves the actual old inode aside, authenticates it, then publishes with
no replacement. Unexpected bytes are exclusively restored or retained at a named backup; no
unknown destination is unlinked. A retained conflict requires explicit review/fresh reconstruction.
The preserved historical index is authenticated by baselineSha256, not rebound to today's HOST
index. This is not a Git publication candidate. Full/build/browser checks remain independent.
Supplemental verify is offline source replay ONLY, never full/handoff or diagnostic promotion.
supplemental-tools prints data fingerprints only, not approval. Independently review the exact
tool files AND Node/TypeScript runtime before binding toolsSha256/runtimeSha256 in reviews JSON.
It never integrates or deploys. A destination differing from any reported integration preimage
requires a fresh preserved baseline, exact three-way feature review and new independent approvals;
never overwrite newer host authorities with an older candidate's generated metadata.
No command commits, pushes, creates a PR, loads credentials or starts production services.`;
export function parseArguments(argv) {
  const [command, ...values] = argv;
  const schemas = {
    inspect: ['project', 'source', 'target', 'root', 'output', 'purpose'], prepare: ['plan', 'destination', 'purpose'],
    record: ['candidate', 'approve-source', 'reviewed-derived', 'accept-output', 'accept-existing-output', 'reviews'],
    verify: ['candidate', 'scope'], handoff: ['candidate', 'output'],
    'supplemental-prepare': ['candidate', 'baseline', 'baseline-sha256', 'original-root', 'source', 'target', 'reviews', 'reviews-sha256', 'control'],
    'supplemental-record': ['candidate', 'control', 'control-sha256', 'accept-source', 'accept-output'],
    'supplemental-verify': ['candidate', 'control', 'control-sha256'],
    'supplemental-tools': [],
  };
  if (!schemas[command]) throw new Error(usage);
  const repeated = new Set(['approve-source', 'reviewed-derived', 'accept-output', 'accept-existing-output', 'accept-source']);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.slice(2), value = values[index + 1];
    if (!values[index]?.startsWith('--') || !schemas[command].includes(key) || !value || value.startsWith('--')) throw new Error(`Invalid arguments\n${usage}`);
    if (repeated.has(key)) (options[key] ??= []).push(value);
    else { if (key in options) throw new Error(`Duplicate --${key}`); options[key] = value; }
  }
  const required = {
    inspect: ['project', 'source', 'target'], prepare: ['plan', 'destination'], record: ['candidate'], verify: ['candidate'], handoff: ['candidate', 'output'],
    'supplemental-prepare': ['candidate', 'baseline', 'baseline-sha256', 'original-root', 'source', 'target', 'reviews', 'reviews-sha256', 'control'],
    'supplemental-record': ['candidate', 'control', 'control-sha256', 'accept-source', 'accept-output'],
    'supplemental-verify': ['candidate', 'control', 'control-sha256'],
    'supplemental-tools': [],
  };
  for (const key of required[command]) if (!options[key]) throw new Error(`Missing --${key}\n${usage}`);
  for (const key of ['source', 'destination', ...(command.startsWith('supplemental-') ? ['candidate', 'control', 'original-root', 'baseline', 'reviews'] : [])]) if (options[key] && !path.isAbsolute(options[key])) throw new Error(`--${key} must be absolute`);
  return { command, options };
}
function hashApprovals(values, flag) {
  const approvals = {};
  for (const value of values ?? []) {
    const separator = value.lastIndexOf('=');
    if (separator < 1 || !/^[a-f0-9]{64}$/.test(value.slice(separator + 1))) throw new Error(`--${flag} requires PATH=SHA256`);
    const name = value.slice(0, separator);
    if (Object.hasOwn(approvals, name)) throw new Error(`Duplicate --${flag}: ${name}`);
    approvals[name] = value.slice(separator + 1);
  }
  return approvals;
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(usage); return; }
  const { command, options } = parseArguments(argv);
  let result;
  if (command === 'supplemental-tools') {
    result = await supplementalTools();
  } else if (command === 'supplemental-prepare') {
    result = await prepareSupplemental({ candidate: options.candidate, baseline: options.baseline, baselineSha256: options['baseline-sha256'], originalRoot: options['original-root'], source: options.source, target: options.target, reviews: options.reviews, reviewsSha256: options['reviews-sha256'], control: options.control });
  } else if (command === 'supplemental-record') {
    result = await recordSupplemental({ candidate: options.candidate, control: options.control, controlSha256: options['control-sha256'], approvedSourceHashes: hashApprovals(options['accept-source'], 'accept-source'), approvedOutputHashes: hashApprovals(options['accept-output'], 'accept-output') });
  } else if (command === 'supplemental-verify') {
    result = await verifySupplemental({ candidate: options.candidate, control: options.control, controlSha256: options['control-sha256'] });
  } else if (command === 'inspect') {
    result = await inspect(options);
    if (options.output) {
      const output = path.resolve(options.output);
      await directory(path.dirname(output));
      await publish(path.dirname(output), path.basename(output), encode(result), 0o644, { exclusive: true });
    }
  } else if (command === 'prepare') result = await prepare(options);
  else if (command === 'record') {
    const approvedOutputHashes = {};
    for (const value of options['accept-output'] ?? []) {
      const separator = value.lastIndexOf('=');
      if (separator < 1 || !/^[a-f0-9]{64}$/.test(value.slice(separator + 1))) throw new Error('--accept-output requires PATH=SHA256');
      const name = value.slice(0, separator);
      if (name in approvedOutputHashes) throw new Error(`Duplicate output approval: ${name}`);
      approvedOutputHashes[name] = value.slice(separator + 1);
    }
    const approvedExistingOutputs = {};
    for (const value of options['accept-existing-output'] ?? []) {
      const separator = value.lastIndexOf('=');
      const name = value.slice(0, separator), hashes = value.slice(separator + 1).split(':');
      if (separator < 1 || hashes.length !== 2 || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('--accept-existing-output requires PATH=RECORDED_SHA256:SNAPSHOT_SHA256');
      if (name in approvedExistingOutputs) throw new Error(`Duplicate existing output approval: ${name}`);
      approvedExistingOutputs[name] = { recordedSha256: hashes[0], snapshotSha256: hashes[1] };
    }
    let reviews = [];
    if (options.reviews) {
      const name = path.resolve(options.reviews);
      reviews = JSON.parse((await file(await directory(path.dirname(name)), path.basename(name))).bytes);
      if (!Array.isArray(reviews)) throw new Error('--reviews must contain a JSON array of structured review decisions');
    }
    result = await record({ candidate: path.resolve(options.candidate), approvedSourcePaths: options['approve-source'] ?? [], reviewedDerivedOutputs: options['reviewed-derived'] ?? [], approvedOutputHashes, approvedExistingOutputs, reviews });
  } else if (command === 'verify') result = await verify({ candidate: path.resolve(options.candidate), scope: options.scope });
  else result = await handoff({ candidate: path.resolve(options.candidate), output: path.resolve(options.output) });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'blocked' || result.status === 'failed' || result.blockers?.length) process.exitCode = 2;
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  if (['SUPPLEMENTAL_RECONSTRUCTION_REQUIRED', 'SUPPLEMENTAL_TRANSACTION_PENDING'].includes(error.code)) {
    console.error(JSON.stringify({ status: 'blocked', code: error.code, message: error.message, details: error.details }, null, 2));
    process.exitCode = 2;
  } else {
    console.error(`upstream-sync: ${error.message}`);
    process.exitCode = 1;
  }
});
