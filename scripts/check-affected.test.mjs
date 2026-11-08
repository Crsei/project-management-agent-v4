import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { collectGitChanges, describeAffectedChecks, parseAffectedArgs, parseGitChanges, runAffectedCli, selectAffectedChecks } from './check-affected.mjs';

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const allStages = ['static', 'build', 'host', 'backend', 'agent'];
const selected = files => selectAffectedChecks(files.map(file => ({ path: file })));

async function fixture(t) {
  // Never put Git fixtures or synthetic dotenv files in a checkout/private HOME.
  const root = await mkdtemp('/var/tmp/dovspace-affected-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'home'));
  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: path.join(root, 'home'),
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Affected fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Affected fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const put = async (file, content = 'fixture\n') => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const git = (...args) => execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env });
  return { root, env, put, git };
}

function cliOptions(cwd) {
  const messages = [], errors = [];
  return { cwd, messages, errors, log: message => messages.push(message), error: message => errors.push(message) };
}

test('shared dependencies and hidden workspace inputs never omit backend or host coverage', () => {
  for (const file of [
    'packages/contracts/src/client.ts', 'vendor/openhands-extensions/output-inventory.json',
    'scripts/build-assets.mjs', 'patches/dependency.patch', '.github/workflows/ci.yml',
    'docs/contracts/openapi.yaml', 'docs/agent-source/provider.md',
  ]) {
    const plan = selected(['apps/web/src/local.ts', file]);
    assert.equal(plan.scope, 'all', file);
    assert.deepEqual(plan.stages, allStages, file);
  }
});

test('lockfiles, configuration and unknown inputs conservatively broaden local selections', () => {
  for (const file of [
    'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', '.env.example',
    'apps/web/src/nested.config.ts', 'pnpm-workspace.yaml',
    'new-unknown-area/file.ts', 'docs/implementation/internal.md',
  ]) {
    const plan = selected(['apps/marketing/src/pages/index.astro', file]);
    assert.equal(plan.scope, 'all', file);
    assert.deepEqual(plan.stages, allStages, file);
  }
});

test('clear local changes reduce feedback without claiming complete CI', () => {
  assert.deepEqual(selected(['docs/guides/development.md']).stages, []);
  assert.equal(selected(['docs/guides/development.md']).scope, 'docs');
  assert.deepEqual(selected(['apps/marketing/src/pages/index.astro']).stages, ['static', 'build']);
  assert.deepEqual(selected(['apps/web/src/model.test.ts']).stages, ['static', 'build', 'backend', 'agent']);
  const combined = selected(['docs/guides/development.md', 'apps/web/public/icon.svg', 'apps/marketing/public/icon.svg']);
  assert.equal(combined.scope, 'web+marketing');
  assert.deepEqual(combined.stages, ['static', 'build', 'backend', 'agent']);
  assert.equal(selected([]).scope, 'none');
});

test('backend suites consuming Web models remain selected for Web-only and mixed changes', () => {
  // Account-security and product-roadmap backend regressions consume these
  // Web models; their changes must not be treated as browser-only feedback.
  for (const input of [
    'apps/web/src/features/pm/service/settings/account-security-recovery.ts',
    'apps/web/src/features/pm/product-roadmap/model.ts',
  ]) {
    for (const files of [[input], [input, 'apps/marketing/src/pages/index.astro']]) {
      const stages = selected(files).stages;
      assert.ok(stages.includes('backend'), input);
      assert.ok(stages.indexOf('build') >= 0 && stages.indexOf('build') < stages.indexOf('backend'));
    }
  }
});

