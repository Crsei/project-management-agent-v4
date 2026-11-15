import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { CliRuntime } from '../../../../packages/pm-cli/runtime.ts';
import type { TerminalDescriptor } from '@agent-workspace/contracts/inspector';
import { agentLogin, agentLogout, connectAgent } from '../../../../packages/pm-cli/agent-connection.ts';
import { agentRuntimeFamily, terminalStream, type TerminalIo } from '../../../../packages/pm-cli/agent-runtime.ts';

const root = await mkdtemp(path.join(await realpath(tmpdir()), 'pm-cli-agent-runtime-'));
const code = path.join(root, 'code'), outside = path.join(root, 'outside');
const keys = ['AGENT_WORKSPACE_DATA_DIR', 'AGENT_WORKSPACE_ALLOWED_ROOTS', 'AGENT_WORKSPACE_ACCESS_TOKEN', 'PM_AGENT_URL', 'PM_AGENT_SESSION_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, 'data');
process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([root]);
process.env.AGENT_WORKSPACE_ACCESS_TOKEN = 'disposable-runtime-operator-' + 'a'.repeat(40);
process.env.PM_AGENT_SESSION_DIR = path.join(root, 'credentials');
process.env.GIT_CEILING_DIRECTORIES = root;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'isolated-git-config');
delete process.env.GIT_CONFIG_COUNT;
delete process.env.GIT_CONFIG_PARAMETERS;
// Durable/workspace modules snapshot environment at load time. These dynamic
// imports intentionally cross the isolated test module-loading boundary.
const { inspectorRoutes } = await import('./inspector/index.ts');
const { readInspectorProjection } = await import('./inspector/scope.ts');
const { attachTerminalUpgrade, stopTerminals } = await import('./inspector/terminal.ts');
const { openAgentWorkspace, updateAgentWorkspace } = await import('./agent-workspaces.ts');
const { ensureThread } = await import('./durable/threads.ts');
const { closeStore } = await import('./durable/store.ts');
const { accessGuard, accessRoutes } = await import('./access.ts');
const exec = promisify(execFile);
let agent: Server, origin: string, workspace: { id: string; revision: number }, serviceId: string;
const output: unknown[] = [];
const runtime: CliRuntime = {
  async authentication() { throw new Error('Agent runtime must not use PM authentication'); },
  async connection() { throw new Error('Agent runtime must not use PM authentication'); },
  async json() { throw new Error('Agent runtime must not use PM transport'); },
  async response() { throw new Error('Agent runtime must not use PM transport'); },
  print(value) { output.push(value); },
};
async function command(...args: string[]): Promise<unknown> {
  const start = output.length;
  assert.equal(await agentRuntimeFamily.dispatch(['agent', ...args], runtime), true);
  return output.length > start ? output.at(-1) : undefined;
}
before(async () => {
  await mkdir(code); await mkdir(outside); await mkdir(path.join(code, 'nested'));
  await writeFile(path.join(code, 'remote-only.txt'), 'server cwd, not CLI cwd\n');
  await writeFile(path.join(outside, 'secret.txt'), 'must never be projected');
  await symlink(outside, path.join(code, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  workspace = openAgentWorkspace({ path: code });
  ensureThread('runtime-session', undefined, { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision });
  const app = new Hono().route('/api', accessRoutes).use('/api/*', accessGuard).route('/api', inspectorRoutes);
  agent = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  if (!agent.listening) await once(agent, 'listening');
  attachTerminalUpgrade(agent);
  origin = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`; process.env.PM_AGENT_URL = origin;
  await agentLogin({ token: process.env.AGENT_WORKSPACE_ACCESS_TOKEN! });
  const listed = await command('terminal', 'list', '--workspace', workspace.id, '--revision', String(workspace.revision)) as { serviceId: string };
  serviceId = listed.serviceId;
});
after(async () => {
  await stopTerminals(); await agentLogout().catch(() => undefined); closeStore();
  const closed = once(agent, 'close'); agent.closeAllConnections(); agent.close(); await closed;
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  await rm(root, { recursive: true, force: true });
});

test('dispatch leaves unrelated prefixes untouched and validates finite options before connecting', async () => {
  assert.equal(await agentRuntimeFamily.dispatch(['agent', 'providers', 'list'], runtime), false);
  assert.equal(await agentRuntimeFamily.dispatch(['files', 'list'], runtime), false);
  await assert.rejects(command('files', 'write', '--session', 'runtime-session'), /Unknown agent files action/u);
  await assert.rejects(command('git', 'commit', '--session', 'runtime-session'), /Unknown agent git action/u);
  await assert.rejects(command('files', 'read', '--session', 'runtime-session', '--path', '../outside/secret.txt'), /relative/u);
  await assert.rejects(command('files', 'list', '--session', 'runtime-session', '--cwd', code), /Unknown or unsupported option/u);
  await assert.rejects(command('terminal', 'create', '--workspace', workspace.id, '--revision', String(workspace.revision), '--request-id', randomUUID()), /service-id/u);
});

test('Files are bounded Session projections of actual server cwd, never the CLI working directory', async () => {
  const cwd = process.cwd(); process.chdir(outside);
  try {
    const file = await command('files', 'read', '--session', 'runtime-session', '--path', 'remote-only.txt') as { content: string };
    assert.equal(file.content, 'server cwd, not CLI cwd\n');
    const tree = await command('files', 'list', '--session', 'runtime-session') as { root: string; entries: { name: string }[] };
    assert.equal(tree.root, code); assert.ok(tree.entries.some(entry => entry.name === 'remote-only.txt'));
    assert.ok(!tree.entries.some(entry => entry.name === 'escape'));
    await assert.rejects(command('files', 'read', '--session', 'runtime-session', '--path', 'escape/secret.txt'), { code: 'invalid_path' });
    const found = await command('files', 'search', '--session', 'runtime-session', '--query', 'remote-only') as { entries: { path: string }[] };
    assert.deepEqual(found.entries.map(entry => entry.path), ['remote-only.txt']);
  } finally { process.chdir(cwd); }
});

test('Git distinguishes non-repository, empty repository, real diff and Git executable failure', async () => {
  const nonRepo = await command('git', 'status', '--session', 'runtime-session') as { repo: boolean };
  assert.equal(nonRepo.repo, false);
  await assert.rejects(command('git', 'diff', '--session', 'runtime-session', '--path', 'remote-only.txt'), { code: 'not_a_repo' });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: code });
  const empty = await command('git', 'status', '--session', 'runtime-session') as { repo: boolean; files: { path: string }[] };
  assert.equal(empty.repo, true); assert.ok(empty.files.some(file => file.path === 'remote-only.txt'));
  const diff = await command('git', 'diff', '--session', 'runtime-session', '--path', 'remote-only.txt') as { untracked: boolean; patch: string };
  assert.equal(diff.untracked, true); assert.match(diff.patch, /server cwd, not CLI cwd/u);
  const oldPath = process.env.PATH; process.env.PATH = path.join(root, 'missing-bin');
  try { await assert.rejects(command('git', 'status', '--session', 'runtime-session'), { code: 'git_failed' }); }
  finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
});

test('read-only Git status/diff fail before either clean or process filter can execute', async () => {
  const filtered = path.join(root, 'filtered'); await mkdir(filtered);
  await exec('git', ['init', '-q'], { cwd: filtered });
  await writeFile(path.join(filtered, 'tracked.txt'), 'before\n');
  await exec('git', ['add', 'tracked.txt'], { cwd: filtered });
  await writeFile(path.join(filtered, '.gitattributes'), '*.txt filter=inert\n');
  await writeFile(path.join(filtered, 'tracked.txt'), 'changed worktree bytes\n');
  const marker = path.join(filtered, 'filter-invoked');
  const script = path.join(filtered, 'inert-filter.cjs');
  // An accidental invocation is observable but inert: append only inside this
  // disposable repository, then exit immediately (never a hanging Git protocol).
  await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)},'invoked\\n');process.exit(1);`);
  const selected = openAgentWorkspace({ path: filtered });
  ensureThread('filter-session', undefined, { version: 2, agentWorkspaceId: selected.id, agentWorkspaceRevision: selected.revision });
  for (const mode of ['clean', 'process']) {
    const key = `filter.inert.${mode}`;
    await exec('git', ['config', key, `"${process.execPath}" "${script}"`], { cwd: filtered });
    try {
      await assert.rejects(command('git', 'status', '--session', 'filter-session'), { code: 'git_filter_unsupported' });
      await assert.rejects(command('git', 'diff', '--session', 'filter-session', '--path', 'tracked.txt'), { code: 'git_filter_unsupported' });
      await assert.rejects(access(marker), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(filtered, 'tracked.txt'), 'utf8'), 'changed worktree bytes\n');
    } finally { await exec('git', ['config', '--unset-all', key], { cwd: filtered }); }
  }
  const ordinary = await command('git', 'status', '--session', 'filter-session') as { repo: boolean };
  assert.equal(ordinary.repo, true, 'an attribute without an executable filter is still inspectable');
  // Installed but unused global-style filter definitions must not disable
  // ordinary repositories; only an attribute selecting an executable matters.
  await exec('git', ['config', 'filter.unused.clean', `"${process.execPath}" "${script}"`], { cwd: filtered });
  try {
    const unrelated = await command('git', 'status', '--session', 'filter-session') as { repo: boolean };
    assert.equal(unrelated.repo, true);
    const unrelatedDiff = await command('git', 'diff', '--session', 'filter-session', '--path', 'tracked.txt') as { patch: string };
    assert.match(unrelatedDiff.patch, /changed worktree bytes/);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await exec('git', ['config', '--unset-all', 'filter.unused.clean'], { cwd: filtered }); }
});

