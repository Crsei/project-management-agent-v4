import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { Workspace } from '../../../pm-core/index.ts';
import { createApp, type ApiApplication } from '../apps/server/index.ts';
import type { Diagnostic, FileRecord, UnsupportedFile, WorkspaceSnapshot } from '../../../pm-schema/index.ts';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../../../pm-cli/index.ts', import.meta.url));
const FUTURE = '---\nschema: pm/v2\nid: DOC-900\nentity: document\n---\n# Future source\n\nDo not downgrade.\n';

async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-transport-'));
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
  });
  await workspace.init();
  const request = (endpoint: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => application.app.request(`http://localhost/api${endpoint}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { workspace, application, request };
}

async function record(response: Response, status = 200): Promise<FileRecord> {
  const payload = await response.json();
  assert.equal(response.status, status, JSON.stringify(payload));
  return payload as FileRecord;
}

async function diagnostics(response: Response, status: number, code?: string): Promise<Diagnostic[]> {
  const payload = await response.json() as { error: string; diagnostics: Diagnostic[] };
  assert.equal(response.status, status, JSON.stringify(payload));
  assert.equal(typeof payload.error, 'string');
  assert.ok(payload.diagnostics.length > 0);
  for (const item of payload.diagnostics) {
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.path, 'string');
    assert.equal(typeof item.message, 'string');
    assert.equal(item.severity, 'error');
  }
  if (code) assert.ok(payload.diagnostics.some(item => item.code === code), JSON.stringify(payload));
  return payload.diagnostics;
}
async function cliService(t: TestContext, application: ApiApplication) {
  const ready = Promise.withResolvers<number>();
  const server = serve({ fetch: application.app.fetch, hostname: '127.0.0.1', port: 0 }, info => ready.resolve(info.port));
  server.on('error', ready.reject);
  t.after(async () => {
    application.closeStreams();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = await ready.promise;
  return (...args: string[]) => execute(process.execPath, [cliPath, ...args], {
    env: { ...process.env, PM_API_URL: `http://127.0.0.1:${port}` }, timeout: 20000,
  });
}

async function cliFailure(run: (...args: string[]) => Promise<{ stdout: string; stderr: string }>, args: string[], pattern?: RegExp) {
  await assert.rejects(run(...args), (error: unknown) => {
    const failure = error as { code: number; stderr: string };
    assert.equal(failure.code, 1);
    if (pattern) assert.match(failure.stderr, pattern);
    return true;
  });
}

test('HTTP exposes protocol, generic creation, source, context, atomic generic edits and idempotency', async t => {
  const { request } = await fixture(t);
  const protocol = await (await request('/protocol')).json() as { schema: string; fields: { name: string }[] };
  assert.equal(protocol.schema, 'pm/v1');
  assert.ok(protocol.fields.some(field => field.name === 'document_kind'));
  const projectInput = { entity: 'project', title: 'Project', owner: 'alice', goal: 'Ship', status: 'active' };
  const project = await record(await request('/entities', 'POST', projectInput, { 'Idempotency-Key': 'transport-project' }), 201);
  const repeatedProject = await record(await request('/entities', 'POST', projectInput, { 'Idempotency-Key': 'transport-project' }), 201);
  assert.equal(repeatedProject.id, project.id);
  assert.equal(project.entity.status, 'active');
  const document = await record(await request('/entities', 'POST', { entity: 'document', title: 'Decision', document_kind: 'decision', project: project.id }), 201);
  assert.equal(document.entity.document_kind, 'decision');
  const input = { title: 'Idempotent task', project: project.id, labels: ['test'] };
  const task = await record(await request('/items', 'POST', input, { 'Idempotency-Key': 'transport-create' }), 201);
  const repeated = await record(await request('/items', 'POST', { labels: ['test'], project: project.id, title: 'Idempotent task' }, { 'Idempotency-Key': 'transport-create' }), 201);
  assert.equal(repeated.id, task.id);
  await diagnostics(await request('/items', 'POST', { ...input, title: 'Changed intent' }, { 'Idempotency-Key': 'transport-create' }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await record(await request(`/files/${task.id}`))).raw, task.raw);
  assert.equal((await request(`/context/${task.id}`)).status, 200);
  const changed = await record(await request(`/entities/${task.id}`, 'PATCH', { changes: { status: 'done', labels: [], assignee: null }, revision: task.revision }));
  assert.equal(changed.entity.status, 'done');
  assert.deepEqual(changed.entity.labels, []);
  await diagnostics(await request(`/entities/${task.id}`, 'PATCH', { changes: { status: 'todo' }, revision: task.revision }), 409);
  const saved = await record(await request(`/files/${task.id}`, 'PUT', { raw: changed.raw.replace('# Idempotent task', '# Renamed task'), revision: changed.revision }));
  assert.equal(saved.entity.title, 'Renamed task');
  await diagnostics(await request(`/items/${task.id}`, 'PATCH', { changes: { status: 'todo' }, revision: saved.revision }), 404, 'ROUTE_NOT_FOUND');
  const snapshot = await (await request('/workspace')).json() as WorkspaceSnapshot;
  assert.equal(snapshot.files.length, 3);
  assert.deepEqual(snapshot.errors, []);
});

