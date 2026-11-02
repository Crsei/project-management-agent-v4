import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { createPmAutomationService, type PmAutomationMutationPort } from '../packages/application/src/automation-pm.ts';
import { authorizeAutomationStudioService } from '../packages/application/src/automation-studio-auth.ts';
import { createAgentChatTools } from '../apps/server/pm/src/agent-chat-tools.ts';
import { createPmAutomationMutationPort } from '../apps/server/pm/src/automation-pm-mutations.ts';
import { registerPmAutomationRoutes } from '../apps/server/pm/src/automation-pm-routes.ts';
import { CoreWorkspacePool, authorizeCoreScope } from '../apps/server/pm/src/core-routes.ts';
import { coreRecordToEntity } from '../apps/server/pm/src/core-adapter.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { DomainError, type Actor } from '../packages/domain/src/core.ts';
import { pmAutomationCandidatePreviewSchema, pmAutomationReviewResultSchema, type PmAutomationCandidate, type PmAutomationSnapshot, type PmAutomationResult, type PmAutomationAgentEvidence, type PmAutomationEvent, type PmAutomationTemplateId } from '../packages/contracts/src/automation-pm.ts';
import type { StudioConfig } from '../packages/contracts/src/automation-studio.ts';
import { getMembership } from '../packages/application/src/access.ts';
import { runCommand, requestHash } from '../packages/application/src/kernel.ts';
import { readExternalReceipt } from '../packages/application/src/core-bridge.ts';
import { readTaskComments, taskCommentsCommands } from '../packages/application/src/task-comments.ts';
import type { CoreAccess } from '../packages/application/src/ports.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV4WorkerTestDatabase } from './worker-environment.ts';
import { capturePmAutomationEvents, insertPmAutomationSignal } from '../packages/application/src/automation-pm-signals.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
let database: MailFixtureDatabase;
const evidence: PmAutomationAgentEvidence = { sources: [], sessions: [], executions: [], pullRequests: [], coverage: ['sessions', 'executions', 'pull-requests'].map(source => ({ source: source as 'sessions' | 'executions' | 'pull-requests', status: 'complete', observedRecords: 0, totalRecords: 0, reason: null })) };
const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
async function fixture(signal: AbortSignal) {
  const lifecycle = new MailFixtureScope(signal);
  const { pool, actor, other, workspaceId, cores, workspace } = await lifecycle.initialize(async () => {
    const { pool } = await acquireMailFixtureDatabase(lifecycle, database);
    const actor = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'PM automation owner', password: 'Isolated-PM-Automation-Password' });
    const other = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Another actor', password: 'Isolated-PM-Automation-Password' });
    const workspaceId = (await createWorkspace(pool, actor.id, 'Scoped native PM automation')).id;
    const root = await lifecycle.acquire(() => mkdtemp(join(tmpdir(), 'pm-automation-review-')), value => rm(value, { recursive: true, force: true }));
    const cores = await lifecycle.acquire(async () => new CoreWorkspacePool(root, pool), value => value.close());
    const workspace = await cores.get(workspaceId);
    return { pool, actor, other, workspaceId, cores, workspace };
  });
  try {
    let project = await workspace.createEntity({ entity: 'project', title: 'Native authorized project' });
    project = await workspace.patch(project.id, { status: 'active' }, project.revision);
    const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Observed task', body: 'Original requirement\n\n- [ ] Explicit acceptance' });
    const peer = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Observed prerequisite' });
    const foreignProject = await workspace.createEntity({ entity: 'project', title: 'Foreign project' });
    const foreignTask = await workspace.createEntity({ entity: 'work_item', project: foreignProject.id, title: 'Must not widen here' });
    await pool.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,$4)', [workspaceId, other.id, ['domain.read', 'planning.edit'], [project.id]]);
    const core = readonlyCorePort(id => cores.rootFor(id));
    async function coreFor(principal: Actor): Promise<CoreAccess> {
      const scope = await authorizeCoreScope(pool, principal, workspaceId, 'domain.read');
      return { handles: () => true, async get(id) { const file = workspace.get(id); scope.entity(file); return coreRecordToEntity(workspaceId, file); }, async list(kind) { return workspace.snapshot().files.filter(file => scope.allows(file)).map(file => coreRecordToEntity(workspaceId, file)).filter(entity => entity.kind === kind); }, async records() { return workspace.snapshot().files.filter(file => scope.allows(file)); }, async sprintHistory() { return workspace.sprintHistory(); }, configuration: () => workspace.configuration().config };
    }
    const tools = createAgentChatTools({ database: () => pool, coreWorkspaces: cores, localProjects: { enabled: false, defaultParent: null },
      async executeCommand(principal, ws, command, checkAuthorization) { return runCommand(pool, principal, ws, command, taskCommentsCommands, await coreFor(principal), core, checkAuthorization); },
      readCommandReceipt(principal, ws, command) { return readExternalReceipt(pool, principal, ws, command.commandId, requestHash(command as unknown as Record<string, unknown>)); },
      async readComments(principal, ws, taskId, options) { return readTaskComments({ sql: pool, actor: principal, workspaceId: ws, membership: await getMembership(pool, principal, ws), now: new Date(), core: await coreFor(principal) }, taskId, options); },
    });
    const mutations = createPmAutomationMutationPort({ database: () => pool, coreWorkspaces: cores, tools });
    const service = createPmAutomationService({ database: () => pool, core, mutations });
    async function execution(args: Record<string, unknown> = {}, owner = actor, source: { payload?: PmAutomationEvent; trigger?: 'event' | 'test'; sourceKey?: string; templateId?: PmAutomationTemplateId } = {}) {
      const definitionId = randomUUID(), id = randomUUID(), requestId = randomUUID();
      const templateId = source.templateId ?? 'pm-stalled-tasks';
      const config: StudioConfig = { name: 'PM source review', description: '', projectId: project.id, tags: [], templateId, templateVersion: '1.0.0', templateInputs: args, trigger: source.trigger === 'event' && source.payload ? { kind: 'event', source: 'pm', key: source.payload.key, filter: {} } : { kind: 'manual' }, action: { kind: 'template', templateId, arguments: args, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 60 }, dailyLimit: 10, cooldownMinutes: 0 };
      await pool.query('INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config) VALUES($1,$2,$3,$4,$5::jsonb)', [definitionId, workspaceId, owner.id, project.id, JSON.stringify(config)]);
      await pool.query("INSERT INTO automation_studio_executions(id,workspace_id,actor_id,definition_id,project_id,definition_revision,config_snapshot,request_id,trigger,payload,source_key,status,dispatched_at) VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7,$8,$9::jsonb,$10,'running',clock_timestamp())", [id, workspaceId, owner.id, definitionId, project.id, JSON.stringify(config), requestId, source.trigger ?? 'test', source.payload ? JSON.stringify(source.payload) : null, source.sourceKey ?? null]);
      return { id, definitionId, requestId, identity: { actorId: owner.id, workspaceId, projectId: project.id, executionId: id, requestId, definitionId, definitionRevision: 1 } };
    }
    const publish = async (snapshot: PmAutomationSnapshot, candidates: PmAutomationCandidate[]): Promise<PmAutomationResult> => { await service.publish(actor, workspaceId, snapshot.executionId, { templateId: snapshot.templateId, executionId: snapshot.executionId, observedAt: snapshot.observedAt, summary: 'Actual source-bound review', findings: [], candidates, coverage: snapshot.coverage, gaps: snapshot.coverage.filter(item => item.status !== 'complete').map(item => ({ source: item.source, reason: item.reason! })) }); return service.result(actor, workspaceId, snapshot.executionId); };
    const commentCandidate = (snapshot: PmAutomationSnapshot): PmAutomationCandidate => ({ id: 'followup', kind: 'task-comment', title: 'Reviewed followup', rationale: 'Explicit user review', sourceRefs: [snapshot.sources.find(source => source.id === task.id)!], evidence: [], status: 'pending', revision: 1, taskId: task.id, expectedRevision: snapshot.tasks.find(item => item.id === task.id)!.revision, body: 'Please report actual progress.' });
    return { lifecycle, pool, actor, other, workspaceId, workspace, project, task, peer, foreignTask, core, cores, mutations, service, execution, publish, commentCandidate };
  } catch (error) { await lifecycle.close(); throw error; }
}

