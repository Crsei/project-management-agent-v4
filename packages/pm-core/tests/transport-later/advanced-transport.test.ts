import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { Workspace } from '../../../pm-core/index.ts';
import { createApp } from '../apps/server/index.ts';
import { defaultConfiguration, type FileRecord, type Diagnostic, type SavedView } from '../../../pm-schema/index.ts';
import type { MigrationPlan, MigrationSummary } from '../../../pm-core/migrations.ts';
import { api, ApiError, type ConfigurationResponse } from '../apps/web/src/api.ts';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../../../pm-cli/index.ts', import.meta.url));

async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-advanced-transport-'));
  const inputs = await mkdtemp(path.join(os.tmpdir(), 'pm-cli-inputs-'));
  for (const [name, raw] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), raw);
  }
  const workspace = new Workspace(root);
  const application = createApp(workspace);
  t.after(async () => {
    application.closeStreams();
    await workspace.close();
    await rm(root, { recursive: true, force: true });
    await rm(inputs, { recursive: true, force: true });
  });
  await workspace.init();
  const request = (endpoint: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => application.app.request(`http://localhost/api${endpoint}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const input = async (name: string, value: unknown): Promise<string> => {
    const filename = path.join(inputs, name);
    await writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value));
    return filename;
  };
  const cli = async () => {
    const ready = Promise.withResolvers<number>();
    const server = serve({ fetch: application.app.fetch, hostname: '127.0.0.1', port: 0 }, info => ready.resolve(info.port));
    server.on('error', ready.reject);
    t.after(async () => {
      application.closeStreams();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const port = await ready.promise;
    return (...args: string[]) => execute(process.execPath, [cliPath, ...args], { env: { ...process.env, PM_API_URL: `http://127.0.0.1:${port}` }, timeout: 20000 });
  };
  return { workspace, root, request, input, cli };
}

async function payload<T>(response: Response, status = 200): Promise<T> {
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result as T;
}

async function rejected(response: Response, code?: string) {
  const result = await response.json() as { error: string; diagnostics: Diagnostic[] };
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  for (const diagnostic of result.diagnostics) {
    assert.equal(typeof diagnostic.code, 'string');
    assert.equal(typeof diagnostic.path, 'string');
    assert.equal(typeof diagnostic.message, 'string');
  }
  if (code) assert.ok(result.diagnostics.some(item => item.code === code), JSON.stringify(result));
  return result.diagnostics;
}

async function cliRejected(run: (...args: string[]) => Promise<{ stdout: string; stderr: string }>, args: string[], code?: string) {
  await assert.rejects(run(...args), (error: unknown) => {
    const result = error as { code: number; stderr: string };
    assert.equal(result.code, 1);
    if (code) assert.ok(result.stderr.includes(`[${code}]`), result.stderr);
    return true;
  });
}

function configuration() {
  const config = structuredClone(defaultConfiguration);
  config.custom_fields = [
    { name: 'x-points', label: 'Points', type: 'number', entities: ['work_item'], min: 0 },
    { name: 'x-ready', label: 'Ready', type: 'boolean', entities: ['work_item'] },
  ];
  config.workflows.work_item = {
    initial: 'queued',
    states: [{ id: 'queued', label: 'Queued', category: 'unstarted' }, { id: 'shipped', label: 'Shipped', category: 'completed' }],
    transitions: [{ from: 'queued', to: 'shipped' }],
  };
  return config;
}

