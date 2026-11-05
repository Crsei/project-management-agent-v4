#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, prepare, record, verify, handoff } from './upstream-sync/core.mjs';
import { directory, encode, file, publish } from './upstream-sync/io.mjs';

const usage = `Usage:
  node scripts/upstream-sync.mjs inspect --project t3code|cc-switch --source ABS --target REF [--root ROOT] [--output NEW_JSON]
  node scripts/upstream-sync.mjs prepare --plan PLAN_JSON --destination NEW_ABS [--purpose upstream-update|local-authoring]
  node scripts/upstream-sync.mjs record --candidate DIR [--approve-source PATH] [--reviewed-derived PATH] [--accept-output PATH=SHA256] [--reviews JSON]
  node scripts/upstream-sync.mjs verify --candidate DIR [--scope provenance|full]
  node scripts/upstream-sync.mjs handoff --candidate DIR --output NEW_DIR

inspect is read-only except an explicitly requested new report. prepare never changes host source.
record review flags are explicit data approvals, never executable commands. Full verification requires
Bubblewrap isolation and all affected-profile prerequisites; provenance is not full verification.
No command commits, pushes, creates a PR, loads credentials or starts production services.`;
export function parseArguments(argv) {
  const [command, ...values] = argv;
  const schemas = { inspect: ['project', 'source', 'target', 'root', 'output'], prepare: ['plan', 'destination', 'purpose'], record: ['candidate', 'approve-source', 'reviewed-derived', 'accept-output', 'reviews'], verify: ['candidate', 'scope'], handoff: ['candidate', 'output'] };
  if (!schemas[command]) throw new Error(usage);
  const repeated = new Set(['approve-source', 'reviewed-derived', 'accept-output']);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.slice(2), value = values[index + 1];
    if (!values[index]?.startsWith('--') || !schemas[command].includes(key) || !value || value.startsWith('--')) throw new Error(`Invalid arguments\n${usage}`);
    if (repeated.has(key)) (options[key] ??= []).push(value);
    else { if (key in options) throw new Error(`Duplicate --${key}`); options[key] = value; }
  }
  const required = { inspect: ['project', 'source', 'target'], prepare: ['plan', 'destination'], record: ['candidate'], verify: ['candidate'], handoff: ['candidate', 'output'] };
  for (const key of required[command]) if (!options[key]) throw new Error(`Missing --${key}\n${usage}`);
  for (const key of ['source', 'destination']) if (options[key] && !path.isAbsolute(options[key])) throw new Error(`--${key} must be absolute`);
  return { command, options };
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(usage); return; }
  const { command, options } = parseArguments(argv);
  let result;
  if (command === 'inspect') {
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
    let reviews = [];
    if (options.reviews) {
      const name = path.resolve(options.reviews);
      reviews = JSON.parse((await file(await directory(path.dirname(name)), path.basename(name))).bytes);
      if (!Array.isArray(reviews)) throw new Error('--reviews must contain a JSON array of structured review decisions');
    }
    result = await record({ candidate: path.resolve(options.candidate), approvedSourcePaths: options['approve-source'] ?? [], reviewedDerivedOutputs: options['reviewed-derived'] ?? [], approvedOutputHashes, reviews });
  } else if (command === 'verify') result = await verify({ candidate: path.resolve(options.candidate), scope: options.scope });
  else result = await handoff({ candidate: path.resolve(options.candidate), output: path.resolve(options.output) });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'blocked' || result.status === 'failed' || result.blockers?.length) process.exitCode = 2;
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`upstream-sync: ${error.message}`); process.exitCode = 1; });
