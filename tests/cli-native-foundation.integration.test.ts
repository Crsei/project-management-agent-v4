import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it, type TestContext } from 'node:test';
import { inspectFrontmatter } from '../packages/pm-markdown/index.ts';
import type { FileRecord, SavedView } from '../packages/pm-schema/index.ts';
import type { Entity } from '../packages/domain/src/core.ts';
import type { CoreCreationAttempt } from '../packages/contracts/src/core-creation.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';

const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../packages/pm-cli/index.ts', import.meta.url));

async function fixture(t: TestContext) {
  const f = await createDashboardFixture({ signal: t.signal });
  t.after(() => f.close(), { timeout: 60_000 });
  const inputs = await mkdtemp(path.join(await realpath('/tmp'), 'pm-native-cli-'));
  f.deferCleanup(() => rm(inputs, { recursive: true, force: true }));
  const environment = {
    PATH: process.env.PATH ?? '', HOME: inputs, LANG: 'C.UTF-8',
    PM_API_URL: f.origin, PM_WORKSPACE_ID: f.workspaceId,
    PM_SESSION_TOKEN: f.ownerCookie.slice(f.ownerCookie.indexOf('=') + 1),
    PM_CLI_SESSION_DIR: path.join(inputs, 'sessions'), PM_CLI_OPERATION_DIR: path.join(inputs, 'operations'),
  };
  const runAt = (env: NodeJS.ProcessEnv, ...args: string[]) => execute(process.execPath, [entrypoint, ...args], { env, signal: t.signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const run = (...args: string[]) => runAt(environment, ...args);
  const input = async (name: string, text: string) => {
    const filename = path.join(inputs, name);
    await writeFile(filename, text, { mode: 0o600 });
    return filename;
  };
  const base = `/api/v1/workspaces/${f.workspaceId}/core`;
  const source = async (id: string) => {
    const result = await f.request<FileRecord>(`${base}/files/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  return { ...f, base, inputs, environment, run, runAt, input, source };
}

async function rejected(operation: Promise<{ stdout: string; stderr: string }>, code?: string) {
  await assert.rejects(operation, (error: unknown) => {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1, failure.stderr);
    assert.equal(failure.stdout, '');
    if (code) assert.ok(failure.stderr.includes(code), failure.stderr);
    return true;
  });
}

describe('native CLI source, discovery and original-operation protocols', { skip: !dashboardDatabaseUrl }, () => {
  it('saves all nine source/body kinds with exact metadata, explicit CAS and server identity guards', { timeout: 600_000 }, async t => {
    const f = await fixture(t);
    const project = await f.command<Entity>('CreateProject', { name: 'CLI source scope', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    let editedTask: FileRecord | undefined;
    for (const kind of ['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']) {
      const created = await f.request<FileRecord>(`${f.base}/entities`, {
        method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
        body: { entity: kind, title: `Editable ${kind}`, ...(kind === 'project' ? {} : { project: project.id }), labels: ['retained'], related_to: [project.id], 'x-cli-preserve': 'unknown metadata', body: 'Original body' },
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const before = created.body;
      const original = inspectFrontmatter(before.raw);
      const body = `# Editable ${kind}\n\nA real CLI body edit for ${kind}.\n`;
      const bodyFile = await f.input(`${kind}-body.md`, body);
      const saved = JSON.parse((await f.run('entity', 'body', before.id, '--file', bodyFile, '--revision', before.revision)).stdout) as FileRecord;
      assert.equal(inspectFrontmatter(saved.raw).body, body);
      assert.deepEqual(inspectFrontmatter(saved.raw).metadata, original.metadata);
      assert.equal(saved.raw.slice(0, saved.raw.length - body.length), before.raw.slice(0, before.raw.length - original.body.length));
      assert.deepEqual(saved.entity.related_to, before.entity.related_to);
      assert.equal(saved.entity.status, before.entity.status);
      assert.equal(saved.entity.title, before.entity.title);
      const raw = `${saved.raw}\nSaved through the native source protocol.\n`;
      const sourceFile = await f.input(`${kind}-source.md`, raw);
      const updated = JSON.parse((await f.run('entity', 'source', saved.id, '--file', sourceFile, '--revision', saved.revision)).stdout) as FileRecord;
      assert.equal(updated.raw, raw);
      assert.equal(updated.revision, createHash('sha256').update(raw).digest('hex'));
      assert.equal((await f.source(updated.id)).raw, raw);
      await rejected(f.run('entity', 'source', saved.id, '--file', sourceFile, '--revision', before.revision), 'REVISION_CONFLICT');
      await rejected(f.run('entity', 'body', saved.id, '--file', bodyFile, '--revision', before.revision), 'REVISION_CONFLICT');
      assert.equal((await f.source(updated.id)).raw, raw);
      if (kind === 'work_item') editedTask = updated;
    }
    assert.ok(editedTask);
    const before = editedTask;
    await rejected(f.run('entity', 'source', before.id, '--file', await f.input('identity.md', before.raw.replace(/^id:.*$/m, 'id: TASK-999999')), '--revision', before.revision));
    await rejected(f.run('entity', 'body', before.id, '--file', await f.input('renamed-body.md', '# A hidden title change\n'), '--revision', before.revision), 'CLI_INVALID_ARGUMENT');
    await rejected(f.run('entity', 'source', before.id, '--file', await f.input('malformed.md', 'not a protocol document'), '--revision', before.revision));
    await rejected(f.run('entity', 'source', before.id, '--file', await f.input('oversized.md', 'x'.repeat(4 * 1024 * 1024 + 1)), '--revision', before.revision), 'CLI_INVALID_ARGUMENT');
    await rejected(f.run('entity', 'source', before.id, '--file', await f.input('missing-revision.md', before.raw)), 'CLI_INVALID_ARGUMENT');
    assert.equal((await f.source(before.id)).raw, before.raw);
    const invalidUtf8 = path.join(f.inputs, 'invalid-utf8.md');
    await writeFile(invalidUtf8, Buffer.from([0xc0, 0x80]));
    await rejected(f.run('entity', 'source', before.id, '--file', invalidUtf8, '--revision', before.revision), 'CLI_INVALID_ARGUMENT');
    assert.equal((await f.source(before.id)).raw, before.raw);
  });

  it('discovers saved definitions/revisions, preserves absent/stale CAS and filters inaccessible project views', { timeout: 300_000 }, async t => {
    const f = await fixture(t);
    const first = await f.command<Entity>('CreateProject', { name: 'Visible scope', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const second = await f.command<Entity>('CreateProject', { name: 'Hidden scope', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const definition = { name: 'Native saved view', layout: 'table', entity: 'work_item', project: first.id, columns: ['title', 'status'] };
    const filename = await f.input('view.json', JSON.stringify(definition));
    const saved = JSON.parse((await f.run('view', 'save', 'native-view', '--file', filename)).stdout) as SavedView;
    assert.ok(saved.revision);
    const list = JSON.parse((await f.run('view', 'list')).stdout) as { items: SavedView[] };
    assert.deepEqual(list.items.find(view => view.id === saved.id), saved);
    const discovered = JSON.parse((await f.run('view', 'get', saved.id)).stdout) as SavedView;
    assert.deepEqual(discovered, saved);
    const changedFile = await f.input('changed-view.yaml', `name: Changed native view\nlayout: table\nentity: work_item\nproject: ${first.id}\ncolumns: [title]\n`);
    const changed = JSON.parse((await f.run('view', 'save', saved.id, '--file', changedFile, '--revision', discovered.revision!)).stdout) as SavedView;
    assert.notEqual(changed.revision, discovered.revision);
    await rejected(f.run('view', 'save', saved.id, '--file', filename), 'REVISION_CONFLICT');
    await rejected(f.run('view', 'save', saved.id, '--file', filename, '--revision', discovered.revision!), 'REVISION_CONFLICT');
    assert.deepEqual(JSON.parse((await f.run('view', 'get', saved.id)).stdout), changed);
    await rejected(f.run('view', 'get', 'never-saved'), 'CLI_VIEW_NOT_FOUND');
    const hidden = await f.input('hidden-view.json', JSON.stringify({ ...definition, name: 'DO-NOT-LEAK-VIEW', project: second.id }));
    await f.run('view', 'save', 'hidden-view', '--file', hidden);
    const member = await f.member('Scoped view reader');
    await f.command('SetWorkspaceMember', { userId: member.user.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [first.id] });
    const environment = { ...f.environment, PM_SESSION_TOKEN: member.cookie.slice(member.cookie.indexOf('=') + 1) };
    const scoped = await f.runAt(environment, 'view', 'list');
    assert.ok(!scoped.stdout.includes('DO-NOT-LEAK-VIEW'));
    assert.ok(!scoped.stdout.includes(second.id));
    await rejected(f.runAt(environment, 'view', 'get', 'hidden-view'), 'CLI_VIEW_NOT_FOUND');
    await rejected(f.runAt(environment, 'view', 'save', 'unauthorized', '--file', filename));
  });

  it('queries the original lost creation without a new write or ID, distinguishes task action and reads command receipts', { timeout: 300_000 }, async t => {
    const f = await fixture(t);
    const project = await f.command<Entity>('CreateProject', { name: 'Original request scope', goal: '', ownerId: f.owner.id, completionCriteria: [] });
    const calls: { method: string; url: string }[] = [];
    let dropCreation = true;
    let dropSource = false;
    const proxy = createServer(async (incoming, outgoing) => {
      try {
        const method = incoming.method ?? 'GET', url = incoming.url ?? '/';
        calls.push({ method, url });
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const name of ['authorization', 'content-type', 'idempotency-key']) {
          const value = incoming.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        const upstream = await fetch(`${f.origin}${url}`, { method, headers, ...(body ? { body } : {}), redirect: 'error', signal: t.signal });
        const text = await upstream.text();
        if (dropCreation && method === 'POST' && url === `${f.base}/entities`) {
          assert.equal(upstream.status, 200, text);
          dropCreation = false;
          outgoing.destroy();
          return;
        }
        if (dropSource && method === 'PUT' && url.startsWith(`${f.base}/files/`)) {
          assert.equal(upstream.status, 200, text);
          dropSource = false;
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        outgoing.end(text);
      } catch (error) { outgoing.destroy(error as Error); }
    });
    f.deferCleanup(async () => {
      const closed = once(proxy, 'close');
      proxy.closeAllConnections(); proxy.close();
      await closed;
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address(); assert.ok(address && typeof address === 'object');
    const environment = { ...f.environment, PM_API_URL: `http://127.0.0.1:${address.port}` };
    const run = (...args: string[]) => f.runAt(environment, ...args);
    const key = randomUUID();
    await rejected(run('entity', 'create', '--entity', 'work_item', '--title', 'Committed then response lost', '--project', project.id, '--idempotency-key', key), 'CLI_CONNECTION_FAILED');
    const original = JSON.parse((await run('creation-attempt', 'get', key, '--kind', 'entity')).stdout) as CoreCreationAttempt;
    assert.equal(original.status, 'committed');
    if (original.status !== 'committed' || original.current.status !== 'present') throw new Error('Expected real original committed source');
    const id = original.entityId;
    assert.equal(original.current.record.id, id);
    assert.equal(original.current.record.revision, original.revision);
    assert.deepEqual(JSON.parse((await run('creation-attempt', 'recover', key, '--kind', 'entity')).stdout), original);
    assert.deepEqual(JSON.parse((await run('creation-attempt', 'get', key, '--kind', 'task')).stdout), { status: 'not_found' });
    const creationWrites = () => calls.filter(call => call.method === 'POST' && (call.url === `${f.base}/entities` || call.url === `${f.base}/items`)).length;
    assert.equal(creationWrites(), 1, 'GET/recover may not redispatch creation');
    const taskKey = randomUUID();
    const task = JSON.parse((await run('task', 'create', '--title', 'Task entrypoint identity', '--project', project.id, '--idempotency-key', taskKey)).stdout) as FileRecord;
    const taskOriginal = JSON.parse((await run('creation-attempt', 'get', taskKey, '--kind', 'task')).stdout) as CoreCreationAttempt;
    assert.equal(taskOriginal.status, 'committed');
    if (taskOriginal.status !== 'committed') throw new Error('Expected original task creation');
    assert.equal(taskOriginal.entityId, task.id);
    assert.deepEqual(JSON.parse((await run('creation-attempt', 'recover', taskKey, '--kind', 'task')).stdout), taskOriginal);
    assert.equal(creationWrites(), 2);
    const changedRaw = `${task.raw}\nSource committed before its response was dropped.\n`;
    const changedFile = await f.input('dropped-source.md', changedRaw);
    const expectedRevision = createHash('sha256').update(changedRaw).digest('hex');
    dropSource = true;
    await assert.rejects(run('task', 'source', task.id, '--file', changedFile, '--revision', task.revision, '--idempotency-key', randomUUID()), (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /CLI_CONNECTION_FAILED/);
      assert.ok(failure.stderr.includes(expectedRevision), failure.stderr);
      return true;
    });
    assert.equal((await run('file', task.id)).stdout, changedRaw, 'A dropped source response is reconciled by readback, not write replay');
    assert.equal(calls.filter(call => call.method === 'PUT' && call.url === `${f.base}/files/${task.id}`).length, 1);
    assert.equal((await f.source(task.id)).revision, expectedRevision);
    const archived = JSON.parse((await run('entity', 'archive', id, '--revision', original.current.record.revision)).stdout) as FileRecord;
    await run('entity', 'delete', id, '--revision', archived.revision, '--confirm', id);
    assert.deepEqual(JSON.parse((await run('creation-attempt', 'recover', key, '--kind', 'entity')).stdout), { status: 'committed', entityId: id, revision: original.revision, current: { status: 'deleted' } });
    assert.equal(creationWrites(), 2, 'Deleted originals must never be recreated');
    const unknownKey = randomUUID();
    assert.deepEqual(JSON.parse((await run('creation-attempt', 'get', unknownKey)).stdout), { status: 'not_found' });
    assert.deepEqual(JSON.parse((await run('creation-attempt', 'recover', unknownKey)).stdout), { status: 'not_found' });
    assert.equal(creationWrites(), 2);
    const commandId = randomUUID();
    const command = await f.send({ commandId, commandType: 'CreateWorkItem', projectId: project.id, payload: { title: 'Original command', description: '', acceptanceCriteria: [] } });
    assert.equal(command.status, 200, JSON.stringify(command.body));
    assert.equal(command.body.status, 'committed');
    assert.deepEqual(JSON.parse((await run('command', 'receipt', commandId)).stdout), command.body);
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.includes('/commands')).length, 0, 'CLI receipt query must never execute an application command');
    const files = await f.request<{ items: FileRecord[] }>(`${f.base}/items`);
    assert.equal(files.body.items.filter(file => file.entity.title === 'Committed then response lost').length, 0);
    assert.equal((await readFile(path.join(f.coreRoot, f.workspaceId, '.pm/state/state.json'), 'utf8')).includes(id), true);
  });
});
