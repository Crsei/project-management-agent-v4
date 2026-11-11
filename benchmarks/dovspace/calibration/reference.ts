import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SYNTHETIC_DOCUMENTS, SYNTHETIC_FACTS, KNOWLEDGE_FIXTURE_FILES, HISTORICAL_SESSION_FILES, K02_CURRENT_REASON, K02_TIMELINE, L04_CURRENT_DOCUMENT } from '../fixtures/documents.ts';
import { PROJECTS, ISSUES } from '../fixtures/dataset.ts';
import { CODE_FIXTURE_FILES, FIXTURE_VERSION, resolveTaskDefinition, type TaskId } from '../tasks/index.ts';
import { D01_PLAN } from '../tasks/policies.ts';
import type { BenchEvent, FixtureEntity, FixtureHandle, FixtureReceipt, FixtureSnapshot } from '../schemas/types.ts';
import { check, type GradeInput } from '../graders/types.ts';
import { REQUIRED_FACTS } from '../graders/knowledge.ts';
import { REFERENCE_RETRY_SOURCE, REFERENCE_RETRY_TEST, REFERENCE_INCIDENT_SOURCE, REFERENCE_INCIDENT_TEST } from './reference-source.ts';

export const REFERENCE_SCOPE = 'Grader calibration only: synthetic trusted authority/transport evidence and real isolated candidate code execution; NOT a model run or live PM/Agent recovery experiment.';
export function putPublic(snapshot: FixtureSnapshot, filename: string, content: string | unknown): void {
  snapshot.publicFiles[filename] = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n').toString('base64');
}
function makeEntity(key: string, projectId: string | null, title: string, body: string, kind = 'work_item'): FixtureEntity {
  const id = `reference-${key}`;
  const entity = { id, entity: kind, title, project: projectId, body, ...(kind === 'work_item' ? { status: key === 'atlas-code' || key === 'cedar-handoff' ? 'in_progress' : 'todo', priority: 'medium', due: '2026-12-01' } : {}) };
  return { key, id, projectId: kind === 'project' ? id : projectId, kind, revision: `reference-revision-${key}-0`, path: `core/${id}.md`, entity, raw: `---\nid: ${id}\n---\n\n${body}` };
}
export function referenceCase(taskId: TaskId, root: string): GradeInput {
  const fixture: FixtureHandle = { fixtureId: `calibration-${taskId}`, fixtureVersion: FIXTURE_VERSION, root, publicRoot: path.join(root, 'public'), authorityRoot: path.join(root, 'authority-not-mounted'), agentDataRoot: path.join(root, 'agent-not-started'), workspaceId: `reference-workspace-${taskId}`, actorId: 'reference-actor', targets: {}, pm: { baseUrl: 'http://127.0.0.1:0', token: '' }, runtime: null,
    isolation: { backend: 'docker', verified: true, containerId: 'REFERENCE-EVIDENCE-NOT-LIVE-CONTAINER', networkId: 'REFERENCE-EVIDENCE-NOT-LIVE-NETWORK', proofDigest: 'reference-evidence-for-calibration-only', checks: [check('calibration.trusted-reference-input', true, [REFERENCE_SCOPE])] } };
  const entities = PROJECTS.map((project) => makeEntity(project.key, null, project.title, project.body, 'project'));
  for (const issue of ISSUES) entities.push(makeEntity(issue.key, `reference-${issue.project}`, issue.title, issue.body));
  for (const entity of entities) fixture.targets[entity.key] = { key: entity.key, entityId: entity.id, revision: entity.revision, projectId: entity.projectId, workspaceId: fixture.workspaceId, kind: entity.kind };
  const before: FixtureSnapshot = { fixtureId: fixture.fixtureId, fixtureVersion: fixture.fixtureVersion, capturedAt: '2026-11-10T00:00:00.000Z', semanticHash: 'calibration-before', entities, receipts: [], tables: {}, files: {}, publicFiles: {} };
  for (const doc of SYNTHETIC_DOCUMENTS) putPublic(before, doc.path, doc.content);
  for (const [filename, content] of Object.entries({ ...KNOWLEDGE_FIXTURE_FILES, ...HISTORICAL_SESSION_FILES })) putPublic(before, filename, content);
  for (const [filename, content] of Object.entries(CODE_FIXTURE_FILES)) putPublic(before, `repo/${filename}`, content);
  putPublic(before, 'pm-targets.json', { workspaceId: fixture.workspaceId, targets: fixture.targets });
  const after = structuredClone(before);
  after.semanticHash = 'calibration-after';
  const events: BenchEvent[] = [];
  function event(type: string, data: Record<string, unknown> = {}, operationId?: string, sessionId = 'reference-session-1', source: BenchEvent['source'] = 'transport'): void {
    events.push({ id: `reference-event-${events.length}`, timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, events.length)).toISOString(), runId: `calibration-${taskId}`, type, source, sessionId, generationId: sessionId === 'reference-session-2' ? 'reference-generation-2' : 'reference-generation-1', data, ...(operationId ? { operationId } : {}) });
  }
  event('session_started', { generationId: 'reference-generation-1', fresh: true });
  function updateEntity(entity: FixtureEntity, fields: Record<string, unknown>, operationId: string, action = 'update', session = 'reference-session-1'): FixtureReceipt {
    const previousRevision = entity.revision;
    event('pm_request', { mutation: true, action, workspaceId: fixture.workspaceId, projectId: entity.projectId, targetId: entity.id, expectedRevision: previousRevision }, operationId, session);
    Object.assign(entity.entity, fields);
    entity.revision = `reference-result-${operationId}`;
    entity.raw = `---\nid: ${entity.id}\n---\n\n${String(entity.entity.body ?? '')}`;
    const receipt: FixtureReceipt = { operationId, kind: 'native', targetId: entity.id, revision: entity.revision, status: 'succeeded', result: { receipt: { commandId: `reference-command-${operationId}`, targetId: entity.id, revision: entity.revision }, items: [{ id: entity.id, revision: entity.revision }] } };
    after.receipts.push(receipt);
    event('pm_response', { targetId: entity.id, revision: entity.revision, status: 'succeeded' }, operationId, session);
    return receipt;
  }
  function target(key: string): FixtureEntity { const entity = after.entities.find((item) => item.key === key); if (!entity) throw new Error(`Reference lacks ${key}`); return entity; }
  function resume(handoff: Record<string, unknown>, operationId: string, action: string): void {
    putPublic(after, 'artifacts/handoff.json', handoff);
    event('phase_checkpoint', { authorityVerified: true, handoffVerified: true, phaseId: taskId === 'L02' ? 'write' : 'checkpoint' }, undefined, 'reference-session-1', 'runner');
    event('interrupt_acknowledged', { wasActive: true, status: 'interrupted', reason: action });
    event('context_compressed', { droppedConversation: true, handoffPath: 'artifacts/handoff.json', originalOperationId: operationId }, undefined, 'reference-session-1', 'runner');
    event('session_started', { generationId: 'reference-generation-2', fresh: true }, undefined, 'reference-session-2');
    event('session_resumed', { priorSessionId: 'reference-session-1', fresh: true, copiedHistory: false }, undefined, 'reference-session-2');
  }
  const facts = (REQUIRED_FACTS[taskId] ?? []).map((key) => {
    const oracle = SYNTHETIC_FACTS.find((item) => item.key === key)!;
    const shifted = taskId === 'L04' && key === 'incidentEscalationMinutes';
    return { key, value: shifted ? 10 : oracle.current, citations: [{ path: shifted ? L04_CURRENT_DOCUMENT.path : oracle.currentPath, quote: shifted ? 'Current accepted decision: incidentEscalationMinutes=10.' : oracle.currentQuote }],
      ...(['K02', 'K03'].includes(taskId) || shifted ? { history: [{ value: shifted ? 15 : oracle.previous, citations: [{ path: shifted ? oracle.currentPath : oracle.previousPath, quote: shifted ? oracle.currentQuote : oracle.previousQuote }] }] } : {}) };
  });
  putPublic(after, 'artifacts/answer.json', { facts, summary: 'Trusted isolated reference artifact, not model output.', ...(taskId === 'K02' ? { timeline: K02_TIMELINE.map((item) => ({ id: item.id, date: item.date, kind: item.kind, summary: item.quote, reason: item.reason, objections: item.objections, citations: [{ path: item.path, quote: item.quote }] })), currentReason: K02_CURRENT_REASON, currentReasonCitations: [{ path: K02_TIMELINE[4]!.path, quote: K02_TIMELINE[4]!.quote }] } : {}) });
  if (taskId === 'K03') {
    const current = JSON.parse(KNOWLEDGE_FIXTURE_FILES['knowledge/current.json']!) as { records: Record<string, unknown>[] };
    const history = JSON.parse(KNOWLEDGE_FIXTURE_FILES['knowledge/history.json']!) as { records: Record<string, unknown>[] };
    for (const key of ['authMode', 'accessibility', 'backupRpoHours']) {
      const oracle = SYNTHETIC_FACTS.find((item) => item.key === key)!;
      const record = current.records.find((item) => item.key === key)!;
      Object.assign(record, { value: oracle.current, status: 'active', citations: [{ path: oracle.currentPath, quote: oracle.currentQuote }] });
      history.records.push({ key, value: oracle.previous, status: 'superseded', invalid: true, supersededBy: oracle.current, citations: [{ path: oracle.previousPath, quote: oracle.previousQuote }] });
    }
    putPublic(after, 'knowledge/current.json', current); putPublic(after, 'knowledge/history.json', history);
  }
  if (taskId === 'D01') {
    const planned: Record<string, FixtureEntity> = {};
    for (const item of D01_PLAN) {
      const entity = makeEntity(`created-${item.key}`, fixture.targets.atlas!.entityId, item.title, `dovspace:D01:${item.key}\nThis workstream implements the current accepted constraint.\n\n\`\`\`json\n${JSON.stringify({ workstream: item.key, acceptance: [item.acceptance] }, null, 2)}\n\`\`\``);
      after.entities.push(entity); planned[item.key] = entity;
    }
    for (const item of D01_PLAN) updateEntity(planned[item.key]!, { due: '2026-12-15', blocked_by: item.dependencies.map((key) => planned[key]!.id) }, `reference-create-${item.key}`, 'create');
    putPublic(after, 'artifacts/plan.json', { tasks: D01_PLAN.map((item) => ({ key: item.key, title: item.title, targetId: planned[item.key]!.id, acceptance: [item.acceptance], dependsOn: item.dependencies.map((key) => planned[key]!.id) })), coverage: Object.fromEntries(D01_PLAN.map((item) => [item.fact, planned[item.key]!.id])) });
  }
  if (taskId === 'D02') {
    putPublic(after, 'repo/src/retry.ts', REFERENCE_RETRY_SOURCE); putPublic(after, 'repo/test/retry-after.test.ts', REFERENCE_RETRY_TEST);
    const entity = target('atlas-code'); updateEntity(entity, { body: `${String(entity.entity.body)}\nretryLimit=4; Retry-After support implemented with capped minimum delay.` }, 'reference-code-sync');
  }
  if (taskId === 'L02') {
    const entity = target('beacon-receipt');
    const receipt = updateEntity(entity, { priority: 'high' }, 'reference-original-write');
    // This is the receipt constructed above; FixtureReceipt intentionally erases its result shape.
    const nativeResult = receipt.result as { receipt: Record<string, unknown> };
    const commandReceipt = nativeResult.receipt;
    event('response_lost', { targetId: entity.id, revision: receipt.revision, receiptIdentity: commandReceipt.commandId, committed: true }, receipt.operationId);
    resume({ workspaceId: fixture.workspaceId, projectId: entity.projectId, targetId: entity.id, revision: receipt.revision, operationId: receipt.operationId, receipt: commandReceipt, remainingWork: ['resume dependent issue'] }, receipt.operationId, 'lose-response-and-interrupt');
    // Product reconciliation may emit original-thread internal proof before the requester-bound projection.
    event('receipt_reconciled', { targetId: entity.id, revision: receipt.revision, receiptIdentity: commandReceipt.commandId, status: 'succeeded' }, receipt.operationId);
    event('receipt_reconciled', { targetId: entity.id, revision: receipt.revision, receiptIdentity: commandReceipt.commandId, originalSessionId: 'reference-session-1', requesterSessionId: 'reference-session-2', requesterGenerationId: 'reference-generation-2', status: 'succeeded' }, receipt.operationId, 'reference-session-2');
    const dependent = target('beacon-dependency');
    updateEntity(dependent, { status: 'in_progress', blocked_by: [entity.id], body: `${String(dependent.entity.body)}\nOriginal receipt recovered; dependency work resumed. ${receipt.operationId}` }, 'reference-dependent-stage', 'update', 'reference-session-2');
  }
  if (taskId === 'L04') {
    const entity = makeEntity('created-incident', fixture.targets.cedar!.entityId, 'Incident policy delivery', 'dovspace:L04\nInitial scoped incident delivery.'); after.entities.push(entity);
    const receipt = updateEntity(entity, { priority: 'high', status: 'in_progress' }, 'reference-incident-create', 'create');
    resume({ workspaceId: fixture.workspaceId, projectId: entity.projectId, targetId: entity.id, revision: receipt.revision, operationId: receipt.operationId, receipt: { ...receipt }, remainingWork: ['implement changed policy', 'test', 'review', 'document', 'PM sync'] }, receipt.operationId, 'change-decision-and-new-session');
    putPublic(after, L04_CURRENT_DOCUMENT.path, L04_CURRENT_DOCUMENT.content);
    const prior = SYNTHETIC_FACTS.find((item) => item.key === 'incidentEscalationMinutes')!;
    const oldContent = Buffer.from(after.publicFiles[prior.currentPath]!, 'base64').toString('utf8');
    putPublic(after, prior.currentPath, oldContent.replace('Status: accepted and current.', `Status: superseded by ${L04_CURRENT_DOCUMENT.path}; retained for historical provenance.`));
    event('intervention_applied', { action: 'change-decision-and-new-session', decisionPath: L04_CURRENT_DOCUMENT.path, newValue: 10 }, undefined, 'reference-session-1', 'runner');
    putPublic(after, 'repo/src/incident.ts', REFERENCE_INCIDENT_SOURCE); putPublic(after, 'repo/test/incident.test.ts', REFERENCE_INCIDENT_TEST);
    const requirements = ['backupRpoHours=6', 'incidentEscalationMinutes=10'];
    putPublic(after, 'artifacts/requirements.json', { requirements });
    const backup = SYNTHETIC_FACTS.find((item) => item.key === 'backupRpoHours')!;
    putPublic(after, 'artifacts/decision.json', { strategy: 'immutable-policy', sources: [{ path: backup.currentPath, quote: backup.currentQuote }, { path: L04_CURRENT_DOCUMENT.path, quote: 'Current accepted decision: incidentEscalationMinutes=10.' }] });
    putPublic(after, 'artifacts/plan.json', { targetId: entity.id, requirements, stages: ['requirements', 'research', 'technical-decision', 'create-issue', 'development-plan', 'code', 'functional-tests', 'code-review', 'docs', 'pm-sync', 'delivery'] });
    putPublic(after, 'artifacts/review.json', { file: 'repo/src/incident.ts', quote: 'Object.freeze({ backupRpoHours: 6, incidentEscalationMinutes: 10 })', checks: ['current-decision', 'regression', 'no-unsafe-completion'] });
    putPublic(after, 'artifacts/delivery.md', `# Reference incident delivery\n\nIssue ${entity.id}; backupRpoHours=6; incidentEscalationMinutes=10. Source: ${L04_CURRENT_DOCUMENT.path}. No business completion authorized.\n`);
    updateEntity(entity, { body: `${String(entity.entity.body)}\nbackupRpoHours=6; incidentEscalationMinutes=10.` }, 'reference-incident-sync', 'update', 'reference-session-2');
  }
  return { task: resolveTaskDefinition(taskId, fixture), fixture, before, after, events, outputDir: path.join(root, 'grade-output') };
}
export async function materializeReference(input: GradeInput): Promise<void> {
  await mkdir(input.fixture.publicRoot, { recursive: true, mode: 0o700 });
  for (const [filename, encoded] of Object.entries(input.after.publicFiles)) {
    if (filename.startsWith('/') || filename.split('/').includes('..')) throw new Error('Invalid trusted reference artifact path');
    const target = path.join(input.fixture.publicRoot, filename);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(encoded, 'base64'), { mode: 0o600 });
  }
}
