import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.ts';
import { publishOutboxBatch } from '../packages/application/src/outbox.ts';
import type { Membership } from '../packages/application/src/access.ts';
import type { Actor, Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';

type JsonResponse<T = any> = { status: number; body: T; headers: Headers };
type CommandOptions = { cookie?: string; workspace?: string; extra?: Partial<Command> };
type SseEvent = { event: string; id?: string; data: any };
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// A real HTTP reader is required: app.inject() buffers streaming replies and
// cannot verify disconnect/reconnect or authorization changes on a live stream.
async function eventStream(url: string, cookie: string, lastEventId?: string) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { cookie, ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }) }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.ok(response.body);
  const history: SseEvent[] = [];
  const waiters = new Set<(event: SseEvent) => void>();
  const reader = response.body.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
        let separator: number;
        while ((separator = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, separator);
          pending = pending.slice(separator + 2);
          const fields = block.split('\n').filter(line => !line.startsWith(':'));
          const data = fields.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const id = fields.find(line => line.startsWith('id:'))?.slice(3).trim();
          const event: SseEvent = { event: fields.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message', data: JSON.parse(data), ...(id === undefined ? {} : { id }) };
          history.push(event);
          for (const waiter of waiters) waiter(event);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally { reader.releaseLock(); }
  })();
  // Observe a read failure immediately, while retaining it for close()/done.
  void done.catch(() => {});
  return {
    history, done,
    async waitFor(predicate: (event: SseEvent) => boolean, timeoutMs = 8_000): Promise<SseEvent> {
      const existing = history.find(predicate);
      if (existing) return existing;
      return new Promise((resolveEvent, reject) => {
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Timed out waiting for an SSE event')); }, timeoutMs);
        const waiter = (event: SseEvent) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolveEvent(event);
        };
        waiters.add(waiter);
      });
    },
    async close() { controller.abort(); await done; },
  };
}