test('explicit ignored targets and index-only attributes are covered before Git content conversion', async () => {
  const filtered = path.join(root, 'filter-target-coverage'); await mkdir(filtered);
  await exec('git', ['init', '-q'], { cwd: filtered });
  await writeFile(path.join(filtered, 'tracked.log'), 'ordinary indexed bytes\n');
  await exec('git', ['add', 'tracked.log'], { cwd: filtered });
  await mkdir(path.join(filtered, 'hidden')); await mkdir(path.join(filtered, 'mixed', 'hidden'), { recursive: true });
  await writeFile(path.join(filtered, 'hidden', 'ignored.txt'), 'ignored target bytes\n');
  await writeFile(path.join(filtered, 'mixed', 'plain.log'), 'ordinary untracked bytes\n');
  await writeFile(path.join(filtered, 'mixed', 'hidden', 'ignored.txt'), 'ignored descendant bytes\n');
  await writeFile(path.join(filtered, '.gitignore'), 'hidden/\nmixed/hidden/\n');
  await writeFile(path.join(filtered, '.gitattributes'), 'hidden/*.txt filter=inert\nmixed/hidden/*.txt filter=inert\n');
  const marker = path.join(filtered, 'filter-invoked'), script = path.join(filtered, 'inert-filter.cjs');
  await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)},'invoked\\n');process.exit(1);`);
  const selected = openAgentWorkspace({ path: filtered });
  ensureThread('filter-target-session', undefined, { version: 2, agentWorkspaceId: selected.id, agentWorkspaceRevision: selected.revision });
  await exec('git', ['config', 'filter.inert.clean', `"${process.execPath}" "${script}"`], { cwd: filtered });
  try {
    const ordinary = await command('git', 'status', '--session', 'filter-target-session') as { repo: boolean };
    assert.equal(ordinary.repo, true, 'ignored targets not inspected by ordinary status must not disable it');
    await assert.rejects(command('git', 'diff', '--session', 'filter-target-session', '--path', 'hidden/ignored.txt'), { code: 'git_filter_unsupported' });
    await assert.rejects(command('git', 'diff', '--session', 'filter-target-session', '--path', 'mixed'), { code: 'git_filter_unsupported' });
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await exec('git', ['config', '--unset-all', 'filter.inert.clean'], { cwd: filtered }); }
  // The working attributes disable filters, but the staged attributes still
  // select one. Both views must be considered before a staged/read conversion.
  await writeFile(path.join(filtered, '.gitattributes'), '*.log filter=inert\n');
  await exec('git', ['add', '.gitattributes'], { cwd: filtered });
  await writeFile(path.join(filtered, '.gitattributes'), '*.log -filter\n');
  await exec('git', ['config', 'filter.inert.process', `"${process.execPath}" "${script}"`], { cwd: filtered });
  try {
    await assert.rejects(command('git', 'diff', '--session', 'filter-target-session', '--path', 'tracked.log', '--staged', 'true'), { code: 'git_filter_unsupported' });
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await exec('git', ['config', '--unset-all', 'filter.inert.process'], { cwd: filtered }); }
});

test('HTTP projections reject drive-relative paths before native path resolution', async () => {
  const connection = await connectAgent();
  try {
    for (const relative of ['C:relative', 'D:relative', 'C:\\absolute', 'D:/absolute']) {
      const result = await connection.request(`/api/inspector/files?${new URLSearchParams({ threadId: 'runtime-session', path: relative })}`);
      assert.equal(result.status, 400);
      assert.equal((await result.json() as { code: string }).code, 'invalid_path');
    }
  } finally { connection.close(); }
});

if (process.platform === 'win32') test('Windows cross-volume junction cannot expose Files or become a PTY cwd', {
  skip: !process.env.PM_CLI_TEST_OTHER_VOLUME ? 'set PM_CLI_TEST_OTHER_VOLUME to a writable disposable parent on another volume' : false,
}, async () => {
  const parent = await realpath(process.env.PM_CLI_TEST_OTHER_VOLUME!);
  assert.notEqual(path.parse(parent).root.toLowerCase(), path.parse(root).root.toLowerCase(), 'the fixture must actually cross volumes');
  const target = await mkdtemp(path.join(parent, 'cli-cross-volume-'));
  const junction = path.join(code, 'other-volume');
  try {
    await writeFile(path.join(target, 'outside.txt'), 'must not escape\n');
    await symlink(target, junction, 'junction');
    await assert.rejects(command('files', 'list', '--session', 'runtime-session', '--path', 'other-volume'), { code: 'invalid_path' });
    await assert.rejects(command('terminal', 'create', '--workspace', workspace.id, '--revision', String(workspace.revision),
      '--service-id', serviceId, '--request-id', randomUUID(), '--path', 'other-volume'), { code: 'invalid_terminal_request' });
  } finally { await rm(junction, { force: true }); await rm(target, { recursive: true, force: true }); }
});

test('read completion preserves metadata changes but rechecks root inode, current allowed scope and Agent access', async () => {
  const selected = path.join(root, 'changing'); await mkdir(selected);
  let current = openAgentWorkspace({ path: selected });
  ensureThread('changing-session', undefined, { version: 2, agentWorkspaceId: current.id, agentWorkspaceRevision: current.revision });
  const url = new URL(`${origin}/api/inspector/files?threadId=changing-session`);
  const loginResponse = await fetch(`${origin}/api/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token: process.env.AGENT_WORKSPACE_ACCESS_TOKEN }) });
  const cookie = loginResponse.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value!.startsWith('agent_v4_access='))!;
  const headers = new Headers({ host: new URL(origin).host, origin, cookie });
  await assert.rejects(readInspectorProjection(url, headers, async () => {
    await rename(selected, `${selected}-old`); await mkdir(selected); return 'must not escape';
  }), /replaced|changed|unavailable/iu);
  await rm(selected, { recursive: true }); await rename(`${selected}-old`, selected);
  const metadataRead = await readInspectorProjection(url, headers, async () => {
    current = updateAgentWorkspace(current.id, { expectedRevision: current.revision, name: 'Renamed while reading', archived: true });
    return 'the existing Session keeps its immutable directory binding';
  });
  assert.equal(metadataRead, 'the existing Session keeps its immutable directory binding');
  const allowedRoots = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS!;
  try {
    await assert.rejects(readInspectorProjection(url, headers, async () => {
      process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([outside]); return 'must not escape revoked scope';
    }), { code: 'directory_not_allowed' });
  } finally { process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = allowedRoots; }
  const mainUrl = new URL(`${origin}/api/inspector/files?threadId=runtime-session`);
  const originalToken = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  try {
    await assert.rejects(readInspectorProjection(mainUrl, headers, async () => { process.env.AGENT_WORKSPACE_ACCESS_TOKEN = 'rotated-disposable-' + 'b'.repeat(40); return 'private'; }), { code: 'access_required' });
  } finally { process.env.AGENT_WORKSPACE_ACCESS_TOKEN = originalToken; }
});

