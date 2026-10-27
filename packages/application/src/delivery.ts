import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor, Capability, Entity, EntityKind } from '../../domain/src/core.ts';
import { assertCriteria, assertProjectWritable, assertRule, assertSameProject, assertUnarchived } from '../../domain/src/planning.ts';
import { artifactLifecyclePayloads, assertArtifactVisible } from '../../domain/src/artifact-files.ts';
import { MAX_BLOB_BYTES } from '../../infrastructure/src/blobs.ts';
import type { BlobStore } from '../../infrastructure/src/blobs.ts';
import type { CommandContext, CommandRegistry } from './ports.ts';
import { readEntity } from './queries.ts';

export const UPLOAD_TTL_MS = 60 * 60 * 1000;
const id = z.uuid().toLowerCase();
const text = z.string().trim().min(1).max(20_000);
const refs = z.array(id).max(200).refine(values => new Set(values).size === values.length, 'Duplicate references');
const nonemptyRefs = refs.refine(values => values.length > 0, 'At least one reference is required');
const entityId = z.string().regex(/^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, 'Expected a stable entity ID');
const entityRefs = z.array(entityId).max(200).refine(values => new Set(values).size === values.length, 'Duplicate references');
const nonemptyEntityRefs = entityRefs.refine(values => values.length > 0, 'At least one reference is required');
const fileName = z.string().min(1).max(255).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f/\\]/u.test(value) && value !== '.' && value !== '..', 'Unsafe file name');
const mediaType = z.string().min(3).max(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/);
const sourceRun = { sourceRunId: z.null().optional() };
const criterion = z.strictObject({ criterionId: z.string().min(1).max(160), result: z.enum(['pass', 'fail', 'inconclusive']), basisRefs: nonemptyRefs, explanation: text });

function target(ctx: CommandContext): string {
  if (!ctx.command.targetId) throw new DomainError('target_id_required');
  return ctx.command.targetId;
}

function projectId(ctx: CommandContext, entity?: Entity): string {
  const value = entity?.projectId ?? ctx.command.projectId;
  assertRule(value, 'project_id_required');
  assertRule(!ctx.command.projectId || ctx.command.projectId === value, 'project_mismatch');
  return value;
}

async function project(ctx: CommandContext, capability: Capability, scope: string, active = false): Promise<Entity> {
  await ctx.require(capability, scope);
  const item = await ctx.get(scope, 'project');
  assertProjectWritable(item, active);
  return item;
}

async function reference(ctx: CommandContext, value: string, kind: EntityKind, scope: string): Promise<Entity> {
  const item = await ctx.get(value, kind);
  assertSameProject(item, scope);
  return item;
}

function canonicalBase64(value: string): Buffer {
  if (value.length > 4 * Math.ceil(MAX_BLOB_BYTES / 3)) throw new DomainError('upload_too_large', 'Maximum decoded upload size is 8 MiB', 413);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new DomainError('invalid_base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_BLOB_BYTES) throw new DomainError('upload_too_large', 'Maximum decoded upload size is 8 MiB', 413);
  if (bytes.toString('base64') !== value) throw new DomainError('invalid_base64');
  return bytes;
}

async function verifyVersion(store: BlobStore, version: Entity): Promise<Buffer> {
  const bytes = await store.read(version.data.objectKey, { workspaceId: version.workspaceId, projectId: version.projectId!, ...(version.data.storageId ? { storageId: version.data.storageId } : {}) });
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== version.data.sha256 || digest !== version.data.contentDigest || bytes.byteLength !== version.data.size) throw new DomainError('blob_integrity_error', 'Artifact metadata does not match stored content', 503);
  return bytes;
}

async function upload(ctx: CommandContext, store: BlobStore, uploadId: string, scope: string): Promise<Entity> {
  const item = await reference(ctx, uploadId, 'upload', scope);
  ctx.checkVersion(item);
  assertRule(item.data.ownerId === ctx.actor.id, 'upload_owner_mismatch');
  assertRule(item.data.consumedAt === null && item.data.consumedByArtifactVersionId === null, 'upload_already_consumed');
  assertRule(Date.parse(item.data.expiresAt) > Date.now(), 'upload_expired');
  const bytes = await store.read(item.data.objectKey, { workspaceId: ctx.workspaceId, projectId: scope, ...(item.data.storageId ? { storageId: item.data.storageId } : {}) });
  assertRule(bytes.length === item.data.size && createHash('sha256').update(bytes).digest('hex') === item.data.sha256, 'blob_integrity_error');
  return item;
}

