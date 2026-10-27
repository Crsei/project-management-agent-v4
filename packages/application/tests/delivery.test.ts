import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor, Capability, Command, Entity, EntityKind } from '../../domain/src/core.ts';
import type { CommandContext } from '../src/ports.ts';
import { createDeliveryCommands } from '../src/delivery.ts';
import { LocalBlobStore } from '../../infrastructure/src/blobs.ts';

async function harness(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pm-delivery-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalBlobStore(root);
  await store.init();
  const registry = createDeliveryCommands(store);
  const actor: Actor = { id: randomUUID(), email: 'human@example.test', name: 'Human' };
  const workspaceId = randomUUID();
  const entities = new Map<string, Entity>();
  const events: { type: string; entity: Entity }[] = [];
  const denied = new Set<Capability>();
  function seed(kind: EntityKind, data: Record<string, any>, scope: string | null = null, entityId: string = randomUUID()): Entity {
    const item = { id: entityId, workspaceId, projectId: scope, kind, version: 1, data: structuredClone(data), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: actor.id };
    entities.set(item.id, item);
    return structuredClone(item);
  }
  const project = seed('project', { name: 'P', status: 'active', archivedAt: null });
  const criterionA = randomUUID();
  const criterionB = randomUUID();
  const work = seed('work_item', { title: 'Deliver', description: 'Exact scope', status: 'in_progress', contentRevision: 1, acceptanceCriteria: [{ id: criterionA, text: 'Text is complete' }, { id: criterionB, text: 'Text is readable' }], currentSubmissionId: null, archivedAt: null }, project.id);
  async function run(type: string, payload: Record<string, unknown>, options: { targetId?: string; projectId?: string; expectedVersions?: Record<string, number> } = {}): Promise<any> {
    const definition = registry[type]!;
    const command: Command = { commandId: randomUUID(), commandType: type, projectId: project.id, ...options, payload: definition.payload.parse(payload) as Record<string, unknown> };
    const created = new Set<string>();
    const ctx: CommandContext = {
      sql: { async query() { return { rows: [], rowCount: 0 }; } }, actor, workspaceId, command,
      async require(capability) { if (denied.has(capability)) throw new DomainError('forbidden', 'forbidden', 403); },
      async requireSelf() { await ctx.require('domain.read'); },
      async get(value, kind) {
        const item = entities.get(value);
        if (!item || (kind && item.kind !== kind)) throw new DomainError('entity_not_found', 'entity_not_found', 404);
        return structuredClone(item);
      },
      async list(kind, scope) { return [...entities.values()].filter(item => item.kind === kind && (scope === undefined || item.projectId === scope)).map(item => structuredClone(item)); },
      async insert(kind, data, scope, value) { const entity = seed(kind, data, scope ?? null, value); created.add(entity.id); return entity; },
      async update(entity, data) {
        ctx.checkVersion(entity);
        const updated = { ...entity, version: entity.version + 1, data: structuredClone(data) };
        entities.set(entity.id, updated);
        return structuredClone(updated);
      },
      checkVersion(entity) { if (!created.has(entity.id) && command.expectedVersions?.[entity.id] !== entity.version) throw new DomainError('version_conflict', 'version_conflict', 409); },
      async emit(type, entity) { events.push({ type, entity }); },
    };
    return definition.handler(ctx);
  }
  async function register(content = 'A human document') {
    const { upload } = await run('StageUpload', { contentBase64: Buffer.from(content).toString('base64'), fileName: 'document.txt', mediaType: 'text/plain' });
    const result = await run('RegisterArtifact', { title: 'Document', kind: 'document', uploadId: upload.id }, { expectedVersions: { [upload.id]: upload.version } });
    return { upload, ...result };
  }
  async function submit(artifactVersionIds: string[], evidenceIds: string[] = []) {
    const current = entities.get(work.id)!;
    return run('SubmitWorkItemResult', { contentRevision: current.data.contentRevision, artifactVersionIds, evidenceIds }, { targetId: work.id, expectedVersions: { [work.id]: current.version } });
  }
  function reviewPayload(versionId: string) {
    return { criterionResults: [criterionA, criterionB].map(criterionId => ({ criterionId, result: 'pass', basisRefs: [versionId], explanation: 'I inspected the exact document and confirmed this criterion.' })), verdict: 'passed', reason: 'All criteria checked by a human.' };
  }
  return { actor, workspaceId, project, work, criterionA, criterionB, entities, events, denied, store, run, register, submit, reviewPayload };
}

