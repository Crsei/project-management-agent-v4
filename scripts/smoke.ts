import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Entity } from '../packages/domain/src/core.ts';
import { authenticate, revokeSession, serviceOrigin } from '../packages/pm-cli/auth.ts';

const entitySchema = z.object({
  id: z.string(), workspaceId: z.string(), projectId: z.string().nullable(),
  kind: z.enum(['project', 'work_item', 'milestone', 'conversation', 'intent', 'decision', 'upload', 'artifact', 'artifact_version', 'evidence', 'submission', 'review']),
  version: z.number(), data: z.record(z.string(), z.unknown()),
  createdAt: z.string().nullable(), updatedAt: z.string().nullable(), createdBy: z.string(),
});
const evidenceSchema = z.object({
  workspaceId: z.string(), projectId: z.string(), workItemId: z.string(),
  artifactVersionId: z.string(), commandIds: z.array(z.string()), sha256: z.string(),
});
const capabilitiesSchema = z.object({ execution: z.object({ enabled: z.boolean() }) });
const submissionSchema = entitySchema.extend({
  data: z.object({ workScopeSnapshot: z.object({ acceptanceCriteria: z.array(z.object({ id: z.string() })).min(1) }) }),
});
type CommandOptions = { target?: Entity; projectId?: string; versions?: Record<string, number> };

const origin = serviceOrigin(process.env.PUBLIC_ORIGIN ?? process.env.PM_API_URL ?? 'http://127.0.0.1:3224');
const authentication = await authenticate(origin);
const evidencePath = '.local/evidence/service-smoke.json';
const verifying = process.argv.includes('--verify');
let base: string;
let userId: string;
let workspaceId: string;
const ids: string[] = [];
async function json<Schema extends z.ZodType>(route: string, schema: Schema, body?: unknown): Promise<z.output<Schema>> {
  const response = await fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...authentication.headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.ok, true, `${route} returned HTTP ${response.status}`);
  const result: unknown = await response.json().catch(() => { throw new Error(`${route} returned an invalid JSON response`); });
  return schema.parse(result);
}
async function command(commandType: string, payload: unknown, options?: CommandOptions): Promise<z.output<typeof entitySchema>>;
async function command<T>(commandType: string, payload: unknown, options: CommandOptions, schema: z.ZodType<T>): Promise<T>;
async function command(commandType: string, payload: unknown, options: CommandOptions = {}, schema: z.ZodType = entitySchema): Promise<unknown> {
  const commandId = randomUUID();
  const receipt = await json(`${base}/commands`, z.object({ status: z.literal('committed'), result: schema }), {
    commandId, commandType, payload,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.target ? { targetId: options.target.id } : {}),
    expectedVersions: { ...options.versions, ...(options.target ? { [options.target.id]: options.target.version } : {}) },
  });
  assert.equal(receipt.status, 'committed');
  ids.push(commandId);
  return receipt.result;
}