async function publishVersion(ctx: CommandContext, artifact: Entity, staged: Entity, versionId: string): Promise<Entity> {
  const version = await ctx.insert('artifact_version', {
    artifactId: artifact.id, uploadId: staged.id, objectKey: staged.data.objectKey,
    ...(staged.data.storageId ? { storageId: staged.data.storageId } : {}),
    contentDigest: staged.data.sha256, sha256: staged.data.sha256, size: staged.data.size,
    mediaType: staged.data.mediaType, fileName: staged.data.fileName, sourceRunId: null, producerId: ctx.actor.id,
  }, artifact.projectId, versionId);
  const consumed = await ctx.update(staged, { ...staged.data, consumedAt: new Date().toISOString(), consumedByArtifactVersionId: version.id });
  await ctx.emit('UploadConsumed', consumed, { artifactVersionId: version.id });
  await ctx.emit('ArtifactVersionAdded', version);
  return version;
}

function assertCurrentSubmission(workItem: Entity, submission: Entity): void {
  assertUnarchived(workItem);
  assertRule(submission.data.workItemId === workItem.id, 'submission_mismatch');
  const saved = submission.data.workScopeSnapshot;
  const current = workItem.data.acceptanceCriteria as { id: string; text: string }[];
  assertCriteria(current);
  assertRule(saved?.workItemId === workItem.id && saved.title === workItem.data.title && saved.description === workItem.data.description, 'submission_snapshot_mismatch');
  assertRule(Array.isArray(saved.acceptanceCriteria) && saved.acceptanceCriteria.length === current.length && current.every(item => saved.acceptanceCriteria.some((entry: { id: string; text: string }) => entry.id === item.id && entry.text === item.text)), 'submission_snapshot_mismatch');
}