test('HTTP lifecycle filters archived objects, restores identity and conservatively deletes', async t => {
  const { request } = await fixture(t);
  const target = await record(await request('/items', 'POST', { title: 'Lifecycle' }), 201);
  await diagnostics(await request(`/entities/${target.id}`, 'DELETE', { revision: target.revision }), 422);
  let archived = await record(await request(`/entities/${target.id}/archive`, 'POST', { revision: target.revision }));
  assert.equal(archived.entity.archived, true);
  assert.equal(archived.entity.status, target.entity.status);
  const visible = await (await request('/items')).json();
  assert.ok(Array.isArray(visible.items));
  assert.equal(visible.items.length, 0);
  for (const filter of ['include', 'only']) {
    const result = await (await request(`/items?archived=${filter}`)).json();
    assert.ok(Array.isArray(result.items));
    assert.equal(result.items.length, 1);
  }
  assert.equal((await record(await request(`/files/${target.id}`))).id, target.id);
  const restored = await record(await request(`/entities/${target.id}/restore`, 'POST', { revision: archived.revision }));
  assert.equal(restored.id, target.id);
  assert.equal(restored.entity.archived, false);
  const referring = await record(await request('/entities', 'POST', { entity: 'document', title: 'Reference', related_to: [target.id] }), 201);
  archived = await record(await request(`/entities/${target.id}/archive`, 'POST', { revision: restored.revision }));
  const blocked = await diagnostics(await request(`/entities/${target.id}`, 'DELETE', { revision: archived.revision }), 422);
  assert.ok(blocked.some(item => item.field === 'related_to' && item.entityId === referring.id));
  await record(await request(`/entities/${referring.id}`, 'PATCH', { changes: { related_to: [] }, revision: referring.revision }));
  const deleted = await request(`/entities/${target.id}`, 'DELETE', { revision: archived.revision });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { id: target.id, deleted: true });
  await diagnostics(await request(`/files/${target.id}`), 404);
  const next = await record(await request('/items', 'POST', { title: 'New identity' }), 201);
  assert.notEqual(next.id, target.id);
});

