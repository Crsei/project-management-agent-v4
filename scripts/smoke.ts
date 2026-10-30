import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Entity } from '../packages/domain/src/core.ts';

const origin = process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3224';
const credentials = JSON.parse(await readFile('.local/access.json', 'utf8')) as { email: string; password: string; userId: string; workspaceId: string };
const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: credentials.email, password: credentials.password }), signal: AbortSignal.timeout(10_000) });
assert.equal(login.status, 200, 'Local administrator must be able to log in');
await login.json();
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const base = `/api/v1/workspaces/${credentials.workspaceId}`;
const ids: string[] = [];
async function json(route: string, body?: unknown) {
  const response = await fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const result = await response.json() as any;
  assert.equal(response.ok, true, JSON.stringify({ route, status: response.status, result }));
  return result;
}
async function command(commandType: string, payload: unknown, options: { target?: Entity; projectId?: string; versions?: Record<string, number> } = {}): Promise<any> {
  const commandId = randomUUID();
  const receipt = await json(`${base}/commands`, {
    commandId, commandType, payload,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.target ? { targetId: options.target.id } : {}),
    expectedVersions: { ...options.versions, ...(options.target ? { [options.target.id]: options.target.version } : {}) },
  });
  assert.equal(receipt.status, 'committed');
  ids.push(commandId);
  return receipt.result;
}

await mkdir('.local/evidence', { recursive: true, mode: 0o700 });
const evidencePath = '.local/evidence/service-smoke.json';
try {
  assert.equal((await json('/health/ready')).status, 'ready');
  if (process.argv.includes('--verify')) {
    const saved = JSON.parse(await readFile(evidencePath, 'utf8'));
    assert.equal(saved.workspaceId, credentials.workspaceId);
    const item = await json(`${base}/entities/${saved.workItemId}`);
    assert.equal(item.data.status, 'done');
    const project = await json(`${base}/entities/${saved.projectId}`);
    assert.equal(project.data.status, 'completed');
    assert.ok(project.data.archivedAt);
    for (const id of saved.commandIds) assert.equal((await json(`${base}/commands/${id}`)).status, 'committed');
    const content = await fetch(`${origin}${base}/artifact-versions/${saved.artifactVersionId}/content`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(content.status, 200);
    assert.equal(createHash('sha256').update(new Uint8Array(await content.arrayBuffer())).digest('hex'), saved.sha256);
    console.log(JSON.stringify({ status: 'verified', projectId: saved.projectId, receipts: saved.commandIds.length, persistence: 'same IDs and content hash', executionEnabled: (await json('/api/v1/capabilities')).execution.enabled }));
  } else {
    const criterionId = randomUUID();
    let project: Entity = await command('CreateProject', { name: `Backend acceptance ${new Date().toISOString()}`, goal: 'Validate the real manual delivery path', ownerId: credentials.userId, completionCriteria: ['Verified manual delivery'] });
    project = await command('ActivateProject', {}, { target: project });
    const scope = { projectId: project.id };
    let milestone: Entity = await command('CreateMilestone', { title: 'Backend acceptance', criteria: ['Delivered artifact reviewed'] }, scope);
    let item: Entity = await command('CreateWorkItem', { title: 'Produce a verified document', description: 'Real HTTP + PostgreSQL + persistent file acceptance.', acceptanceCriteria: [{ id: criterionId, text: 'The delivered document can be downloaded with its recorded SHA-256.' }], assigneeId: credentials.userId }, scope);
    item = await command('AssignMilestone', { milestoneId: milestone.id }, { ...scope, target: item });
    item = await command('ReadyWorkItem', {}, { ...scope, target: item });
    item = await command('StartWorkItem', {}, { ...scope, target: item });
    const bytes = Buffer.from('Project Management backend manual delivery.\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const staged = await command('StageUpload', { contentBase64: bytes.toString('base64'), mediaType: 'text/plain', fileName: 'backend-acceptance.txt' }, scope);
    const artifact = await command('RegisterArtifact', { title: 'Backend acceptance document', kind: 'document', uploadId: staged.upload.id }, { ...scope, versions: { [staged.upload.id]: staged.upload.version } });
    const evidence = await command('RecordEvidence', { subjectRefs: [item.id, artifact.artifactVersion.id], method: 'Content digest comparison', scope: 'The uploaded document bytes', result: 'pass', observedAt: new Date().toISOString(), artifactVersionRefs: [artifact.artifactVersion.id] }, scope);
    const submitted = await command('SubmitWorkItemResult', { contentRevision: 1, artifactVersionIds: [artifact.artifactVersion.id], evidenceIds: [evidence.evidence.id] }, { ...scope, target: item });
    item = submitted.workItem;
    const reviewCriterion = submitted.submission.data.workScopeSnapshot.acceptanceCriteria[0].id;
    const reviewed = await command('RecordReview', { verdict: 'passed', reason: 'Downloaded artifact matches the acceptance criterion', criterionResults: [{ criterionId: reviewCriterion, result: 'pass', basisRefs: [artifact.artifactVersion.id, evidence.evidence.id], explanation: 'Versioned content and digest checked.' }] }, { ...scope, target: submitted.submission, versions: { [item.id]: item.version } });
    item = await command('CompleteWorkItem', { submissionId: submitted.submission.id, reviewId: reviewed.review.id }, { ...scope, target: item });
    milestone = await command('AchieveMilestone', { reason: 'Accepted work delivered', criteriaChecks: [{ criterionIndex: 0, explanation: 'The linked work item is done.' }] }, { ...scope, target: milestone });
    project = await command('CompleteProject', { reason: 'Manual acceptance completed', criteriaChecks: [{ criterionIndex: 0, explanation: 'Work item and milestone passed.' }] }, { target: project });
    project = await command('ArchiveObject', { kind: 'project', reason: 'Keep this verified acceptance record' }, { target: project });
    const report = { checkedAt: new Date().toISOString(), source: 'real HTTP, PostgreSQL and local persistent blob storage', workspaceId: credentials.workspaceId, projectId: project.id, workItemId: item.id, artifactVersionId: artifact.artifactVersion.id, sha256, commandIds: ids, executionEnabled: false };
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: 'passed', projectId: project.id, workItemId: item.id, commands: ids.length, evidencePath }));
  }
} finally {
  await json('/api/v1/auth/logout', {}).catch(() => {});
}