test('manual upload, fixed submission and terminal review preserve scope without completing work', async t => {
  const h = await harness(t);
  const { artifact, artifactVersion, upload } = await h.register();
  assert.deepEqual(artifact.data.versionRefs, [artifactVersion.id]);
  assert.equal(artifactVersion.data.sourceRunId, null);
  assert.equal(h.entities.get(upload.id)!.data.consumedByArtifactVersionId, artifactVersion.id);
  assert.equal((await h.store.read(artifactVersion.data.objectKey)).toString(), 'A human document');
  const { submission, workItem } = await h.submit([artifactVersion.id]);
  assert.equal(workItem.data.status, 'in_progress');
  assert.equal(workItem.data.currentSubmissionId, null);
  assert.equal(workItem.version, h.work.version);
  assert.deepEqual(submission.data.workScopeSnapshot.acceptanceCriteria, h.work.data.acceptanceCriteria);
  assert.equal(h.entities.get(h.work.id)!.version, h.work.version);
  assert.equal(h.entities.get(h.work.id)!.data.currentSubmissionId, null);
  assert.equal(h.entities.get(submission.id)!.kind, 'submission');
  const { review } = await h.run('RecordReview', h.reviewPayload(artifactVersion.id), { targetId: submission.id, expectedVersions: { [submission.id]: 1, [workItem.id]: workItem.version } });
  assert.equal(review.data.verdict, 'passed');
  assert.equal(h.entities.get(h.work.id)!.version, workItem.version);
  assert.equal(h.entities.get(h.work.id)!.data.status, 'in_progress');
  await assert.rejects(h.run('RecordReview', h.reviewPayload(artifactVersion.id), { targetId: submission.id, expectedVersions: { [submission.id]: 1, [workItem.id]: workItem.version } }), { code: 'review_already_recorded' });
});

test('uploads enforce canonical base64, safe metadata and closed payloads', async t => {
  const h = await harness(t);
  for (const contentBase64 of ['Zg', ' Zg==', 'Zg==\n', 'Zh==', '!!!!', 'Zg===']) {
    await assert.rejects(h.run('StageUpload', { contentBase64, fileName: 'a.txt', mediaType: 'text/plain' }), { code: 'invalid_base64' });
  }
  await assert.rejects(h.run('StageUpload', { contentBase64: 'Zg==', fileName: '../a', mediaType: 'text/plain' }));
  await assert.rejects(h.run('StageUpload', { contentBase64: 'Zg==', fileName: 'a', mediaType: 'text/plain\r\nInjected: yes' }));
  await assert.rejects(h.run('StageUpload', { contentBase64: 'Zg==', fileName: 'a', mediaType: 'text/plain', actorId: randomUUID() }));
  await assert.rejects(h.run('RegisterArtifact', { title: 'Bad', kind: 'text', uploadId: randomUUID(), sourceRunId: randomUUID() }));
  assert.equal(h.events.length, 0);
});

test('canonical base64 works at the actual 8 MiB boundary and rejects one extra decoded byte', async t => {
  const h = await harness(t);
  const exact = Buffer.alloc(8 * 1024 * 1024, 7);
  const { upload } = await h.run('StageUpload', { contentBase64: exact.toString('base64'), fileName: 'boundary.bin', mediaType: 'application/octet-stream' });
  assert.equal(upload.data.size, exact.length);
  assert.deepEqual(await h.store.read(upload.data.objectKey), exact);
  await assert.rejects(h.run('StageUpload', { contentBase64: Buffer.alloc(exact.length + 1).toString('base64'), fileName: 'oversized.bin', mediaType: 'application/octet-stream' }), { code: 'upload_too_large' });
});