try {
  const me = await json('/api/v1/auth/me', z.object({ actor: z.object({ id: z.string() }) }));
  userId = me.actor.id;
  const workspaces = await json('/api/v1/workspaces', z.object({ items: z.array(z.object({ id: z.string() })) }));
  const saved = verifying ? evidenceSchema.parse(JSON.parse(await readFile(evidencePath, 'utf8'))) : undefined;
  const requestedWorkspace = process.env.PM_WORKSPACE_ID?.trim() || saved?.workspaceId;
  if (requestedWorkspace) {
    assert.ok(workspaces.items.some((item: { id: string }) => item.id === requestedWorkspace), 'Selected smoke workspace must be authorized');
    workspaceId = requestedWorkspace;
  } else {
    assert.equal(workspaces.items.length, 1, 'Set PM_WORKSPACE_ID when the account has zero or multiple workspaces');
    workspaceId = workspaces.items[0]!.id;
  }
  base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  assert.equal((await json('/health/ready', z.object({ status: z.string() }))).status, 'ready');
  if (verifying) {
    assert.ok(saved);
    assert.equal(saved.workspaceId, workspaceId);
    const item = await json(`${base}/entities/${saved.workItemId}`, entitySchema);
    assert.equal(item.data.status, 'done');
    const project = await json(`${base}/entities/${saved.projectId}`, entitySchema);
    assert.equal(project.data.status, 'completed');
    assert.ok(project.data.archivedAt);
    for (const id of saved.commandIds) assert.equal((await json(`${base}/commands/${id}`, z.object({ status: z.string() }))).status, 'committed');
    const content = await fetch(`${origin}${base}/artifact-versions/${saved.artifactVersionId}/content`, { headers: authentication.headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    assert.equal(content.status, 200);
    assert.equal(createHash('sha256').update(new Uint8Array(await content.arrayBuffer())).digest('hex'), saved.sha256);
    console.log(JSON.stringify({ status: 'verified', projectId: saved.projectId, receipts: saved.commandIds.length, persistence: 'same IDs and content hash', executionEnabled: (await json('/api/v1/capabilities', capabilitiesSchema)).execution.enabled }));
  } else {
    const criterionId = randomUUID();
    let project: Entity = await command('CreateProject', { name: `Backend acceptance ${new Date().toISOString()}`, goal: 'Validate the real manual delivery path', ownerId: userId, completionCriteria: ['Verified manual delivery'] });
    project = await command('ActivateProject', {}, { target: project });
    const scope = { projectId: project.id };
    let milestone: Entity = await command('CreateMilestone', { title: 'Backend acceptance', criteria: ['Delivered artifact reviewed'] }, scope);
    let item: Entity = await command('CreateWorkItem', { title: 'Produce a verified document', description: 'Real HTTP + PostgreSQL + persistent file acceptance.', acceptanceCriteria: [{ id: criterionId, text: 'The delivered document can be downloaded with its recorded SHA-256.' }], assigneeId: userId }, scope);
    item = await command('AssignMilestone', { milestoneId: milestone.id }, { ...scope, target: item });
    item = await command('ReadyWorkItem', {}, { ...scope, target: item });
    item = await command('StartWorkItem', {}, { ...scope, target: item });
    const bytes = Buffer.from('Project Management backend manual delivery.\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const staged = await command('StageUpload', { contentBase64: bytes.toString('base64'), mediaType: 'text/plain', fileName: 'backend-acceptance.txt' }, scope, z.object({ upload: entitySchema }));
    const artifact = await command('RegisterArtifact', { title: 'Backend acceptance document', kind: 'document', uploadId: staged.upload.id }, { ...scope, versions: { [staged.upload.id]: staged.upload.version } }, z.object({ artifactVersion: entitySchema }));
    const evidence = await command('RecordEvidence', { subjectRefs: [item.id, artifact.artifactVersion.id], method: 'Content digest comparison', scope: 'The uploaded document bytes', result: 'pass', observedAt: new Date().toISOString(), artifactVersionRefs: [artifact.artifactVersion.id] }, scope, z.object({ evidence: entitySchema }));
    const submitted = await command('SubmitWorkItemResult', { contentRevision: 1, artifactVersionIds: [artifact.artifactVersion.id], evidenceIds: [evidence.evidence.id] }, { ...scope, target: item }, z.object({ workItem: entitySchema, submission: submissionSchema }));
    item = submitted.workItem;
    const reviewCriterion = submitted.submission.data.workScopeSnapshot.acceptanceCriteria[0]!.id;
    const reviewed = await command('RecordReview', { verdict: 'passed', reason: 'Downloaded artifact matches the acceptance criterion', criterionResults: [{ criterionId: reviewCriterion, result: 'pass', basisRefs: [artifact.artifactVersion.id, evidence.evidence.id], explanation: 'Versioned content and digest checked.' }] }, { ...scope, target: submitted.submission, versions: { [item.id]: item.version } }, z.object({ review: entitySchema }));
    item = await command('CompleteWorkItem', { submissionId: submitted.submission.id, reviewId: reviewed.review.id }, { ...scope, target: item });
    milestone = await command('AchieveMilestone', { reason: 'Accepted work delivered', criteriaChecks: [{ criterionIndex: 0, explanation: 'The linked work item is done.' }] }, { ...scope, target: milestone });
    project = await command('CompleteProject', { reason: 'Manual acceptance completed', criteriaChecks: [{ criterionIndex: 0, explanation: 'Work item and milestone passed.' }] }, { target: project });
    project = await command('ArchiveObject', { kind: 'project', reason: 'Keep this verified acceptance record' }, { target: project });
    const report = { checkedAt: new Date().toISOString(), source: 'real HTTP, PostgreSQL and local persistent blob storage', workspaceId, projectId: project.id, workItemId: item.id, artifactVersionId: artifact.artifactVersion.id, sha256, commandIds: ids, executionEnabled: false };
    await mkdir('.local/evidence', { recursive: true, mode: 0o700 });
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: 'passed', projectId: project.id, workItemId: item.id, commands: ids.length, evidencePath }));
  }
} finally {
  // Only revoke the short-lived session this smoke invocation created. Explicit
  // tokens and saved CLI sessions belong to their caller and remain reusable.
  if (authentication.source === 'password') await revokeSession(origin, authentication.token);
}
