import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import { z } from 'zod';
import { agentDeliveryFamily } from '../../../../packages/pm-cli/agent-delivery.ts';
import { agentLogin, agentLogout } from '../../../../packages/pm-cli/agent-connection.ts';
import type { CliRuntime } from '../../../../packages/pm-cli/runtime.ts';
import { accessGuard, accessRoutes } from './access.ts';
import { DeliveryError, TaskCodeDeliveryService, type DeliveryPorts } from '../../../../packages/application/src/task-code-delivery.ts';
import { TaskWorkflowService, type WorkflowPorts } from '../../../../packages/application/src/task-workflow.ts';
import { deliveryActionSchema, deliveryScopeSchema, prepareDeliverySchema, type DeliveryTree, type TaskCodeDelivery } from '../../../../packages/contracts/src/task-code-delivery.ts';
import { workflowControlSchema, workflowSaveSchema, workflowStartSchema, workflowTemplates, type WorkflowDefinition, type WorkflowRun } from '../../../../packages/contracts/src/task-workflow.ts';
import { appPreviewActionSchema } from '../../../../packages/contracts/src/task-app-preview.ts';
import { AppPreviewManager } from './task-delivery/app-preview.ts';
import { git } from './task-delivery/git.ts';

const scope = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', taskId: 'TASK-001' };
const id = '22222222-2222-4222-8222-222222222222';
const folder = { version: 2 as const, agentWorkspaceId: 'explicit-agent-folder', agentWorkspaceRevision: 1 };
const scopeArgs = ['--workspace-id', scope.workspaceId, '--project-id', scope.projectId, '--task-id', scope.taskId];
const base = 'a'.repeat(40), head = 'b'.repeat(40);