test('real PTY input/resize/attach output/cancel/close use the original service-owned process', { skip: process.platform === 'win32' }, async () => {
  const requestId = randomUUID();
  const created = await command('terminal', 'create', '--workspace', workspace.id, '--revision', String(workspace.revision), '--service-id', serviceId, '--request-id', requestId, '--path', 'nested') as { terminal: TerminalDescriptor };
  const terminal = created.terminal; assert.equal(terminal.startCwd, path.join(code, 'nested'));
  const duplicate = await command('terminal', 'create', '--workspace', workspace.id, '--revision', String(workspace.revision), '--service-id', serviceId, '--request-id', requestId, '--path', 'nested') as { terminal: TerminalDescriptor };
  assert.equal(duplicate.terminal.id, terminal.id);
  await assert.rejects(command('terminal', 'get', '--id', terminal.id, '--service-id', randomUUID()), { code: 'terminal_service_changed' });
  const args = ['--id', terminal.id, '--service-id', serviceId];
  assert.equal((await command('terminal', 'resize', ...args, '--cols', '91', '--rows', '31') as { resized: boolean }).resized, true);
  const connection = await connectAgent();
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  const io = { input, output, error: new PassThrough(), signals } as unknown as TerminalIo;
  const controller = new AbortController();
  let text = '';
  const sawOutput = Promise.withResolvers<void>();
  output.on('data', chunk => { text += chunk.toString(); if (text.includes('__ACTUAL_PTY__\r\n')) sawOutput.resolve(); });
  const attached = terminalStream(connection, terminal, 'attach', { clientId: 'behavior-test', signal: controller.signal }, io);
  try {
    const result = await command('terminal', 'input', ...args, '--text', "stty -echo; printf '__ACTUAL_PTY__\\n'; stty size\n") as { acknowledged: boolean };
    assert.equal(result.acknowledged, true);
    // This is a real native PTY/WS integration, not a sleep: await its output
    // event, with only a failure deadline that cannot use a fake process clock.
    const deadline = setTimeout(() => sawOutput.reject(new Error('real PTY output timed out')), 10_000);
    try { await sawOutput.promise; } finally { clearTimeout(deadline); }
    controller.abort(); await assert.rejects(attached, /cancelled/u);
    assert.equal(input.listenerCount('data'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal((await command('terminal', 'get', ...args) as { terminal: TerminalDescriptor }).terminal.status, 'running');
    await command('terminal', 'close', ...args);
  } finally { connection.close(); input.destroy(); output.destroy(); }
});

test('main CLI local PTY detach exits with an open stdin pipe and leaves the server process running', { skip: process.platform === 'win32' }, async () => {
  const token = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  const created = await command('terminal', 'create', '--workspace', workspace.id, '--revision', String(workspace.revision),
    '--service-id', serviceId, '--request-id', randomUUID()) as { terminal: TerminalDescriptor };
  const args = ['--id', created.terminal.id, '--service-id', serviceId];
  const finished = Promise.withResolvers<void>(), observed = Promise.withResolvers<void>();
  let child: ReturnType<typeof execFile> | undefined;
  try {
    await command('terminal', 'input', ...args, '--text', "printf '__PIPE_DETACH__\\n'\n");
    child = execFile(process.execPath, [path.resolve(import.meta.dirname, '../../../../packages/pm-cli/index.ts'), 'agent', 'terminal', 'attach', ...args],
      { timeout: 10_000 }, error => { if (error) finished.reject(error); else finished.resolve(); });
    let output = '';
    child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('__PIPE_DETACH__\r\n')) observed.resolve(); });
    await Promise.race([observed.promise, finished.promise.then(() => { throw new Error('Attachment ended before PTY output'); })]);
    child.stdin!.write('\u001d');
    // Do not end stdin: detaching must release the CLI's own read handle.
    await finished.promise;
    assert.equal((await command('terminal', 'get', ...args) as { terminal: TerminalDescriptor }).terminal.status, 'running');
  } finally {
    child?.kill('SIGTERM');
    await command('terminal', 'close', ...args);
    if (token === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN; else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  }
});

test('service stop invalidates original PTY identities rather than restoring or rerunning them', { skip: process.platform === 'win32' }, async () => {
  const created = await command('terminal', 'create', '--workspace', workspace.id, '--revision', String(workspace.revision),
    '--service-id', serviceId, '--request-id', randomUUID()) as { terminal: TerminalDescriptor };
  await stopTerminals();
  await assert.rejects(command('terminal', 'get', '--id', created.terminal.id, '--service-id', serviceId), { code: 'terminal_unavailable' });
});