describe('PM automation immutable sources, durable review and original native receipts', { skip: !databaseUrl }, () => {
  before(async t => { assert.ok(databaseUrl); assertV4WorkerTestDatabase(databaseUrl); database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(async () => database?.close(), { timeout: 30000 });
  it('freezes scoped native sources once, does not widen empty/foreign selectors, retains immutable output across service restart', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close);
    const execution = await f.execution({ taskIds: [f.task.id] });
    const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence);
    assert.deepEqual(snapshot.tasks.map(task => task.id), [f.task.id]);
    assert.equal(snapshot.tasks[0]!.description, 'Original requirement');
    assert.deepEqual(snapshot.tasks[0]!.acceptanceCriteria, ['Explicit acceptance']);
    await f.workspace.patch(f.task.id, { title: 'Changed after freeze' }, f.task.revision);
    assert.deepEqual(await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence), snapshot);
    const candidate = f.commentCandidate(snapshot);
    candidate.evidence = [{ sourceRefId: snapshot.tasks[0]!.sourceRefId, quote: JSON.stringify(snapshot.tasks[0]) }];
    const published = await f.publish(snapshot, [candidate]);
    const restarted = createPmAutomationService({ database: () => f.pool, core: f.core, mutations: f.mutations });
    assert.deepEqual(await restarted.result(f.actor, f.workspaceId, execution.id), published);
    await assert.rejects(f.pool.query('UPDATE automation_pm_snapshots SET snapshot=snapshot WHERE execution_id=$1', [execution.id]));
    await assert.rejects(f.pool.query('DELETE FROM automation_pm_results WHERE execution_id=$1', [execution.id]));
    await assert.rejects(f.service.freeze(f.actor, f.workspaceId, (await f.execution({ taskIds: [f.foreignTask.id] })).id, evidence), rejected('automation_pm_scope_forbidden'));
    await assert.rejects(f.service.freeze(f.actor, f.workspaceId, (await f.execution({ taskIds: [] })).id, evidence));
    assert.deepEqual((await f.service.freeze(f.actor, f.workspaceId, (await f.execution({ labels: ['no-match'] })).id, evidence)).tasks, []);
    await assert.rejects(f.service.result(f.other, f.workspaceId, execution.id), rejected('not_found_or_forbidden'));
  });
  it('forbids service apply/tools and user publication; current source conflicts require explicit rebase preserving original quotes', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close); const execution = await f.execution();
    const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence); const candidate = (await f.publish(snapshot, [f.commentCandidate(snapshot)])).candidates[0]!;
    const base = `/api/v1/workspaces/${f.workspaceId}/automations/pm/executions/${execution.id}`;
    assert.equal((await authorizeAutomationStudioService(f.pool, f.core, execution.identity, { method: 'GET', url: `${base}/snapshot`, body: null })).id, f.actor.id);
    await assert.rejects(authorizeAutomationStudioService(f.pool, f.core, execution.identity, { method: 'POST', url: `${base}/candidates/followup/apply`, body: {} }), rejected('automation_service_scope_forbidden'));
    await assert.rejects(authorizeAutomationStudioService(f.pool, f.core, execution.identity, { method: 'POST', url: `/api/v1/workspaces/${f.workspaceId}/agent-tools/call`, body: { scope: { kind: 'projects', projectIds: [f.project.id] } } }), rejected('automation_service_scope_forbidden'));
    const changed = await f.workspace.patch(f.task.id, { title: 'Current changed title' }, f.task.revision);
    const preview = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: 1 }));
    assert.equal(preview.canApply, false); assert.equal(preview.currentTask?.revision, changed.revision);
    const rebased = { ...candidate, reviewSources: preview.currentSources, expectedRevision: changed.revision };
    const editId = randomUUID(); const edited = pmAutomationReviewResultSchema.parse(await f.service.edit(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: editId, expectedRevision: 1, candidate: rebased }));
    assert.deepEqual(edited.candidate.sourceRefs, candidate.sourceRefs); assert.deepEqual(edited.candidate.evidence, candidate.evidence);
    assert.equal((await f.service.receipt(f.actor, f.workspaceId, editId)).httpStatus, 200);
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'unexpected' } }));
    registerPmAutomationRoutes(app, { database: () => f.pool, actor: async () => f.actor, core: f.core, mutations: f.mutations });
    assert.equal((await app.inject({ method: 'POST', url: `${base}/result`, payload: { result: await f.service.result(f.actor, f.workspaceId, execution.id) } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/candidates/followup/ignore`, headers: { authorization: 'Bearer pm-automation-v1.not-a-user' }, payload: { requestId: randomUUID(), expectedRevision: 2 } })).statusCode, 403);
    const ignored = await app.inject({ method: 'POST', url: `${base}/candidates/followup/ignore`, payload: { requestId: randomUUID(), expectedRevision: 2 } });
    assert.equal(ignored.statusCode, 200); assert.equal(ignored.json().result.status, 'ignored'); assert.equal(ignored.json().httpStatus, 200);
    const original = await f.service.result(f.actor, f.workspaceId, execution.id, true);
    assert.equal(original.candidates[0]!.status, 'pending'); assert.equal(original.candidates[0]!.revision, 1);
    assert.equal(original.candidates[0]!.sourceRefs.length, 1, 'Service reconciliation reads original analysis, not augmented or edited review state');
  });
  it('applies actual native content, checklist, relations, comments and documents without completing the task', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close); const execution = await f.execution(); const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence);
    const common = { title: 'Reviewed native write', rationale: 'User approved candidate', sourceRefs: [snapshot.sources.find(source => source.id === f.task.id)!], evidence: [], status: 'pending' as const, revision: 1 };
    const update: PmAutomationCandidate = { ...common, id: 'content', kind: 'task-update', taskId: f.task.id, expectedRevision: f.task.revision, before: { acceptanceCriteria: ['Explicit acceptance'] }, after: { acceptanceCriteria: ['Updated actual acceptance'] } };
    const document: PmAutomationCandidate = { ...common, id: 'document', kind: 'create-document', document: { title: 'Actual summary', body: 'Reviewed summary from real sources', taskIds: [f.task.id] } };
    await f.publish(snapshot, [update, document]);
    const preview = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, execution.id, update.id, { requestId: randomUUID(), expectedRevision: 1 })); assert.equal(preview.canApply, true);
    const requestId = randomUUID(), input = { requestId, expectedRevision: 1, previewToken: preview.previewToken! };
    const applied = pmAutomationReviewResultSchema.parse(await f.service.apply(f.actor, f.workspaceId, execution.id, update.id, input)); assert.equal(applied.status, 'applied');
    assert.deepEqual(f.workspace.get(f.task.id).entity.checklist.map(item => item.text), ['Updated actual acceptance']); assert.equal(f.workspace.get(f.task.id).entity.status, f.task.entity.status);
    assert.deepEqual(await f.service.apply(f.actor, f.workspaceId, execution.id, update.id, input), applied);
    const next = await f.execution(); const nextSnapshot = await f.service.freeze(f.actor, f.workspaceId, next.id, evidence);
    const comment = f.commentCandidate(nextSnapshot); await f.publish(nextSnapshot, [comment, { ...document, sourceRefs: [nextSnapshot.sources.find(source => source.id === f.task.id)!] }]);
    for (const candidateId of ['followup', 'document']) {
      const preview = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, next.id, candidateId, { requestId: randomUUID(), expectedRevision: 1 }));
      const result = pmAutomationReviewResultSchema.parse(await f.service.apply(f.actor, f.workspaceId, next.id, candidateId, { requestId: randomUUID(), expectedRevision: 1, previewToken: preview.previewToken! })); assert.equal(result.status, 'applied');
      if (candidateId === 'document') { const id = result.idMap.document!; assert.equal(f.workspace.get(id).entity.body.includes('Reviewed summary'), true); assert.ok(f.workspace.get(id).entity.related_to.includes(f.task.id)); }
    }
    assert.equal((await f.pool.query('SELECT count(*)::text AS n FROM task_comments WHERE workspace_id=$1 AND task_id=$2', [f.workspaceId, f.task.id])).rows[0].n, '1');
  });
  it('reconciles partial plan under original operation IDs, receipt reads never create remaining tasks, selective plans do not widen', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close); const execution = await f.execution(); const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence);
    const taskDraft = { description: 'Real next action', acceptanceCriteria: ['Verify actual result'], labels: [], dependsOn: [], relatedTaskIds: [], milestoneId: null };
    const candidate: PmAutomationCandidate = { id: 'phase-plan', kind: 'plan', title: 'Reviewed phase', rationale: 'Explicit source-driven plan', sourceRefs: [snapshot.sources.find(source => source.id === f.task.id)!], evidence: [], status: 'pending', revision: 1,
      plan: { title: 'Persistent next phase', description: 'Only selected approved work', tasks: [{ ...taskDraft, localId: 'first', dependsOnLocalIds: [], title: 'First new task' }, { ...taskDraft, localId: 'second', dependsOnLocalIds: ['first'], title: 'Second new task' }] } };
    await f.publish(snapshot, [candidate]);
    const invalid = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: 1, selectedItemIds: ['second'] })); assert.equal(invalid.canApply, false);
    let writes = 0, lose = true;
    const lossy: PmAutomationMutationPort = { async execute(name, input, context) { const result = await f.mutations.execute(name, input, context); writes++; if (lose) { lose = false; throw new Error('Controlled response loss after real native commit'); } return result; }, recover: f.mutations.recover };
    const service = createPmAutomationService({ database: () => f.pool, core: f.core, mutations: lossy });
    const preview = pmAutomationCandidatePreviewSchema.parse(await service.preview(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: 1, selectedItemIds: ['first', 'second'] }));
    const requestId = randomUUID(), original = { requestId, expectedRevision: 1, previewToken: preview.previewToken!, selectedItemIds: ['first', 'second'] };
    const unknown = pmAutomationReviewResultSchema.parse(await service.apply(f.actor, f.workspaceId, execution.id, candidate.id, original)); assert.equal(unknown.status, 'outcome_unknown'); assert.equal(writes, 1);
    const readOnlyRecovery = await service.receipt(f.actor, f.workspaceId, requestId); assert.equal(readOnlyRecovery.httpStatus, 202); assert.equal(writes, 1);
    assert.equal(f.workspace.items({ entity: 'work_item', q: 'Second new task' }).length, 0);
    const completed = pmAutomationReviewResultSchema.parse(await service.apply(f.actor, f.workspaceId, execution.id, candidate.id, original)); assert.equal(completed.status, 'applied');
    assert.notEqual(completed.idMap.first, completed.idMap.second); assert.ok(f.workspace.get(completed.idMap.second!).entity.blocked_by.includes(completed.idMap.first!));
    assert.ok(f.workspace.get(completed.idMap['plan-document:phase-plan']!).entity.body.includes(completed.idMap.first!));
    const persisted = await f.service.result(f.actor, f.workspaceId, execution.id); assert.deepEqual(persisted.candidates[0]!.application?.idMap, completed.idMap);
    await assert.rejects(service.apply(f.actor, f.workspaceId, execution.id, candidate.id, { ...original, selectedItemIds: ['first'] }), rejected('idempotency_conflict'));
    const count = f.workspace.items({ entity: 'work_item', q: 'First new task' }).length; assert.equal(count, 1);
    await assert.rejects(f.pool.query('UPDATE automation_pm_apply_steps SET input=input WHERE request_id=$1 AND result IS NOT NULL', [requestId]));
    await f.pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.id]);
    await assert.rejects(service.receipt(f.actor, f.workspaceId, requestId), rejected('not_found_or_forbidden'));
  });
  it('cannot retarget an editable finding or forge its original source, even when both tasks were observed', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close);
    const execution = await f.execution(); const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence);
    const sources = snapshot.sources.filter(source => source.id === f.task.id || source.id === f.peer.id);
    const relation: PmAutomationCandidate = { id: 'relation', kind: 'task-relation', title: 'Reviewed relationship', rationale: 'Both actual endpoints were observed', sourceRefs: sources, evidence: [], revision: 1, status: 'pending', taskId: f.task.id, expectedRevision: f.task.revision, relation: 'related', before: [], after: [f.peer.id] };
    const candidate = (await f.publish(snapshot, [relation])).candidates[0]!;
    const retargetId = randomUUID();
    await assert.rejects(f.service.edit(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: retargetId, expectedRevision: 1, candidate: { ...relation, sourceRefs: candidate.sourceRefs, taskId: f.peer.id, expectedRevision: f.peer.revision, after: [f.task.id] } }), rejected('automation_pm_review_conflict'));
    assert.equal((await f.service.receipt(f.actor, f.workspaceId, retargetId)).httpStatus, 400);
    const forged = { ...candidate, sourceRefs: candidate.sourceRefs.map(source => ({ ...source, label: 'Fabricated source text' })) };
    await assert.rejects(f.service.edit(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: 1, candidate: forged }), rejected('automation_pm_review_conflict'));
    assert.equal((await f.service.result(f.actor, f.workspaceId, execution.id)).candidates[0]!.revision, 1);
    assert.deepEqual(f.workspace.get(f.task.id).entity.related_to, []);
    assert.deepEqual(f.workspace.get(f.peer.id).entity.related_to, []);
    const peerChanged = await f.workspace.patch(f.peer.id, { title: 'Changed relation endpoint' }, f.peer.revision);
    const conflict = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: 1 }));
    assert.equal(conflict.canApply, false); assert.ok(conflict.currentSources.some(source => source.id === f.peer.id && source.revision === peerChanged.revision));
    const edited = pmAutomationReviewResultSchema.parse(await f.service.edit(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: 1, candidate: { ...candidate, reviewSources: conflict.currentSources } }));
    const preview = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: edited.candidate.revision }));
    assert.equal(preview.canApply, true);
    const applied = pmAutomationReviewResultSchema.parse(await f.service.apply(f.actor, f.workspaceId, execution.id, candidate.id, { requestId: randomUUID(), expectedRevision: edited.candidate.revision, previewToken: preview.previewToken! }));
    assert.equal(applied.status, 'applied'); assert.ok(f.workspace.get(f.task.id).entity.related_to.includes(f.peer.id));
  });
  it('never trusts manual/test payload as historical requirements or previous visits, and binds real native event provenance', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close);
    const beforeTask = f.workspace.get(f.task.id);
    const afterTask = await f.workspace.patch(f.task.id, { title: 'Actual changed requirement' }, beforeTask.revision);
    const nativeEvent = capturePmAutomationEvents({ eventId: randomUUID(), actorId: f.actor.id, workspaceId: f.workspaceId, before: beforeTask, after: afterTask, configuration: f.workspace.configuration().config }).find(event => event.key === 'task.updated')!;
    const manual = await f.execution({}, f.actor, { payload: nativeEvent, templateId: 'pm-requirement-change-impact' });
    const untrusted = await f.service.freeze(f.actor, f.workspaceId, manual.id, evidence);
    assert.equal(untrusted.before, null); assert.equal(untrusted.after, null); assert.equal(untrusted.event, null);
    assert.equal(untrusted.coverage.find(item => item.source === 'versions')!.status, 'unavailable');
    const spoofedVisit: PmAutomationEvent = { ...nativeEvent, eventId: 'forged-visit', key: 'project.visited', before: null, after: null, lastVisitAt: '2020-01-01T00:00:00.000Z', visitedAt: new Date().toISOString(), sourceRef: { ...nativeEvent.sourceRef, kind: 'visit', id: 'forged-boundary', refId: 'forged-visit', revision: 'forged-revision' } };
    const fakeVisit = await f.execution({}, f.actor, { payload: spoofedVisit, trigger: 'event', sourceKey: 'event:forged-visit', templateId: 'pm-since-last-visit' });
    const visitSnapshot = await f.service.freeze(f.actor, f.workspaceId, fakeVisit.id, evidence);
    assert.equal(visitSnapshot.lastVisitAt, null); assert.equal(visitSnapshot.event, null);
    assert.equal(visitSnapshot.coverage.find(item => item.source === 'visits')!.status, 'unavailable');
    await insertPmAutomationSignal(f.pool, nativeEvent);
    const durable = await f.execution({}, f.actor, { payload: nativeEvent, trigger: 'event', sourceKey: `event:${nativeEvent.eventId}`, templateId: 'pm-requirement-change-impact' });
    const trusted = await f.service.freeze(f.actor, f.workspaceId, durable.id, evidence);
    assert.equal(trusted.before?.task.revision, beforeTask.revision); assert.equal(trusted.after?.task.revision, afterTask.revision);
    assert.equal(trusted.coverage.find(item => item.source === 'versions')!.status, 'complete');
    await assert.rejects(f.pool.query("UPDATE automation_pm_signals SET payload='{}'::jsonb WHERE source_key=$1", [nativeEvent.eventId]));
  });
  it('guards real goal revisions on editable plans and reuses existing task IDs without duplicating native tasks', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close);
    const goal = await f.workspace.createEntity({ entity: 'goal', project: f.project.id, title: 'Actual delivery objective', body: 'Explicit goal scope' });
    await f.workspace.patch(f.project.id, { goals: [goal.id] }, f.workspace.get(f.project.id).revision);
    await f.workspace.patch(f.task.id, { goals: [goal.id] }, f.workspace.get(f.task.id).revision);
    const execution = await f.execution({}, f.actor, { templateId: 'pm-next-actions' });
    const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence);
    assert.equal(snapshot.project.goals[0]!.revision, goal.revision);
    assert.equal(snapshot.sources.find(source => source.id === goal.id)!.kind, 'goal');
    const plan: PmAutomationCandidate = { id: 'existing-plan', kind: 'plan', title: 'Existing work next action', rationale: 'Actual linked goal task', sourceRefs: [snapshot.sources.find(source => source.id === f.task.id)!], evidence: [], revision: 1, status: 'pending', plan: { title: 'Actual existing work plan', description: 'Reuse the observed task identity', tasks: [{ localId: 'existing', existingTaskId: f.task.id, dependsOnLocalIds: [], title: 'Display-only plan title', description: '', acceptanceCriteria: [], labels: [], dependsOn: [], relatedTaskIds: [], milestoneId: null }] } };
    await f.publish(snapshot, [plan]);
    const firstPreview = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, execution.id, plan.id, { requestId: randomUUID(), expectedRevision: 1 }));
    const applied = pmAutomationReviewResultSchema.parse(await f.service.apply(f.actor, f.workspaceId, execution.id, plan.id, { requestId: randomUUID(), expectedRevision: 1, previewToken: firstPreview.previewToken! }));
    assert.equal(applied.status, 'applied'); assert.equal(applied.idMap.existing, f.task.id);
    assert.equal(f.workspace.get(f.task.id).entity.title, 'Observed task', 'Existing task draft display fields are not silently applied');
    const planningDocument = applied.idMap['plan-document:existing-plan']!;
    const next = await f.execution({}, f.actor, { templateId: 'pm-next-actions' });
    const nextSnapshot = await f.service.freeze(f.actor, f.workspaceId, next.id, evidence);
    assert.equal(nextSnapshot.documents.find(document => document.id === planningDocument)!.automationOrigin, true);
    await f.publish(nextSnapshot, [{ ...plan, sourceRefs: [nextSnapshot.sources.find(source => source.id === f.task.id)!] }]);
    const changedGoal = await f.workspace.patch(goal.id, { title: 'Changed objective' }, goal.revision);
    const preview = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, next.id, plan.id, { requestId: randomUUID(), expectedRevision: 1 }));
    assert.equal(preview.canApply, false); assert.ok(preview.currentSources.some(source => source.id === goal.id && source.revision === changedGoal.revision));
    assert.equal(f.workspace.items({ entity: 'work_item' }).length, 3);
    await f.workspace.patch(planningDocument, { title: 'Later manual planning edit' }, f.workspace.get(planningDocument).revision);
    const manual = await f.service.freeze(f.actor, f.workspaceId, (await f.execution()).id, evidence);
    assert.equal(manual.documents.find(document => document.id === planningDocument)!.automationOrigin, false);
  });
  it('filters selected activity in SQL before bounding and reports unknown comment totals rather than fabricated complete coverage', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close);
    await f.pool.query(`INSERT INTO project_audit(workspace_id,project_id,source,command_id,action,actor_id,target_id,target_kind,after_version,changes,dedupe_key)
      VALUES($1,$2,'core_http','selected-original','Selected actual activity',$3,$4,'work_item','original','[]'::jsonb,'selected-original')`, [f.workspaceId, f.project.id, f.actor.id, f.task.id]);
    await f.pool.query(`INSERT INTO project_audit(workspace_id,project_id,source,command_id,action,actor_id,target_id,target_kind,after_version,changes,dedupe_key)
      SELECT $1,$2,'core_http','peer-'||n::text,'Unselected peer activity',$3,$4,'work_item',n::text,'[]'::jsonb,'peer-'||n::text FROM generate_series(1,2100) n`, [f.workspaceId, f.project.id, f.actor.id, f.peer.id]);
    await f.pool.query(`WITH inserted AS (
      INSERT INTO task_comments(id,workspace_id,project_id,task_id,author_id,content)
      SELECT md5($1::text||n::text)::uuid,$1::uuid,$2,$3,$4,'Actual bounded comment '||n::text FROM generate_series(1,1001) n RETURNING *)
      INSERT INTO task_comment_revisions(workspace_id,comment_id,version,action,content,actor_id,command_id,occurred_at)
      SELECT workspace_id,id,version,'created',content,author_id,gen_random_uuid(),updated_at FROM inserted`, [f.workspaceId, f.project.id, f.task.id, f.actor.id]);
    const execution = await f.execution({ taskIds: [f.task.id] });
    const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence);
    assert.deepEqual(snapshot.activities.map(activity => activity.title), ['Selected actual activity']);
    assert.equal(snapshot.coverage.find(item => item.source === 'activities')!.status, 'complete');
    assert.equal(snapshot.comments.length, 1000); assert.equal(snapshot.coverage.find(item => item.source === 'comments')!.status, 'partial');
    assert.equal(snapshot.coverage.find(item => item.source === 'comments')!.totalRecords, null);
    assert.ok(snapshot.sources.filter(source => source.kind === 'activity' || source.kind === 'comment').every(source => source.url === null));
    assert.equal(snapshot.sources.find(source => source.id === f.task.id)!.url, `/pm/${f.workspaceId}/entities/${f.task.id}`);
  });
  it('bounds oversized combined evidence with explicit partial coverage and removes orphan source references', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close);
    const now = new Date().toISOString(), sessionId = randomUUID(), sessionRef = `session:${sessionId}:1`;
    const messages = Array.from({ length: 60 }, (_, index) => ({ id: `message-${index}`, sourceRefId: `message:${index}:1`, role: 'assistant' as const, text: 'Observed runtime message content '.repeat(2800), at: now }));
    const sourceIdentity = { actorId: f.actor.id, workspaceId: f.workspaceId, projectId: f.project.id, revision: '1', label: 'Scoped evidence record', url: null, updatedAt: now };
    const sources: PmAutomationAgentEvidence['sources'] = [{ ...sourceIdentity, refId: sessionRef, kind: 'session', id: sessionId }, ...messages.map(message => ({ ...sourceIdentity, refId: message.sourceRefId, kind: 'message' as const, id: message.id }))];
    const supplied: PmAutomationAgentEvidence = { ...evidence, sources, sessions: [{ id: sessionId, sourceRefId: sessionRef, taskIds: [f.task.id], status: 'idle', title: 'Scoped oversized source', topics: [], createdAt: now, updatedAt: now, messages }], coverage: evidence.coverage.map(item => item.source === 'sessions' ? { ...item, observedRecords: 1, totalRecords: 1 } : item) };
    const execution = await f.execution();
    const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, supplied);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 4 * 1024 * 1024);
    assert.equal(snapshot.coverage.find(item => item.source === 'sessions')!.status, 'partial');
    assert.ok(snapshot.coverage.find(item => item.source === 'sessions')!.reason?.includes('byte boundary'));
    assert.equal(snapshot.sources.some(source => source.kind === 'message' || source.kind === 'session'), false);
    assert.ok(snapshot.tasks.some(task => task.id === f.task.id));
  });
  it('persists edited document targets and captures new reference guards only from the original authorized snapshot', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.lifecycle.close);
    const execution = await f.execution(); const snapshot = await f.service.freeze(f.actor, f.workspaceId, execution.id, evidence);
    const draft: PmAutomationCandidate = { id: 'editable-document', kind: 'create-document', title: 'Editable source document', rationale: 'Explicitly reviewed reference', sourceRefs: [snapshot.sources.find(source => source.id === f.task.id)!], evidence: [], status: 'pending', revision: 1, document: { title: 'Edited persistent target', body: 'Actual reviewed document content', taskIds: [] } };
    const original = (await f.publish(snapshot, [draft])).candidates[0]!;
    if (original.kind !== 'create-document') assert.fail();
    const edited = pmAutomationReviewResultSchema.parse(await f.service.edit(f.actor, f.workspaceId, execution.id, draft.id, { requestId: randomUUID(), expectedRevision: 1, candidate: { ...original, document: { ...original.document, taskIds: [f.peer.id] } } }));
    assert.deepEqual(edited.candidate.sourceRefs, original.sourceRefs);
    assert.ok(edited.candidate.reviewSources?.some(source => source.id === f.peer.id && source.revision === f.peer.revision));
    const preview = pmAutomationCandidatePreviewSchema.parse(await f.service.preview(f.actor, f.workspaceId, execution.id, draft.id, { requestId: randomUUID(), expectedRevision: edited.candidate.revision }));
    const applied = pmAutomationReviewResultSchema.parse(await f.service.apply(f.actor, f.workspaceId, execution.id, draft.id, { requestId: randomUUID(), expectedRevision: edited.candidate.revision, previewToken: preview.previewToken! }));
    assert.equal(applied.status, 'applied'); assert.ok(f.workspace.get(applied.idMap[draft.id]!).entity.related_to.includes(f.peer.id));
  });
});