test('HTTP invalid envelopes, origins, queries and missing routes use structured diagnostics', async t => {
  const { request, application } = await fixture(t);
  for (const body of ['{bad', '[]', 'null']) {
    await diagnostics(await application.app.request('http://localhost/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 400, 'INVALID_REQUEST');
  }
  await diagnostics(await application.app.request('http://localhost/api/items', { method: 'POST', body: '{}' }), 400, 'INVALID_REQUEST');
  await diagnostics(await request('/entities/TASK-1/archive', 'POST', { revision: '' }), 400, 'INVALID_REQUEST');
  await diagnostics(await request('/entities/TASK-1', 'PATCH', { changes: [], revision: 'hash' }), 400, 'INVALID_REQUEST');
  await diagnostics(await request('/entities/TASK-1', 'DELETE', { revision: 'hash', cascade: true }), 400, 'INVALID_REQUEST');
  await diagnostics(await request('/items?archived=everything'), 400, 'INVALID_REQUEST');
  await diagnostics(await request('/items', 'POST', { title: 'unsafe' }, { Origin: 'https://attacker.example' }), 403, 'ORIGIN_FORBIDDEN');
  await diagnostics(await request('/items', 'POST', { title: 'unsafe' }, { Origin: 'null' }), 403, 'ORIGIN_FORBIDDEN');
  await diagnostics(await request('/items', 'POST', { title: 'unsafe' }, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'ORIGIN_FORBIDDEN');
  await diagnostics(await request('/missing'), 404, 'ROUTE_NOT_FOUND');
  await diagnostics(await request('/items', 'POST', { title: 'No key' }, { 'Idempotency-Key': '' }), 400, 'INVALID_REQUEST');
  await diagnostics(await request('/entities', 'POST', { entity: 'document', title: 'Invalid', status: 'todo' }), 422);
  const task = await record(await request('/items', 'POST', { title: 'Same origin' }, { Origin: 'http://localhost' }), 201);
  assert.equal(task.entity.title, 'Same origin');
  await diagnostics(await application.app.request('http://localhost/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(5 * 1024 * 1024) }) }), 413, 'REQUEST_TOO_LARGE');
  application.closeStreams();
  await diagnostics(await request('/workspace'), 503, 'SERVER_STOPPING');
});

test('HTTP future protocol source is readable and every write route refuses it', async t => {
  const { request } = await fixture(t, { 'docs/future.md': FUTURE });
  const response = await request('/files/DOC-900');
  assert.equal(response.status, 200);
  const source = await response.json() as UnsupportedFile;
  assert.equal(source.raw, FUTURE);
  assert.equal(source.readOnly, true);
  for (const [endpoint, method, body] of [
    ['/files/DOC-900', 'PUT', { raw: FUTURE.replace('pm/v2', 'pm/v1'), revision: source.revision }],
    ['/entities/DOC-900', 'PATCH', { changes: { owner: 'alice' }, revision: source.revision }],
    ['/entities/DOC-900/archive', 'POST', { revision: source.revision }],
    ['/entities/DOC-900/restore', 'POST', { revision: source.revision }],
    ['/entities/DOC-900', 'DELETE', { revision: source.revision }],
  ] as const) await diagnostics(await request(endpoint, method, body), 422, 'UNSUPPORTED_SCHEMA_VERSION');
  const unchanged = await (await request('/files/DOC-900')).json();
  assert.equal(unchanged.raw, FUTURE);
});

test('CLI supports protocol, generic/task lifecycle, idempotency, source and archive queries', async t => {
  const { application, workspace } = await fixture(t);
  const run = await cliService(t, application);
  assert.equal(JSON.parse((await run('protocol')).stdout).schema, 'pm/v1');
  const projectArgs = ['entity', 'create', '--entity', 'project', '--title', 'CLI project', '--owner', 'alice', '--goal', 'Ship', '--status', 'active', '--idempotency-key', 'cli-project'];
  const project = JSON.parse((await run(...projectArgs)).stdout) as FileRecord;
  assert.equal(JSON.parse((await run(...projectArgs)).stdout).id, project.id);
  const document = JSON.parse((await run('entity', 'create', '--entity', 'document', '--title', 'CLI document', '--document-kind', 'design', '--project', project.id)).stdout) as FileRecord;
  assert.equal(document.entity.document_kind, 'design');
  const create = ['task', 'create', '--title', 'CLI task', '--project', project.id, '--idempotency-key', 'cli-task'];
  const task = JSON.parse((await run(...create)).stdout) as FileRecord;
  assert.equal(JSON.parse((await run(...create)).stdout).id, task.id);
  await cliFailure(run, ['task', 'create', '--title', 'Changed', '--idempotency-key', 'cli-task'], /IDEMPOTENCY_CONFLICT/);
  assert.equal((await run('file', task.id)).stdout, task.raw);
  assert.match((await run('context', task.id)).stdout, /CLI task/);
  const updated = JSON.parse((await run('task', 'update', task.id, '--status', 'done', '--labels', '', '--unset', 'assignee')).stdout) as FileRecord;
  assert.equal(updated.entity.status, 'done');
  const archived = JSON.parse((await run('task', 'archive', task.id, '--revision', updated.revision)).stdout) as FileRecord;
  assert.equal(JSON.parse((await run('task', 'list')).stdout).items.length, 0);
  assert.equal(JSON.parse((await run('task', 'list', '--archived', 'only')).stdout).items.length, 1);
  const restored = JSON.parse((await run('entity', 'restore', task.id, '--revision', archived.revision)).stdout) as FileRecord;
  assert.equal(restored.entity.archived, false);
  const rearchived = JSON.parse((await run('entity', 'archive', task.id, '--revision', restored.revision)).stdout) as FileRecord;
  await cliFailure(run, ['task', 'delete', task.id, '--revision', rearchived.revision]);
  assert.equal(workspace.get(task.id).revision, rearchived.revision);
  assert.deepEqual(JSON.parse((await run('entity', 'delete', task.id, '--revision', rearchived.revision, '--confirm', task.id)).stdout), { id: task.id, deleted: true });
  const changedDocument = JSON.parse((await run('entity', 'update', document.id, '--owner', 'bob', '--revision', document.revision)).stdout) as FileRecord;
  assert.equal(changedDocument.entity.owner, 'bob');
  const archivedDocument = JSON.parse((await run('entity', 'archive', document.id, '--revision', changedDocument.revision)).stdout) as FileRecord;
  assert.equal(JSON.parse((await run('entity', 'restore', document.id, '--revision', archivedDocument.revision)).stdout).entity.archived, false);
});

test('CLI rejects unsafe syntax without mutations and shares protocol diagnostics for invalid fields', async t => {
  const { application, workspace, request } = await fixture(t, { 'docs/future.md': FUTURE });
  const protectedTask = await record(await request('/items', 'POST', { title: 'Protected CLI item' }), 201);
  const run = await cliService(t, application);
  const before = workspace.snapshot();
  for (const args of [
    ['task', 'create', '--title', ''],
    ['entity', 'create', '--title', 'No type'],
    ['entity', 'update', 'TASK-1', '--status', 'done', '--unset', 'status'],
    ['task', 'restore', 'TASK-1'],
    ['task', 'delete', 'TASK-1', '--revision', 'hash', '--confirm', 'TASK-2'],
    ['task', 'list', '--archived', 'yes'],
    ['task', 'create', '--title', 'x', '--title', 'y'],
    ['file', '../secret'],
    ['protocol', 'extra'],
  ]) await cliFailure(run, args);
  for (const [args, code] of [
    [['task', 'create', '--title', 'Bad date', '--due', '2026-02-30'], /SCHEMA_VALIDATION/],
    [['task', 'create', '--title', 'Bad status', '--status', 'active'], /SCHEMA_VALIDATION/],
    [['task', 'create', '--title', 'Bad array', '--blocked-by', 'TASK-1,,TASK-2'], /SCHEMA_VALIDATION/],
    [['entity', 'create', '--entity', 'document', '--title', 'Bad field', '--status', 'todo'], /FIELD_NOT_APPLICABLE/],
    [['task', 'create', '--title', 'Bad boolean', '--archived', 'yes'], /SCHEMA_VALIDATION/],
    [['entity', 'update', protectedTask.id, '--unset', 'id'], /IMMUTABLE_FIELD/],
    [['entity', 'update', protectedTask.id, '--unset', 'revision'], /DERIVED_FIELD/],
  ] as [string[], RegExp][]) await cliFailure(run, args, code);
  assert.deepEqual(workspace.snapshot(), before);
  assert.equal((await run('file', 'DOC-900')).stdout, FUTURE);
  await cliFailure(run, ['entity', 'update', 'DOC-900', '--owner', 'alice'], /UNSUPPORTED_SCHEMA_VERSION/);
  await cliFailure(run, ['task', 'create', '--title', 'Missing project', '--project', 'PRJ-999'], /REFERENCE_NOT_FOUND[\s\S]*path=[\s\S]*field=project[\s\S]*target=PRJ-999/);
});