test('staged content has an owner, finite lease, a version and a single consumer', async t => {
  const h = await harness(t);
  const { upload } = await h.run('StageUpload', { contentBase64: 'Zg==', fileName: 'a', mediaType: 'text/plain' });
  assert.ok(Date.parse(upload.data.expiresAt) > Date.now());
  assert.ok(Date.parse(upload.data.expiresAt) <= Date.now() + 3_600_000);
  const payload = { title: 'Artifact', kind: 'text', uploadId: upload.id };
  await assert.rejects(h.run('RegisterArtifact', payload), { code: 'version_conflict' });
  const opts = { expectedVersions: { [upload.id]: 1 } };
  h.entities.get(upload.id)!.data.ownerId = randomUUID();
  await assert.rejects(h.run('RegisterArtifact', payload, opts), { code: 'upload_owner_mismatch' });
  h.entities.get(upload.id)!.data.ownerId = h.actor.id;
  h.entities.get(upload.id)!.data.expiresAt = new Date(0).toISOString();
  await assert.rejects(h.run('RegisterArtifact', payload, opts), { code: 'upload_expired' });
  h.entities.get(upload.id)!.data.expiresAt = new Date(Date.now() + 60_000).toISOString();
  await h.run('RegisterArtifact', payload, opts);
  await assert.rejects(h.run('RegisterArtifact', payload, { expectedVersions: { [upload.id]: 2 } }), { code: 'upload_already_consumed' });
});

test('new artifact versions require both expected versions and never alter an existing submission', async t => {
  const h = await harness(t);
  const { artifact, artifactVersion } = await h.register();
  const { submission } = await h.submit([artifactVersion.id]);
  const { upload } = await h.run('StageUpload', { contentBase64: Buffer.from('New document').toString('base64'), fileName: 'a.txt', mediaType: 'text/plain' });
  await assert.rejects(h.run('AddArtifactVersion', { uploadId: upload.id }, { targetId: artifact.id, expectedVersions: { [upload.id]: 1 } }), { code: 'version_conflict' });
  const next = await h.run('AddArtifactVersion', { uploadId: upload.id }, { targetId: artifact.id, expectedVersions: { [artifact.id]: 1, [upload.id]: 1 } });
  assert.deepEqual(next.artifact.data.versionRefs, [artifactVersion.id, next.artifactVersion.id]);
  assert.deepEqual(h.entities.get(submission.id)!.data.artifactVersionIds, [artifactVersion.id]);
});

test('cross-project references and stale submission snapshots are rejected', async t => {
  const h = await harness(t);
  const { artifactVersion } = await h.register();
  h.entities.get(artifactVersion.id)!.projectId = randomUUID();
  await assert.rejects(h.submit([artifactVersion.id]), { code: 'project_mismatch' });
  h.entities.get(artifactVersion.id)!.projectId = h.project.id;
  const { submission } = await h.submit([artifactVersion.id]);
  assert.equal(submission.data.contentRevision, 1);
  h.entities.get(h.work.id)!.data.title = 'Changed scope';
  await assert.rejects(h.run('RecordReview', h.reviewPayload(artifactVersion.id), { targetId: submission.id, expectedVersions: { [submission.id]: 1, [h.work.id]: 1 } }), { code: 'submission_snapshot_mismatch' });
  h.entities.get(h.work.id)!.data.title = h.work.data.title;
  h.entities.get(h.work.id)!.data.acceptanceCriteria = [{ id: h.criterionA, text: 'Different criterion text' }];
  await assert.rejects(h.run('ReturnWorkItemForChanges', { reason: 'Stale snapshot' }, { targetId: h.work.id, expectedVersions: { [h.work.id]: 1 } }), { code: 'submission_snapshot_mismatch' });
});

test('corrupt referenced content blocks submission before WorkItem state changes', async t => {
  const h = await harness(t);
  const { artifactVersion } = await h.register();
  h.entities.get(artifactVersion.id)!.data.contentDigest = '0'.repeat(64);
  await assert.rejects(h.submit([artifactVersion.id]), { code: 'blob_integrity_error' });
  assert.equal(h.entities.get(h.work.id)!.data.status, 'in_progress');
  assert.equal([...h.entities.values()].filter(item => item.kind === 'submission').length, 0);
});