test('HTTP config CAS, effective protocol and generic query preserve typed custom values and configured states', async t => {
  const { request } = await fixture(t);
  const initial = await payload<ConfigurationResponse>(await request('/config'));
  assert.equal(initial.revision, 'absent');
  const config = configuration();
  const saved = await payload<ConfigurationResponse>(await request('/config', 'PUT', { config, revision: initial.revision }));
  assert.notEqual(saved.revision, initial.revision);
  assert.deepEqual(saved.diagnostics, []);
  await rejected(await request('/config', 'PUT', { config, revision: initial.revision }));
  assert.equal((await payload<ConfigurationResponse>(await request('/config'))).revision, saved.revision);
  const task = await payload<FileRecord>(await request('/entities', 'POST', { entity: 'work_item', title: 'Configured task', 'x-points': 8, 'x-ready': true }), 201);
  assert.equal(task.entity.status, 'queued');
  assert.equal(task.entity['x-points'], 8);
  assert.equal(task.entity['x-ready'], true);
  const query = await payload<{ items: FileRecord[] }>(await request('/query', 'POST', { view: { entity: 'work_item', layout: 'table', where: { all: [{ field: 'x-points', op: 'gte', value: 5 }, { field: 'x-ready', op: 'eq', value: true }] }, order_by: [{ field: 'x-points', direction: 'desc' }] } }));
  assert.deepEqual(query.items.map(item => item.id), [task.id]);
  const shipped = await payload<FileRecord>(await request(`/entities/${task.id}`, 'PATCH', { changes: { status: 'shipped' }, revision: task.revision }));
  await rejected(await request(`/entities/${task.id}`, 'PATCH', { changes: { status: 'queued' }, revision: shipped.revision }));
  const protocol = await payload<unknown>(await request('/protocol'));
  assert.ok(JSON.stringify(protocol).includes('queued'));
  await rejected(await request('/query', 'POST', { view: { layout: 'table', where: { field: 'not-a-field', op: 'eq', value: true } } }));
  const malformed = structuredClone(config);
  malformed.custom_fields.push({ ...malformed.custom_fields[0] });
  await rejected(await request('/config', 'PUT', { config: malformed, revision: saved.revision }));
  assert.equal((await payload<ConfigurationResponse>(await request('/config'))).revision, saved.revision);
});

test('HTTP saved views use revision CAS and new routes reject extra envelopes and foreign origins', async t => {
  const { request, root } = await fixture(t);
  const first = await payload<SavedView>(await request('/views/team', 'PUT', { name: 'Team', layout: 'table', entity: 'work_item' }));
  assert.ok(first.revision);
  await rejected(await request('/views/team', 'PUT', { name: 'Overwrite', layout: 'table' }));
  const second = await payload<SavedView>(await request('/views/team', 'PUT', { ...first, name: 'Team board', layout: 'kanban', group_by: 'status', order: [] }));
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.id, first.id);
  assert.deepEqual(second.order, []);
  const savedBytes = await readFile(path.join(root, '.pm/views/team.yaml'), 'utf8');
  await rejected(await request('/views/team', 'PUT', { ...second, id: 'another-view', name: 'Rejected replacement' }), 'INVALID_REQUEST');
  assert.equal(await readFile(path.join(root, '.pm/views/team.yaml'), 'utf8'), savedBytes);
  await rejected(await request('/views/team', 'PUT', { name: 'Stale', layout: 'table', revision: first.revision }));
  assert.ok(!(await readFile(path.join(root, '.pm/views/team.yaml'), 'utf8')).includes('revision:'));
  for (const [endpoint, body] of [
    ['/config', { config: defaultConfiguration, revision: 'absent', extra: true }],
    ['/query', { view: { layout: 'table' }, extra: true }],
    ['/migrations/preview', { kind: 'normalize-v1', extra: true }],
    ['/migrations/mig-00000000-0000-0000-0000-000000000000/apply', { revision: 'x', force: true }],
    ['/views/new', { name: 'New', layout: 'table', extra: true }],
  ] as const) {
    const method = endpoint === '/config' || endpoint.startsWith('/views/') ? 'PUT' : 'POST';
    await rejected(await request(endpoint, method, body), 'INVALID_REQUEST');
    await rejected(await request(endpoint, method, body, { Origin: 'https://attacker.example' }), 'ORIGIN_FORBIDDEN');
  }
  await rejected(await request('/config', 'PUT', { config: defaultConfiguration }), 'INVALID_REQUEST');
  await rejected(await request('/query', 'POST', { view: [], archived: 'all' }), 'INVALID_REQUEST');
  await rejected(await request('/migrations/mig-00000000-0000-0000-0000-000000000000/restore', 'POST', {}), 'INVALID_REQUEST');
});

test('HTTP migration preview is nonmutating, apply is revision-bound and restore recovers exact source', async t => {
  const { request } = await fixture(t);
  const task = await payload<FileRecord>(await request('/items', 'POST', { title: 'Migration task' }), 201);
  const plan = await payload<MigrationPlan>(await request('/migrations/preview', 'POST', { kind: 'transform', changes: [{ id: task.id, set: { status: 'done' } }] }));
  assert.deepEqual(plan.diagnostics.filter(item => item.severity === 'error'), []);
  assert.ok(plan.files.length > 0);
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).raw, task.raw);
  await rejected(await request(`/migrations/${plan.id}/apply`, 'POST', {}), 'INVALID_REQUEST');
  await rejected(await request(`/migrations/${plan.id}/apply`, 'POST', { revision: 'wrong' }));
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).raw, task.raw);
  await payload(await request(`/migrations/${plan.id}/apply`, 'POST', { revision: plan.revision }));
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).entity.status, 'done');
  const summaries = await payload<MigrationSummary[]>(await request('/migrations'));
  assert.equal(summaries.find(item => item.id === plan.id)?.status, 'applied');
  await rejected(await request(`/migrations/${plan.id}/restore`, 'POST', { revision: '' }), 'INVALID_REQUEST');
  await payload(await request(`/migrations/${plan.id}/restore`, 'POST', { revision: plan.revision }));
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).raw, task.raw);
});