test('NUL Git records retain deletion and both rename endpoints, including hostile-looking names', () => {
  const destination = 'apps/web/src/ new\n$(not-a-command);.ts';
  const source = 'packages/contracts/src/deleted contract.ts';
  const output = `1 .D N... 100644 100644 000000 a b docs/guides/deleted.md\0` +
    `2 R. N... 100644 100644 100644 a b R100 ${destination}\0${source}\0` +
    '? apps/web/src/untracked\tfile.ts\0';
  const changes = parseGitChanges(output);
  assert.deepEqual(changes.map(change => change.path), ['docs/guides/deleted.md', destination, source, 'apps/web/src/untracked\tfile.ts']);
  assert.equal(changes[2].status, 'rename-source');
  assert.equal(selected([destination]).scope, 'web');
  assert.equal(selectAffectedChecks(changes).scope, 'all');
  const description = describeAffectedChecks(selectAffectedChecks(changes), 'fixture');
  assert.ok(description.includes(JSON.stringify(destination)));
  assert.ok(!description.includes(destination));
  assert.throws(() => parseGitChanges('1 .D N... a b c d e file'), /Incomplete/);
  assert.throws(() => parseGitChanges('2 R. N... a b c d e R100 new\0'), /Missing Git rename source/);
  assert.throws(() => parseGitChanges('future unsupported format\0'), /Unsupported/);
  const submodule = parseGitChanges('1 .M S.M. 160000 160000 160000 a b apps/web/src/submodule\0');
  assert.equal(selectAffectedChecks(submodule).scope, 'all');
  const unmerged = parseGitChanges('u UU N... 100644 100644 100644 100644 a b c apps/web/src/conflict.ts\0');
  assert.equal(selectAffectedChecks(unmerged).scope, 'all');
});

test('real Git discovery includes staged, unstaged, deleted, renamed and all untracked files', async t => {
  const f = await fixture(t);
  await f.git('init', '--quiet');
  for (const file of ['apps/web/src/staged.ts', 'apps/marketing/src/unstaged.ts', 'docs/deleted.md', 'packages/contracts/src/original.ts']) await f.put(file, `${file}\n`);
  await f.git('add', '--all');
  await f.git('commit', '--quiet', '-m', 'fixture baseline');
  assert.deepEqual(await collectGitChanges(f.root), []);
  await f.put('apps/web/src/staged.ts', 'staged edit\n');
  await f.git('add', '--', 'apps/web/src/staged.ts');
  await f.put('apps/web/src/staged.ts', 'additional unstaged edit\n');
  await f.put('apps/marketing/src/unstaged.ts', 'unstaged edit\n');
  await rm(path.join(f.root, 'docs/deleted.md'));
  await rename(path.join(f.root, 'packages/contracts/src/original.ts'), path.join(f.root, 'apps/web/src/renamed.ts'));
  await f.git('add', '--all');
  await f.put('apps/marketing/src/unstaged.ts', 'another unstaged edit\n');
  const strange = 'apps/web/src/ leading\n$(touch SHOULD_NOT_EXIST);.ts';
  await f.put(strange);
  await f.put('unmapped-new-area/first.ts');
  await f.put('unmapped-new-area/second.ts');
  const changes = await collectGitChanges(f.root);
  const paths = new Set(changes.map(change => change.path));
  for (const file of ['apps/web/src/staged.ts', 'apps/marketing/src/unstaged.ts', 'docs/deleted.md', 'packages/contracts/src/original.ts', 'apps/web/src/renamed.ts', strange, 'unmapped-new-area/first.ts', 'unmapped-new-area/second.ts']) assert.ok(paths.has(file), file);
  assert.equal(changes.find(change => change.path === 'packages/contracts/src/original.ts').status, 'rename-source');
  assert.ok(changes.find(change => change.path === 'apps/marketing/src/unstaged.ts').status.includes('M'));
  assert.equal(changes.find(change => change.path === strange).status, 'untracked');
  assert.equal(selectAffectedChecks(changes).scope, 'all');
  await assert.rejects(access(path.join(f.root, 'SHOULD_NOT_EXIST')));
});

