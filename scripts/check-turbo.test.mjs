import assert from 'node:assert/strict';
import { access, chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { createCiCommandRunner, createCiRecorder } from './check-ci-process.mjs';
import { createCheckEnvironment, createTurboDispatcher, parseTurboArguments, runCheckTurbo } from './check-turbo.mjs';

const secretEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: '/private-provider-home', TMPDIR: '/private-data-tmp',
  NODE_OPTIONS: '--import=/private-node-injection.mjs',
  PM_SESSION_TOKEN: 'private-pm-token', AWS_SECRET_ACCESS_KEY: 'private-cloud-key',
  TURBO_TOKEN: 'private-turbo-token', TURBO_API: 'https://private-cache.invalid',
  TURBO_CACHE: 'remote:rw', TURBO_ENV_MODE: 'loose', DOVSPACE_CHECK_TOOLCHAIN: 'private-forged-toolchain',
  AGENT_BUILD_OUTDIR: '/private-build-redirect', PUBLIC_APP_URL: 'https://private-override.invalid', PM_ENABLE_LAB: '1',
};
const workspaceDirectories = {
  '@pm/web': 'apps/web',
  '@agent-workspace/contracts': 'packages/agent-contracts',
  '@agent-workspace/client-runtime': 'packages/agent-client-runtime',
  '@agent-workspace/server': 'apps/server/agent',
  '@agent-workspace/marketing': 'apps/marketing',
  '@agent-workspace/cc-switch-host': 'apps/server/cc-switch-host',
};
const lintTasks = ['//#lint', '//#lint:gateway', '//#lint:agent', '@pm/web#lint', '//#lint:ci', '//#lint:upstream'];
const buildTasks = [
  '@agent-workspace/contracts#build', '@agent-workspace/client-runtime#build', '@agent-workspace/client-runtime#typecheck',
  '//#typecheck', '//#build', '@agent-workspace/server#build', '@pm/web#build',
  '@agent-workspace/marketing#typecheck', '@agent-workspace/marketing#build',
];
const generatedDirectories = new Map([
  ['@agent-workspace/contracts#build', ['packages/agent-contracts/dist']],
  ['@agent-workspace/client-runtime#build', ['packages/agent-client-runtime/dist']],
  ['//#build', ['dist']],
  ['@agent-workspace/server#build', ['apps/server/agent/dist']],
  ['@pm/web#build', ['apps/web/dist']],
  ['@agent-workspace/marketing#build', ['apps/marketing/.astro', 'apps/marketing/dist']],
  ['@agent-workspace/cc-switch-host#build', ['apps/server/cc-switch-host/dist']],
]);