// Execution has never been initialized in this first-stage schema. Introducing
// Run storage requires the authoritative occupancy guard here and in Planning,
// including when new execution is disabled; a feature flag cannot prove no Run.
// Orphaned and expired staged blobs are retained until a reference-aware GC is
// implemented. This module never deletes content as part of a failed command.
export function createDeliveryCommands(store: BlobStore): CommandRegistry {
  return {
    StageUpload: {
      payload: z.strictObject({ contentBase64: z.string().max(4 * Math.ceil(MAX_BLOB_BYTES / 3)), fileName, mediaType }),
      async handler(ctx) {
        const payload = ctx.command.payload as { contentBase64: string; fileName: string; mediaType: string };
        const scope = projectId(ctx);
        await project(ctx, 'delivery.write', scope);
        const stored = await store.put(canonicalBase64(payload.contentBase64), { workspaceId: ctx.workspaceId, projectId: scope });
        const staged = await ctx.insert('upload', {
          objectKey: stored.key, sha256: stored.sha256, size: stored.size, fileName: payload.fileName, mediaType: payload.mediaType,
          ...(stored.storageId ? { storageId: stored.storageId } : {}),
          ownerId: ctx.actor.id, expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(), consumedAt: null, consumedByArtifactVersionId: null,
        }, scope);
        await ctx.emit('UploadStaged', staged);
        return { upload: staged };
      },
    },
    RegisterArtifact: {
      payload: z.strictObject({ title: text, kind: z.string().trim().min(1).max(100), uploadId: id, ...sourceRun }),
      async handler(ctx) {
        const payload = ctx.command.payload as { title: string; kind: string; uploadId: string };
        const scope = projectId(ctx);
        await project(ctx, 'delivery.write', scope);
        const staged = await upload(ctx, store, payload.uploadId, scope);
        const versionId = randomUUID();
        const artifact = await ctx.insert('artifact', { title: payload.title, kind: payload.kind, hiddenAt: null, hiddenBy: null, versionRefs: [versionId], latestVersionId: versionId }, scope);
        const version = await publishVersion(ctx, artifact, staged, versionId);
        await ctx.emit('ArtifactRegistered', artifact, { artifactVersionId: version.id });
        return { artifact, artifactVersion: version };
      },
    },
    AddArtifactVersion: {
      payload: z.strictObject({ uploadId: id, ...sourceRun }),
      async handler(ctx) {
        const artifact = await ctx.get(target(ctx), 'artifact');
        const scope = projectId(ctx, artifact);
        await project(ctx, 'delivery.write', scope);
        ctx.checkVersion(artifact);
        assertArtifactVisible(artifact);
        const staged = await upload(ctx, store, ctx.command.payload.uploadId as string, scope);
        const version = await publishVersion(ctx, artifact, staged, randomUUID());
        const updated = await ctx.update(artifact, { ...artifact.data, versionRefs: [...artifact.data.versionRefs, version.id], latestVersionId: version.id });
        await ctx.emit('ArtifactUpdated', updated, { artifactVersionId: version.id });
        return { artifact: updated, artifactVersion: version };
      },
    },
    RenameArtifact: {
      payload: artifactLifecyclePayloads.RenameArtifact,
      async handler(ctx) {
        const artifact = await ctx.get(target(ctx), 'artifact');
        await project(ctx, 'delivery.write', projectId(ctx, artifact));
        ctx.checkVersion(artifact);
        assertArtifactVisible(artifact);
        const title = ctx.command.payload.title as string;
        if (title === artifact.data.title) return { artifact };
        const updated = await ctx.update(artifact, { ...artifact.data, title });
        await ctx.emit('ArtifactRenamed', updated);
        return { artifact: updated };
      },
    },
    HideArtifact: {
      payload: artifactLifecyclePayloads.HideArtifact,
      async handler(ctx) {
        const artifact = await ctx.get(target(ctx), 'artifact');
        await project(ctx, 'delivery.write', projectId(ctx, artifact));
        ctx.checkVersion(artifact);
        if (artifact.data.hiddenAt !== null) return { artifact };
        const updated = await ctx.update(artifact, { ...artifact.data, hiddenAt: new Date().toISOString(), hiddenBy: ctx.actor.id });
        await ctx.emit('ArtifactHidden', updated);
        return { artifact: updated };
      },
    },
    RestoreArtifact: {
      payload: artifactLifecyclePayloads.RestoreArtifact,
      async handler(ctx) {
        const artifact = await ctx.get(target(ctx), 'artifact');
        await project(ctx, 'delivery.write', projectId(ctx, artifact));
        ctx.checkVersion(artifact);
        if (artifact.data.hiddenAt === null) return { artifact };
        const updated = await ctx.update(artifact, { ...artifact.data, hiddenAt: null, hiddenBy: null });
        await ctx.emit('ArtifactRestored', updated);
        return { artifact: updated };
      },
    },
    CopyArtifactVersion: {
      payload: artifactLifecyclePayloads.CopyArtifactVersion,
      async handler(ctx) {
        const sourceVersion = await ctx.get(target(ctx), 'artifact_version');
        const sourceArtifact = await ctx.get(sourceVersion.data.artifactId as string, 'artifact');
        assertSameProject(sourceArtifact, sourceVersion.projectId!);
        assertRule(sourceArtifact.data.versionRefs.includes(sourceVersion.id), 'artifact_version_mismatch');
        const scope = projectId(ctx);
        const destination = await project(ctx, 'delivery.write', scope);
        ctx.checkVersion(sourceArtifact);
        ctx.checkVersion(sourceVersion);
        ctx.checkVersion(destination);

        const bytes = await verifyVersion(store, sourceVersion);
        const stored = await store.put(bytes, { workspaceId: ctx.workspaceId, projectId: scope });
        if (stored.key === sourceVersion.data.objectKey || stored.sha256 !== sourceVersion.data.sha256 || stored.size !== sourceVersion.data.size) {
          throw new DomainError('blob_integrity_error', 'The copied object is not an independent verified version', 503);
        }
        // Provider acknowledgement is not proof of readable independent bytes.
        // Failed publication deliberately retains any new orphan object.
        await verifyVersion(store, { ...sourceVersion, projectId: scope, data: { ...sourceVersion.data, objectKey: stored.key, storageId: stored.storageId } });
        await ctx.core?.refresh?.();
        const currentDestination = await project(ctx, 'delivery.write', scope);
        ctx.checkVersion(currentDestination);
        await ctx.require('domain.read', sourceVersion.projectId);
        await ctx.require('domain.read', scope);

        const staged = await ctx.insert('upload', {
          objectKey: stored.key, sha256: stored.sha256, size: stored.size,
          ...(stored.storageId ? { storageId: stored.storageId } : {}),
          fileName: sourceVersion.data.fileName, mediaType: sourceVersion.data.mediaType,
          ownerId: ctx.actor.id, expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
          consumedAt: null, consumedByArtifactVersionId: null,
        }, scope);
        await ctx.emit('UploadStaged', staged);
        const versionId = randomUUID();
        const artifact = await ctx.insert('artifact', {
          title: ctx.command.payload.targetTitle, kind: ctx.command.payload.targetKind,
          hiddenAt: null, hiddenBy: null, versionRefs: [versionId], latestVersionId: versionId,
        }, scope);
        const artifactVersion = await publishVersion(ctx, artifact, staged, versionId);
        await ctx.sql.query(`INSERT INTO artifact_copy_origins(
          workspace_id,target_artifact_version_id,target_artifact_id,target_project_id,
          source_artifact_id,source_artifact_version_id,source_project_id,copied_by,command_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ctx.workspaceId, artifactVersion.id, artifact.id, scope, sourceArtifact.id, sourceVersion.id, sourceVersion.projectId, ctx.actor.id, ctx.command.commandId]);
        await ctx.emit('ArtifactRegistered', artifact, { artifactVersionId: artifactVersion.id });
        await ctx.emit('ArtifactCopied', artifact, { artifactVersionId: artifactVersion.id });
        return { artifact, artifactVersion };
      },
    },
    RecordEvidence: {
      payload: z.strictObject({ subjectRefs: nonemptyEntityRefs, method: text, scope: text, result: z.enum(['pass', 'fail', 'inconclusive']), observedAt: z.iso.datetime({ offset: true }), artifactVersionRefs: refs, ...sourceRun }),
      async handler(ctx) {
        const payload = ctx.command.payload as { subjectRefs: string[]; method: string; scope: string; result: string; observedAt: string; artifactVersionRefs: string[] };
        const scope = projectId(ctx);
        await project(ctx, 'delivery.write', scope);
        assertRule(Date.parse(payload.observedAt) <= Date.now() + 5 * 60_000, 'observation_in_future');
        for (const value of payload.subjectRefs) {
          const subject = await ctx.get(value);
          assertRule((subject.kind === 'project' && subject.id === scope) || subject.projectId === scope, 'project_mismatch');
          assertRule(['project', 'work_item', 'artifact', 'artifact_version'].includes(subject.kind), 'invalid_evidence_subject');
        }
        for (const value of payload.artifactVersionRefs) await verifyVersion(store, await reference(ctx, value, 'artifact_version', scope));
        const evidence = await ctx.insert('evidence', { ...payload, sourceRunId: null, producerId: ctx.actor.id }, scope);
        await ctx.emit('EvidenceRecorded', evidence);
        return { evidence };
      },
    },
    SubmitWorkItemResult: {
      payload: z.strictObject({ contentRevision: z.number().int().positive(), artifactVersionIds: nonemptyRefs, evidenceIds: refs }),
      async handler(ctx) {
        const payload = ctx.command.payload as { contentRevision: number; artifactVersionIds: string[]; evidenceIds: string[] };
        const workItem = await ctx.get(target(ctx), 'work_item');
        const scope = projectId(ctx, workItem);
        await project(ctx, 'delivery.submit', scope, true);
        ctx.checkVersion(workItem);
        assertUnarchived(workItem);
        assertCriteria(workItem.data.acceptanceCriteria);
        const artifacts = new Set<string>();
        for (const value of payload.artifactVersionIds) {
          const version = await reference(ctx, value, 'artifact_version', scope);
          assertRule(version.data.sourceRunId === null, 'capability_not_enabled');
          await verifyVersion(store, version);
          artifacts.add(version.data.artifactId);
        }
        for (const value of payload.evidenceIds) {
          const evidence = await reference(ctx, value, 'evidence', scope);
          assertRule(evidence.data.sourceRunId === null, 'capability_not_enabled');
          assertRule(evidence.data.artifactVersionRefs.every((item: string) => payload.artifactVersionIds.includes(item)), 'evidence_scope_mismatch');
          assertRule(evidence.data.subjectRefs.some((item: string) => item === scope || item === workItem.id || payload.artifactVersionIds.includes(item) || artifacts.has(item)), 'evidence_scope_mismatch');
        }
        const submittedAt = new Date().toISOString();
        const submission = await ctx.insert('submission', {
          workItemId: workItem.id, contentRevision: payload.contentRevision,
          workScopeSnapshot: { workItemId: workItem.id, contentRevision: payload.contentRevision, title: workItem.data.title, description: workItem.data.description, acceptanceCriteria: structuredClone(workItem.data.acceptanceCriteria), capturedAt: submittedAt },
          artifactVersionIds: [...payload.artifactVersionIds], evidenceIds: [...payload.evidenceIds], submittedBy: ctx.actor.id, submittedAt,
        }, scope);
        await ctx.emit('SubmissionCreated', submission);
        return { workItem, submission };
      },
    },
    RecordReview: {
      payload: z.strictObject({ criterionResults: z.array(criterion).min(1).max(200), verdict: z.enum(['passed', 'changes_requested']), reason: text }),
      async handler(ctx) {
        const payload = ctx.command.payload as { criterionResults: { criterionId: string; result: string; basisRefs: string[]; explanation: string }[]; verdict: string; reason: string };
        const submission = await ctx.get(target(ctx), 'submission');
        const scope = projectId(ctx, submission);
        await project(ctx, 'delivery.review', scope, true);
        const workItem = await reference(ctx, submission.data.workItemId, 'work_item', scope);
        ctx.checkVersion(submission);
        ctx.checkVersion(workItem);
        assertCurrentSubmission(workItem, submission);
        assertRule(!(await ctx.list('review', scope)).some(item => item.data.submissionId === submission.id), 'review_already_recorded');
        const criteria = submission.data.workScopeSnapshot.acceptanceCriteria as { id: string; text: string }[];
        assertRule(payload.criterionResults.length === criteria.length && new Set(payload.criterionResults.map(item => item.criterionId)).size === criteria.length && criteria.every(item => payload.criterionResults.some(result => result.criterionId === item.id)), 'incomplete_review');
        const allowed = new Set<string>([...submission.data.artifactVersionIds, ...submission.data.evidenceIds]);
        const positive = new Set<string>(submission.data.artifactVersionIds);
        for (const value of submission.data.artifactVersionIds) await verifyVersion(store, await reference(ctx, value, 'artifact_version', scope));
        for (const value of submission.data.evidenceIds) {
          const evidence = await reference(ctx, value, 'evidence', scope);
          if (evidence.data.result === 'pass') positive.add(value);
        }
        for (const result of payload.criterionResults) {
          assertRule(result.basisRefs.every(value => allowed.has(value)), 'review_basis_outside_submission');
          if (result.result === 'pass') assertRule(result.basisRefs.some(value => positive.has(value)), 'passing_basis_required');
        }
        if (payload.verdict === 'passed') assertRule(payload.criterionResults.every(item => item.result === 'pass'), 'incomplete_review');
        const review = await ctx.insert('review', { submissionId: submission.id, workItemId: workItem.id, contentRevision: submission.data.contentRevision, ...payload, reviewerId: ctx.actor.id, reviewedAt: new Date().toISOString() }, scope);
        await ctx.emit(payload.verdict === 'passed' ? 'ReviewPassed' : 'ReviewChangesRequested', review);
        return { review };
      },
    },
    ReturnWorkItemForChanges: {
      payload: z.strictObject({ reason: text, reviewId: id.optional() }),
      async handler(ctx) {
        const workItem = await ctx.get(target(ctx), 'work_item');
        const scope = projectId(ctx, workItem);
        await project(ctx, 'delivery.submit', scope, true);
        ctx.checkVersion(workItem);
        const submissions = (await ctx.list('submission', scope)).filter(item => item.data.workItemId === workItem.id).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
        const submission = submissions[0];
        assertRule(submission, 'submission_required');
        assertCurrentSubmission(workItem, submission);
        if (ctx.command.payload.reviewId) {
          const review = await reference(ctx, ctx.command.payload.reviewId as string, 'review', scope);
          assertRule(review.data.submissionId === submission.id && review.data.workItemId === workItem.id && review.data.contentRevision === submission.data.contentRevision && review.data.verdict === 'changes_requested', 'changes_requested_review_required');
        }
        await ctx.emit('WorkItemReturnedForChanges', submission, { reason: ctx.command.payload.reason, reviewId: ctx.command.payload.reviewId ?? null });
        return { workItem, submission };
      },
    },
  };
}

export async function downloadArtifactVersion(pool: Pool, actor: Actor, workspaceId: string, versionId: string, store: BlobStore): Promise<{ bytes: Buffer; sha256: string; mediaType: string; fileName: string }> {
  const version = await readEntity(pool, actor, workspaceId, versionId);
  if (version.kind !== 'artifact_version') throw new DomainError('entity_not_found', 'Artifact version not found', 404);
  const bytes = await verifyVersion(store, version);
  return { bytes, sha256: version.data.sha256, mediaType: version.data.mediaType, fileName: version.data.fileName };
}