/** Actual accessGuard + application services over disposable HTTP. Git/Provider
 * ports are controlled protocol boundaries, NOT real GitHub or paid inference. */
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'cli-agent-delivery-'));
  const keys = ['AGENT_WORKSPACE_ACCESS_TOKEN', 'AGENT_APPROVAL_MODE', 'PM_AGENT_URL', 'PM_AGENT_SESSION_DIR', 'AGENT_WORKSPACE_DATA_DIR'] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const token = 'disposable-operator-' + 'x'.repeat(43), pmToken = 'p'.repeat(43);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  process.env.AGENT_APPROVAL_MODE = 'ask';
  process.env.PM_AGENT_SESSION_DIR = path.join(root, 'credentials');
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, 'agent-data');
  const records = new Map<string, TaskCodeDelivery>(), definitions = new Map<string, WorkflowDefinition>(), runs = new Map<string, WorkflowRun>();
  const calls: string[] = [], requests: string[] = [];
  const task = { ...scope, revision: 'r1', title: 'Scoped requirement', description: 'Acceptance from actual task', root: '/fixture/repo', status: 'todo' };
  let tree: DeliveryTree = { head: base, fingerprint: 'base-tree', files: [], diff: '' };
  let remote: string | null = null, pr: { number: number; url: string } | null = null, allowed = true;
  const authorize: DeliveryPorts['authorize'] = async value => {
    if (!allowed || value.workspaceId !== scope.workspaceId || value.projectId !== scope.projectId || value.taskId !== scope.taskId) throw new DeliveryError('denied', 'Current PM scope denied');
    return { ...task };
  };
  const ports: DeliveryPorts = {
    read: key => structuredClone(records.get(key) ?? null), list: () => structuredClone([...records.values()]), save: value => { records.set(value.id, structuredClone(value)); }, authorize,
    prepare: async () => { calls.push('prepare'); return { root: task.root, directory: '/fixture/worktree', directoryIdentity: '1:2', commonDirectory: '/fixture/repo/.git', remote: 'https://github.com/example/fixture.git', owner: 'example', repo: 'fixture', baseBranch: 'main', baseSha: base, branch: 'codex/cli-test' }; },
    verify: async () => {}, tree: async () => structuredClone(tree), busy: () => false,
    develop: async value => { calls.push('develop'); if (value.worktreeWriteConfirmed) tree = { head: base, fingerprint: 'edited-tree', files: ['src/a.ts'], diff: '+ actual change boundary' }; return 'original-generation'; },
    generation: () => ({ id: 'original-generation', status: 'completed' }),
    test: async () => { calls.push('test'); return { exitCode: 0, outputDigest: 'captured-output-digest' }; },
    commit: async () => { calls.push('commit'); tree = { head, fingerprint: 'committed-tree', files: [], diff: '' }; return head; },
    push: async () => { calls.push('push'); remote = head; }, remoteHead: async () => remote,
    findPr: async () => pr, createPr: async () => { calls.push('pr'); pr = { number: 7, url: 'https://github.com/example/fixture/pull/7' }; return pr; },
    feedback: async () => ({ head, state: 'open', draft: true, observedAt: '2026-11-13T00:00:00.000Z', checks: [{ name: 'test', status: 'completed', conclusion: 'success' }], reviews: [] }),
  };
  const delivery = new TaskCodeDeliveryService(ports);
  const workflowPorts: WorkflowPorts = {
    readDefinition: key => structuredClone(definitions.get(key) ?? null), definitions: () => structuredClone([...definitions.values()]), saveDefinition: value => { definitions.set(value.id, structuredClone(value)); },
    readRun: key => structuredClone(runs.get(key) ?? null), runs: () => structuredClone([...runs.values()]), saveRun: value => { runs.set(value.id, structuredClone(value)); },
    authorize, repository: async () => 'example/fixture', provider: async () => {}, delivery, readDelivery: ports.read,
  };
  const workflow = new TaskWorkflowService(workflowPorts), previews = new AppPreviewManager(0);
  const app = new Hono().route('/api', accessRoutes).use('/api/*', accessGuard).use('/api/*', async (c, next) => {
    requests.push(c.req.path);
    if (c.req.header('authorization') !== `Bearer ${pmToken}`) return c.json({ error: 'Native PM actor required' }, 401);
    return next();
  });
  app.onError((error, c) => c.json({ error: 'Rejected by current authority', code: error instanceof DeliveryError ? error.code : 'invalid_input' }, error instanceof DeliveryError ? 409 : error instanceof z.ZodError ? 400 : 500));
  app.get('/api/task-deliveries', async c => c.json({ items: await delivery.list(deliveryScopeSchema.parse(c.req.query())) }));
  app.post('/api/task-deliveries', async c => c.json(await delivery.prepare(prepareDeliverySchema.parse(await c.req.json()))));
  app.get('/api/task-deliveries/:id', async c => c.json(await delivery.inspect(c.req.param('id'))));
  app.post('/api/task-deliveries/:id/actions', async c => c.json(await delivery.act(c.req.param('id'), deliveryActionSchema.parse(await c.req.json()))));
  app.get('/api/task-workflows', async c => { const { executionSelection, ...query } = c.req.query(); return c.json(await workflow.catalog({ ...deliveryScopeSchema.parse(query), ...(executionSelection ? { executionSelection: JSON.parse(executionSelection) } : {}) })); });
  app.post('/api/task-workflows/definitions', async c => c.json(await workflow.saveDefinition(workflowSaveSchema.parse(await c.req.json()))));
  app.post('/api/task-workflows/runs', async c => c.json(await workflow.start(workflowStartSchema.parse(await c.req.json()))));
  app.get('/api/task-workflows/runs/:id', async c => c.json(await workflow.read(c.req.param('id'))));
  app.post('/api/task-workflows/runs/:id/control', async c => { const body = workflowControlSchema.parse(await c.req.json()); return c.json(body.action === 'new-session' ? await workflow.replaceSession(c.req.param('id'), body.version, body.executionSelection) : await workflow.control(c.req.param('id'), body.action, body.version)); });
  app.get('/api/task-deliveries/:id/preview', async c => { const value = ports.read(c.req.param('id')); if (!value) throw new DeliveryError('not_found', 'Missing receipt'); await authorize(value, false); return c.json(await previews.inspect(value.id, await previews.supported(value))); });
  app.post('/api/task-deliveries/:id/preview', async c => {
    const input = appPreviewActionSchema.parse(await c.req.json()), value = ports.read(c.req.param('id'));
    if (!value) throw new DeliveryError('not_found', 'Missing receipt'); await authorize(value, true);
    if (input.action === 'stop') { await previews.stop(value.id); return c.json(previews.state(value.id, await previews.supported(value))); }
    return c.json(await previews.start(value, input.head));
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const route = incoming.url!.replace(/^\/agent(?=\/)/, '');
      const response = await app.fetch(new Request(`http://${incoming.headers.host}${route}`, { method: incoming.method ?? 'GET', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries())); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.PM_AGENT_URL = `${origin}/agent`;
  const output: unknown[] = [];
  const runtime: CliRuntime = {
    async authentication() { return { origin, headers: { Authorization: `Bearer ${pmToken}` } }; },
    async connection() { throw new Error('Explicit delivery scopes must not require unrelated workspace selection'); },
    async json() { throw new Error('PM HTTP proxy must not be used'); }, async response() { throw new Error('PM HTTP proxy must not be used'); }, print(value) { output.push(value); },
  };
  await agentLogin({ token });
  return {
    root, runtime, output, calls, records, definitions, runs, task, ports, workflow, requests,
    async run(...args: string[]) { output.length = 0; assert.equal(await agentDeliveryFamily.dispatch(['agent', ...args], runtime), true); return output.at(-1); },
    async file(name: string, value: unknown) { const filename = path.join(root, name); await writeFile(filename, JSON.stringify(value)); return filename; },
    setTree(value: DeliveryTree) { tree = value; }, deny() { allowed = false; }, allow() { allowed = true; },
    async close() {
      await previews.close(); await agentLogout().catch(() => undefined);
      const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
      for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
      await rm(root, { recursive: true, force: true });
    },
  };
}

const neverConnect: CliRuntime = {
  async authentication() { throw new Error('Unexpected identity lookup'); }, async connection() { throw new Error('Unexpected workspace selection'); }, async json() { throw new Error('Unexpected PM request'); }, async response() { throw new Error('Unexpected PM response'); }, print() { throw new Error('Unexpected output'); },
};

test('unowned Agent commands are untouched; invalid finite commands and publication consent fail before identity lookup', async () => {
  for (const args of [['task', 'list'], ['agent', 'session', 'list'], ['agent', 'provider', 'list']]) assert.equal(await agentDeliveryFamily.dispatch(args, neverConnect), false);
  for (const args of [
    ['agent', 'delivery', 'shell', 'git push'], ['agent', 'workflow', 'dag', '--file', 'arbitrary.json'], ['agent', 'preview', 'task', 'exec', id],
    ['agent', 'delivery', 'push', id, '--head', head], ['agent', 'delivery', 'commit', id, '--fingerprint', 'x', '--confirm', 'false'],
    ['agent', 'delivery', 'get', `${id}/actions`], ['agent', 'delivery', 'get', id, '--cwd', '/tmp'],
    ['agent', 'workflow', 'approve', id, '--version', '1e2', '--confirm', 'true'], ['agent', 'preview', 'task', 'start', id, '--head', head, '--confirm', 'true', '--command', 'node arbitrary.mjs'],
  ]) await assert.rejects(agentDeliveryFamily.dispatch(args, neverConnect), error => error instanceof Error && !error.message.includes('Unexpected'));
});

test('delivery CLI preserves independent operator plus current PM actor and original unknown publication receipts', async () => {
  const f = await fixture();
  try {
    const input = { ...scope, id, taskRevision: 'r1', baseBranch: 'main', executionSelection: folder };
    await f.run('delivery', 'prepare', '--file', await f.file('prepare.json', input));
    await f.run('delivery', 'prepare', '--file', await f.file('same-prepare.json', input));
    assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
    const development = await f.file('develop.json', { providerInstanceId: 'explicit-provider', model: 'explicit-model', purpose: 'development', allowWorktreeWrite: true });
    await f.run('delivery', 'develop', id, '--file', development);
    await f.run('delivery', 'refresh', id);
    assert.equal(f.records.get(id)?.step, 'developed'); assert.equal(f.task.status, 'todo', 'run success is not Done');
    await f.run('delivery', 'test', id, '--command', 'fixture-verification', '--confirm', 'true');
    assert.equal(f.records.get(id)?.test?.taskRevision, 'r1'); assert.equal(f.records.get(id)?.test?.head, base);
    f.setTree({ head: base, fingerprint: 'changed-after-test', files: ['src/a.ts'], diff: '+changed again' });
    await assert.rejects(f.run('delivery', 'commit', id, '--fingerprint', 'edited-tree', '--confirm', 'true'), { code: 'AGENT_DELIVERY_REQUEST_FAILED', status: 409 });
    assert.equal(f.calls.includes('commit'), false);
    f.setTree({ head: base, fingerprint: 'edited-tree', files: ['src/a.ts'], diff: '+original verified change' });
    await f.run('delivery', 'commit', id, '--fingerprint', 'edited-tree', '--confirm', 'true');
    const push = f.ports.push; f.ports.push = async value => { await push(value); throw new Error('lost push acknowledgement'); };
    await assert.rejects(f.run('delivery', 'push', id, '--head', head, '--confirm', 'true'), { code: 'AGENT_DELIVERY_OUTCOME_UNKNOWN' });
    assert.equal((f.output[0] as TaskCodeDelivery).pending?.action, 'push');
    await assert.rejects(f.run('delivery', 'push', id, '--head', head, '--confirm', 'true'), { status: 409 });
    await f.run('delivery', 'get', id); await f.run('delivery', 'refresh', id);
    assert.equal(f.calls.filter(call => call === 'push').length, 1);
    const create = f.ports.createPr; f.ports.createPr = async value => { await create(value); throw new Error('lost PR acknowledgement'); };
    await assert.rejects(f.run('delivery', 'draft-pr', id, '--head', head, '--confirm', 'true'), { code: 'AGENT_DELIVERY_OUTCOME_UNKNOWN' });
    await f.run('delivery', 'refresh', id);
    assert.equal(f.calls.filter(call => call === 'pr').length, 1);
    const receipt = f.records.get(id)!;
    assert.equal(receipt.feedback?.head, head); assert.equal(receipt.feedback?.fingerprint, 'committed-tree'); assert.equal(receipt.feedback?.taskRevision, 'r1');
    const before = [...f.calls];
    await f.run('delivery', 'new-session', id, '--selection-file', await f.file('selection.json', folder), '--confirm', 'true');
    assert.deepEqual(f.calls, before); assert.equal(f.records.get(id)?.generationId, 'original-generation'); assert.equal(f.records.get(id)?.previousThreadIds?.length, 1);
    f.task.revision = 'edited-requirement';
    assert.equal((await f.run('delivery', 'get', id) as { taskChanged: boolean }).taskChanged, true);
    await assert.rejects(f.run('delivery', 'push', id, '--head', head, '--confirm', 'true'), { status: 409 });
    f.deny(); await assert.rejects(f.run('delivery', 'list', ...scopeArgs), { status: 409 });
  } finally { await f.close(); }
});

test('workflow CLI pins immutable published node version and enforces CAS, current approval authority and finite graph prerequisites', async () => {
  const f = await fixture();
  try {
    const graph = structuredClone(workflowTemplates[0]!.draft);
    graph.nodes.splice(3, 0, { id: 'human', kind: 'approval', label: 'Human continue, not business review', x: 0, y: 0, config: {} });
    graph.edges[2]!.target = 'human'; graph.edges.push({ id: 'human-next', source: 'human', target: 'end3', port: 'next' });
    const definition = { ...scope, id, expectedRevision: 0, graph, publish: true };
    const invalid = structuredClone(graph); invalid.edges = [];
    await assert.rejects(f.run('workflow', 'save-definition', '--file', await f.file('invalid-graph.json', { ...definition, graph: invalid })), { status: 409 });
    assert.equal(f.definitions.size, 0, 'missing finite-node prerequisites never publish a version');
    await f.run('workflow', 'save-definition', '--file', await f.file('definition.json', definition));
    const input = { ...scope, id, taskRevision: 'r1', definitionId: id, definitionVersion: 1, baseBranch: 'main', repository: 'example/fixture', providerInstanceId: 'chosen-provider', model: 'chosen-model', executionSelection: folder, consent: { execute: true, worktreeWrite: false, commit: false, push: false, draftPr: false } };
    await assert.rejects(f.run('workflow', 'start', '--file', await f.file('unpublished.json', { ...input, definitionVersion: 99 })), { status: 409 });
    await f.run('workflow', 'start', '--file', await f.file('start.json', input));
    const pinned = f.runs.get(id)!.graph;
    graph.name = 'Future graph';
    await f.run('workflow', 'save-definition', '--file', await f.file('next-version.json', { ...definition, expectedRevision: 1, graph }));
    assert.deepEqual(f.runs.get(id)!.graph, pinned);
    for (let count = 0; count < 8 && f.runs.get(id)!.current !== 'human'; count++) await f.workflow.tick(id);
    await f.workflow.tick(id);
    const waiting = f.runs.get(id)!; assert.equal(waiting.status, 'waiting');
    await assert.rejects(f.run('workflow', 'approve', id, '--version', String(waiting.version - 1), '--confirm', 'true'), { status: 409 });
    f.deny(); await assert.rejects(f.run('workflow', 'approve', id, '--version', String(waiting.version), '--confirm', 'true'), { status: 409 });
    assert.equal(f.runs.get(id)?.status, 'waiting'); assert.equal(f.task.status, 'todo'); assert.deepEqual(f.calls, ['prepare', 'develop']);
    f.allow();
    await assert.rejects(f.run('workflow', 'confirm-transition', id, '--version', String(waiting.version), '--confirm', 'true'), { status: 409 });
    await f.run('workflow', 'approve', id, '--version', String(waiting.version), '--confirm', 'true');
    await f.workflow.tick(id); assert.equal(f.runs.get(id)?.status, 'completed'); assert.equal(f.task.status, 'todo');
    assert.deepEqual(f.calls, ['prepare', 'develop'], 'approval/recovery never replays the original Agent');
  } finally { await f.close(); }
});

test('development files cannot smuggle another operation or expand ordinary Session publication', async () => {
  const f = await fixture();
  try {
    const count = f.requests.length;
    for (const extra of [{ action: 'push', head, confirm: true }, { cwd: '/etc' }, { endpoint: '/api/private' }, { command: 'git push' }]) {
      const file = await f.file('smuggled.json', { providerInstanceId: 'provider', model: 'model', ...extra });
      await assert.rejects(f.run('delivery', 'develop', id, '--file', file));
    }
    assert.equal(f.requests.length, count); assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

function previewPage(url: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  const call = request({ hostname: '127.0.0.1', port: target.port, path: '/', headers: { host: target.host }, timeout: 3000 }, response => {
    let body = ''; response.on('data', chunk => { body += String(chunk); }); response.on('end', () => resolve({ status: response.statusCode!, body }));
  });
  call.once('error', reject); call.once('timeout', () => call.destroy(new Error('Preview read timeout'))); call.end();
  return promise;
}

// Real Linux namespaces are opt-in and never replaced with a host-process fake.
// PM_PREVIEW_EXPECT_NAMESPACE_REJECTION is for an actually restricted namespace
// environment; it does not mock bwrap, loosen isolation, or count as lifecycle proof.
test('CLI real fixed app preview lifecycle or explicit namespace rejection', { skip: process.env.PM_PREVIEW_SANDBOX_TEST !== '1' && process.env.PM_PREVIEW_EXPECT_NAMESPACE_REJECTION !== '1' }, async () => {
  const f = await fixture();
  try {
    const repository = path.join(f.root, 'repository'), directory = path.join(f.root, 'worktree'); await mkdir(repository); await mkdir(path.join(repository, 'app'));
    await git(repository, 'init', '-b', 'main'); await git(repository, 'config', 'user.name', 'Disposable preview'); await git(repository, 'config', 'user.email', 'preview@example.invalid');
    await writeFile(path.join(repository, 'app/server.mjs'), `import http from 'node:http';import fs from 'node:fs';const file=process.env.DATA_DIR+'/count';let count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;http.createServer((req,res)=>{if(req.url==='/health'){res.end('ok');return}fs.writeFileSync(file,String(++count));res.end(String(count))}).listen(process.env.PREVIEW_SOCKET);`);
    await git(repository, 'add', 'app'); await git(repository, 'commit', '-m', 'Disposable fixed preview protocol'); await git(repository, 'remote', 'add', 'origin', 'https://github.com/example/disposable.git');
    const commit = (await git(repository, 'rev-parse', 'HEAD')).trim(); await git(repository, 'worktree', 'add', '-b', 'codex/preview-cli', directory, commit); const stat = await lstat(directory);
    f.task.root = repository;
    f.records.set(id, { ...scope, id, taskRevision: 'r1', title: f.task.title, description: f.task.description, baseBranch: 'main', createdAt: '', updatedAt: '', version: 1, threadId: 'saved-original-session', executionSelection: folder, step: 'pr', head: commit, pr: { number: 1, url: 'https://github.com/example/disposable/pull/1' }, test: { passed: true, command: 'fixture', fingerprint: 'bound', exitCode: 0, outputDigest: 'digest', at: '' }, git: { root: repository, directory, directoryIdentity: `${stat.dev}:${stat.ino}`, commonDirectory: path.join(repository, '.git'), remote: 'https://github.com/example/disposable.git', owner: 'example', repo: 'disposable', baseBranch: 'main', baseSha: commit, branch: 'codex/preview-cli' } });
    const initial = await f.run('preview', 'task', 'status', id) as { status: string }; assert.equal(initial.status, 'stopped');
    if (process.env.PM_PREVIEW_EXPECT_NAMESPACE_REJECTION === '1') {
      await assert.rejects(f.run('preview', 'task', 'start', id, '--head', commit, '--confirm', 'true'), { status: 409 });
      const rejected = await f.run('preview', 'task', 'status', id) as { status: string; url: null };
      assert.notEqual(rejected.status, 'running'); assert.equal(rejected.url, null); assert.deepEqual(f.calls, []);
      return;
    }
    const started = await f.run('preview', 'task', 'start', id, '--head', commit, '--confirm', 'true') as { status: string; url: string };
    assert.equal(started.status, 'running'); assert.ok(started.url);
    assert.deepEqual(await previewPage(started.url), { status: 200, body: '1' });
    const active = await f.run('preview', 'task', 'status', id) as { url: string }; assert.equal(active.url, started.url);
    const stopped = await f.run('preview', 'task', 'stop', id, '--confirm', 'true') as { status: string; url: null }; assert.equal(stopped.status, 'stopped'); assert.equal(stopped.url, null);
    assert.equal((await previewPage(started.url)).status, 403);
    const again = await f.run('preview', 'task', 'start', id, '--head', commit, '--confirm', 'true') as { status: string; url: string }; assert.equal(again.status, 'running');
    assert.deepEqual(await previewPage(again.url), { status: 200, body: '2' });
    f.task.revision = 'requirement-changed'; await f.run('preview', 'task', 'stop', id, '--confirm', 'true');
    assert.deepEqual(f.calls, []); assert.equal(f.task.status, 'todo');
  } finally { await f.close(); }
});