test('terminal reviews check each criterion, locked basis and current work version', async t => {
  const h = await harness(t);
  const { artifactVersion } = await h.register();
  const { submission } = await h.submit([artifactVersion.id]);
  const opts = { targetId: submission.id, expectedVersions: { [submission.id]: 1, [h.work.id]: 1 } };
  const valid = h.reviewPayload(artifactVersion.id);
  await assert.rejects(h.run('RecordReview', valid, { targetId: submission.id, expectedVersions: { [submission.id]: 1 } }), { code: 'version_conflict' });
  await assert.rejects(h.run('RecordReview', { ...valid, criterionResults: valid.criterionResults.slice(1) }, opts), { code: 'incomplete_review' });
  await assert.rejects(h.run('RecordReview', { ...valid, criterionResults: [valid.criterionResults[0], valid.criterionResults[0]] }, opts), { code: 'incomplete_review' });
  await assert.rejects(h.run('RecordReview', { ...valid, criterionResults: valid.criterionResults.map(item => ({ ...item, basisRefs: [randomUUID()] })) }, opts), { code: 'review_basis_outside_submission' });
  await assert.rejects(h.run('RecordReview', { ...valid, criterionResults: valid.criterionResults.map(item => ({ ...item, result: 'fail' })) }, opts), { code: 'incomplete_review' });
  assert.equal([...h.entities.values()].filter(item => item.kind === 'review').length, 0);
});

test('failed evidence remains immutable and cannot be the sole passing basis', async t => {
  const h = await harness(t);
  const { artifactVersion } = await h.register();
  const { evidence } = await h.run('RecordEvidence', { subjectRefs: [h.work.id], method: 'Manual inspection', scope: 'Previous document', result: 'fail', observedAt: new Date().toISOString(), artifactVersionRefs: [artifactVersion.id] });
  const { submission } = await h.submit([artifactVersion.id], [evidence.id]);
  const opts = { targetId: submission.id, expectedVersions: { [submission.id]: 1, [h.work.id]: 1 } };
  const valid = h.reviewPayload(artifactVersion.id);
  await assert.rejects(h.run('RecordReview', { ...valid, criterionResults: valid.criterionResults.map(item => ({ ...item, basisRefs: [evidence.id] })) }, opts), { code: 'passing_basis_required' });
  await h.run('RecordReview', { ...valid, criterionResults: valid.criterionResults.map(item => ({ ...item, basisRefs: [artifactVersion.id, evidence.id], explanation: 'The earlier failing observation is explained by the corrected exact artifact I inspected.' })) }, opts);
  assert.equal(h.entities.get(evidence.id)!.data.result, 'fail');
});

test('returning a submission preserves its terminal review and requires a new submission', async t => {
  const h = await harness(t);
  const { artifactVersion } = await h.register();
  const { submission } = await h.submit([artifactVersion.id]);
  const reviewData = h.reviewPayload(artifactVersion.id);
  const { review } = await h.run('RecordReview', { ...reviewData, verdict: 'changes_requested', criterionResults: reviewData.criterionResults.map(item => ({ ...item, result: 'fail' })) }, { targetId: submission.id, expectedVersions: { [submission.id]: 1, [h.work.id]: 1 } });
  const returned = await h.run('ReturnWorkItemForChanges', { reason: 'Address review feedback', reviewId: review.id }, { targetId: h.work.id, expectedVersions: { [h.work.id]: 1 } });
  assert.equal(returned.workItem.data.status, 'in_progress');
  assert.equal(returned.workItem.data.currentSubmissionId, null);
  assert.equal(returned.workItem.version, h.work.version);
  assert.equal(h.entities.get(h.work.id)!.data.status, 'in_progress');
  assert.equal(h.entities.get(h.work.id)!.data.currentSubmissionId, null);
  assert.equal(h.entities.get(review.id)!.data.verdict, 'changes_requested');
  assert.equal(h.entities.get(submission.id)!.kind, 'submission');
  const returnedEvent = h.events.at(-1)!;
  assert.equal(returnedEvent.type, 'WorkItemReturnedForChanges');
  assert.equal(returnedEvent.entity.id, submission.id);
  await assert.rejects(h.run('RecordReview', reviewData, { targetId: submission.id, expectedVersions: { [submission.id]: 1, [h.work.id]: 1 } }), { code: 'review_already_recorded' });
  const next = await h.submit([artifactVersion.id]);
  assert.notEqual(next.submission.id, submission.id);
});