async function linkedCheckout(t, root) {
  const commonRoot = await mkdtemp('/var/tmp/dovspace-check-turbo-common-');
  t.after(() => rm(commonRoot, { recursive: true, force: true }));
  const git = promisify(execFile);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: commonRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  await git('git', ['init', '--quiet', commonRoot], { env });
  await git('git', ['-C', commonRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { env });
  await git('git', ['-C', commonRoot, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', root, 'HEAD'], { env });
  return path.join(commonRoot, '.git');
}

async function fixture(t, { pnpmVersion = '11.9.0', turboVersion = '2.11.10', turboExit = 0, pnpmExit = 0, installTurbo = true, interrupt, gitLayout = 'normal' } = {}) {
  const root = await mkdtemp('/var/tmp/dovspace-check-turbo-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const commonGit = gitLayout === 'linked' ? await linkedCheckout(t, root) : path.join(root, '.git');
  const nativePackage = `@turbo/linux-${process.arch === 'x64' ? '64' : process.arch}`;
  const nativeRoot = path.join(root, 'node_modules/turbo/node_modules', nativePackage);
  await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
  const workspaces = [];
  for (const [name, relative] of Object.entries(workspaceDirectories)) {
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name }));
    workspaces.push({ name, path: directory });
  }
  await writeFile(path.join(root, '.node-version'), process.versions.node);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs', packageManager: 'pnpm@11.9.0', devDependencies: { turbo: '2.11.10' } }));
  await writeFile(path.join(root, 'workspaces.json'), JSON.stringify(workspaces));
  await mkdir(path.join(root, 'scripts/upstream-sync'), { recursive: true });
  await writeFile(path.join(root, 'scripts/probe.mjs'), '');
  await mkdir(path.join(root, 'apps/web/src'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.turbo/\n.env.*\n!.env.example\n');
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ globalDependencies: ['package.json', 'turbo.json', '.gitignore'], tasks: {
    '//#lint': { inputs: ['apps/server/pm/src/**', '!**/.local/**', '!**/.env.*'] },
    '//#lint:gateway': { inputs: ['apps/server/gateway.ts'] },
    '//#lint:agent': { inputs: ['apps/server/agent/**', '!**/node_modules/**', '!**/.turbo/**', '!**/.local/**', '!**/.env.*'] },
    '@pm/web#lint': { inputs: ['src/**', '!**/.local/**', '!**/.env.*'] },
    '//#lint:ci': { inputs: ['scripts/probe.mjs'] },
    '//#lint:upstream': { inputs: ['scripts/upstream-sync/**'] },
    ...Object.fromEntries([...buildTasks, '@agent-workspace/cc-switch-host#build'].map(task => {
      const base = task.startsWith('//#') ? '' : workspaceDirectories[task.split('#')[0]];
      const directories = generatedDirectories.get(task) ?? [];
      return [task, { inputs: ['$TURBO_ROOT$/scripts/**', '!$TURBO_ROOT$/**/.local/**', '!$TURBO_ROOT$/**/.env.*'], outputs: directories.map(directory => `${path.posix.relative(base, directory)}/**`) }];
    })),
  } }));
  if (gitLayout === 'normal') {
    await mkdir(path.join(root, '.git/info'), { recursive: true });
    await writeFile(path.join(root, '.git/info/exclude'), '');
  } else if (gitLayout === 'unsafe') await writeFile(path.join(root, '.git'), 'gitdir: /private/external-common-dir\n');
  const capture = destination => `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, destination))}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');`;
  await writeFile(path.join(root, 'node_modules/.bin/pnpm'), `#!${process.execPath}
if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(pnpmVersion)}); }
else if (process.argv[2] === 'exec' && process.argv[3] === process.execPath && process.argv[4] === '--version') { ${capture('preflight-seen.jsonl')} if (require('node:fs').existsSync(${JSON.stringify(path.join(root, 'stale-dependencies'))})) process.exit(23); process.stdout.write(require('node:child_process').execFileSync(process.execPath, ['--version'])); }
else if (process.argv[2] === 'list') { process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path.join(root, 'workspaces.json'))}, 'utf8')); }
else if (process.argv[2] === 'run' && process.argv[3] === 'build') { const result = require('node:child_process').spawnSync(process.execPath, ['emit.cjs'], { stdio: 'inherit' }); if (result.signal) process.kill(process.pid, result.signal); else process.exit(result.status ?? 1); }
else { ${capture('pnpm-seen.jsonl')} process.exit(${pnpmExit}); }
`, { mode: 0o700 });
  if (installTurbo) {
    await mkdir(path.join(nativeRoot, 'bin'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/turbo/package.json'), JSON.stringify({ version: '2.11.10' }));
    await writeFile(path.join(nativeRoot, 'package.json'), JSON.stringify({ version: '2.11.10', type: 'commonjs' }));
    const body = interrupt ? `process.kill(process.ppid, ${JSON.stringify(interrupt)}); setInterval(() => {}, 1000);` : `process.exit(${turboExit});`;
    await writeFile(path.join(nativeRoot, 'bin/turbo'), `#!${process.execPath}
if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(turboVersion)}); }
else {
  ${capture('turbo-seen.jsonl')}
  if (!process.argv.includes('--dry=json')) require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'tasks-executed.jsonl'))}, JSON.stringify(process.argv.slice(3).filter(argument => !argument.startsWith('--'))) + '\\n');
  ${body}
}
`, { mode: 0o700 });
  }
  const run = args => runCheckTurbo({ root, args, ambientEnv: secretEnvironment });
  const invocations = async tool => (await readFile(path.join(root, `${tool}-seen.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const seen = async tool => (await invocations(tool)).at(-1);
  const records = async () => {
    const names = await readdir(path.join(root, '.local/ci-runs'));
    return (await Promise.all(names.map(name => readFile(path.join(root, '.local/ci-runs', name), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
  };
  const caller = async () => {
    const temporary = await mkdtemp('/var/tmp/dovspace-check-turbo-caller-');
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const env = createCheckEnvironment(root, temporary, secretEnvironment);
    for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) await mkdir(env[key], { mode: 0o700 });
    const recorder = createCiRecorder(root, () => {});
    t.after(() => recorder.close());
    const runner = createCiCommandRunner({ cwd: root, recorder });
    return { temporary, env, runner };
  };
  return { root, commonGit, nativeRoot, run, seen, invocations, records, caller };
}

function assertPrivateEnvironment(env) {
  assert.match(env.HOME, /^\/var\/tmp\/dovspace-check-turbo-/);
  for (const key of ['PM_SESSION_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'TURBO_TOKEN', 'TURBO_API', 'TURBO_CACHE', 'TURBO_ENV_MODE', 'AGENT_BUILD_OUTDIR', 'PUBLIC_APP_URL', 'PM_ENABLE_LAB']) assert.equal(env[key], undefined);
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.equal(env.DOVSPACE_ISOLATED_CHECKS, '1');
  assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(env.npm_config_manage_package_manager_versions, 'false');
  assert.equal(env.TURBO_TELEMETRY_DISABLED, '1');
  assert.equal(env.DO_NOT_TRACK, '1');
}

function selectedNativeTasks(invocation) {
  assert.equal(invocation.args[0], 'run');
  return invocation.args.slice(1).filter(argument => !argument.startsWith('--'));
}

test('arguments select only known stages or distinct registry IDs in an isolated cache namespace', () => {
  assert.deepEqual(parseTurboArguments([]), { mode: 'turbo', cacheName: 'default', stage: 'lint', tasks: [] });
  assert.deepEqual(parseTurboArguments(['--dry', '--stage', 'build', '--cache-name', 'acceptance-1']), { mode: 'dry', cacheName: 'acceptance-1', stage: 'build', tasks: [] });
  assert.deepEqual(parseTurboArguments(['--baseline', '--task', 'lint:web', '--task', 'host:build']), { mode: 'baseline', cacheName: 'default', stage: null, tasks: ['lint:web', 'host:build'] });
  for (const args of [
    ['build'], ['--', 'test'], ['--filter=@agent-workspace/server'], ['--cache=remote:rw'],
    ['--stage'], ['--stage', 'all'], ['--stage', '__proto__'], ['--stage', 'lint', '--stage', 'build'],
    ['--task'], ['--task', 'constructor'], ['--task', 'lint:web', '--task', 'lint:web'], ['--task', '@pm/web#lint'],
    ['--stage', 'lint', '--task', 'lint:web'], ['--task', 'lint:web', '--stage', 'lint'],
    ['--dry', '--baseline'], ['--dry', '--dry'], ['--baseline', '--cache-name', 'one'],
    ['--cache-name'], ['--cache-name', '../private'], ['--cache-name', '/private'],
    ['--cache-name', 'a', '--cache-name', 'b'],
  ]) assert.throws(() => parseTurboArguments(args), /Usage:/);
});

test('standalone environment never inherits credentials or Node and Turbo injection', () => {
  const env = createCheckEnvironment('/repository', '/var/tmp/dovspace-check-turbo-owned', secretEnvironment);
  assertPrivateEnvironment(env);
  assert.equal(env.HOME, '/var/tmp/dovspace-check-turbo-owned/home');
  assert.equal(env.TMPDIR, '/var/tmp/dovspace-check-turbo-owned/tmp');
  assert.equal(env.DOVSPACE_CHECK_TOOLCHAIN, undefined);
  assert.ok(env.PATH.startsWith(`${path.dirname(process.execPath)}${path.delimiter}`));
});

test('standalone default selects all lint scopes, isolates children and cleans its private Home', async t => {
  const { root, run, seen, records } = await fixture(t);
  await run(['--cache-name', 'cold-1']);
  const invocation = await seen('turbo');
  assert.deepEqual(selectedNativeTasks(invocation), lintTasks);
  assert.ok(invocation.args.includes('--cache=local:rw'));
  assert.ok(invocation.args.includes(`--cache-dir=${root}/.local/check-turbo/cold-1`));
  assert.ok(invocation.args.includes('--env-mode=strict'));
  assert.ok(invocation.args.includes('--framework-inference=false'));
  assert.ok(invocation.args.includes('--concurrency=1'));
  assert.ok(invocation.args.includes('--summarize'));
  assertPrivateEnvironment(invocation.env);
  assert.ok(invocation.env.DOVSPACE_CHECK_TOOLCHAIN.startsWith(`${process.platform}-${process.arch}:node-${process.versions.node}:pnpm-11.9.0:turbo-2.11.10:umask-077:ignore-`));
  assert.match(invocation.env.DOVSPACE_CHECK_TOOLCHAIN, /:ignore-[a-f0-9]{64}$/);
  await assert.rejects(access(invocation.env.HOME), { code: 'ENOENT' });
  const values = await records();
  assert.equal(values.find(value => value.kind === 'run' && value.event === 'end').status, 'passed');
  assert.equal(values.find(value => value.event === 'scope').stage, 'lint');
  assert.ok(values.some(value => value.kind === 'command' && value.label.includes('local cache hits are not execution')));
  for (const secret of ['private-pm-token', 'private-cloud-key', 'private-turbo-token', 'private-provider-home', 'private-forged-toolchain']) assert.ok(!JSON.stringify(values).includes(secret));
});

test('imported dispatcher reuses caller ownership and never installs handlers or removes caller directories', async t => {
  const f = await fixture(t);
  const { temporary, env, runner } = await f.caller();
  const listeners = ['SIGINT', 'SIGTERM'].map(signal => process.listeners(signal));
  const supplied = { ...env, ...secretEnvironment, HOME: env.HOME, TMPDIR: env.TMPDIR };
  const dispatcher = createTurboDispatcher({ root: f.root, runner, env: supplied });
  await dispatcher.runTasks(['lint:web']);
  await dispatcher.runStage('host-build');
  assert.deepEqual((await f.invocations('turbo')).map(selectedNativeTasks), [['@pm/web#lint'], ['@agent-workspace/cc-switch-host#build']]);
  const invocation = await f.seen('turbo');
  assertPrivateEnvironment(invocation.env);
  assert.equal(invocation.env.HOME, env.HOME);
  assert.notEqual(invocation.env.DOVSPACE_CHECK_TOOLCHAIN, supplied.DOVSPACE_CHECK_TOOLCHAIN);
  assert.equal(supplied.DOVSPACE_CHECK_TOOLCHAIN, 'private-forged-toolchain');
  await access(temporary);
  await access(env.HOME);
  assert.deepEqual(await readdir(env.TMPDIR), []);
  for (const [index, signal] of ['SIGINT', 'SIGTERM'].entries()) assert.deepEqual(process.listeners(signal), listeners[index]);
});

test('baseline runs original leaves with the same ordered prerequisite closure and needs no native install', async t => {
  const { root, run, invocations } = await fixture(t, { installTurbo: false });
  await run(['--baseline', '--task', 'build:client-types']);
  const commands = await invocations('pnpm');
  assert.deepEqual(commands.map(command => command.args), [
    ['--filter', '@agent-workspace/contracts', 'build'],
    ['--filter', '@agent-workspace/client-runtime', 'build'],
    ['--filter', '@agent-workspace/client-runtime', 'typecheck'],
  ]);
  for (const command of commands) assertPrivateEnvironment(command.env);
  await assert.rejects(access(commands[0].env.HOME), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, '.local/check-turbo')), { code: 'ENOENT' });
});

test('single late build selection includes prerequisites exactly once, not unrelated lint or host scopes', async t => {
  const { run, seen } = await fixture(t);
  await run(['--task', 'build:marketing', '--task', 'build:client']);
  assert.deepEqual(selectedNativeTasks(await seen('turbo')), buildTasks);
});

test('dry resolves the same build closure but executes neither baseline leaves nor a Turbo run', async t => {
  const { root, run, seen, records } = await fixture(t);
  await run(['--dry', '--task', 'build:client-types']);
  const invocation = await seen('turbo');
  assert.deepEqual(selectedNativeTasks(invocation), buildTasks.slice(0, 3));
  assert.ok(invocation.args.includes('--dry=json'));
  assert.ok(!invocation.args.includes('--summarize'));
  await assert.rejects(access(path.join(root, 'pnpm-seen.jsonl')), { code: 'ENOENT' });
  const values = await records();
  assert.equal(values.find(value => value.event === 'scope').mode, 'dry');
  assert.ok(values.some(value => value.kind === 'command' && value.label.includes('no task execution')));
});

test('deliberate Turbo and baseline failures stay failed and clean owned temporary files', async t => {
  const turbo = await fixture(t, { turboExit: 7 });
  await assert.rejects(turbo.run([]), /failed \(7\)/);
  await assert.rejects(access((await turbo.seen('turbo')).env.HOME), { code: 'ENOENT' });
  const values = await turbo.records();
  assert.ok(values.some(value => value.kind === 'command' && value.event === 'end' && value.code === 7 && value.status === 'failed'));
  assert.equal(values.find(value => value.kind === 'run' && value.event === 'end').status, 'failed');
  const baseline = await fixture(t, { pnpmExit: 9 });
  await assert.rejects(baseline.run(['--baseline', '--stage', 'build']), /failed \(9\)/);
  const commands = await baseline.invocations('pnpm');
  assert.equal(commands.length, 1);
  await assert.rejects(access(commands[0].env.HOME), { code: 'ENOENT' });
});

test('cancellation of a running native child remains interrupted and still cleans private files', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) await t.test(signal, async child => {
    const { run, seen, records } = await fixture(child, { interrupt: signal });
    await assert.rejects(run(['--task', 'lint:pm']), /SIGINT|SIGTERM/);
    await assert.rejects(access((await seen('turbo')).env.HOME), { code: 'ENOENT' });
    assert.ok((await records()).some(value => value.kind === 'command' && value.event === 'end' && value.status === 'interrupted' && value.signal === signal));
  });
});

test('cancellation during final asynchronous cleanup cannot return or record run success', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) await t.test(signal, async child => {
    const { run, seen, records } = await fixture(child);
    let interruptedDuringCleanup = false;
    child.mock.method(console, 'error', message => {
      if (typeof message !== 'string' || !message.startsWith('[ci:timing] ')) return;
      const event = JSON.parse(message.slice('[ci:timing] '.length));
      if (event.kind === 'stage' && event.event === 'end' && !interruptedDuringCleanup) {
        interruptedDuringCleanup = true;
        process.emit(signal);
      }
    });
    await assert.rejects(run([]), new RegExp(`Turbo checks interrupted by ${signal}`));
    assert.equal(interruptedDuringCleanup, true);
    await assert.rejects(access((await seen('turbo')).env.HOME), { code: 'ENOENT' });
    assert.equal((await records()).find(value => value.kind === 'run' && value.event === 'end').status, 'interrupted');
  });
});

test('wrong pnpm and missing Turbo fail without a task or any launcher fallback', async t => {
  const mismatched = await fixture(t, { pnpmVersion: '10.0.0' });
  await assert.rejects(mismatched.run([]), /pnpm does not match/);
  await assert.rejects(access(path.join(mismatched.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
  const missing = await fixture(t, { installTurbo: false });
  await assert.rejects(missing.run([]), /Turbo is not installed/);
  await assert.rejects(access(path.join(missing.root, 'pnpm-seen.jsonl')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(missing.root, 'tasks-executed.jsonl')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(missing.root, '.local/check-turbo')), { code: 'ENOENT' });
});

test('unpinned toolchains and mismatched installed package or executable versions fail closed', async t => {
  for (const change of [
    { file: '.node-version', value: '0.0.0', error: /repository-pinned Node/ },
    { file: 'package.json', value: JSON.stringify({ packageManager: 'pnpm@11.9.0', devDependencies: { turbo: '^2.11.10' } }), error: /exactly pinned Turbo/ },
    { file: 'node_modules/turbo/package.json', value: JSON.stringify({ version: '0.0.0' }), error: /Turbo does not match/ },
  ]) {
    const f = await fixture(t);
    await writeFile(path.join(f.root, change.file), change.value);
    await assert.rejects(f.run([]), change.error);
    await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
  }
  const nativeManifest = await fixture(t);
  await writeFile(path.join(nativeManifest.nativeRoot, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  await assert.rejects(nativeManifest.run([]), /platform binary does not match/);
  const nativeExecutable = await fixture(t, { turboVersion: '0.0.0' });
  await assert.rejects(nativeExecutable.run([]), /Native Turbo executable does not match/);
  const missingBinary = await fixture(t);
  await rm(path.join(missingBinary.nativeRoot, 'bin/turbo'));
  await assert.rejects(missingBinary.run([]), /platform binary is missing/);
});

test('symlinked cache, root summary and package log directories cannot redirect writes', async t => {
  const outside = await mkdtemp('/var/tmp/dovspace-check-turbo-outside-');
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const relative of ['.local/check-turbo/default', '.turbo/runs', 'apps/web/.turbo']) {
    const f = await fixture(t);
    await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true, mode: 0o700 });
    await symlink(outside, path.join(f.root, relative));
    await assert.rejects(f.run([]), /must not be symlinks/);
    await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
  }
  assert.deepEqual(await readdir(outside), []);
});

test('imported selection and options reject unknown values before running any tool', async t => {
  const f = await fixture(t);
  const { env } = await f.caller();
  const runner = { run() { assert.fail('An invalid selection must not launch a tool'); } };
  const dispatcher = createTurboDispatcher({ root: f.root, runner, env });
  for (const ids of [[], ['constructor'], ['lint:web', 'lint:web'], ['lint:web', '--filter=*'], 'lint']) await assert.rejects(dispatcher.runTasks(ids), /registry allowlist/);
  for (const stage of ['all', '__proto__', undefined]) await assert.rejects(dispatcher.runStage(stage), /Unknown Turbo check stage/);
  for (const options of [null, [], { baseline: 'true' }, { force: true }]) await assert.rejects(dispatcher.runTasks(['lint:pm'], options), /boolean baseline option/);
  assert.throws(() => createTurboDispatcher({ root: '.', runner, env }), /absolute repository root/);
  assert.throws(() => createTurboDispatcher({ root: f.root, runner, env, cacheName: '../private' }), /safe local cache name/);
  assert.throws(() => createTurboDispatcher({ root: f.root, runner, env, force: true }), /Unknown Turbo dispatcher options/);
});

test('dispatcher refuses missing isolation, unsafe caller directories and escaped workspace paths', async t => {
  const f = await fixture(t);
  const { env, runner } = await f.caller();
  for (const invalid of [
    { ...env, DOVSPACE_ISOLATED_CHECKS: undefined },
    { ...env, HOME: '/private/../provider-home' },
    { ...env, HOME: f.root },
    { ...env, HOME: env.TMPDIR },
  ]) await assert.rejects(createTurboDispatcher({ root: f.root, runner, env: invalid }).runTasks(['lint:pm']), /isolated checks environment|private absolute temporary|must be distinct/);
  await chmod(env.HOME, 0o755);
  await assert.rejects(createTurboDispatcher({ root: f.root, runner, env }).runTasks(['lint:pm']), /owned, private and not symlinks/);
  await chmod(env.HOME, 0o700);
  await writeFile(path.join(f.root, 'workspaces.json'), JSON.stringify([{ name: '@pm/web', path: '/var/tmp' }]));
  await assert.rejects(createTurboDispatcher({ root: f.root, runner, env }).runTasks(['lint:web']), /workspace must be inside the repository/);
  await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
});

test('normal checkout local exclude changes alter the cache identity without exposing exclude bytes', async t => {
  const f = await fixture(t);
  await f.run(['--task', 'lint:agent']);
  const before = await f.seen('turbo');
  await writeFile(path.join(f.root, '.git/info/exclude'), 'private-exclude-pattern\n');
  await f.run(['--task', 'lint:agent']);
  const after = await f.seen('turbo');
  assert.ok(before.args.includes('--cache=local:rw'));
  assert.ok(after.args.includes('--cache=local:rw'));
  assert.notEqual(before.env.DOVSPACE_CHECK_TOOLCHAIN, after.env.DOVSPACE_CHECK_TOOLCHAIN);
  assert.ok(!JSON.stringify(await f.records()).includes('private-exclude-pattern'));
});

test('a no-Git export disables cache reads and writes but still executes selected checks', async t => {
  const f = await fixture(t, { gitLayout: 'none' });
  await f.run(['--task', 'lint:agent']);
  const invocation = await f.seen('turbo');
  assert.deepEqual(selectedNativeTasks(invocation), ['//#lint:agent']);
  assert.ok(invocation.args.includes('--cache=local:'));
  await access(path.join(f.root, 'tasks-executed.jsonl'));
  assert.ok((await f.records()).some(value => value.label.includes('cache disabled: git-layout-unproven; real execution')));
});

test('authenticated linked Git uses the real common exclude identity without publishing its path or bytes', async t => {
  const f = await fixture(t, { gitLayout: 'linked' });
  await f.run(['--task', 'build:contracts']);
  const before = await f.seen('turbo');
  await writeFile(path.join(f.commonGit, 'info/exclude'), 'private-common-exclude-marker\n');
  await f.run(['--task', 'build:contracts']);
  const after = await f.seen('turbo');
  assert.ok(before.args.includes('--cache=local:rw'));
  assert.ok(after.args.includes('--cache=local:rw'));
  assert.notEqual(before.env.DOVSPACE_CHECK_TOOLCHAIN, after.env.DOVSPACE_CHECK_TOOLCHAIN);
  const records = JSON.stringify(await f.records());
  assert.ok(!records.includes(f.commonGit));
  assert.ok(!records.includes('private-common-exclude-marker'));
});

test('unproven Git pointers bypass native SCM for real leaves and dry fails closed', async t => {
  const f = await fixture(t, { gitLayout: 'unsafe' });
  await f.run(['--task', 'lint:agent']);
  assert.deepEqual((await f.seen('pnpm')).args, ['lint:agent']);
  await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
  await assert.rejects(f.run(['--dry', '--task', 'lint:agent']), /unsafe Git metadata: git-layout-unproven/);
  assert.equal((await f.invocations('pnpm')).length, 1);
  const records = JSON.stringify(await f.records());
  assert.ok(records.includes('unsafe SCM bypassed'));
  assert.ok(!records.includes('/private/external-common-dir'));
});

test('nested Git boundaries and symlinked excludes disable caching, not the lint execution', async t => {
  const nested = await fixture(t);
  await mkdir(path.join(nested.root, 'apps/server/agent/.git'));
  await nested.run(['--task', 'lint:agent']);
  assert.ok((await nested.seen('turbo')).args.includes('--cache=local:'));
  await access(path.join(nested.root, 'tasks-executed.jsonl'));
  assert.ok((await nested.records()).some(value => value.label.includes('cache disabled: nested-git-boundary; real execution')));
  const linkedExclude = await fixture(t);
  await rm(path.join(linkedExclude.root, '.git/info/exclude'));
  await symlink('/private/not-readable-excludes', path.join(linkedExclude.root, '.git/info/exclude'));
  await linkedExclude.run(['--task', 'lint:agent']);
  await assert.rejects(access(path.join(linkedExclude.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
  assert.deepEqual((await linkedExclude.seen('pnpm')).args, ['lint:agent']);
});

test('uncacheable export dry reports its reason without executing tasks, and builds remain usable', async t => {
  const f = await fixture(t, { gitLayout: 'none' });
  await f.run(['--dry', '--task', 'lint:agent']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:'));
  await assert.rejects(access(path.join(f.root, 'tasks-executed.jsonl')), { code: 'ENOENT' });
  assert.ok((await f.records()).some(value => value.label.includes('no task execution; cache disabled: git-layout-unproven')));
  await f.run(['--task', 'build:client-types']);
  assert.deepEqual(selectedNativeTasks(await f.seen('turbo')), buildTasks.slice(0, 3));
  await access(path.join(f.root, 'tasks-executed.jsonl'));
});

test('full build baseline retains all nine original leaves in order without Git or native Turbo', async t => {
  const f = await fixture(t, { gitLayout: 'none', installTurbo: false });
  await f.run(['--baseline', '--stage', 'build']);
  assert.deepEqual((await f.invocations('pnpm')).map(command => command.args), [
    ['--filter', '@agent-workspace/contracts', 'build'],
    ['--filter', '@agent-workspace/client-runtime', 'build'],
    ['--filter', '@agent-workspace/client-runtime', 'typecheck'],
    ['typecheck'], ['build'],
    ['--filter', '@agent-workspace/server', 'build'],
    ['--filter', '@pm/web', 'build'],
    ['--filter', '@agent-workspace/marketing', 'typecheck'],
    ['--filter', '@agent-workspace/marketing', 'build'],
  ]);
});

test('private-excluded code never reuses a cached green or leaks source contents', async t => {
  for (const relative of ['apps/web/src/.env.ts', 'apps/web/src/.local/private.ts']) await t.test(relative, async child => {
    const f = await fixture(child);
    await f.run(['--task', 'lint:web']);
    assert.ok((await f.seen('turbo')).args.includes('--cache=local:rw'));
    await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
    await writeFile(path.join(f.root, relative), 'private-source-marker-not-for-artifacts');
    await f.run(['--task', 'lint:web']);
    assert.ok((await f.seen('turbo')).args.includes('--cache=local:'));
    const values = await f.records();
    assert.ok(values.some(value => value.label.includes('cache disabled: private-task-inputs; real execution')));
    assert.ok(!JSON.stringify(values).includes('private-source-marker-not-for-artifacts'));
  });
});

test('explicit private historical docs are pruned without inspecting their contents or disabling public build caching', async t => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(path.join(f.root, 'turbo.json'), 'utf8'));
  config.tasks['@agent-workspace/server#build'].inputs.push('$TURBO_ROOT$/docs/**', '!$TURBO_ROOT$/docs/implementation/**');
  await writeFile(path.join(f.root, 'turbo.json'), JSON.stringify(config));
  const history = path.join(f.root, 'docs/implementation');
  await mkdir(history, { recursive: true });
  await writeFile(path.join(f.root, 'docs/guide.md'), 'public build input');
  await symlink('/private/do-not-read', path.join(history, '.gitignore'));
  await writeFile(path.join(history, '.env.ts'), 'private-history-marker');
  await f.run(['--task', 'build:agent']);
  const before = await f.seen('turbo');
  await writeFile(path.join(history, '.env.ts'), 'changed-private-history-marker');
  await f.run(['--task', 'build:agent']);
  const after = await f.seen('turbo');
  assert.ok(before.args.includes('--cache=local:rw'));
  assert.ok(after.args.includes('--cache=local:rw'));
  assert.equal(after.env.DOVSPACE_CHECK_TOOLCHAIN, before.env.DOVSPACE_CHECK_TOOLCHAIN);
  assert.ok(!JSON.stringify(await f.records()).includes('private-history-marker'));
});

test('same-content permission changes invalidate identity and unreadable source disables caching', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'apps/web/src/main.ts');
  await writeFile(source, 'export const value = 1;\n', { mode: 0o644 });
  await f.run(['--task', 'lint:web']);
  const initial = (await f.seen('turbo')).env.DOVSPACE_CHECK_TOOLCHAIN;
  await f.run(['--task', 'lint:web']);
  assert.equal((await f.seen('turbo')).env.DOVSPACE_CHECK_TOOLCHAIN, initial);
  await chmod(source, 0o600);
  await f.run(['--task', 'lint:web']);
  const readable = await f.seen('turbo');
  assert.ok(readable.args.includes('--cache=local:rw'));
  assert.notEqual(readable.env.DOVSPACE_CHECK_TOOLCHAIN, initial);
  await chmod(source, 0o000);
  await f.run(['--task', 'lint:web']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:'));
  assert.ok((await f.records()).some(value => value.label.includes('cache disabled: unreadable-task-inputs; real execution')));
  await chmod(source, 0o600);
});

test('a same-content file-to-symlink transition cannot return a cached lint result', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'apps/web/src/main.ts'), target = path.join(f.root, 'apps/web/src/target.ts');
  await writeFile(source, 'export const value = 1;\n');
  await writeFile(target, 'export const value = 1;\n');
  await f.run(['--task', 'lint:web']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:rw'));
  await rm(source);
  await symlink(target, source);
  await f.run(['--task', 'lint:web']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:'));
  assert.ok((await f.records()).some(value => value.label.includes('cache disabled: symlinked-task-inputs; real execution')));
});

test('Oxlint custom ignore negations invalidate excluded-directory cache eligibility', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'apps/server/agent/.turbo');
  await mkdir(directory);
  await writeFile(path.join(directory, 'probe.ts'), 'private-source-marker');
  await f.run(['--task', 'lint:agent']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:rw'));
  await writeFile(path.join(f.root, 'apps/server/agent/.eslintignore'), '!.turbo/\n!.turbo/**\n');
  await f.run(['--task', 'lint:agent']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:'));
  assert.ok((await f.records()).some(value => value.label.includes('cache disabled: private-task-inputs; real execution')));
});

test('an excluded dependency directory becoming a symlink cannot reuse Oxlint cache', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'apps/server/agent/node_modules');
  await mkdir(directory);
  await f.run(['--task', 'lint:agent']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:rw'));
  await rm(directory, { recursive: true });
  await symlink(path.join(f.root, 'apps/web/src'), directory);
  await f.run(['--task', 'lint:agent']);
  assert.ok((await f.seen('turbo')).args.includes('--cache=local:'));
  assert.ok((await f.records()).some(value => value.label.includes('cache disabled: symlinked-task-inputs; real execution')));
});

test('every call on a reused dispatcher rechecks dependency state before touching cache or outputs', async t => {
  const f = await fixture(t);
  const { env, runner } = await f.caller();
  const dispatcher = createTurboDispatcher({ root: f.root, env, runner, cacheName: 'warm' });
  await dispatcher.runTasks(['build:contracts']);
  const output = path.join(f.root, 'packages/agent-contracts/dist');
  await mkdir(output);
  await writeFile(path.join(output, 'previous.d.ts'), 'preserve until dependency state is valid');
  await writeFile(path.join(f.root, 'stale-dependencies'), '');
  await assert.rejects(dispatcher.runTasks(['build:contracts']), /dependency freshness .*failed \(23\)/);
  assert.equal((await f.invocations('turbo')).length, 1);
  assert.equal((await f.invocations('preflight')).length, 2);
  assert.equal(await readFile(path.join(output, 'previous.d.ts'), 'utf8'), 'preserve until dependency state is valid');
});

test('owned output roots, ancestors and descendants reject symlinks before any restoration or cleanup', async t => {
  const outside = await mkdtemp('/var/tmp/dovspace-check-turbo-output-');
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'private-marker'), 'never modify this outside tree');
  for (const relative of ['dist', 'dist/escape', 'apps/server']) await t.test(relative, async child => {
    const f = await fixture(child);
    const link = path.join(f.root, relative);
    await rm(link, { recursive: true, force: true });
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(outside, link);
    const preserved = path.join(f.root, 'packages/agent-contracts/dist');
    await mkdir(preserved);
    await writeFile(path.join(preserved, 'previous.d.ts'), 'must survive a different unsafe root');
    await assert.rejects(f.run(['--task', 'build:agent']), /output ancestors|artifact entries|ENOENT|workspace/);
    await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(preserved, 'previous.d.ts'), 'utf8'), 'must survive a different unsafe root');
  });
  assert.deepEqual(await readdir(outside), ['private-marker']);
  assert.equal(await readFile(path.join(outside, 'private-marker'), 'utf8'), 'never modify this outside tree');
});

test('baseline and native builds clean only declared output roots, while dry leaves inventory intact', async t => {
  for (const mode of ['--baseline', '--dry', null]) await t.test(mode ?? 'native', async child => {
    const f = await fixture(child);
    const output = path.join(f.root, 'packages/agent-contracts/dist');
    const unrelated = path.join(f.root, 'packages/agent-contracts/keep.txt');
    await mkdir(output);
    await writeFile(path.join(output, 'deleted-source.d.ts'), 'stale');
    await writeFile(unrelated, 'caller-owned');
    await f.run([...(mode ? [mode] : []), '--task', 'build:contracts']);
    assert.equal(await readFile(unrelated, 'utf8'), 'caller-owned');
    if (mode === '--dry') assert.equal(await readFile(path.join(output, 'deleted-source.d.ts'), 'utf8'), 'stale');
    else await assert.rejects(access(output), { code: 'ENOENT' });
  });
});

test('cache entries and task logs cannot redirect native reads or writes through symlinks', async t => {
  const outside = await mkdtemp('/var/tmp/dovspace-check-turbo-entry-');
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret'), 'private-marker');
  for (const relative of ['.local/check-turbo/default/entry.tar.zst', '.turbo/turbo-lint.log', 'apps/web/.turbo/turbo-lint.log']) {
    const f = await fixture(t);
    await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true, mode: 0o700 });
    await symlink(path.join(outside, 'secret'), path.join(f.root, relative));
    await assert.rejects(f.run(['--task', 'lint:web']), /artifact entries.*not symlinks/);
    await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'private-marker');
});

test('hardlinked output, cache and log entries cannot mutate their other inode aliases', async t => {
  const outside = await mkdtemp('/var/tmp/dovspace-check-turbo-hardlink-');
  t.after(() => rm(outside, { recursive: true, force: true }));
  const preserved = path.join(outside, 'preserved');
  await writeFile(preserved, 'caller-owned bytes');
  for (const relative of ['packages/agent-contracts/dist/linked.d.ts', '.local/check-turbo/default/entry.tar.zst', 'apps/web/.turbo/turbo-lint.log']) {
    const f = await fixture(t);
    await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true, mode: 0o700 });
    await link(preserved, path.join(f.root, relative));
    const task = relative.startsWith('packages/') ? 'build:contracts' : 'lint:web';
    await assert.rejects(f.run(['--task', task]), /artifact entries must be ordinary unlinked/);
    await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
    assert.equal(await readFile(preserved, 'utf8'), 'caller-owned bytes');
  }
});

test('linked common metadata requires an authentic backlink and rejects symlinked administrative files', async t => {
  for (const change of ['backlink', 'commondir', 'common-info', 'index', 'config', 'marker']) await t.test(change, async child => {
    const f = await fixture(child, { gitLayout: 'linked' });
    const admin = (await readFile(path.join(f.root, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    if (change === 'backlink') await writeFile(path.join(admin, 'gitdir'), '/private/not-this-worktree/.git\n');
    else if (change === 'commondir') {
      await rm(path.join(admin, 'commondir'));
      await symlink('/private/do-not-read', path.join(admin, 'commondir'));
    } else if (change === 'common-info') {
      await rm(path.join(f.commonGit, 'info'), { recursive: true });
      await symlink('/private/do-not-read', path.join(f.commonGit, 'info'));
    } else if (change === 'index' || change === 'config') {
      const filename = path.join(change === 'index' ? admin : f.commonGit, change);
      await rm(filename, { force: true });
      await symlink('/private/do-not-read', filename);
    } else {
      await rm(path.join(f.root, '.git'));
      await symlink(f.commonGit, path.join(f.root, '.git'));
    }
    await f.run(['--task', 'lint:gateway']);
    assert.deepEqual((await f.seen('pnpm')).args, ['lint:gateway']);
    await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
    await assert.rejects(f.run(['--dry', '--task', 'lint:gateway']), /unsafe Git metadata/);
    assert.ok(!JSON.stringify(await f.records()).includes('/private/do-not-read'));
  });
});

test('tracked files inside generated output roots are never deleted, overwritten or restored', async t => {
  const f = await fixture(t, { gitLayout: 'linked' });
  const directory = path.join(f.root, 'packages/agent-contracts/dist');
  await mkdir(directory);
  const source = path.join(directory, 'tracked-source.ts');
  await writeFile(source, 'caller-owned tracked source');
  await promisify(execFile)('/usr/bin/git', ['-C', f.root, '-c', 'core.hooksPath=/dev/null', 'add', '--force', '--', 'packages/agent-contracts/dist/tracked-source.ts'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  // The inspection must not parse original local config/includes, even when
  // an include would make native Git reject the repository configuration.
  const include = path.join(f.root, 'private-metadata');
  await writeFile(include, '[invalid-config\n');
  await writeFile(path.join(f.commonGit, 'config'), `[core]\nrepositoryformatversion = 0\n[include]\npath = ${include}\n`);
  for (const mode of [[], ['--baseline'], ['--dry']]) {
    await assert.rejects(f.run([...mode, '--task', 'build:contracts']), /must not contain tracked source/);
    assert.equal(await readFile(source, 'utf8'), 'caller-owned tracked source');
  }
  await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.root, 'pnpm-seen.jsonl')), { code: 'ENOENT' });
});

test('native Git index inspection failures preserve every existing output and cannot reach cache restoration', async t => {
  const f = await fixture(t, { gitLayout: 'linked' });
  const admin = (await readFile(path.join(f.root, '.git'), 'utf8')).trim().slice('gitdir: '.length);
  await writeFile(path.join(admin, 'index'), 'not-a-git-index');
  const output = path.join(f.root, 'packages/agent-contracts/dist');
  await mkdir(output);
  await writeFile(path.join(output, 'keep.d.ts'), 'preserve on ambiguous ownership');
  await assert.rejects(f.run(['--task', 'build:contracts']), /isolated Git index.*failed/);
  assert.equal(await readFile(path.join(output, 'keep.d.ts'), 'utf8'), 'preserve on ambiguous ownership');
  await assert.rejects(access(path.join(f.root, 'turbo-seen.jsonl')), { code: 'ENOENT' });
});

test('real native linked-worktree cache restores clean byte/mode inventory and never stores failed work', async t => {
  const f = await fixture(t, { gitLayout: 'linked' });
  const originalMask = process.umask();
  const quotedPnpm = path.join(f.root, "pnpm's tool");
  await rename(path.join(f.root, 'node_modules/.bin/pnpm'), quotedPnpm);
  await symlink(quotedPnpm, path.join(f.root, 'node_modules/.bin/pnpm'));
  const require = createRequire(import.meta.url);
  const turboManifest = require.resolve('turbo/package.json');
  const native = createRequire(turboManifest).resolve(`@turbo/linux-${process.arch === 'x64' ? '64' : process.arch}/bin/turbo`);
  await copyFile(native, path.join(f.nativeRoot, 'bin/turbo'));
  await chmod(path.join(f.nativeRoot, 'bin/turbo'), 0o700);
  const task = '@agent-workspace/contracts#build';
  const directory = path.join(f.root, 'packages/agent-contracts');
  const output = path.join(directory, 'dist');
  const source = path.join(directory, 'src/value.ts');
  await writeFile(path.join(f.commonGit, 'info/exclude'), 'packages/agent-contracts/src/value.ts\n');
  await mkdir(path.dirname(source));
  await writeFile(source, 'export declare const value: 1;\n');
  const sourceAlias = path.join(f.root, 'node_modules/local-file-source.ts');
  await link(source, sourceAlias);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@agent-workspace/contracts', version: '1.0.0', scripts: { build: 'node emit.cjs' } }));
  await writeFile(path.join(directory, 'emit.cjs'), `
const fs = require('node:fs');
const source = fs.readFileSync('src/value.ts', 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(f.root, 'executions'))}, 'run\\n');
fs.appendFileSync(${JSON.stringify(path.join(f.root, 'leaf-masks'))}, process.umask().toString(8) + '\\n');
if (source === 'fail') process.exit(7);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.d.ts', source);
fs.chmodSync('dist', 0o750);
fs.chmodSync('dist/index.d.ts', 0o640);
`);
  await writeFile(path.join(f.root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - apps/*\n  - apps/server/*\n');
  await writeFile(path.join(f.root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\nimporters:\n  .: {}\n  packages/agent-contracts: {}\n");
  await writeFile(path.join(f.root, 'turbo.json'), JSON.stringify({
    remoteCache: { enabled: false },
    globalDependencies: ['scripts/probe.mjs'],
    globalEnv: ['DOVSPACE_CHECK_TOOLCHAIN'],
    globalPassThroughEnv: ['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'pnpm_config_verify_deps_before_run'],
    tasks: { [task]: { inputs: ['src/**', 'emit.cjs', '$TURBO_ROOT$/scripts/probe.mjs'], outputs: ['dist/**'], cache: true } },
  }));
  const summaries = path.join(f.root, '.turbo/runs');
  const summaryNames = () => readdir(summaries).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const run = async (dispatch = () => f.run(['--task', 'build:contracts', '--cache-name', 'real-native'])) => {
    const previous = new Set(await summaryNames());
    await dispatch();
    const created = (await summaryNames()).filter(name => !previous.has(name) && name.endsWith('.json'));
    assert.equal(created.length, 1);
    const summary = JSON.parse(await readFile(path.join(summaries, created[0]), 'utf8'));
    return summary.tasks.find(value => value.taskId === task).cache.status;
  };
  const inventory = async () => ({
    content: await readFile(path.join(output, 'index.d.ts'), 'utf8'),
    directoryMode: (await lstat(output)).mode & 0o777,
    fileMode: (await lstat(path.join(output, 'index.d.ts'))).mode & 0o777,
    files: await readdir(output),
  });
  const count = async () => (await readFile(path.join(f.root, 'executions'), 'utf8')).trim().split('\n').length;
  assert.equal(await run(), 'MISS');
  const initial = await inventory();
  assert.equal(process.umask(), originalMask);
  assert.equal(await readFile(path.join(f.root, 'leaf-masks'), 'utf8'), '77\n');
  await writeFile(path.join(output, 'stale.d.ts'), 'deleted-source-output');
  const unrelated = path.join(directory, 'keep.txt');
  await writeFile(unrelated, 'caller-owned');
  assert.equal(await run(), 'HIT');
  assert.deepEqual(await inventory(), initial);
  assert.equal(await count(), 1);
  assert.equal(await readFile(unrelated, 'utf8'), 'caller-owned');
  await rm(output, { recursive: true });
  assert.equal(await run(), 'HIT');
  assert.deepEqual(await inventory(), initial);
  assert.equal(await count(), 1);
  await writeFile(sourceAlias, 'export declare const value: 2;\n');
  assert.equal(await run(), 'MISS');
  assert.equal((await inventory()).content, 'export declare const value: 2;\n');
  assert.equal(await count(), 2);
  await writeFile(source, 'fail');
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.run(['--task', 'build:contracts', '--cache-name', 'real-native']), /failed/);
  assert.equal(await count(), 4);
  await writeFile(source, 'export declare const value: 2;\n');
  assert.equal(await run(), 'HIT');
  assert.equal(await count(), 4);
  const { env, runner } = await f.caller();
  const dispatcher = createTurboDispatcher({ root: f.root, env, runner, cacheName: 'real-native' });
  const beforeCaller = process.umask(0o022);
  try {
    assert.equal(await run(() => dispatcher.runTasks(['build:contracts'])), 'MISS');
    assert.equal(process.umask(), 0o022);
    assert.equal(await run(() => dispatcher.runTasks(['build:contracts'])), 'HIT');
    assert.equal(process.umask(), 0o022);
    assert.equal(await count(), 5);
    assert.equal((await readFile(path.join(f.root, 'leaf-masks'), 'utf8')).trim().split('\n').at(-1), '22');
    assert.equal((await lstat(path.join(f.root, '.local/check-turbo/real-native'))).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(directory, '.turbo'))).mode & 0o777, 0o700);
  } finally { process.umask(beforeCaller); }
  assert.equal(process.umask(), originalMask);
  assert.equal(await run(), 'HIT');
  assert.equal(await count(), 5);
  assert.ok(!JSON.stringify(await f.records()).includes('private-pm-token'));
});

test('real pinned pnpm rejects stale dependencies before either a warm cache lookup or baseline leaf', async t => {
  const f = await fixture(t);
  // Use the installed pinned pnpm, not the command fixture. Offline protects the
  // test even if a regression accidentally re-enables pnpm's install default.
  await rm(path.join(f.root, 'node_modules/.bin/pnpm'));
  const manifest = JSON.parse(await readFile(path.join(f.root, 'package.json'), 'utf8'));
  manifest.scripts = { 'lint:gateway': `node -e "require('node:fs').writeFileSync('leaf-ran', 'unexpected')"` };
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(f.root, 'pnpm-workspace.yaml'), 'packages: []\noffline: true\nverifyDepsBeforeRun: install\n');
  const native = path.join(f.nativeRoot, 'bin/turbo');
  const trap = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(f.root, 'native-ran'))}, 'unexpected'); process.exit(91);\n`;
  await writeFile(native, trap, { mode: 0o700 });
  const cache = path.join(f.root, '.local/check-turbo/warm');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'existing-entry'), 'unchanged');
  const temporary = await mkdtemp('/var/tmp/dovspace-check-turbo-caller-');
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const env = createCheckEnvironment(f.root, temporary, process.env);
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) await mkdir(env[key], { mode: 0o700 });
  let diagnostic = '';
  const observer = new Writable({ write(chunk, _encoding, callback) { diagnostic += chunk.toString(); callback(); } });
  const recorder = createCiRecorder(f.root, () => {});
  const runner = createCiCommandRunner({ cwd: f.root, recorder, stdout: observer, stderr: observer });
  try {
    for (const baseline of [false, true]) {
      diagnostic = '';
      const dispatcher = createTurboDispatcher({ root: f.root, runner, env: { ...env, pnpm_config_verify_deps_before_run: 'install' }, cacheName: 'warm' });
      await assert.rejects(dispatcher.runTasks(['lint:gateway'], { baseline }), /Pinned pnpm dependency freshness .*failed \(1\)/);
      assert.match(diagnostic, /ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/);
    }
    await assert.rejects(access(path.join(f.root, 'native-ran')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(f.root, 'leaf-ran')), { code: 'ENOENT' });
    assert.equal(await readFile(native, 'utf8'), trap);
    assert.equal(await readFile(path.join(cache, 'existing-entry'), 'utf8'), 'unchanged');
  } finally { recorder.close(); }
});