test('HTTP migration refuses stale plans and never rewrites unsupported protocol source', async t => {
  const future = '---\nschema: pm/v2\nid: DOC-900\nentity: document\n---\n# Future\n\nKeep these exact bytes.\n';
  const { request } = await fixture(t);
  const task = await payload<FileRecord>(await request('/items', 'POST', { title: 'Stale migration' }), 201);
  const plan = await payload<MigrationPlan>(await request('/migrations/preview', 'POST', { kind: 'transform', changes: [{ id: task.id, set: { status: 'done' } }] }));
  const edited = await payload<FileRecord>(await request(`/entities/${task.id}`, 'PATCH', { changes: { title: 'Unreviewed edit' }, revision: task.revision }));
  await rejected(await request(`/migrations/${plan.id}/apply`, 'POST', { revision: plan.revision }));
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).raw, edited.raw);
  const futureWorkspace = await fixture(t, { 'docs/future.md': future });
  const response = await futureWorkspace.request('/migrations/preview', 'POST', { kind: 'transform', changes: [{ id: 'DOC-900', set: { schema: 'pm/v1' } }] });
  if (response.ok) {
    const unsafe = await payload<MigrationPlan>(response);
    assert.ok(unsafe.diagnostics.some(item => item.severity === 'error'));
    await rejected(await futureWorkspace.request(`/migrations/${unsafe.id}/apply`, 'POST', { revision: unsafe.revision }));
  } else {
    await rejected(response);
  }
  assert.equal((await payload<{ raw: string }>(await futureWorkspace.request('/files/DOC-900'))).raw, future);
});

test('CLI supports typed fields, all entity kinds, config, query/view revisions and confirmed migrations', async t => {
  const { request, input, cli } = await fixture(t);
  const run = await cli();
  const configFile = await input('config.json', configuration());
  const initial = JSON.parse((await run('config', 'get')).stdout) as ConfigurationResponse;
  await run('config', 'set', '--file', configFile, '--revision', initial.revision);
  const task = JSON.parse((await run('entity', 'create', '--entity', 'work_item', '--title', 'Typed task', '--set', '{"x-points":13,"x-ready":false}')).stdout) as FileRecord;
  assert.equal(task.entity['x-points'], 13);
  assert.equal(task.entity['x-ready'], false);
  assert.equal(JSON.parse((await run('task', 'list', '--status', 'queued')).stdout).items[0].id, task.id);
  const ids: string[] = [task.id];
  for (const kind of ['project', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']) {
    const item = JSON.parse((await run('entity', 'create', '--entity', kind, '--title', kind, ...(kind === 'goal' ? ['--target', '42', '--unit', 'points'] : []))).stdout) as FileRecord;
    assert.equal(item.entity.entity, kind);
    if (kind === 'goal') assert.equal(item.entity.target, 42);
    ids.push(item.id);
    assert.deepEqual(JSON.parse((await run('entity', 'list', '--entity', kind)).stdout).items.map((entry: FileRecord) => entry.id), [item.id]);
  }
  assert.equal(JSON.parse((await run('entity', 'list')).stdout).items.length, ids.length);
  const viewFile = await input('query.yaml', 'layout: table\nentity: work_item\nwhere:\n  field: x-points\n  op: gte\n  value: 10\n');
  assert.deepEqual(JSON.parse((await run('view', 'query', '--file', viewFile)).stdout).items.map((entry: FileRecord) => entry.id), [task.id]);
  const saveFile = await input('view.json', { name: 'Points', layout: 'table', entity: 'work_item', columns: ['title', 'x-points'] });
  const view = JSON.parse((await run('view', 'save', 'Points', '--file', saveFile)).stdout) as SavedView;
  await cliRejected(run, ['view', 'save', 'Points', '--file', saveFile]);
  await run('view', 'save', 'Points', '--file', saveFile, '--revision', view.revision!);
  const migrationFile = await input('migration.yaml', `kind: transform\nchanges:\n  - id: ${task.id}\n    set:\n      status: shipped\n`);
  const plan = JSON.parse((await run('migration', 'preview', '--file', migrationFile)).stdout) as MigrationPlan;
  for (const action of ['apply', 'restore']) {
    await cliRejected(run, ['migration', action, plan.id, '--revision', plan.revision], 'CLI_INVALID_ARGUMENT');
    await cliRejected(run, ['migration', action, plan.id, '--confirm', plan.id], 'CLI_INVALID_ARGUMENT');
    await cliRejected(run, ['migration', action, plan.id, '--revision', plan.revision, '--confirm', 'wrong'], 'CLI_INVALID_ARGUMENT');
  }
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).raw, task.raw);
  await run('migration', 'apply', plan.id, '--revision', plan.revision, '--confirm', plan.id);
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).entity.status, 'shipped');
  assert.equal(JSON.parse((await run('migration', 'list')).stdout).find((entry: MigrationSummary) => entry.id === plan.id).status, 'applied');
  await run('migration', 'restore', plan.id, '--revision', plan.revision, '--confirm', plan.id);
  assert.equal((await payload<FileRecord>(await request(`/files/${task.id}`))).raw, task.raw);
});