test('delivery capabilities and archived projects guard file writes and state transitions', async t => {
  const h = await harness(t);
  h.denied.add('delivery.write');
  await assert.rejects(h.run('StageUpload', { contentBase64: 'Zg==', fileName: 'a', mediaType: 'text/plain' }), { code: 'forbidden' });
  h.denied.clear();
  h.entities.get(h.project.id)!.data.archivedAt = new Date().toISOString();
  await assert.rejects(h.run('StageUpload', { contentBase64: 'Zg==', fileName: 'a', mediaType: 'text/plain' }), { code: 'object_archived' });
  assert.equal(h.events.length, 0);
});

test('artifact title rename, hidden editing guard and restore retain immutable history and enforce CAS even for no-op state', async t => {
  const h = await harness(t);
  const { artifact, artifactVersion } = await h.register();
  const before = structuredClone(artifactVersion);
  const opts = (entity: Entity) => ({ targetId: entity.id, expectedVersions: { [entity.id]: entity.version } });
  const renamed = (await h.run('RenameArtifact', { title: '  中文 / arbitrary.png  ' }, opts(artifact))).artifact as Entity;
  assert.equal(renamed.data.title, '中文 / arbitrary.png');
  assert.deepEqual(h.entities.get(artifactVersion.id), before);
  const events = h.events.length;
  const same = await h.run('RenameArtifact', { title: renamed.data.title }, opts(renamed));
  assert.equal(same.artifact.version, renamed.version); assert.equal(h.events.length, events);
  const hidden = (await h.run('HideArtifact', {}, opts(renamed))).artifact as Entity;
  assert.equal(hidden.data.hiddenBy, h.actor.id); assert.ok(hidden.data.hiddenAt);
  await assert.rejects(h.run('RenameArtifact', { title: 'Blocked' }, opts(hidden)), { code: 'artifact_hidden' });
  const staged = (await h.run('StageUpload', { contentBase64: 'eA==', fileName: 'new.txt', mediaType: 'text/plain' })).upload as Entity;
  await assert.rejects(h.run('AddArtifactVersion', { uploadId: staged.id }, { ...opts(hidden), expectedVersions: { [hidden.id]: hidden.version, [staged.id]: staged.version } }), { code: 'artifact_hidden' });
  await assert.rejects(h.run('HideArtifact', {}, opts(renamed)), { code: 'version_conflict' });
  const restored = (await h.run('RestoreArtifact', {}, opts(hidden))).artifact as Entity;
  assert.equal(restored.id, artifact.id); assert.equal(restored.data.hiddenAt, null); assert.equal(restored.data.hiddenBy, null);
  assert.deepEqual(restored.data.versionRefs, artifact.data.versionRefs);
  const afterRestore = h.events.length;
  await h.run('RestoreArtifact', {}, opts(restored));
  assert.equal(h.events.length, afterRestore);
  await assert.rejects(h.run('RestoreArtifact', {}, opts(hidden)), { code: 'version_conflict' });
});