describe('first-stage backend: real PostgreSQL, files, HTTP, workers and SSE', { skip: !databaseUrl, timeout: 240_000 }, () => {
  const namespace = `test_backend_${randomUUID().replaceAll('-', '')}`;
  const password = 'integration-password-2026';
  let bootstrap: Pool;
  let pool: Pool;
  let workerPool: Pool;
  let app: ReturnType<typeof buildApp>;
  let origin: string;
  let blobRoot: string;
  let coreRoot: string;
  let owner: Actor;
  let ownerCookie: string;
  let workspaceId: string;

  async function request<T = any>(path: string, options: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<JsonResponse<T>> {
    const response = await fetch(`${origin}${path}`, {
      method: options.method ?? 'GET',
      headers: { cookie: options.cookie ?? ownerCookie, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  async function signIn(user: Actor) {
    const result = await request('/api/v1/auth/login', { method: 'POST', cookie: '', body: { email: user.email, password } });
    assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie');
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.equal(result.body.actor.id, user.id);
    return cookie.split(';')[0]!;
  }
  const path = (workspace = workspaceId) => `/api/v1/workspaces/${workspace}`;
  function input(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Command {
    return { commandId: randomUUID(), commandType, payload, ...extra };
  }
  async function send(command: Command, options: CommandOptions = {}) {
    return request<CommandReceipt>(`${path(options.workspace)}/commands`, { method: 'POST', body: command, cookie: options.cookie ?? ownerCookie });
  }
  async function committed<T = Entity>(commandType: string, payload: Record<string, unknown>, options: CommandOptions = {}): Promise<T> {
    const result = await send(input(commandType, payload, options.extra), options);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'committed', JSON.stringify(result.body));
    return result.body.result as T;
  }
  function expected(...entities: Entity[]) { return Object.fromEntries(entities.map(entity => [entity.id, entity.version])); }
  async function read(id: string, workspace = workspaceId): Promise<Entity> {
    const result = await request<Entity>(`${path(workspace)}/entities/${id}`);
    assert.equal(result.status, 200);
    return result.body;
  }
  async function activeProject(name: string, workspace = workspaceId) {
    const project = await committed('CreateProject', { name, goal: 'A verifiable human delivery', ownerId: owner.id, completionCriteria: ['All agreed work delivered'] }, { workspace });
    return committed('ActivateProject', {}, { workspace, extra: { targetId: project.id, expectedVersions: expected(project) } });
  }
  async function workingItem(project: Entity, title = 'Deliver a document') {
    let work = await committed('CreateWorkItem', { title, description: 'Produce the agreed document and preserve its exact contents.', acceptanceCriteria: [{ id: randomUUID(), text: 'The submitted document contains the agreed text.' }], assigneeId: owner.id }, { workspace: project.workspaceId, extra: { projectId: project.id } });
    work = await committed('ReadyWorkItem', {}, { workspace: project.workspaceId, extra: { targetId: work.id, expectedVersions: expected(work) } });
    return committed('StartWorkItem', {}, { workspace: project.workspaceId, extra: { targetId: work.id, expectedVersions: expected(work) } });
  }
  async function artifact(project: Entity, bytes = Buffer.from('A real human document.\n完整交付。\u0000\ufffd')) {
    const staged = await committed<{ upload: Entity }>('StageUpload', { contentBase64: bytes.toString('base64'), fileName: '人工成果.txt', mediaType: 'text/plain' }, { workspace: project.workspaceId, extra: { projectId: project.id } });
    const registered = await committed<{ artifact: Entity; artifactVersion: Entity }>('RegisterArtifact', { title: 'Human document', kind: 'document', uploadId: staged.upload.id }, { workspace: project.workspaceId, extra: { projectId: project.id, expectedVersions: expected(staged.upload) } });
    return { ...registered, upload: staged.upload, bytes };
  }
  async function submitted(project: Entity) {
    const work = await workingItem(project);
    const delivery = await artifact(project);
    const result = await committed<{ workItem: Entity; submission: Entity }>('SubmitWorkItemResult', { contentRevision: 1, artifactVersionIds: [delivery.artifactVersion.id], evidenceIds: [] }, { workspace: project.workspaceId, extra: { targetId: work.id, expectedVersions: expected(work) } });
    return { ...result, ...delivery };
  }
  function reviewPayload(submission: Entity, versionId: string, verdict: 'passed' | 'changes_requested' = 'passed') {
    return { criterionResults: submission.data.workScopeSnapshot.acceptanceCriteria.map((criterion: { id: string }) => ({ criterionId: criterion.id, result: verdict === 'passed' ? 'pass' : 'fail', basisRefs: [versionId], explanation: 'Inspected the exact submitted artifact against this criterion.' })), verdict, reason: 'A human reviewed each agreed criterion.' };
  }
  async function flushOutbox() { while (await publishOutboxBatch(pool, 500) > 0) { /* Drain every workspace in this isolated test schema. */ } }
  async function conversation(workspace = workspaceId, project?: Entity) {
    return committed<Entity>('CreateConversation', { title: `Discussion ${randomUUID()}` }, { workspace, extra: project ? { projectId: project.id } : {} });
  }
  async function appendMessage(workspace: string, conversation: Entity, content: string) {
    const result = await committed<{ conversation: Entity; message: { id: string; contentVersion: number } }>('AppendMessage', { content }, { workspace, extra: { targetId: conversation.id, expectedVersions: expected(conversation) } });
    return result.conversation;
  }
  async function member(name: string) {
    const user = await createUser(pool, { name, email: `${randomUUID()}@example.test`, password });
    return { user, cookie: await signIn(user) };
  }

  before(async () => {
    bootstrap = createPool(databaseUrl!);
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${namespace},public`);
    const scopedUrl = url.toString();
    pool = createPool(scopedUrl);
    workerPool = createPool(scopedUrl);
    await migrate(pool);
    owner = await createUser(pool, { email: 'backend-owner@example.test', name: 'Backend owner', password });
    workspaceId = (await createWorkspace(pool, owner.id, 'HTTP integration')).id;
    const testsRoot = resolve(process.env.TMPDIR ?? '.local/tests');
    await mkdir(testsRoot, { recursive: true });
    blobRoot = await mkdtemp(join(testsRoot, 'backend-'));
    coreRoot = await mkdtemp(join(testsRoot, 'core-'));
    app = buildApp({ databaseUrl: scopedUrl, ...await createBoundLocalStorage(pool, blobRoot), coreWorkspaceRoot: coreRoot });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    ownerCookie = await signIn(owner);
  });
  after(async () => {
    await app?.close();
    await workerPool?.end();
    await pool?.end();
    if (bootstrap) {
      try { await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); }
      finally { await bootstrap.end(); }
    }
    if (blobRoot) await rm(blobRoot, { recursive: true, force: true });
    if (coreRoot) await rm(coreRoot, { recursive: true, force: true });
  });

  it('INF-05/06 authenticates with a revocable cookie, rejects spoofed actors and reports execution disabled', async () => {
    assert.equal((await request('/api/v1/auth/me', { cookie: '' })).status, 401);
    assert.equal((await request('/api/v1/auth/me')).body.actor.id, owner.id);
    const capabilities = await request('/api/v1/capabilities');
    assert.equal(capabilities.body.execution.enabled, false);
    for (const commandType of ['CreateSession', 'CreateRun', 'RequestApproval', 'RecordRunSucceeded']) {
      const result = await send(input(commandType, {}));
      assert.equal(result.status, 409);
      assert.equal(result.body.error?.code, 'capability_not_enabled');
    }
    const spoofed = await request(`${path()}/commands`, { method: 'POST', body: { ...input('CreateProject', {}), actor: { id: owner.id, role: 'admin' } } });
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.body.error.code, 'validation_failed');
    const forbiddenOrigin = await request('/api/v1/auth/logout', { method: 'POST', headers: { origin: 'https://untrusted.example.test' } });
    assert.equal(forbiddenOrigin.status, 403);
    const cookie = await signIn(owner);
    assert.equal((await request('/api/v1/auth/logout', { method: 'POST', cookie })).status, 200);
    assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
    const kinds = await pool.query("SELECT count(*)::text AS count FROM entities WHERE kind NOT IN ('project','work_item','milestone','conversation','intent','decision','upload','artifact','artifact_version','evidence','submission','review')");
    assert.equal(kinds.rows[0].count, '0');
  });

  it('SC-06/16/17 completes the manual API loop, downloads exact bytes and explicitly closes and archives project scope', async () => {
    const project = await activeProject('Complete manual delivery');
    const milestone = await committed('CreateMilestone', { title: 'Human delivery accepted', criteria: ['The agreed document was accepted'] }, { extra: { projectId: project.id } });
    let work = await workingItem(project);
    work = await committed('AssignMilestone', { milestoneId: milestone.id }, { extra: { targetId: work.id, expectedVersions: expected(work) } });
    const delivery = await artifact(project);
    assert.equal(delivery.artifactVersion.data.sourceRunId, null);
    assert.equal((await read(delivery.upload.id)).data.consumedByArtifactVersionId, delivery.artifactVersion.id);
    const download = await fetch(`${origin}${path()}/artifact-versions/${delivery.artifactVersion.id}/content`, { headers: { cookie: ownerCookie } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), delivery.bytes);
    assert.equal(download.headers.get('etag'), `"${createHash('sha256').update(delivery.bytes).digest('hex')}"`);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    const { evidence } = await committed<{ evidence: Entity }>('RecordEvidence', { subjectRefs: [work.id], method: 'Human inspection of downloaded bytes', scope: 'All agreed text', result: 'pass', observedAt: new Date().toISOString(), artifactVersionRefs: [delivery.artifactVersion.id] }, { extra: { projectId: project.id } });
    const { submission, workItem } = await committed<{ submission: Entity; workItem: Entity }>('SubmitWorkItemResult', { contentRevision: 1, artifactVersionIds: [delivery.artifactVersion.id], evidenceIds: [evidence.id] }, { extra: { targetId: work.id, expectedVersions: expected(work) } });
    assert.deepEqual(submission.data.workScopeSnapshot.acceptanceCriteria, work.data.acceptanceCriteria);
    // The Markdown core owns completion: a work item can be completed without a
    // review, and the PM review history never gates that core transition.
    const beforeReview = await committed('CompleteWorkItem', { submissionId: submission.id, reviewId: randomUUID() }, { extra: { targetId: work.id, expectedVersions: expected(workItem) } });
    assert.equal(beforeReview.data.status, 'done');
    assert.equal('completionRecord' in beforeReview.data, false);
    const reopened = await committed('ReopenWorkItem', { reason: 'The human delivery still records a review' }, { extra: { targetId: work.id, expectedVersions: expected(beforeReview) } });
    assert.equal(reopened.data.status, 'in_progress');
    const { review } = await committed<{ review: Entity }>('RecordReview', reviewPayload(submission, delivery.artifactVersion.id), { extra: { targetId: submission.id, expectedVersions: expected(submission, reopened) } });
    assert.equal((await read(work.id)).data.status, 'in_progress');
    assert.equal(review.data.reviewerId, owner.id);
    const done = await committed('CompleteWorkItem', { submissionId: submission.id, reviewId: review.id }, { extra: { targetId: work.id, expectedVersions: expected(reopened) } });
    assert.equal(done.data.status, 'done');
    assert.equal('completionRecord' in done.data, false);
    assert.equal((await read(project.id)).data.status, 'active');
    await committed('AchieveMilestone', { reason: 'All agreed work accepted', criteriaChecks: [{ criterionIndex: 0, explanation: 'The work item has an explicit completion record' }] }, { extra: { targetId: milestone.id, expectedVersions: expected(milestone) } });
    const completedProject = await committed('CompleteProject', { reason: 'Project criteria checked', criteriaChecks: [{ criterionIndex: 0, explanation: 'The accepted document fulfills the project goal' }] }, { extra: { targetId: project.id, expectedVersions: expected(project) } });
    const archived = await committed('ArchiveObject', { kind: 'project', reason: 'Retain the finished project and all delivery history' }, { extra: { targetId: project.id, expectedVersions: expected(completedProject) } });
    assert.ok(archived.data.archivedAt);
    // Submission and review are immutable historical snapshots.
    assert.deepEqual((await read(submission.id)).data, submission.data);
    assert.equal((await read(submission.id)).data.workScopeSnapshot.description, work.data.description);
    assert.deepEqual((await read(review.id)).data, review.data);
    assert.equal((await read(review.id)).data.verdict, 'passed');
  });

  it('SC-13 returns durable same-key receipts and rejects changed requests without repeating effects', async () => {
    const command = input('CreateProject', { name: 'One durable creation', goal: 'Replay safely', ownerId: owner.id, completionCriteria: ['Only one project'] });
    const original = await send(command);
    assert.equal(original.status, 200);
    const replay = await send({ payload: { completionCriteria: ['Only one project'], ownerId: owner.id, goal: 'Replay safely', name: 'One durable creation' }, commandType: command.commandType, commandId: command.commandId });
    assert.deepEqual(replay.body, original.body);
    const receipt = await request(`${path()}/commands/${command.commandId}`);
    assert.deepEqual(receipt.body, original.body);
    const conflict = await send({ ...command, payload: { ...command.payload, name: 'Different request' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error?.code, 'command_id_conflict');
    // Core commands are committed by the Markdown workspace, not the PM outbox.
    const effects = await pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [command.commandId]);
    assert.equal(effects.rows[0].count, '0');
    const invalid = input('ReadyWorkItem', {}, { targetId: randomUUID() });
    const rejected = await send(invalid);
    assert.equal(rejected.body.status, 'rejected');
    assert.deepEqual((await send(invalid)).body, rejected.body);
    assert.deepEqual((await request(`${path()}/commands/${invalid.commandId}`)).body, rejected.body);
  });

  it('SC-01/02 keeps messages and proposed intents separate from work, then converts an accepted revision exactly once', async () => {
    const workspace = (await createWorkspace(pool, owner.id, 'Explicit intent conversion')).id;
    const project = await activeProject('Explicit intent conversion', workspace);
    const conversation = await committed('CreateConversation', { title: 'A human planning discussion' }, { workspace, extra: { projectId: project.id } });
    const appended = await committed<{ conversation: Entity; message: { id: string; contentVersion: number } }>('AppendMessage', { content: 'We should deliver a carefully reviewed document.' }, { workspace, extra: { targetId: conversation.id, expectedVersions: expected(conversation) } });
    const intent = await committed('ProposeIntent', { summary: 'Deliver a document', goal: 'Make the agreed information available', conversationId: conversation.id, sourceMessageRefs: [{ messageId: appended.message.id, contentVersion: appended.message.contentVersion }] }, { workspace, extra: { projectId: project.id } });
    assert.deepEqual((await request(`${path(workspace)}/entities?kind=work_item&projectId=${project.id}`)).body.items, []);
    const fields = { title: 'An explicitly planned delivery', description: 'The accepted intent becomes work only through a command', acceptanceCriteria: [{ id: randomUUID(), text: 'The accepted goal has been delivered' }], assigneeId: owner.id, intentId: intent.id, acceptedRevision: 1 };
    const premature = await send(input('CreateWorkItemFromIntent', { ...fields, decisionId: randomUUID() }, { projectId: project.id }), { workspace });
    assert.equal(premature.body.error?.code, 'accepted_intent_required');
    const accepted = await committed<{ intent: Entity; decision: Entity }>('AcceptIntent', { revision: 1, reason: 'The human explicitly accepts this goal', basisRefs: [] }, { workspace, extra: { targetId: intent.id, expectedVersions: expected(intent) } });
    const commands = [input('CreateWorkItemFromIntent', { ...fields, decisionId: accepted.decision.id }, { projectId: project.id }), input('CreateWorkItemFromIntent', { ...fields, decisionId: accepted.decision.id }, { projectId: project.id })];
    const results = await Promise.all(commands.map(command => send(command, { workspace })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)!.body.error?.code, 'intent_already_converted');
    const successIndex = results.findIndex(result => result.status === 200);
    assert.deepEqual((await send(commands[successIndex]!, { workspace })).body, results[successIndex]!.body);
    const works = (await request(`${path(workspace)}/entities?kind=work_item&projectId=${project.id}`)).body.items;
    assert.equal(works.length, 1);
    assert.deepEqual(works[0].data.originIntentRef, { intentId: intent.id, acceptedRevision: 1, decisionId: accepted.decision.id });
    assert.equal(works[0].data.status, 'draft');
  });

  it('INF-04 rejects unsafe uploads and reused staging, and blocks corrupt content before download or submission succeeds', async () => {
    const project = await activeProject('Real blob integrity');
    const work = await workingItem(project);
    const invalidBase64 = await send(input('StageUpload', { contentBase64: 'Zh==', fileName: 'safe.txt', mediaType: 'text/plain' }, { projectId: project.id }));
    assert.equal(invalidBase64.body.error?.code, 'invalid_base64');
    const unsafeName = await send(input('StageUpload', { contentBase64: 'Zg==', fileName: '../escape.txt', mediaType: 'text/plain' }, { projectId: project.id }));
    assert.equal(unsafeName.body.error?.code, 'validation_failed');
    const delivery = await artifact(project);
    const reused = await send(input('RegisterArtifact', { title: 'Cannot consume twice', kind: 'document', uploadId: delivery.upload.id }, { projectId: project.id, expectedVersions: { [delivery.upload.id]: 2 } }));
    assert.equal(reused.body.error?.code, 'upload_already_consumed');
    const file = join(blobRoot, delivery.artifactVersion.data.objectKey);
    await writeFile(file, Buffer.from('Externally corrupted bytes'));
    try {
      const failedDownload = await request(`${path()}/artifact-versions/${delivery.artifactVersion.id}/content`);
      assert.equal(failedDownload.status, 503);
      assert.equal(failedDownload.body.error.code, 'blob_integrity_error');
      const rejected = await send(input('SubmitWorkItemResult', { contentRevision: 1, artifactVersionIds: [delivery.artifactVersion.id], evidenceIds: [] }, { targetId: work.id, expectedVersions: expected(work) }));
      assert.equal(rejected.body.error?.code, 'blob_integrity_error');
      assert.deepEqual(await read(work.id), work);
      assert.deepEqual((await request(`${path()}/entities?kind=submission&projectId=${project.id}`)).body.items, []);
      assert.equal((await pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [rejected.body.commandId])).rows[0].count, '0');
    } finally { await writeFile(file, delivery.bytes); }
    const recovered = await fetch(`${origin}${path()}/artifact-versions/${delivery.artifactVersion.id}/content`, { headers: { cookie: ownerCookie } });
    assert.equal(recovered.status, 200);
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), delivery.bytes);
  });

  it('persists date-only schedules, clears ranges and keeps metadata separate from submitted content', async () => {
    const project = await activeProject('Calendar schedule');
    const delivery = await submitted(project);
    const original = delivery.workItem;
    assert.equal(original.data.startDate, null);
    assert.equal(original.data.dueDate, null);
    let work = await committed('UpdateWorkItemMetadata', { startDate: '2028-02-29', dueDate: '2028-03-02' }, { extra: { targetId: original.id, expectedVersions: expected(original) } });
    assert.notEqual(work.version, original.version);
    assert.deepEqual(await read(work.id), work);
    const stale = await send(input('UpdateWorkItemMetadata', { startDate: null }, { targetId: work.id, expectedVersions: expected(original) }));
    assert.equal(stale.body.error?.code, 'version_conflict');
    const missingVersion = await send(input('UpdateWorkItemMetadata', { dueDate: null }, { targetId: work.id }));
    assert.equal(missingVersion.body.error?.code, 'version_conflict');
    for (const payload of [
      { startDate: '2028-03-03' },
      { dueDate: '2028-02-28' },
      { startDate: '2028-03-04', dueDate: '2028-03-03' },
    ]) {
      const rejected = await send(input('UpdateWorkItemMetadata', payload, { targetId: work.id, expectedVersions: expected(work) }));
      assert.equal(rejected.body.error?.code, 'invalid_schedule_range');
      assert.equal((await pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [rejected.body.commandId])).rows[0].count, '0');
    }
    for (const date of ['2027-02-29', '2028-02-30', '2028-04-31', '2028-13-01', '2028-00-01', '2028-01-00', '2028-2-09', '2028-02-29T00:00:00Z']) {
      for (const field of ['startDate', 'dueDate']) {
        const rejected = await send(input('UpdateWorkItemMetadata', { [field]: date }, { targetId: work.id, expectedVersions: expected(work) }));
        assert.equal(rejected.body.error?.code, 'validation_failed', date);
      }
    }
    assert.deepEqual(await read(work.id), work);
    work = await committed('UpdateWorkItemMetadata', { priority: 'high' }, { extra: { targetId: work.id, expectedVersions: expected(work) } });
    assert.equal(work.data.startDate, '2028-02-29');
    assert.equal(work.data.dueDate, '2028-03-02');
    work = await committed('UpdateWorkItemMetadata', { startDate: null, dueDate: '2028-02-01' }, { extra: { targetId: work.id, expectedVersions: expected(work) } });
    assert.equal(work.data.startDate, null);
    assert.equal(work.data.dueDate, '2028-02-01');
    work = await committed('UpdateWorkItemMetadata', { startDate: '2028-02-01' }, { extra: { targetId: work.id, expectedVersions: expected(work) } });
    assert.equal(work.data.startDate, work.data.dueDate);
    work = await committed('UpdateWorkItemMetadata', { dueDate: null }, { extra: { targetId: work.id, expectedVersions: expected(work) } });
    assert.equal(work.data.startDate, '2028-02-01');
    assert.equal(work.data.dueDate, null);
    work = await committed('UpdateWorkItemMetadata', { startDate: null }, { extra: { targetId: work.id, expectedVersions: expected(work) } });
    assert.equal(work.data.startDate, null);
    assert.equal(work.data.dueDate, null);
    assert.notEqual(work.version, original.version);
    assert.equal('currentSubmissionId' in work.data, false);
    assert.equal(work.data.status, 'in_progress');
    // Metadata edits never rewrite the submitted content snapshot.
    assert.deepEqual((await read(delivery.submission.id)).data.workScopeSnapshot.acceptanceCriteria, original.data.acceptanceCriteria);
    assert.deepEqual(await read(work.id), work);
    const listed = (await request(`${path()}/entities?kind=work_item&projectId=${project.id}`)).body.items;
    assert.deepEqual(listed, [work]);
  });

  it('SC-12 serializes HTTP CAS writers and preserves a queryable rejection without success events', async () => {
    const project = await activeProject('Concurrent writers');
    const work = await workingItem(project);
    const extra = { targetId: work.id, expectedVersions: expected(work) };
    const [left, right] = await Promise.all([
      send(input('UpdateWorkItemMetadata', { priority: 'high' }, extra)),
      send(input('UpdateWorkItemMetadata', { priority: 'urgent' }, extra)),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);
    const rejected = [left, right].find(result => result.body.status === 'rejected')!.body;
    // A stale writer is stopped by the PM version check or by the core revision CAS.
    assert.ok(['version_conflict', 'REVISION_CONFLICT'].includes(rejected.error?.code ?? ''));
    const accepted = [left, right].find(result => result.status === 200)!;
    const committedWrite = accepted.body.result as Entity;
    const saved = await read(work.id);
    assert.equal(saved.version, committedWrite.version);
    assert.notEqual(saved.version, work.version);
    assert.deepEqual((await request(`${path()}/commands/${rejected.commandId}`)).body, rejected);
    assert.equal((await pool.query('SELECT count(*)::text AS count FROM outbox WHERE command_id=$1', [rejected.commandId])).rows[0].count, '0');
  });

  it('SC-07/19 treats an old passed Review as history, keeps core completion ungated and requires explicit reopen', async () => {
    const project = await activeProject('Old review is historical');
    const first = await submitted(project);
    const { review } = await committed<{ review: Entity }>('RecordReview', reviewPayload(first.submission, first.artifactVersion.id), { extra: { targetId: first.submission.id, expectedVersions: expected(first.submission, first.workItem) } });
    const changed = await committed('UpdateWorkItemContent', { title: 'Revised delivery', description: 'A new agreed scope', acceptanceCriteria: [{ id: randomUUID(), text: 'The revised scope was inspected' }] }, { extra: { targetId: first.workItem.id, expectedVersions: expected(first.workItem) } });
    assert.notEqual(changed.data.contentRevision, first.workItem.data.contentRevision);
    assert.equal('currentSubmissionId' in changed.data, false);
    assert.equal(changed.data.status, 'in_progress');
    // The old submission snapshot no longer matches the current core content.
    const stale = await send(input('ReturnWorkItemForChanges', { reason: 'Review the old snapshot' }, { targetId: changed.id, expectedVersions: expected(changed) }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error?.code, 'submission_snapshot_mismatch');
    assert.deepEqual((await read(first.submission.id)).data, first.submission.data);
    assert.deepEqual((await read(review.id)).data, review.data);
    const next = await committed<{ workItem: Entity; submission: Entity }>('SubmitWorkItemResult', { contentRevision: 2, artifactVersionIds: [first.artifactVersion.id], evidenceIds: [] }, { extra: { targetId: changed.id, expectedVersions: expected(changed) } });
    const secondReview = await committed<{ review: Entity }>('RecordReview', reviewPayload(next.submission, first.artifactVersion.id), { extra: { targetId: next.submission.id, expectedVersions: expected(next.submission, next.workItem) } });
    const done = await committed('CompleteWorkItem', { submissionId: next.submission.id, reviewId: secondReview.review.id }, { extra: { targetId: changed.id, expectedVersions: expected(next.workItem) } });
    assert.equal(done.data.status, 'done');
    assert.equal('completionRecord' in done.data, false);
    // Editing a done core work item is allowed; completion is not terminal storage.
    const edited = await committed('UpdateWorkItemContent', { title: 'Edited after completion', description: 'The core permits a later edit', acceptanceCriteria: done.data.acceptanceCriteria }, { extra: { targetId: done.id, expectedVersions: expected(done) } });
    assert.equal(edited.data.status, 'done');
    const reopened = await committed('ReopenWorkItem', { reason: 'Explicitly undertake another delivery' }, { extra: { targetId: edited.id, expectedVersions: expected(edited) } });
    assert.equal(reopened.data.status, 'in_progress');
    assert.equal('currentSubmissionId' in reopened.data, false);
    assert.equal('completionHistory' in reopened.data, false);
    await committed('StartWorkItem', {}, { extra: { targetId: reopened.id, expectedVersions: expected(reopened) } });
  });

  it('SC-18 allows only one terminal Review and serializes review against return-for-changes', async () => {
    const project = await activeProject('Review concurrency');
    const first = await submitted(project);
    const reviewer = await member('Second reviewer');
    await committed('SetWorkspaceMember', { userId: reviewer.user.id, capabilities: ['domain.read', 'delivery.review'], projectIds: [project.id] });
    const extra = { targetId: first.submission.id, expectedVersions: expected(first.submission, first.workItem) };
    const results = await Promise.all([
      send(input('RecordReview', reviewPayload(first.submission, first.artifactVersion.id), extra)),
      send(input('RecordReview', reviewPayload(first.submission, first.artifactVersion.id, 'changes_requested'), extra), { cookie: reviewer.cookie }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)!.body.error?.code, 'review_already_recorded');
    const reviews = await request(`${path()}/entities?kind=review&projectId=${project.id}`);
    assert.equal(reviews.body.items.filter((review: Entity) => review.data.submissionId === first.submission.id).length, 1);
    assert.equal((await read(first.workItem.id)).data.status, 'in_progress');
    const second = await submitted(project);
    const [reviewed, returned] = await Promise.all([
      send(input('RecordReview', reviewPayload(second.submission, second.artifactVersion.id), { targetId: second.submission.id, expectedVersions: expected(second.submission, second.workItem) })),
      send(input('ReturnWorkItemForChanges', { reason: 'Author withdraws this exact submission' }, { targetId: second.workItem.id, expectedVersions: expected(second.workItem) })),
    ]);
    // Returning for changes is a PM notification; it neither completes nor
    // reopens the core work item, so it cannot race the review's CAS.
    assert.equal(returned.status, 200);
    assert.equal(reviewed.status, 200);
    const current = await read(second.workItem.id);
    assert.equal(current.data.status, 'in_progress');
    assert.equal('currentSubmissionId' in current.data, false);
    const stale = await send(input('RecordReview', reviewPayload(second.submission, second.artifactVersion.id), { targetId: second.submission.id, expectedVersions: expected(second.submission, current) }));
    assert.equal(stale.body.error?.code, 'review_already_recorded');
  });

  it('SC-11 serializes opposite dependency edges, allows cross-project and cancelled prerequisites, and rejects cycles', async () => {
    const project = await activeProject('Dependency graph');
    const left = await workingItem(project, 'Left');
    const right = await workingItem(project, 'Right');
    const results = await Promise.all([
      send(input('AddDependency', { prerequisiteId: right.id }, { targetId: left.id, expectedVersions: expected(left) })),
      send(input('AddDependency', { prerequisiteId: left.id }, { targetId: right.id, expectedVersions: expected(right) })),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 422]);
    const cycle = results.find(result => result.status === 422)!.body;
    const cycleDetails = cycle.error?.details as { diagnostics?: { code: string }[] } | undefined;
    assert.ok(cycleDetails?.diagnostics?.some(item => item.code === 'RELATION_CYCLE'), JSON.stringify(cycle));
    const dependent = results[0]!.status === 200 ? await read(left.id) : await read(right.id);
    const prerequisite = dependent.id === left.id ? right : left;
    assert.deepEqual(dependent.data.prerequisiteIds, [prerequisite.id]);
    await committed('CancelWorkItem', { reason: 'This prerequisite is explicitly cancelled' }, { extra: { targetId: prerequisite.id, expectedVersions: expected(prerequisite) } });
    const delivery = await artifact(project);
    const submittedWork = await committed<{ workItem: Entity; submission: Entity }>('SubmitWorkItemResult', { contentRevision: 1, artifactVersionIds: [delivery.artifactVersion.id], evidenceIds: [] }, { extra: { targetId: dependent.id, expectedVersions: expected(dependent) } });
    // A cancelled prerequisite no longer blocks core completion.
    const completed = await committed('CompleteWorkItem', { submissionId: submittedWork.submission.id }, { extra: { targetId: dependent.id, expectedVersions: expected(submittedWork.workItem) } });
    assert.equal(completed.data.status, 'done');
    const otherProject = await activeProject('Other dependency scope');
    const foreign = await workingItem(otherProject);
    // The Markdown core permits cross-project blocked_by edges.
    const crossProject = await committed('AddDependency', { prerequisiteId: foreign.id }, { extra: { targetId: dependent.id, expectedVersions: expected(completed) } });
    assert.deepEqual(crossProject.data.prerequisiteIds, [prerequisite.id, foreign.id]);
    const selfReference = await send(input('AddDependency', { prerequisiteId: dependent.id }, { targetId: dependent.id, expectedVersions: expected(crossProject) }));
    assert.equal(selfReference.body.error?.code, 'SELF_REFERENCE');
    assert.deepEqual((await read(dependent.id)).data.prerequisiteIds, [prerequisite.id, foreign.id]);
  });

  it('SC-14/INF-06 enforces project/workspace scopes for reads, delivery, receipts and review authority', async () => {
    const allowed = await activeProject('Allowed scope');
    const hidden = await activeProject('Hidden scope');
    const delivery = await submitted(allowed);
    const secretArtifact = await artifact(hidden);
    const guest = await member('Scoped contributor');
    await committed('SetWorkspaceMember', { userId: guest.user.id, capabilities: ['domain.read', 'planning.edit', 'delivery.write', 'delivery.submit'], projectIds: [allowed.id] });
    const visible = await request(`${path()}/entities?kind=project`, { cookie: guest.cookie });
    assert.deepEqual(visible.body.items.map((project: Entity) => project.id), [allowed.id]);
    assert.equal((await request(`${path()}/entities/${hidden.id}`, { cookie: guest.cookie })).status, 404);
    const forbiddenDownload = await fetch(`${origin}${path()}/artifact-versions/${secretArtifact.artifactVersion.id}/content`, { headers: { cookie: guest.cookie } });
    assert.equal(forbiddenDownload.status, 404);
    await forbiddenDownload.arrayBuffer();
    const noReview = await send(input('RecordReview', reviewPayload(delivery.submission, delivery.artifactVersion.id), { targetId: delivery.submission.id, expectedVersions: expected(delivery.submission, delivery.workItem) }), { cookie: guest.cookie });
    assert.equal(noReview.status, 403);
    assert.equal(noReview.body.error?.code, 'permission_denied');
    const noComplete = await send(input('CompleteWorkItem', { submissionId: delivery.submission.id, reviewId: randomUUID() }, { targetId: delivery.workItem.id, expectedVersions: expected(delivery.workItem) }), { cookie: guest.cookie });
    assert.equal(noComplete.body.error?.code, 'permission_denied');
    const crossProject = await send(input('RecordEvidence', { subjectRefs: [delivery.workItem.id], method: 'Attempt cross-project evidence', scope: 'Forbidden', result: 'pass', observedAt: new Date().toISOString(), artifactVersionRefs: [secretArtifact.artifactVersion.id] }, { projectId: allowed.id }));
    assert.equal(crossProject.body.error?.code, 'project_mismatch');
    const otherWorkspace = (await createWorkspace(pool, owner.id, 'Private workspace')).id;
    const privateProject = await activeProject('Other workspace project', otherWorkspace);
    assert.equal((await request(`${path(otherWorkspace)}/entities/${privateProject.id}`, { cookie: guest.cookie })).status, 404);
    // Core IDs are workspace-local and can repeat across workspaces, so only
    // membership separates the workspaces; an absent core target is rejected.
    const injectedWorkspace = await send(input('AddDependency', { prerequisiteId: delivery.workItem.id }, { targetId: 'PRJ-999', expectedVersions: { 'PRJ-999': 1 } }));
    assert.equal(injectedWorkspace.status, 404);
    const guestCommand = input('UpdateWorkItemMetadata', { priority: 'normal' }, { targetId: delivery.workItem.id, expectedVersions: expected(delivery.workItem) });
    const written = await send(guestCommand, { cookie: guest.cookie });
    assert.equal(written.status, 200);
    assert.equal((await request(`${path()}/commands/${guestCommand.commandId}`)).status, 404);
    const memberships = (await request<Membership[]>(`${path()}/members`)).body;
    const membership = memberships.find(item => item.userId === guest.user.id)!;
    await committed('RevokeWorkspaceMember', { userId: guest.user.id }, { extra: { expectedVersions: { [guest.user.id]: membership.version } } });
    assert.equal((await send(guestCommand, { cookie: guest.cookie })).status, 404);
    assert.equal((await request(`${path()}/commands/${guestCommand.commandId}`, { cookie: guest.cookie })).status, 404);
  });

  it('INF-02 publishes from two workers without duplicate events, and recovers an already-published outbox row', async () => {
    const workspace = (await createWorkspace(pool, owner.id, 'Concurrent worker publication')).id;
    const project = await activeProject('Events have one durable identity', workspace);
    // Core commands do not write PM outbox rows; PM-only conversation events
    // provide the durable publication fixture.
    let discussion = await conversation(workspace, project);
    for (let index = 0; index < 240; index++) discussion = await appendMessage(workspace, discussion, `Durable publication fixture ${index}`);
    const before = await pool.query('SELECT count(*)::text AS count FROM outbox WHERE workspace_id=$1', [workspace]);
    assert.equal(before.rows[0].count, '241');
    await Promise.all([publishOutboxBatch(pool, 500), publishOutboxBatch(workerPool, 500)]);
    await flushOutbox();
    const rows = await pool.query<{ cursor: string; event_id: string }>('SELECT cursor::text,event_id FROM events WHERE workspace_id=$1 ORDER BY events.cursor', [workspace]);
    assert.equal(rows.rows.length, Number(before.rows[0].count));
    assert.equal(new Set(rows.rows.map(row => row.event_id)).size, rows.rows.length);
    assert.deepEqual(rows.rows.map(row => row.cursor), rows.rows.map((_, index) => String(index + 1)));
    const firstPage = await request(`${path(workspace)}/changes?after=0`);
    assert.equal(firstPage.body.events.length, 200);
    const remainingPage = await request(`${path(workspace)}/changes?after=${firstPage.body.cursor}`);
    assert.equal(firstPage.body.events.length + remainingPage.body.events.length, rows.rows.length);
    assert.equal(remainingPage.body.cursor, rows.rows.at(-1)!.cursor);
    const replayedId = rows.rows[0]!.event_id;
    await pool.query('UPDATE outbox SET published_at=NULL WHERE workspace_id=$1 AND event_id=$2', [workspace, replayedId]);
    await Promise.all([publishOutboxBatch(pool, 500), publishOutboxBatch(workerPool, 500)]);
    assert.deepEqual((await pool.query('SELECT cursor::text,event_id FROM events WHERE workspace_id=$1 ORDER BY events.cursor', [workspace])).rows, rows.rows);
    assert.equal((await pool.query('SELECT count(*)::text AS count FROM outbox WHERE workspace_id=$1 AND published_at IS NULL', [workspace])).rows[0].count, '0');
  });

  it('INF-03/05 paginates durable change cursors, rejects invalid/expired cursors and resumes from a snapshot', async () => {
    const workspace = (await createWorkspace(pool, owner.id, 'Cursor pagination')).id;
    const project = await activeProject('Paginated stream', workspace);
    await flushOutbox();
    const baseline = (await request(`${path(workspace)}/changes?after=0`)).body.cursor;
    for (let index = 0; index < 205; index++) await conversation(workspace, project);
    await flushOutbox();
    const first = (await request(`${path(workspace)}/changes?after=${baseline}`)).body;
    assert.equal(first.events.length, 200);
    const second = (await request(`${path(workspace)}/changes?after=${first.cursor}`)).body;
    assert.equal(second.events.length, 5);
    assert.equal(second.cursor, second.head);
    const all = [...first.events, ...second.events];
    assert.equal(new Set(all.map(event => event.event.eventId)).size, 205);
    assert.deepEqual(all.map(event => event.cursor), all.map((_, index) => String(BigInt(baseline) + BigInt(index + 1))));
    const page = await request(`${path(workspace)}/entities?kind=conversation&projectId=${project.id}&limit=100`);
    assert.equal(page.body.items.length, 100);
    assert.ok(page.body.nextCursor);
    const page2 = await request(`${path(workspace)}/entities?kind=conversation&projectId=${project.id}&limit=100&after=${encodeURIComponent(page.body.nextCursor)}`);
    assert.equal(page2.body.items.length, 100);
    const page3 = await request(`${path(workspace)}/entities?kind=conversation&projectId=${project.id}&limit=100&after=${encodeURIComponent(page2.body.nextCursor)}`);
    assert.equal(page3.body.items.length, 5);
    assert.equal(page3.body.nextCursor, null);
    assert.equal(new Set([...page.body.items, ...page2.body.items, ...page3.body.items].map((entity: Entity) => entity.id)).size, 205);
    const wrongCursorScope = await request(`${path(workspace)}/entities?kind=intent&after=${encodeURIComponent(page.body.nextCursor)}`);
    assert.equal(wrongCursorScope.status, 400);
    assert.equal((await request(`${path(workspace)}/changes?after=bad`)).body.error.code, 'invalid_cursor');
    assert.equal((await request(`${path(workspace)}/changes?after=${BigInt(second.head) + 1n}`)).body.error.code, 'invalid_cursor');
    // Simulate retained-history expiry only inside this test's private schema.
    await pool.query('DELETE FROM events WHERE workspace_id=$1 AND cursor<=$2::bigint', [workspace, first.cursor]);
    const expired = await request(`${path(workspace)}/changes?after=${baseline}`);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, 'cursor_expired');
    const snapshot = await request(`${path(workspace)}/entities?kind=conversation&projectId=${project.id}&limit=100`);
    assert.equal(snapshot.body.cursor, second.head);
    assert.deepEqual((await request(`${path(workspace)}/changes?after=${snapshot.body.cursor}`)).body.events, []);
  });

  it('INF-03 subscribes over HTTP and resumes missed changes using Last-Event-ID after disconnection', async t => {
    const workspace = (await createWorkspace(pool, owner.id, 'SSE reconnect')).id;
    const project = await activeProject('SSE before', workspace);
    await flushOutbox();
    const baseline = (await request(`${path(workspace)}/changes?after=0`)).body.cursor;
    const first = await eventStream(`${origin}${path(workspace)}/events?after=${baseline}`, ownerCookie);
    t.after(() => first.close());
    let discussion = await conversation(workspace, project);
    await flushOutbox();
    const seen = await first.waitFor(event => event.event === 'change' && event.data.aggregateId === discussion.id);
    assert.equal(seen.data.aggregateVersion, discussion.version);
    assert.ok(seen.id);
    assert.equal('payload' in seen.data, false);
    await first.close();
    discussion = await appendMessage(workspace, discussion, 'SSE changed while disconnected');
    await flushOutbox();
    const resumed = await eventStream(`${origin}${path(workspace)}/events`, ownerCookie, seen.id);
    t.after(() => resumed.close());
    const recovered = await resumed.waitFor(event => event.event === 'change' && event.data.aggregateVersion === discussion.version);
    assert.ok(BigInt(recovered.id!) > BigInt(seen.id));
    assert.equal(resumed.history.filter(event => event.event === 'change').some(event => event.data.eventId === seen.data.eventId), false);
    await resumed.waitFor(event => event.event === 'checkpoint' && event.id === recovered.id);
  });

  it('INF-03/06 filters project streams, advances checkpoints over hidden events and disconnects revoked members', async t => {
    const workspace = (await createWorkspace(pool, owner.id, 'SSE scope and revocation')).id;
    const visible = await activeProject('Visible SSE scope', workspace);
    const hidden = await activeProject('Hidden SSE scope', workspace);
    const guest = await member('SSE guest');
    await committed('SetWorkspaceMember', { userId: guest.user.id, capabilities: ['domain.read'], projectIds: [visible.id] }, { workspace });
    await flushOutbox();
    const denied = await request(`${path(workspace)}/events?projectId=${hidden.id}`, { cookie: guest.cookie });
    assert.equal(denied.status, 404);
    const baseline = (await request(`${path(workspace)}/changes?after=0`)).body.cursor;
    const stream = await eventStream(`${origin}${path(workspace)}/events?after=${baseline}&projectId=${visible.id}`, guest.cookie);
    t.after(() => stream.close());
    await conversation(workspace, hidden);
    await flushOutbox();
    const head = (await request(`${path(workspace)}/changes?after=${baseline}`)).body.cursor;
    await stream.waitFor(event => event.event === 'checkpoint' && event.id === head);
    assert.equal(stream.history.some(event => event.event === 'change' && event.data.projectId === hidden.id), false);
    const shown = await conversation(workspace, visible);
    await flushOutbox();
    await stream.waitFor(event => event.event === 'change' && event.data.aggregateId === shown.id);
    const memberships = (await request<Membership[]>(`${path(workspace)}/members`)).body;
    const membership = memberships.find(item => item.userId === guest.user.id)!;
    await committed('RevokeWorkspaceMember', { userId: guest.user.id }, { workspace, extra: { expectedVersions: { [guest.user.id]: membership.version } } });
    const revoked = await stream.waitFor(event => event.event === 'stream_error');
    assert.equal(revoked.data.code, 'not_found_or_forbidden');
    await stream.done;
    assert.equal((await request(`${path(workspace)}/changes?after=${head}&projectId=${visible.id}`, { cookie: guest.cookie })).status, 404);
  });

  it('INF-06 terminates a live authenticated SSE stream after logout invalidates its session', async t => {
    const workspace = (await createWorkspace(pool, owner.id, 'SSE session revocation')).id;
    await activeProject('Session-bound stream', workspace);
    await flushOutbox();
    const baseline = (await request(`${path(workspace)}/changes?after=0`)).body.cursor;
    const cookie = await signIn(owner);
    const stream = await eventStream(`${origin}${path(workspace)}/events?after=${baseline}`, cookie);
    t.after(() => stream.close());
    assert.equal((await request('/api/v1/auth/logout', { method: 'POST', cookie })).status, 200);
    const expired = await stream.waitFor(event => event.event === 'stream_error');
    assert.equal(expired.data.code, 'unauthenticated');
    await stream.done;
  });
});