test('explicit dry-run replaces Git discovery, accepts absent files and performs no checks or writes', async t => {
  const f = await fixture(t);
  const options = cliOptions(f.root); // Deliberately not a Git repository.
  const name = 'apps/web/src/deleted file\n$(literal).ts';
  assert.equal(await runAffectedCli(['--dry-run', '--file', name, '--file', 'docs/deleted.md'], options), 0);
  assert.equal(options.errors.length, 0);
  await assert.rejects(access(path.join(f.root, '.local')));
  const gitFailure = cliOptions(f.root);
  assert.equal(await runAffectedCli(['--dry-run'], gitFailure), 1);
  assert.ok(gitFailure.errors.length > 0);
  assert.throws(() => parseAffectedArgs(['--command', 'touch bad']), /Usage/);
  assert.throws(() => parseAffectedArgs(['--base', 'HEAD~1']), /Usage/);
  assert.throws(() => parseAffectedArgs(['--file']), /Usage/);
  for (const file of ['../outside', '/absolute', 'a/../b', 'a//b', 'C:\\absolute', 'a\0b']) assert.throws(() => parseAffectedArgs(['--file', file]), /repository-relative/);
});

test('a real supervised nonzero stage propagates failure and stops before build or regressions', async t => {
  const f = await fixture(t);
  await f.put('scripts/check-ci.mjs', `import { appendFileSync } from 'node:fs'; appendFileSync('executed', process.argv[3] + '\\n'); process.exit(7);`);
  const options = cliOptions(f.root);
  assert.equal(await runAffectedCli(['--file', 'pnpm-lock.yaml'], options), 1);
  assert.match(options.errors.join('\n'), /failed \(7\)/);
  assert.equal(await readFile(path.join(f.root, 'executed'), 'utf8'), 'static\n');
  assert.doesNotMatch(options.messages.join('\n'), /Selected developer scope completed/);
});

test('selected regressions always get a fresh same-invocation build and a credential-free environment', async t => {
  const f = await fixture(t);
  await f.put('stale-build', 'must not authorize regression');
  await f.put('scripts/check-ci.mjs', `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const stage = process.argv[3];
if (process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.NODE_OPTIONS || process.env.PM_SESSION_TOKEN) process.exit(81);
if (process.env.DOVSPACE_ISOLATED_CHECKS !== '1' || !process.env.HOME.startsWith('/')) process.exit(82);
if (stage === 'agent' ? process.env.PM_OPENHANDS_AUTHORING_SOURCE !== ${JSON.stringify(path.join(f.root, 'explicit-public-source-path'))} : process.env.PM_OPENHANDS_AUTHORING_SOURCE !== undefined) process.exit(84);
appendFileSync('executed', stage + '\\n');
if (stage === 'build') writeFileSync('fresh-build', 'this invocation');
if ((stage === 'agent' || stage === 'backend') && !existsSync('fresh-build')) process.exit(83);
`);
  const driver = `
import { runAffectedCli } from ${JSON.stringify(new URL('./check-affected.mjs', import.meta.url).href)};
process.exitCode = await runAffectedCli(['--file', 'packages/contracts/src/client.ts'], { cwd: process.cwd() });
`;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', driver], {
    cwd: f.root,
    env: { ...f.env, PM_OPENHANDS_AUTHORING_SOURCE: path.join(f.root, 'explicit-public-source-path'), DATABASE_URL: 'postgresql://synthetic-invalid', TEST_DATABASE_URL: 'postgresql://synthetic-invalid', PM_SESSION_TOKEN: 'synthetic-token', NODE_OPTIONS: '--max-old-space-size=256' },
    timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(await readFile(path.join(f.root, 'executed'), 'utf8'), 'static\nbuild\nhost\nbackend\nagent\n');
  await rm(path.join(f.root, 'executed'));
  await f.put('scripts/check-ci.mjs', `import { appendFileSync } from 'node:fs'; const stage = process.argv[3]; appendFileSync('executed', stage + '\\n'); if (stage === 'build') process.exit(9);`);
  const failed = cliOptions(f.root);
  assert.equal(await runAffectedCli(['--file', 'apps/web/src/model.ts'], failed), 1);
  assert.equal(await readFile(path.join(f.root, 'executed'), 'utf8'), 'static\nbuild\n');
  assert.match(failed.errors.join('\n'), /failed \(9\)/);
});