test('selected historical copy uses real independent read/put/read bytes, does not follow latest and keeps provenance out of target data', async t => {
  const h = await harness(t);
  const initial = await h.register('first version X');
  const staged = (await h.run('StageUpload', { contentBase64: Buffer.from('newest Y').toString('base64'), fileName: 'newest.txt', mediaType: 'text/plain' })).upload as Entity;
  const next = await h.run('AddArtifactVersion', { uploadId: staged.id }, { targetId: initial.artifact.id, expectedVersions: { [initial.artifact.id]: 1, [staged.id]: 1 } });
  const hidden = (await h.run('HideArtifact', {}, { targetId: next.artifact.id, expectedVersions: { [next.artifact.id]: next.artifact.version } })).artifact as Entity;
  const snapshot = structuredClone(hidden);
  const read = h.store.read.bind(h.store); const reads: string[] = [];
  h.store.read = async key => { reads.push(key); return read(key); };
  const copied = await h.run('CopyArtifactVersion', { targetTitle: 'Independent', targetKind: 'document' }, { targetId: initial.artifactVersion.id, expectedVersions: { [hidden.id]: hidden.version, [initial.artifactVersion.id]: 1, [h.project.id]: 1 } });
  assert.notEqual(copied.artifact.id, hidden.id); assert.notEqual(copied.artifactVersion.id, initial.artifactVersion.id);
  assert.notEqual(copied.artifactVersion.data.objectKey, initial.artifactVersion.data.objectKey);
  assert.deepEqual(reads, [initial.artifactVersion.data.objectKey, copied.artifactVersion.data.objectKey]);
  assert.equal((await read(copied.artifactVersion.data.objectKey)).toString(), 'first version X');
  assert.equal(copied.artifactVersion.data.fileName, 'document.txt');
  assert.equal(copied.artifactVersion.data.producerId, h.actor.id); assert.equal(copied.artifactVersion.data.sourceRunId, null);
  assert.deepEqual(copied.artifact.data.versionRefs, [copied.artifactVersion.id]); assert.equal(copied.artifact.data.hiddenAt, null);
  assert.deepEqual(h.entities.get(hidden.id), snapshot);
  assert.equal(JSON.stringify(copied).includes(initial.artifactVersion.id), false);
  assert.equal(JSON.stringify(copied).includes(hidden.id), false);
});

test('copy validates all baselines before blob IO and does not publish after a target lifecycle change during put', async t => {
  const h = await harness(t);
  const { artifact, artifactVersion } = await h.register();
  const expectedVersions = { [artifact.id]: artifact.version, [artifactVersion.id]: artifactVersion.version, [h.project.id]: h.project.version };
  const put = h.store.put.bind(h.store); let puts = 0;
  h.store.put = async bytes => { puts += 1; const stored = await put(bytes); h.entities.get(h.project.id)!.data.archivedAt = new Date().toISOString(); return stored; };
  await assert.rejects(h.run('CopyArtifactVersion', { targetTitle: 'Copy', targetKind: 'document' }, { targetId: artifactVersion.id, expectedVersions: { ...expectedVersions, [artifact.id]: 99 } }), { code: 'version_conflict' });
  assert.equal(puts, 0);
  const count = h.entities.size;
  await assert.rejects(h.run('CopyArtifactVersion', { targetTitle: 'Copy', targetKind: 'document' }, { targetId: artifactVersion.id, expectedVersions }), { code: 'object_archived' });
  assert.equal(puts, 1); assert.equal(h.entities.size, count);
});

test('copy refuses provider key sharing, corrupt source and unreadable new objects without publishing target entities', async t => {
  const h = await harness(t);
  const { artifact, artifactVersion } = await h.register();
  const opts = { targetId: artifactVersion.id, expectedVersions: { [artifact.id]: 1, [artifactVersion.id]: 1, [h.project.id]: 1 } };
  const payload = { targetTitle: 'Copy', targetKind: 'document' };
  const count = h.entities.size;
  const put = h.store.put.bind(h.store);
  h.store.put = async () => ({ key: artifactVersion.data.objectKey, sha256: artifactVersion.data.sha256, size: artifactVersion.data.size });
  await assert.rejects(h.run('CopyArtifactVersion', payload, opts), { code: 'blob_integrity_error' });
  h.store.put = put;
  const read = h.store.read.bind(h.store);
  h.store.read = async key => key === artifactVersion.data.objectKey ? Buffer.from('corrupt') : read(key);
  await assert.rejects(h.run('CopyArtifactVersion', payload, opts), { code: 'blob_integrity_error' });
  h.store.read = async key => { if (key === artifactVersion.data.objectKey) return read(key); throw new DomainError('blob_read_failed', 'Injected new-object read failure', 503); };
  await assert.rejects(h.run('CopyArtifactVersion', payload, opts), { code: 'blob_read_failed' });
  assert.equal(h.entities.size, count);
});
