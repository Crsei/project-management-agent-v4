import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createCiCommandRunner, createCiRecorder } from './check-ci-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);
const stageOrder = ['static', 'build', 'host', 'backend', 'agent'];
const usage = `Usage: node scripts/check-affected.mjs [--dry-run] [--file <repository-relative-path>]...
Without --file, inspect staged, unstaged and untracked Git changes (including both rename paths).
Repeated --file replaces Git discovery; include old and new paths for explicit renames.
This developer feedback is not full-CI evidence, and does not compare committed branch changes.`;

export function parseAffectedArgs(args) {
  let dryRun = false, help = false;
  const files = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--help') help = true;
    else if (argument === '--file' && index + 1 < args.length) files.push(repositoryPath(args[++index]));
    else throw new Error(usage);
  }
  return { dryRun, help, files };
}

function repositoryPath(value) {
  // No filesystem reads: deleted files remain valid inputs. Do not trim or
  // shell-split names; spaces, newlines and shell metacharacters are literal.
  if (typeof value !== 'string' || !value || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Changed paths must be nonempty repository-relative paths without dot segments');
  }
  return value;
}

/** Parse porcelain v2 NUL records, never human/quoted Git output. */
export function parseGitChanges(output) {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Incomplete Git status output');
  const records = output.slice(0, -1).split('\0');
  const changes = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('? ')) {
      changes.push({ path: repositoryPath(record.slice(2)), status: 'untracked' });
      continue;
    }
    const kind = record[0];
    // type 1: XY sub mH mI mW hH hI path; type 2 additionally has Xscore.
    // Unmerged records have four modes and three object IDs after sub.
    const fields = kind === '1' ? 6 : kind === '2' ? 7 : kind === 'u' ? 8 : 0;
    const match = fields && new RegExp(`^${kind} ([^ ]+) ((?:[^ ]+ ){${fields}})(.+)$`, 's').exec(record);
    if (!match || !/^[.MADRCUT]{2}$/.test(match[1])) throw new Error('Unsupported Git status record; refusing an incomplete affected scope');
    const submodule = match[2].split(' ', 1)[0] !== 'N...';
    const status = kind === 'u' ? 'unmerged' : match[1];
    changes.push({ path: repositoryPath(match[3]), status, ...(submodule ? { submodule: true } : {}) });
    if (kind === '2') {
      const previous = records[++index];
      if (previous === undefined) throw new Error('Missing Git rename source path');
      changes.push({ path: repositoryPath(previous), status: 'rename-source', ...(submodule ? { submodule: true } : {}) });
    }
  }
  return changes;
}

export async function collectGitChanges(cwd = root) {
  // Disable optional index writes and configured fsmonitor/hooks. Git receives
  // no ambient Git overrides, private HOME, credentials or Node injection.
  const { stdout } = await execFileAsync('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null',
    '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none', '--renames',
  ], {
    cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    },
  });
  return parseGitChanges(stdout);
}