test('nested CI cancellation waits for its cleanup owner without killing a sibling or starting another stage', { timeout: 40_000 }, async t => {
  const root = await mkdtemp('/var/tmp/dovspace-affected-cancel-');
  const children = [];
  const start = script => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const seen = new Set(), waiting = new Map();
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { seen.add(line); waiting.get(line)?.resolve(); });
    child.stderr.resume();
    const marker = async value => {
      if (seen.has(value)) return;
      const pending = Promise.withResolvers();
      waiting.set(value, pending);
      await Promise.race([pending.promise, closed.then(() => { throw new Error(`Fixture exited before synchronization marker ${value}`); })]);
    };
    const value = { child, closed, marker, seen };
    children.push(value);
    return value;
  };
  t.after(async () => {
    await writeFile(path.join(root, 'release-cleanup'), '').catch(() => {});
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(value => value.closed));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/check-ci.mjs'), `
import { existsSync, appendFileSync, watch, writeFileSync } from 'node:fs';
import { createCiCommandRunner, createCiRecorder } from ${JSON.stringify(new URL('./check-ci-process.mjs', import.meta.url).href)};
const recorder = createCiRecorder(process.cwd(), () => {});
let interrupted;
const runner = createCiCommandRunner({ cwd: process.cwd(), recorder, interrupted: () => interrupted });
const stop = signal => {
  appendFileSync('forwarded-signals', signal + '\\n');
  if (interrupted) return;
  interrupted = signal;
  runner.stop(signal);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
appendFileSync('executed', process.argv[3] + '\\n');
try {
  await runner.run('Owned cancellation fixture', process.execPath, ['-e', \`
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { clearInterval(timer); console.log('fixture:worker-stopped'); });
    console.log('fixture:worker-ready');
  \`], process.env);
} catch {
  process.exitCode = 143;
} finally {
  const released = new Promise(resolve => {
    const watcher = watch(process.cwd(), (_event, filename) => { if (filename === 'release-cleanup') check(); });
    const check = () => { if (existsSync('release-cleanup')) { watcher.close(); resolve(); } };
    check();
  });
  console.log('fixture:cleanup-ready');
  await released;
  writeFileSync('cleanup-complete', JSON.stringify({ home: process.env.HOME, homePresent: existsSync(process.env.HOME) }));
  recorder.close();
}
`);
  const sibling = start(`
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => { clearInterval(timer); console.log('fixture:sibling-stopped'); });
console.log('fixture:sibling-ready');
`);
  await sibling.marker('fixture:sibling-ready');
  const driver = start(`
import { runAffectedCli } from ${JSON.stringify(new URL('./check-affected.mjs', import.meta.url).href)};
process.exitCode = await runAffectedCli(['--file', 'pnpm-lock.yaml'], { cwd: process.cwd() });
`);
  await driver.marker('fixture:worker-ready');
  driver.child.kill('SIGTERM');
  await driver.marker('fixture:worker-stopped');
  await driver.marker('fixture:cleanup-ready');
  driver.child.kill('SIGINT'); // A second cancellation must not reach the cleanup owner.
  // The former outer supervisor killed the cleanup owner after its 10s grace
  // plus 2s supervised allowance. Hold a synchronized cleanup barrier past that
  // exact regression boundary; the child, not an outer timer, decides completion.
  await Promise.race([
    delay(12_250),
    driver.closed.then(() => { throw new Error('Affected exited while nested CI still owned cleanup'); }),
  ]);
  assert.equal(sibling.child.exitCode, null);
  assert.equal(sibling.seen.has('fixture:sibling-stopped'), false);
  await writeFile(path.join(root, 'release-cleanup'), '');
  assert.deepEqual(await driver.closed, { code: 1, signal: null });
  const cleanup = JSON.parse(await readFile(path.join(root, 'cleanup-complete'), 'utf8'));
  assert.equal(cleanup.homePresent, true);
  await assert.rejects(access(cleanup.home));
  assert.equal(await readFile(path.join(root, 'forwarded-signals'), 'utf8'), 'SIGTERM\n');
  assert.equal(await readFile(path.join(root, 'executed'), 'utf8'), 'static\n');
  assert.equal(sibling.child.exitCode, null);
});

test('real Web and Astro config/loaders ignore external dotenv fixtures only under the isolated marker', async t => {
  const f = await fixture(t);
  const web = path.join(f.root, 'apps/web'), marketing = path.join(f.root, 'apps/marketing');
  await mkdir(web, { recursive: true });
  await mkdir(marketing, { recursive: true });
  await f.put('package.json', '{"type":"module"}\n');
  await copyFile(path.join(repository, 'apps/web/vite.config.ts'), path.join(web, 'vite.config.ts'));
  await copyFile(path.join(repository, 'apps/marketing/astro.config.mjs'), path.join(marketing, 'astro.config.mjs'));
  await symlink(path.join(repository, 'apps/web/node_modules'), path.join(web, 'node_modules'), 'dir');
  await symlink(path.join(repository, 'apps/marketing/node_modules'), path.join(marketing, 'node_modules'), 'dir');
  await symlink(path.join(repository, 'vendor'), path.join(f.root, 'vendor'), 'dir');
  await f.put('.env', 'PM_WEB_PORT=45555\nPM_ENABLE_LAB=false\nVITE_DOVSPACE_DOTENV_FIXTURE=web-fixture\n');
  await f.put('apps/marketing/.env', 'PUBLIC_DOVSPACE_DOTENV_FIXTURE=marketing-fixture\nPRIVATE_DOVSPACE_DOTENV_FIXTURE=synthetic-not-a-secret\n');
  const script = `
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const web = path.join(root, 'apps/web'), marketing = path.join(root, 'apps/marketing');
const webRequire = createRequire(path.join(web, 'fixture.mjs'));
const { loadConfigFromFile, resolveConfig } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(web, 'vite.config.ts'), web, 'silent', undefined, 'native');
assert.ok(loaded);
const isolated = process.env.DOVSPACE_ISOLATED_CHECKS === '1';
assert.equal(loaded.config.server.port, isolated ? 4326 : 45555);
const resolved = await resolveConfig({ ...loaded.config, root: web, configFile: false, plugins: [] }, 'serve', 'test');
assert.equal(resolved.env.VITE_DOVSPACE_DOTENV_FIXTURE, isolated ? undefined : 'web-fixture');
const marketingRequire = createRequire(path.join(marketing, 'fixture.mjs'));
const astroConfigUrl = pathToFileURL(marketingRequire.resolve('astro/config'));
const { default: config } = await import(pathToFileURL(path.join(marketing, 'astro.config.mjs')).href);
const { createEnvLoader } = await import(new URL('../env/env-loader.js', astroConfigUrl).href);
const values = createEnvLoader({ mode: 'test', config: { ...config, root: pathToFileURL(marketing + path.sep) }, useStatic: true }).get();
assert.equal(values.PUBLIC_DOVSPACE_DOTENV_FIXTURE, isolated ? undefined : 'marketing-fixture');
assert.equal(values.PRIVATE_DOVSPACE_DOTENV_FIXTURE, isolated ? undefined : 'synthetic-not-a-secret');
`;
  for (const isolated of [false, true]) {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: f.root, env: { ...f.env, ...(isolated ? { DOVSPACE_ISOLATED_CHECKS: '1' } : {}) }, timeout: 60_000, maxBuffer: 1024 * 1024,
    });
  }
});