test('CLI invalid typed envelopes, unsafe YAML and oversized files leave workspace unchanged', async t => {
  const { workspace, input, cli } = await fixture(t);
  const run = await cli();
  const before = workspace.snapshot();
  for (const set of ['[]', 'null', '{bad', '{"entity":"project"}', '{"id":"TASK-999"}', '{"revision":"x"}', '{"__proto__":{}}', '{"title":"duplicate"}']) {
    await cliRejected(run, ['task', 'create', '--title', 'Rejected', '--set', set], 'CLI_INVALID_ARGUMENT');
  }
  const badFiles = [
    await input('alias.yaml', 'one: &one [1, 2]\ntwo: *one\n'),
    await input('duplicate.yaml', 'layout: table\nlayout: graph\n'),
    await input('array.json', []),
    await input('large.yaml', 'x'.repeat(5 * 1024 * 1024 + 1)),
  ];
  for (const filename of badFiles) await cliRejected(run, ['view', 'query', '--file', filename], 'CLI_INVALID_ARGUMENT');
  assert.deepEqual(workspace.snapshot(), before);
});

test('browser API preserves structured diagnostics and sends configuration, query, view and migration CAS envelopes', async t => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ ok: true });
  });
  const config = configuration();
  await api.configuration();
  await api.saveConfiguration(config, 'config-revision');
  await api.query({ layout: 'table', entity: 'goal' }, 'include');
  await api.saveView('team', { name: 'Team', layout: 'table', revision: 'view-revision' });
  await api.migrations();
  await api.previewMigration({ kind: 'normalize-v1' });
  await api.applyMigration('plan/id', 'plan-revision');
  await api.restoreMigration('plan/id', 'plan-revision');
  assert.deepEqual(calls, [
    { url: '/api/config', method: 'GET', body: undefined },
    { url: '/api/config', method: 'PUT', body: { config, revision: 'config-revision' } },
    { url: '/api/query', method: 'POST', body: { view: { layout: 'table', entity: 'goal' }, archived: 'include' } },
    { url: '/api/views/team', method: 'PUT', body: { name: 'Team', layout: 'table', revision: 'view-revision' } },
    { url: '/api/migrations', method: 'GET', body: undefined },
    { url: '/api/migrations/preview', method: 'POST', body: { kind: 'normalize-v1' } },
    { url: '/api/migrations/plan%2Fid/apply', method: 'POST', body: { revision: 'plan-revision' } },
    { url: '/api/migrations/plan%2Fid/restore', method: 'POST', body: { revision: 'plan-revision' } },
  ]);
  const diagnostics: Diagnostic[] = [{ code: 'MIGRATION_CONFLICT', severity: 'error', path: 'work-items/task.md', entityId: 'TASK-1', field: 'status', targetId: 'TASK-2', line: 4, message: 'Changed source' }];
  fetchMock.mock.mockImplementation(async () => Response.json({ error: 'Rejected', diagnostics }, { status: 422 }));
  await assert.rejects(api.applyMigration('plan', 'revision'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.deepEqual(error.diagnostics, diagnostics);
    return true;
  });
});