function classify(change) {
  const file = repositoryPath(change.path);
  if (change.submodule || change.status === 'unmerged') return ['all', 'submodule or unresolved merge affects an unknown dependency closure'];
  // Manifests/configuration, shared packages, scripts, source inventories and
  // unknown paths deliberately have no reduced profile. Workspace imports are
  // not only package.json edges: Vite aliases consume PM sources, Agent bundles
  // PM CLI and desktop maintenance, and provenance reads vendor inventories.
  if (/(?:^|\/)(?:package\.json|[^/]*lock[^/]*\.(?:json|ya?ml)|tsconfig[^/]*\.json|[^/]*config\.[^/]+|\.env(?:\.[^/]*)?)$/.test(file)) return ['all', 'configuration, lockfile or environment input may affect every area'];
  if (/^(?:packages|vendor|scripts|patches|\.github)\//.test(file) || file.startsWith('docs/contracts/') || file.startsWith('docs/agent-source/')) return ['all', 'shared dependency, contract, tooling or provenance input'];
  if (/^docs\/(?!implementation\/).+\.md$/.test(file) || ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].includes(file)) return ['docs', 'public Markdown is checked against the complete documentation/link graph'];
  if (/^apps\/web\/(?:src|public)\//.test(file) || file === 'apps/web/index.html') return ['web', 'Web-local source or asset; backend tests also consume Web models, so retain static/build/backend/agent'];
  if (/^apps\/marketing\/(?:src|public)\//.test(file)) return ['marketing', 'marketing-local source or asset; retain complete static/build checks'];
  return ['all', 'unmapped or cross-runtime input; use the complete existing CI stage sequence'];
}

export function selectAffectedChecks(changes) {
  const reasons = changes.map(change => {
    const [area, reason] = classify(change);
    return { path: change.path, status: change.status ?? 'explicit', area, reason };
  });
  const areas = new Set(reasons.map(reason => reason.area));
  const scope = !areas.size ? 'none' : areas.has('all') ? 'all' : areas.has('web') ? areas.has('marketing') ? 'web+marketing' : 'web' : areas.has('marketing') ? 'marketing' : 'docs';
  const stages = scope === 'all' ? [...stageOrder] : scope === 'web' || scope === 'web+marketing' ? ['static', 'build', 'backend', 'agent'] : scope === 'marketing' ? ['static', 'build'] : [];
  return { scope, stages, reasons };
}

function commandsForPlan(plan) {
  if (plan.scope === 'docs') return [{ label: 'Affected public documentation', args: ['scripts/check-docs.mjs'] }];
  return plan.stages.map(stage => {
    if (!stageOrder.includes(stage)) throw new Error('Unknown affected CI stage');
    return { label: `Affected ${stage} stage`, args: ['scripts/check-ci.mjs', '--stage', stage] };
  });
}

export function describeAffectedChecks(plan, source) {
  const lines = [
    `[affected] Developer-only feedback; NOT full-CI or release acceptance. Input: ${source}.`,
    `[affected] Selected scope: ${plan.scope}; stages: ${plan.stages.join(' -> ') || (plan.scope === 'docs' ? 'documentation only' : 'none')}.`,
  ];
  for (const { path: file, status, area, reason } of plan.reasons) lines.push(`[affected] ${JSON.stringify(file)} (${status}) -> ${area}: ${reason}`);
  for (const command of commandsForPlan(plan)) lines.push(`[affected] Command: node ${command.args.join(' ')}`);
  if (plan.stages.includes('backend') || plan.stages.includes('agent')) lines.push('[affected] Build always runs first in this invocation; no prior dist is accepted as a regression prerequisite. Backend uses only check-ci owned disposable fixtures and the existing supervisor/lock.');
  if (plan.scope === 'all') lines.push('[affected] Conservative fallback selects all existing stages; run check:ci separately for full-CI evidence.');
  if (plan.scope === 'none') lines.push('[affected] No working-tree changes found; no checks ran. Committed branch changes are not compared.');
  return lines.join('\n');
}

/** Fixed commands only; check-ci remains the sole owner of its nested cleanup. */
export async function executeAffectedChecks(plan, { cwd = root } = {}) {
  const commands = commandsForPlan(plan);
  if (!commands.length) return;
  if (process.platform !== 'linux') throw new Error('Affected execution uses the Linux CI supervisor; --dry-run is available on other platforms');
  const temporary = await mkdtemp(path.join(tmpdir(), 'dovspace-affected-'));
  let recorder, runner, activeCi, interrupted, failure;
  const stop = signal => {
    if (interrupted) return;
    interrupted = signal;
    if (activeCi) activeCi.stop(signal);
    else runner?.stop(signal);
  };
  const sigint = () => stop('SIGINT'), sigterm = () => stop('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    recorder = createCiRecorder(cwd);
    const env = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: path.join(temporary, 'home'), TMPDIR: path.join(temporary, 'tmp'),
      XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
      CI: 'true', DOVSPACE_ISOLATED_CHECKS: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', AWS_EC2_METADATA_DISABLED: 'true',
    };
    for (const name of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) await mkdir(env[name], { mode: 0o700 });
    runner = createCiCommandRunner({ cwd, recorder, interrupted: () => interrupted });
    const runCi = async command => {
      if (interrupted) throw new Error(`Affected checks interrupted by ${interrupted}`);
      const finish = recorder.begin('command', command.label);
      let result = { code: null, signal: null }, spawnFailed = false, forwardingFailed = false, commandFailed = false;
      try {
        // The child already owns process-group supervision, escalation and
        // Docker cleanup. Never race that cleanup with an outer kill timer.
        const childEnv = command.args.at(-1) === 'agent' && process.env.PM_OPENHANDS_AUTHORING_SOURCE !== undefined
          ? { ...env, PM_OPENHANDS_AUTHORING_SOURCE: process.env.PM_OPENHANDS_AUTHORING_SOURCE } : env;
        const child = spawn(process.execPath, command.args, { cwd, env: childEnv, detached: true, stdio: 'inherit' });
        let forwarded = false;
        activeCi = {
          stop(signal) {
            if (forwarded) return;
            forwarded = true;
            try { if (!child.kill(signal)) forwardingFailed = true; }
            catch { forwardingFailed = true; }
          },
        };
        result = await new Promise(resolve => {
          child.once('error', () => { spawnFailed = true; });
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        if (spawnFailed) throw new Error(`${command.label} could not start`);
        if (forwardingFailed) throw new Error(`${command.label} cancellation could not be forwarded`);
        if (result.code !== 0 || result.signal) throw new Error(`${command.label} failed (${result.signal ?? result.code})`);
        if (interrupted) throw new Error(`Affected checks interrupted by ${interrupted}`);
      } catch (error) {
        commandFailed = true;
        throw error;
      } finally {
        activeCi = undefined;
        finish({ status: commandFailed ? interrupted ? 'interrupted' : 'failed' : 'passed', code: result.code, signal: result.signal ?? interrupted ?? null });
      }
    };
    await recorder.measure('run', 'Developer affected checks (not full CI)', async () => {
      for (const command of commands) {
        if (interrupted) throw new Error(`Affected checks interrupted by ${interrupted}`);
        if (command.args[0] === 'scripts/check-ci.mjs') await runCi(command);
        else await runner.run(command.label, process.execPath, command.args, env);
      }
    }, () => interrupted);
  } catch (error) { failure = error; }
  try { await rm(temporary, { recursive: true, force: true }); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Affected checks and owned temporary cleanup failed') : error; }
  try { recorder?.close(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Affected checks and timing close failed') : error; }
  process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  if (failure) throw failure;
  if (interrupted) throw new Error(`Affected checks interrupted by ${interrupted}`);
}

export async function runAffectedCli(args, { cwd = root, log = message => console.log(message), error = message => console.error(message) } = {}) {
  try {
    const options = parseAffectedArgs(args);
    if (options.help) { log(usage); return 0; }
    const changes = options.files.length ? options.files.map(file => ({ path: file, status: 'explicit' })) : await collectGitChanges(cwd);
    const plan = selectAffectedChecks(changes);
    log(describeAffectedChecks(plan, options.files.length ? 'explicit file list (Git discovery replaced)' : 'Git staged + unstaged + untracked'));
    if (options.dryRun) log('[affected] Dry run: no checks executed and no build outputs reused.');
    else {
      await executeAffectedChecks(plan, { cwd });
      if (plan.scope !== 'none') log('[affected] Selected developer scope completed only; full CI and native/Provider/deployment acceptance remain separate.');
    }
    return 0;
  } catch (failure) {
    error(`[affected] ${failure.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runAffectedCli(process.argv.slice(2));
