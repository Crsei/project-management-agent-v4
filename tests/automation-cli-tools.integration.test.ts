import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerAgentToolRoutes } from '../apps/server/pm/src/routes/agent-tool-routes.ts';
import { pmToolCallRecordSchema } from '../packages/agent-contracts/src/pm-tools.ts';
import { createAutomationToolFamily, automationToolRecoveryIdentitySchema } from '../apps/server/pm/src/agent-tools/agent-tool-automation.ts';
import { createAgentChatTools } from '../apps/server/pm/src/agent-tools/agent-chat-tools.ts';
import { createPmAutomationMutationPort } from '../apps/server/pm/src/automation-pm-mutations.ts';
import { CoreWorkspacePool } from '../apps/server/pm/src/routes/core-routes.ts';
import { createAutomationStudioService } from '../packages/application/src/automation-studio.ts';
import { createPmAutomationService, type PmAutomationMutationPort } from '../packages/application/src/automation-pm.ts';
import { runAutomationStudioBatch } from '../packages/application/src/automation-studio-worker.ts';
import { nextStudioDue } from '../packages/application/src/automation-studio-schedule.ts';
import { AutomationToolResultSchema } from '../packages/agent-contracts/src/pm-tool-automation.ts';
import type { AgentChatToolContext } from '../packages/application/src/agent-chat-tools.ts';
import type { StudioConfig, StudioExecutionPort } from '../packages/contracts/src/automation-studio.ts';
import type { PmAutomationAgentEvidence, PmAutomationCandidate } from '../packages/contracts/src/automation-pm.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { createConfiguredAutomationGitPort } from '../packages/infrastructure/src/automation-git.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV4WorkerTestDatabase } from './worker-environment.ts';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
let database: MailFixtureDatabase;
const evidence: PmAutomationAgentEvidence = { sources: [], sessions: [], executions: [], pullRequests: [], coverage: ['sessions', 'executions', 'pull-requests'].map(source => ({ source: source as 'sessions' | 'executions' | 'pull-requests', status: 'complete', observedRecords: 0, totalRecords: 0, reason: null })) };
async function fixture(signal: AbortSignal) {
  const scope = new MailFixtureScope(signal);
  return scope.initialize(async () => {
    const { pool } = await acquireMailFixtureDatabase(scope, database);
    const actor = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Automation tool owner', password: 'Isolated-Automation-Tool-Password' });
    const workspaceId = (await createWorkspace(pool, actor.id, 'Automation tool regression')).id;
    const root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'automation-cli-tools-')), path => rm(path, { recursive: true, force: true }));
    const cores = await scope.acquire(async () => new CoreWorkspacePool(root, pool), value => value.close()), workspace = await cores.get(workspaceId);
    let project = await workspace.createEntity({ entity: 'project', title: 'Automation fixture' }); project = await workspace.patch(project.id, { status: 'active' }, project.revision);
    const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Frozen original source', body: 'Observe the original source.' });
    const core = readonlyCorePort(id => cores.rootFor(id));
    let dispatches = 0, queries = 0, available = true;
    const runtime: StudioExecutionPort = {
      capabilities: async () => ({ actions: [{ id: 'prompt', available, reason: available ? null : 'fixture_runtime_unavailable' }, { id: 'template', available, reason: available ? null : 'fixture_runtime_unavailable' }], providers: [{ id: 'controlled-provider', name: 'Controlled transport', models: ['controlled-model'] }], repositories: [], plugins: [] }),
      dispatch: async () => { dispatches++; throw new Error('Controlled lost response after acceptance'); },
      query: async () => { queries++; return { status: 'completed', externalExecutionId: 'original-external', threadId: null, summary: 'Original execution reconciled', error: null, logs: [] }; },
      cancel: async () => ({ status: 'cancelled', externalExecutionId: 'original-external', threadId: null, summary: 'Original cancellation confirmed', error: null, logs: [] }),
    };
    const toolOptions = { database: () => pool, coreWorkspaces: cores, localProjects: { enabled: false, defaultParent: null }, executeCommand: async () => { throw new Error('This fixture only uses native core PM mutations'); }, readCommandReceipt: async () => null, readComments: async () => { throw new Error('This fixture does not use comment mutations'); } };
    const tools = createAgentChatTools(toolOptions);
    const nativeMutations = createPmAutomationMutationPort({ database: () => pool, coreWorkspaces: cores, tools });
    let loseNativeResponse = false, nativeWrites = 0, nativeRecoveries = 0;
    const mutations: PmAutomationMutationPort = {
      async execute(name, input, context) { const result = await nativeMutations.execute(name, input, context); nativeWrites++; if (loseNativeResponse) { loseNativeResponse = false; throw new Error('Controlled lost response after actual native PM commit'); } return result; },
      async recover(name, input, context) { nativeRecoveries++; return nativeMutations.recover(name, input, context); },
    };
    const options = { database: () => pool, core, runtime, mutations, git: createConfiguredAutomationGitPort({}) }, family = createAutomationToolFamily(options), studio = createAutomationStudioService(options), pm = createPmAutomationService(options);
    const deliveryTools = createAgentChatTools({ ...toolOptions, families: [family] });
    const context = (operationId = randomUUID()): AgentChatToolContext => ({ actor, workspaceId, operationId, threadId: 'automation-regression', messageId: 'explicit-operation', scope: { kind: 'projects', projectIds: [project.id] } });
    const config: StudioConfig = { name: 'Real saved snapshot', description: '', projectId: project.id, tags: [], templateId: null, quickAccess: true, trigger: { kind: 'manual' }, dailyLimit: 20, cooldownMinutes: 0, action: { kind: 'prompt', providerInstanceId: 'controlled-provider', model: 'controlled-model', options: {}, prompt: 'Inspect the authorized project', repositories: [], plugins: [], timeoutSeconds: 60 } };
    return { scope, pool, actor, workspaceId, workspace, project, task, core, runtime, family, studio, pm, context, config, coreWorkspaces: cores, deliveryTools, stats: () => ({ dispatches, queries, nativeWrites, nativeRecoveries }), disable: () => { available = false; }, dropNativeResponse: () => { loseNativeResponse = true; } };
  });
}

describe('Automation CLI family through real native application stores', { skip: !source }, () => {
  before(async t => { assert.ok(source); assertV4WorkerTestDatabase(source); database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(async () => database?.close(), { timeout: 30000 });
  it('T26 saves without execution, retains shortcuts, enforces CAS and uses native DST scheduling', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const created = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_create', { projectId: f.project.id, config: f.config }, f.context()));
    assert.equal(created.kind, 'automation_definition'); if (created.kind !== 'automation_definition') return;
    assert.equal(created.definition.status, 'draft'); assert.equal(f.stats().dispatches, 0); assert.deepEqual((await f.studio.executions(f.actor, f.workspaceId)).items, []);
    const shortcuts = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_definitions', { projectId: f.project.id, quickAccess: true }, f.context()));
    assert.equal(shortcuts.kind, 'automation_definitions'); if (shortcuts.kind === 'automation_definitions') assert.deepEqual(shortcuts.definitions.map(d => d.id), [created.definition.id]);
    const update = { projectId: f.project.id, definitionId: created.definition.id, expectedRevision: 1, config: { ...f.config, name: 'CAS updated' } };
    await f.family.execute('pm_automation_update', update, f.context()); await assert.rejects(f.family.execute('pm_automation_update', update, f.context()), error => error instanceof DomainError && error.code === 'version_conflict');
    const spring = { ...f.config, trigger: { kind: 'cron' as const, expression: '30 2 * * *', timezone: 'America/New_York' } }, autumn = { ...f.config, trigger: { kind: 'cron' as const, expression: '30 1 * * *', timezone: 'America/New_York' } };
    assert.equal(nextStudioDue(spring, new Date('2026-03-08T00:00:00Z'))?.toISOString(), '2026-03-09T06:30:00.000Z');
    assert.equal(nextStudioDue(autumn, new Date('2026-11-01T05:30:00Z'))?.toISOString(), '2026-11-02T06:30:00.000Z');
    f.disable(); const invalid = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_validate', { projectId: f.project.id, config: f.config }, f.context()));
    assert.equal(invalid.kind, 'automation_validation'); if (invalid.kind === 'automation_validation') { assert.equal(invalid.validation.valid, false); assert.ok(invalid.validation.issues.some(i => i.code === 'runtime_unavailable')); }
    await assert.rejects(f.family.execute('pm_automation_test', { projectId: f.project.id, definitionId: created.definition.id, expectedRevision: 2 }, f.context()), error => error instanceof DomainError && error.code === 'automation_configuration_unavailable');
    assert.equal((await f.studio.executions(f.actor, f.workspaceId)).items.length, 0);
    await f.pool.query('UPDATE memberships SET capabilities=$3,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.id, []]);
    await assert.rejects(f.family.authorizeResult!('pm_automation_definitions', { projectId: f.project.id, quickAccess: true }, shortcuts, f.context()));
  });
  it('T27 really queues test, recovers the same original request, queries without redispatch and pages every log', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close); const definition = await f.studio.create(f.actor, f.workspaceId, { requestId: randomUUID(), config: f.config });
    const ctx = f.context(), input = { projectId: f.project.id, definitionId: definition.id, expectedRevision: 1 };
    const result = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_test', input, ctx));
    assert.equal(result.kind, 'automation_execution'); if (result.kind !== 'automation_execution') return;
    assert.equal(result.execution.trigger, 'test'); assert.equal(result.execution.status, 'queued');
    const identity = automationToolRecoveryIdentitySchema.parse(f.family.recoveryIdentity('pm_automation_test', input, ctx)); assert.equal(identity.commandId, result.execution.requestId);
    const counts = async () => (await f.pool.query<{ executions: number; receipts: number; logs: number }>('SELECT (SELECT count(*)::int FROM automation_studio_executions WHERE workspace_id=$1) AS executions,(SELECT count(*)::int FROM automation_studio_receipts WHERE workspace_id=$1) AS receipts,(SELECT count(*)::int FROM automation_studio_execution_events WHERE execution_id=$2) AS logs', [f.workspaceId, result.execution.id])).rows[0];
    const beforeInspection = await counts();
    assert.deepEqual(await f.family.inspectOutcome!(identity, f.actor.id, f.workspaceId), { status: 'succeeded', evidence: 'application_receipt' });
    assert.deepEqual(await f.family.inspectOutcome!({ ...identity, hash: '0'.repeat(64) }, f.actor.id, f.workspaceId), { status: 'unknown', evidence: 'unresolved' });
    assert.equal(await f.family.recover('pm_automation_test', input, f.context()), null, 'Missing original request remains unknown; no replacement execution');
    assert.deepEqual(await counts(), beforeInspection, 'Outcome inspection and absent recovery do not write native evidence');
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, randomUUID()); assert.equal(f.stats().dispatches, 1);
    const recovered = AutomationToolResultSchema.parse(await f.family.recover('pm_automation_test', input, ctx));
    assert.equal(recovered.kind, 'automation_studio_receipt'); if (recovered.kind === 'automation_studio_receipt') assert.equal(recovered.original.requestId, identity.commandId);
    assert.equal(f.stats().dispatches, 1);
    const query = f.runtime.query, expectedMessages = Array.from({ length: 405 }, (_, index) => `complete page ${index + 1}`);
    f.runtime.query = async request => {
      assert.equal(request.executionId, result.execution.id); assert.equal(request.requestId, identity.commandId);
      return { ...await query(request), logs: expectedMessages.map((message, index) => ({ id: `original-log-${index + 1}`, at: new Date().toISOString(), message, stream: 'system' as const })) };
    };
    const queried = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_query', { projectId: f.project.id, executionId: result.execution.id }, f.context()));
    assert.equal(queried.kind, 'automation_execution'); if (queried.kind === 'automation_execution') assert.equal(queried.execution.status, 'completed'); assert.equal(f.stats().dispatches, 1); assert.ok(f.stats().queries > 0);
    const messages: string[] = []; let cursor: string | undefined;
    do { const page = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_logs', { projectId: f.project.id, executionId: result.execution.id, ...(cursor ? { cursor } : {}) }, f.context())); assert.equal(page.kind, 'automation_logs'); if (page.kind !== 'automation_logs') break; messages.push(...page.logs.filter(log => log.message.startsWith('complete page ')).map(log => log.message)); cursor = page.nextCursor ?? undefined; } while (cursor);
    assert.deepEqual(messages, expectedMessages);
    const queued = await f.studio.dispatchTest(f.actor, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    const cancelCtx = f.context(), cancelled = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_cancel', { projectId: f.project.id, executionId: queued.id }, cancelCtx));
    assert.equal(cancelled.kind, 'automation_execution'); if (cancelled.kind === 'automation_execution') assert.equal(cancelled.execution.status, 'cancelled');
    assert.ok(await f.family.recover('pm_automation_cancel', { projectId: f.project.id, executionId: queued.id }, cancelCtx)); assert.equal(f.stats().dispatches, 1);
    let foreignProject = await f.workspace.createEntity({ entity: 'project', title: 'Out of explicit tool scope' });
    foreignProject = await f.workspace.patch(foreignProject.id, { status: 'active' }, foreignProject.revision);
    const foreign = await f.studio.create(f.actor, f.workspaceId, { requestId: randomUUID(), config: { ...f.config, projectId: foreignProject.id } });
    const noise = Array.from({ length: 55 }, () => ({ id: randomUUID(), request_id: randomUUID() }));
    await f.pool.query("INSERT INTO automation_studio_executions(id,workspace_id,actor_id,definition_id,project_id,definition_revision,config_snapshot,request_id,trigger) SELECT r.id,$1,$2,$3,$4,1,$5::jsonb,r.request_id,'test' FROM jsonb_to_recordset($6::jsonb) r(id uuid,request_id uuid)", [f.workspaceId, f.actor.id, foreign.id, foreignProject.id, JSON.stringify(foreign.config), JSON.stringify(noise)]);
    const visible = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_executions', { projectId: f.project.id }, f.context()));
    assert.equal(visible.kind, 'automation_executions');
    if (visible.kind === 'automation_executions') { assert.equal(visible.executions.length, 2); assert.equal(visible.nextCursor, null); assert.ok(visible.executions.every(item => item.configSnapshot.projectId === f.project.id)); }
    const unrestricted = await f.studio.executions(f.actor, f.workspaceId);
    assert.equal(unrestricted.items.length, 50); assert.ok(unrestricted.nextCursor, 'Unrestricted native membership still sees all own project histories');
    await f.pool.query("UPDATE memberships SET project_ids=$3,capabilities=array_remove(capabilities,'access.manage'),version=version+1 WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actor.id, [f.project.id]]);
    const current = await f.studio.executions(f.actor, f.workspaceId);
    assert.equal(current.items.length, 2); assert.equal(current.nextCursor, null, 'Revoked-project rows must not starve the first visible native page');
    assert.ok(current.items.every(item => item.configSnapshot.projectId === f.project.id));
    assert.deepEqual(await f.studio.executions(f.actor, f.workspaceId, undefined, noise[0]!.id), { items: [], nextCursor: null }, 'A revoked-project cursor is not an authorized anchor');
    assert.deepEqual(await f.studio.executions(f.actor, f.workspaceId, foreign.id), { items: [], nextCursor: null });
    await assert.rejects(f.studio.executions(f.actor, f.workspaceId, undefined, undefined, foreignProject.id), error => error instanceof DomainError && [403, 404].includes(error.status));
    await f.pool.query('UPDATE memberships SET project_ids=$3,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.id, []]);
    assert.deepEqual(await f.studio.executions(f.actor, f.workspaceId), { items: [], nextCursor: null });
  });
  it('T28 retains frozen sources, exact candidate closure/idMap and original apply receipt; stale sources cannot apply', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const templateId = 'pm-stalled-tasks', config: StudioConfig = { ...f.config, templateId, templateVersion: '1.0.0', templateInputs: {}, action: { kind: 'template', templateId, arguments: {}, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 60 } };
    const definition = await f.studio.create(f.actor, f.workspaceId, { requestId: randomUUID(), config }), run = await f.studio.dispatchTest(f.actor, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await f.pool.query("UPDATE automation_studio_executions SET dispatched_at=clock_timestamp(),status='running' WHERE id=$1", [run.id]);
    const frozen = await f.pm.freeze(f.actor, f.workspaceId, run.id, evidence), source = frozen.sources.find(s => s.id === f.task.id)!;
    const draft = { title: 'Explicit task', description: 'Reviewed plan', acceptanceCriteria: ['Observable'], labels: [], dependsOn: [], relatedTaskIds: [], milestoneId: null };
    const candidate: PmAutomationCandidate = { id: 'selected-plan', kind: 'plan', title: 'Selected plan', rationale: 'Explicit plan review', sourceRefs: [source], evidence: [], revision: 1, status: 'pending', plan: { title: 'Reviewed plan document', description: 'Only explicitly selected tasks', tasks: [{ ...draft, localId: 'first', existingTaskId: f.task.id, dependsOnLocalIds: [] }, { ...draft, localId: 'second', dependsOnLocalIds: ['first'] }] } };
    await f.pm.publish(f.actor, f.workspaceId, run.id, { templateId, executionId: run.id, observedAt: frozen.observedAt, summary: 'Controlled source-bound proposals', findings: [], candidates: [candidate], coverage: frozen.coverage, gaps: frozen.coverage.filter(c => c.status !== 'complete').map(c => ({ source: c.source, reason: c.reason! })) });
    const base = { projectId: f.project.id, executionId: run.id, candidateId: candidate.id, expectedRevision: 1 };
    const before = f.workspace.snapshot().files.length;
    const incomplete = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_preview', { ...base, selectedItemIds: ['second'] }, f.context()));
    assert.equal(incomplete.kind, 'automation_preview'); if (incomplete.kind === 'automation_preview') assert.equal(incomplete.preview.canApply, false);
    const preview = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_preview', { ...base, selectedItemIds: ['first', 'second'] }, f.context()));
    assert.equal(preview.kind, 'automation_preview'); if (preview.kind !== 'automation_preview') return; assert.equal(preview.preview.canApply, true); assert.equal(f.workspace.snapshot().files.length, before, 'Preview may record a review receipt, never business objects');
    const applyContext = f.context(), input = { ...base, selectedItemIds: ['first', 'second'], previewToken: preview.preview.previewToken! };
    const applied = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_apply', input, applyContext)); assert.equal(applied.kind, 'automation_review_receipt'); if (applied.kind !== 'automation_review_receipt' || !('idMap' in applied.original.result)) return;
    assert.equal(applied.original.result.status, 'applied'); assert.equal(applied.original.result.idMap.first, f.task.id); assert.ok(applied.original.result.idMap.second); assert.ok(applied.original.result.idMap['plan-document:selected-plan']);
    const count = f.workspace.snapshot().files.length, original = AutomationToolResultSchema.parse(await f.family.recover('pm_automation_candidate_apply', input, applyContext));
    assert.equal(original.kind, 'automation_review_receipt'); if (original.kind === 'automation_review_receipt') assert.deepEqual(original.original, applied.original); assert.equal(f.workspace.snapshot().files.length, count);
    assert.deepEqual(await f.pm.snapshot(f.actor, f.workspaceId, run.id), frozen);
    const stale: PmAutomationCandidate = { ...candidate, id: 'stale-plan' };
    // A separate actual execution owns independent immutable analysis for stale-source review.
    const next = await f.studio.dispatchTest(f.actor, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 }); await f.pool.query("UPDATE automation_studio_executions SET dispatched_at=clock_timestamp(),status='running' WHERE id=$1", [next.id]);
    const nextSnapshot = await f.pm.freeze(f.actor, f.workspaceId, next.id, evidence), nextSource = nextSnapshot.sources.find(s => s.id === f.task.id)!;
    await f.pm.publish(f.actor, f.workspaceId, next.id, { templateId, executionId: next.id, observedAt: nextSnapshot.observedAt, summary: 'Stale source guard', findings: [], candidates: [{ ...stale, sourceRefs: [nextSource] }], coverage: nextSnapshot.coverage, gaps: nextSnapshot.coverage.filter(c => c.status !== 'complete').map(c => ({ source: c.source, reason: c.reason! })) });
    const current = f.workspace.get(f.task.id); await f.workspace.patch(f.task.id, { title: 'Changed after source freeze' }, current.revision);
    const blocked = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_preview', { ...base, executionId: next.id, candidateId: stale.id }, f.context())); assert.equal(blocked.kind, 'automation_preview'); if (blocked.kind === 'automation_preview') { assert.equal(blocked.preview.canApply, false); assert.equal(blocked.preview.previewToken, null); }
    if (blocked.kind === 'automation_preview') {
      const proposed = { ...blocked.preview.candidate, reviewSources: blocked.preview.currentSources };
      const edited = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_edit', { ...base, executionId: next.id, candidateId: stale.id, candidate: proposed }, f.context()));
      assert.equal(edited.kind, 'automation_review_receipt');
      if (edited.kind === 'automation_review_receipt' && 'status' in edited.original.result) {
        assert.equal(edited.original.result.status, 'edited');
        assert.deepEqual(edited.original.result.candidate.sourceRefs, blocked.preview.candidate.sourceRefs);
        assert.ok(edited.original.result.candidate.sourceRefs.some(source => source.refId === nextSource.refId));
        assert.deepEqual(edited.original.result.candidate.reviewSources, blocked.preview.currentSources);
        const ignored = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_ignore', { ...base, executionId: next.id, candidateId: stale.id, expectedRevision: edited.original.result.candidate.revision }, f.context()));
        assert.equal(ignored.kind, 'automation_review_receipt');
        if (ignored.kind === 'automation_review_receipt' && 'status' in ignored.original.result) assert.equal(ignored.original.result.status, 'ignored');
      }
    }
    await assert.rejects(f.family.authorizeResult!('pm_automation_candidate_apply', input, applied, { ...applyContext, scope: { kind: 'projects', projectIds: [] } }));
  });
  it('T28 recovers a lost actual native creation receipt without creating the candidate twice', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const templateId = 'pm-stalled-tasks', config: StudioConfig = { ...f.config, templateId, templateVersion: '1.0.0', templateInputs: {}, action: { kind: 'template', templateId, arguments: {}, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 60 } };
    const definition = await f.studio.create(f.actor, f.workspaceId, { requestId: randomUUID(), config }), run = await f.studio.dispatchTest(f.actor, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await f.pool.query("UPDATE automation_studio_executions SET dispatched_at=clock_timestamp(),status='running' WHERE id=$1", [run.id]);
    const snapshot = await f.pm.freeze(f.actor, f.workspaceId, run.id, evidence), source = snapshot.sources.find(s => s.id === f.task.id)!;
    const candidate: PmAutomationCandidate = { id: 'lost-create', kind: 'create-task', title: 'Explicit creation', rationale: 'Source-bound user review', sourceRefs: [source], evidence: [], revision: 1, status: 'pending', task: { title: 'Exactly one real created task', description: 'Actual native commit followed by lost reply', acceptanceCriteria: [], labels: [], dependsOn: [], relatedTaskIds: [], milestoneId: null } };
    await f.pm.publish(f.actor, f.workspaceId, run.id, { templateId, executionId: run.id, observedAt: snapshot.observedAt, summary: 'Actual lost receipt test', findings: [], candidates: [candidate], coverage: snapshot.coverage, gaps: snapshot.coverage.filter(c => c.status !== 'complete').map(c => ({ source: c.source, reason: c.reason! })) });
    const base = { projectId: f.project.id, executionId: run.id, candidateId: candidate.id, expectedRevision: 1 }, preview = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_preview', base, f.context()));
    assert.equal(preview.kind, 'automation_preview'); if (preview.kind !== 'automation_preview') return;
    const context = f.context(), input = { ...base, previewToken: preview.preview.previewToken! }, before = f.workspace.snapshot().files.length;
    f.dropNativeResponse();
    const applied = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_candidate_apply', input, context));
    assert.equal(applied.kind, 'automation_review_receipt'); if (applied.kind !== 'automation_review_receipt' || !('idMap' in applied.original.result)) return;
    assert.equal(applied.original.result.status, 'applied'); assert.ok(applied.original.result.idMap[candidate.id]);
    assert.equal(f.workspace.snapshot().files.length, before + 1); assert.equal(f.stats().nativeWrites, 1); assert.equal(f.stats().nativeRecoveries, 1);
    assert.ok(await f.family.recover('pm_automation_candidate_apply', input, context));
    assert.equal(f.workspace.snapshot().files.length, before + 1); assert.equal(f.stats().nativeWrites, 1);
  });
  it('T28 imports as a draft, exports losslessly, rejects changed original content and retains Git CAS receipts without remote access', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const input = { projectId: f.project.id, document: { version: 1, kind: 'pm-automation-bundle', spec: f.config } }, context = f.context();
    const preview = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_import_preview', input, f.context()));
    assert.equal(preview.kind, 'automation_transfer_preview'); assert.equal((await f.studio.definitions(f.actor, f.workspaceId)).items.length, 0);
    const imported = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_import', input, context));
    assert.equal(imported.kind, 'automation_import_receipt'); if (imported.kind !== 'automation_import_receipt') return;
    assert.equal(imported.original.status, 'completed'); assert.equal(imported.original.definition?.status, 'draft');
    const definitionId = imported.original.definition!.id;
    const exported = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_export', { projectId: f.project.id, definitionId, format: 'bundle' }, f.context()));
    assert.equal(exported.kind, 'automation_export'); if (exported.kind === 'automation_export') { assert.equal(exported.exported.document.kind, 'pm-automation-bundle'); if (exported.exported.document.kind === 'pm-automation-bundle') assert.deepEqual(exported.exported.document.spec, f.config); }
    assert.ok(await f.family.recover('pm_automation_import', input, context));
    assert.equal((await f.studio.definitions(f.actor, f.workspaceId)).items.length, 1);
    await assert.rejects(f.family.execute('pm_automation_import', { ...input, document: { ...input.document, spec: { ...f.config, name: 'Changed original content' } } }, context), error => error instanceof DomainError && error.code === 'idempotency_conflict');
    await assert.rejects(f.family.execute('pm_automation_export', { projectId: f.project.id, definitionId, format: 'source' }, f.context()), error => error instanceof DomainError && error.code === 'automation_transfer_invalid');
    const config = { projectId: f.project.id, enabled: false, repository: 'https://example.invalid/isolated.git', branch: 'main', path: 'automations', authorName: 'Automation fixture', authorEmail: 'fixture@example.test', intervalSeconds: 0, encryptionEnabled: false };
    const save = { projectId: f.project.id, expectedRevision: 0, config }, saveContext = f.context();
    const saved = AutomationToolResultSchema.parse(await f.family.execute('pm_automation_git_save', save, saveContext));
    assert.equal(saved.kind, 'automation_git_status'); if (saved.kind === 'automation_git_status') { assert.equal(saved.status.revision, 1); assert.equal(saved.status.capability.available, false); assert.equal(saved.status.operation, null); }
    const recovered = AutomationToolResultSchema.parse(await f.family.recover('pm_automation_git_save', save, saveContext)); assert.equal(recovered.kind, 'automation_git_receipt');
    await assert.rejects(f.family.execute('pm_automation_git_save', save, f.context()), error => error instanceof DomainError && error.code === 'version_conflict');
    const syncContext = f.context(), sync = { projectId: f.project.id, expectedRevision: 1 };
    await assert.rejects(f.family.execute('pm_automation_git_sync', sync, syncContext), error => error instanceof DomainError && error.code === 'automation_git_unconfigured');
    const identity = f.family.recoveryIdentity('pm_automation_git_sync', sync, syncContext)!;
    assert.deepEqual(await f.family.inspectOutcome!(identity, f.actor.id, f.workspaceId), { status: 'unknown', evidence: 'unresolved' });
    assert.equal(f.stats().dispatches, 0);
  });
  it('withholds frozen task/document quotes after current project moves, including native reads and successful write delivery', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'invalid_result_transport' } }));
    registerAgentToolRoutes(app, { database: () => f.pool, actor: async () => f.actor, coreWorkspaces: f.coreWorkspaces, tools: f.deliveryTools });
    const route = `/api/v1/workspaces/${f.workspaceId}/agent-tools`;
    const requestFor = (name: string, args: unknown, context: AgentChatToolContext) => ({ operationId: context.operationId, name, arguments: args, target: { workspaceId: f.workspaceId, projectId: f.project.id }, threadId: context.threadId, messageId: context.messageId, generationId: 'automation-wire-visibility' });
    let destination = await f.workspace.createEntity({ entity: 'project', title: 'Restricted destination' });
    destination = await f.workspace.patch(destination.id, { status: 'active' }, destination.revision);
    const document = await f.workspace.createEntity({ entity: 'document', project: f.project.id, title: 'Quoted source document', body: 'Frozen source-only document secret.' });
    const templateId = 'pm-stalled-tasks', config: StudioConfig = { ...f.config, templateId, templateVersion: '1.0.0', templateInputs: {}, action: { kind: 'template', templateId, arguments: {}, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 60 } };
    const definition = await f.studio.create(f.actor, f.workspaceId, { requestId: randomUUID(), config }), run = await f.studio.dispatchTest(f.actor, f.workspaceId, definition.id, { requestId: randomUUID(), expectedRevision: 1 });
    await f.pool.query("UPDATE automation_studio_executions SET dispatched_at=clock_timestamp(),status='running' WHERE id=$1", [run.id]);
    const frozen = await f.pm.freeze(f.actor, f.workspaceId, run.id, evidence), taskSource = frozen.sources.find(item => item.id === f.task.id)!, documentSource = frozen.sources.find(item => item.id === document.id)!;
    const candidate: PmAutomationCandidate = { id: 'current-source-review', kind: 'create-document', title: 'Quoted source proposal', rationale: 'Explicit source review', sourceRefs: [taskSource, documentSource], evidence: [], status: 'pending', revision: 1, document: { title: 'Frozen proposal', body: frozen.documents.find(item => item.id === document.id)!.body, taskIds: [f.task.id] } };
    await f.pm.publish(f.actor, f.workspaceId, run.id, { templateId, executionId: run.id, observedAt: frozen.observedAt, summary: 'Source-bound historical findings', findings: [{ id: 'quoted-document', title: 'Document finding', detail: 'Historical source quote', severity: 'info', confidence: 'high', evidence: [{ sourceRefId: documentSource.refId, quote: JSON.stringify(frozen.documents.find(item => item.id === document.id)!) }], candidateIds: [candidate.id] }], candidates: [candidate], coverage: frozen.coverage, gaps: frozen.coverage.filter(item => item.status !== 'complete').map(item => ({ source: item.source, reason: item.reason! })) });
    const readInput = { projectId: f.project.id, executionId: run.id }, snapshotContext = f.context(), resultContext = f.context();
    const snapshotRequest = requestFor('pm_automation_snapshot', readInput, snapshotContext), resultRequest = requestFor('pm_automation_result', readInput, resultContext);
    const snapshotResponse = await app.inject({ method: 'POST', url: `${route}/call`, payload: snapshotRequest }), resultResponse = await app.inject({ method: 'POST', url: `${route}/call`, payload: resultRequest });
    assert.equal(snapshotResponse.statusCode, 200); assert.equal(resultResponse.statusCode, 200);
    const savedSnapshot = AutomationToolResultSchema.parse(pmToolCallRecordSchema.parse(snapshotResponse.json()).result), savedResult = AutomationToolResultSchema.parse(pmToolCallRecordSchema.parse(resultResponse.json()).result);
    assert.equal(savedSnapshot.kind, 'automation_snapshot'); assert.equal(savedResult.kind, 'automation_result');
    if (savedSnapshot.kind === 'automation_snapshot') {
      const savedDocument = savedSnapshot.snapshot.documents.find(item => item.id === document.id);
      assert.ok(savedDocument); assert.equal(savedDocument.body, f.workspace.get(document.id).entity.body);
      assert.ok(savedDocument.body.includes('Frozen source-only document secret.'));
      assert.ok(savedSnapshot.snapshot.sources.some(item => item.refId === documentSource.refId && item.actorId === f.actor.id && item.workspaceId === f.workspaceId));
    }
    if (savedResult.kind === 'automation_result') assert.equal(savedResult.result.findings[0]?.evidence[0]?.sourceRefId, documentSource.refId);
    const reviewInput = { ...readInput, candidateId: candidate.id, expectedRevision: 1 }, previewContext = f.context(), ignoreContext = f.context();
    const savedPreview = await f.family.execute('pm_automation_candidate_preview', reviewInput, previewContext);
    const ignoreRequest = requestFor('pm_automation_candidate_ignore', reviewInput, ignoreContext), ignoreResponse = await app.inject({ method: 'POST', url: `${route}/call`, payload: ignoreRequest });
    assert.equal(ignoreResponse.statusCode, 200);
    const savedIgnore = AutomationToolResultSchema.parse(pmToolCallRecordSchema.parse(ignoreResponse.json()).result);
    assert.equal(savedIgnore.kind, 'automation_review_receipt'); if (savedIgnore.kind !== 'automation_review_receipt') return;
    const originalRequestId = savedIgnore.original.requestId, identity = f.family.recoveryIdentity('pm_automation_candidate_ignore', reviewInput, ignoreContext)!;
    const currentTask = f.workspace.get(f.task.id); await f.workspace.patch(f.task.id, { title: 'Changed but still readable' }, currentTask.revision);
    const currentDocument = f.workspace.get(document.id); await f.workspace.patch(document.id, { title: 'Also changed but readable' }, currentDocument.revision);
    await f.family.authorizeResult!('pm_automation_snapshot', readInput, savedSnapshot, snapshotContext);
    await f.family.authorizeResult!('pm_automation_result', readInput, savedResult, resultContext);
    await f.family.authorizeResult!('pm_automation_candidate_preview', reviewInput, savedPreview, previewContext);
    await f.family.authorizeResult!('pm_automation_candidate_ignore', reviewInput, savedIgnore, ignoreContext);
    assert.deepEqual(await f.pm.snapshot(f.actor, f.workspaceId, run.id), frozen, 'Readable revision changes do not erase or rewrite immutable history');
    const state = async () => (await f.pool.query('SELECT s.snapshot::text AS snapshot,r.result::text AS result,(SELECT count(*)::int FROM automation_pm_candidate_history WHERE execution_id=$1) AS history,(SELECT count(*)::int FROM automation_pm_receipts WHERE execution_id=$1) AS receipts FROM automation_pm_snapshots s JOIN automation_pm_results r USING(execution_id) WHERE s.execution_id=$1', [run.id])).rows;
    const originalState = await state();
    const blocked = (error: unknown) => error instanceof DomainError && [403, 404].includes(error.status);
    for (const id of [f.task.id, document.id]) {
      const current = f.workspace.get(id); await f.workspace.patch(id, { project: destination.id }, current.revision);
      assert.deepEqual(await f.pm.snapshot(f.actor, f.workspaceId, run.id), frozen, 'Unrestricted native membership can read a moved source without revision equality');
      await f.family.authorizeResult!('pm_automation_snapshot', readInput, savedSnapshot, { ...snapshotContext, scope: { kind: 'projects', projectIds: [f.project.id, destination.id] } });
      await assert.rejects(f.family.authorizeResult!('pm_automation_snapshot', readInput, savedSnapshot, snapshotContext), blocked, 'Native membership does not widen the explicit tool source scope');
      await f.pool.query("UPDATE memberships SET project_ids=$3,capabilities=array_remove(capabilities,'access.manage'),version=version+1 WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actor.id, [f.project.id]]);
      await assert.rejects(f.pm.snapshot(f.actor, f.workspaceId, run.id), blocked);
      await assert.rejects(f.pm.result(f.actor, f.workspaceId, run.id), blocked);
      await assert.rejects(f.pm.result(f.actor, f.workspaceId, run.id, true), blocked);
      await assert.rejects(f.pm.receipt(f.actor, f.workspaceId, originalRequestId), blocked);
      await assert.rejects(f.family.execute('pm_automation_review_receipt', { projectId: f.project.id, requestId: originalRequestId }, f.context()), blocked);
      await assert.rejects(f.family.authorizeResult!('pm_automation_snapshot', readInput, savedSnapshot, snapshotContext), blocked);
      await assert.rejects(f.family.authorizeResult!('pm_automation_result', readInput, savedResult, resultContext), blocked);
      await assert.rejects(f.family.authorizeResult!('pm_automation_candidate_preview', reviewInput, savedPreview, previewContext), blocked);
      await assert.rejects(f.family.authorizeResult!('pm_automation_candidate_ignore', reviewInput, savedIgnore, ignoreContext), blocked, 'Successful mutation identity must not bypass quote authorization');
      await assert.rejects(f.family.authorizeResult!('pm_automation_review_receipt', { projectId: f.project.id, requestId: originalRequestId }, savedIgnore, f.context()), blocked);
      assert.deepEqual(await f.family.inspectOutcome!(identity, f.actor.id, f.workspaceId), { status: 'succeeded', evidence: 'application_receipt' }, 'Original execution fact is independent of current visibility');
      for (const original of [snapshotRequest, resultRequest, ignoreRequest]) {
        const response = await app.inject({ method: 'POST', url: `${route}/result`, payload: original });
        assert.ok([403, 404].includes(response.statusCode)); assert.equal(response.body.includes('Frozen source-only document secret.'), false);
      }
      const retained = (await f.pool.query<{ status: string; present: boolean }>('SELECT status,result IS NOT NULL AS present FROM pm_agent_tool_operations WHERE operation_id=ANY($1::uuid[])', [[snapshotRequest.operationId, resultRequest.operationId, ignoreRequest.operationId]])).rows;
      assert.equal(retained.length, 3); assert.ok(retained.every(row => row.status === 'succeeded' && row.present), 'Actual delivery denial preserves original native/tool fact and its stored payload');
      assert.deepEqual(await state(), originalState, 'Readability checks neither repair/reconcile nor mutate frozen data, candidates or receipts');
      await f.pool.query('UPDATE memberships SET project_ids=NULL,version=version+1 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.actor.id]);
      const moved = f.workspace.get(id); await f.workspace.patch(id, { project: f.project.id }, moved.revision);
    }
    assert.equal(f.stats().nativeWrites, 0); assert.equal(f.stats().nativeRecoveries, 0); assert.equal(f.stats().dispatches, 0); assert.equal(f.stats().queries, 0);
  });
  it('delivers real native legacy/unknown execution results through the consumer boundary and withholds malformed stored payloads', { timeout: 120000 }, async t => {
    const f = await fixture(t.signal); t.after(f.scope.close);
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'invalid_result_transport' } }));
    registerAgentToolRoutes(app, { database: () => f.pool, actor: async () => f.actor, coreWorkspaces: f.coreWorkspaces, tools: f.deliveryTools });
    const route = `/api/v1/workspaces/${f.workspaceId}/agent-tools`;
    const requestFor = (name: string, args: unknown) => ({ operationId: randomUUID(), name, arguments: args, target: { workspaceId: f.workspaceId, projectId: f.project.id }, threadId: 'automation-wire-thread', messageId: 'automation-wire-message', generationId: 'automation-wire-generation' });
    const inputs = { boolean: false, zero: 0, unavailable: null, nested: [null, false, 0, { label: 'native JSON value', known: false }] };
    const config = { ...f.config, templateInputs: inputs }, definition = await f.studio.create(f.actor, f.workspaceId, { requestId: randomUUID(), config });
    const legacy = await f.studio.create(f.actor, f.workspaceId, { requestId: randomUUID(), config: { ...config, name: 'Historical folder evidence only' } });
    const historical = { version: 1, workspaceId: f.workspaceId, projectId: null, folder: ['old-registration', false, null] };
    await f.pool.query("UPDATE automation_studio_definitions SET config=jsonb_set(config,'{action,executionSelection}',$2::jsonb) WHERE id=$1", [legacy.id, JSON.stringify(historical)]);
    const legacyRequest = requestFor('pm_automation_definition', { projectId: f.project.id, definitionId: legacy.id }), legacyResponse = await app.inject({ method: 'POST', url: `${route}/call`, payload: legacyRequest });
    assert.equal(legacyResponse.statusCode, 200);
    const legacyRecord = pmToolCallRecordSchema.parse(legacyResponse.json());
    assert.equal(legacyRecord.status, 'succeeded'); assert.equal(legacyRecord.result?.kind, 'automation_definition');
    if (legacyRecord.result?.kind === 'automation_definition') {
      assert.deepEqual(legacyRecord.result.definition.config.templateInputs, inputs);
      assert.deepEqual(legacyRecord.result.definition.historicalExecutionSelection, historical);
      assert.equal(legacyRecord.result.definition.executionUnavailableReason, 'agent_workspace_selection_required');
      assert.equal(legacyRecord.result.definition.config.action.executionSelection, undefined);
    }
    await assert.rejects(f.studio.dispatchTest(f.actor, f.workspaceId, legacy.id, { requestId: randomUUID(), expectedRevision: 1 }), error => error instanceof DomainError && error.code === 'automation_configuration_unavailable');
    const runRequest = requestFor('pm_automation_test', { projectId: f.project.id, definitionId: definition.id, expectedRevision: 1 }), runResponse = await app.inject({ method: 'POST', url: `${route}/call`, payload: runRequest });
    assert.equal(runResponse.statusCode, 200);
    const queued = pmToolCallRecordSchema.parse(runResponse.json());
    assert.equal(queued.status, 'succeeded'); assert.equal(queued.result?.kind, 'automation_execution');
    if (queued.result?.kind !== 'automation_execution') return;
    assert.equal(queued.result.execution.status, 'queued'); assert.equal(queued.result.execution.threadId, null); assert.equal(queued.result.execution.error, null);
    assert.deepEqual(queued.result.execution.configSnapshot.templateInputs, inputs);
    assert.equal(queued.result.receipt?.commandId, queued.result.execution.requestId); assert.ok(queued.commandIds?.includes(queued.result.execution.requestId));
    await runAutomationStudioBatch(f.pool, f.core, f.runtime, randomUUID());
    const stateRequest = requestFor('pm_automation_execution', { projectId: f.project.id, executionId: queued.result.execution.id }), stateResponse = await app.inject({ method: 'POST', url: `${route}/call`, payload: stateRequest });
    assert.equal(stateResponse.statusCode, 200);
    const unknown = pmToolCallRecordSchema.parse(stateResponse.json());
    assert.equal(unknown.status, 'succeeded', 'Reading an unknown native execution is not a claim that the execution completed');
    assert.equal(unknown.result?.kind, 'automation_execution'); if (unknown.result?.kind !== 'automation_execution') return;
    assert.equal(unknown.result.execution.status, 'outcome_unknown'); assert.equal(unknown.result.execution.externalExecutionId, null); assert.equal(unknown.result.execution.threadId, null);
    assert.equal(unknown.result.execution.error, 'runtime_transport_unknown'); assert.deepEqual(unknown.result.execution.configSnapshot.templateInputs, inputs);
    const originalResponse = await app.inject({ method: 'POST', url: `${route}/result`, payload: runRequest }); assert.equal(originalResponse.statusCode, 200);
    const original = pmToolCallRecordSchema.parse(originalResponse.json());
    assert.equal(original.result?.kind, 'automation_execution'); if (original.result?.kind === 'automation_execution') assert.equal(original.result.execution.status, 'queued', 'Original accepted snapshot is not overwritten by a later runtime observation');
    const secret = 'WIRE_PRIVATE_EXTRA_MUST_NOT_BE_PROJECTED';
    await f.pool.query("UPDATE pm_agent_tool_operations SET result=jsonb_set(result,'{execution}',(result->'execution')||jsonb_build_object('token',$2::text)) WHERE operation_id=$1", [stateRequest.operationId, secret]);
    const malformed = await app.inject({ method: 'POST', url: `${route}/result`, payload: stateRequest });
    assert.equal(malformed.statusCode, 500); assert.equal(malformed.body.includes(secret), false);
    await f.pool.query("UPDATE pm_agent_tool_operations SET result=jsonb_set(result #- '{execution,token}','{execution,configSnapshot,action,prompt}',to_jsonb($2::text)) WHERE operation_id=$1", [stateRequest.operationId, 'x'.repeat(200001)]);
    const oversized = await app.inject({ method: 'POST', url: `${route}/result`, payload: stateRequest });
    assert.equal(oversized.statusCode, 500); assert.ok(oversized.body.length < 1000, 'An oversized stored payload is withheld, not silently truncated or printed');
    const fact = (await f.pool.query<{ status: string }>('SELECT status FROM pm_agent_tool_operations WHERE operation_id=$1', [stateRequest.operationId])).rows[0]!;
    assert.equal(fact.status, 'succeeded'); assert.equal(f.stats().dispatches, 1); assert.equal(f.stats().queries, 0);
    assert.equal((await f.studio.executions(f.actor, f.workspaceId)).items.length, 1, 'Consumer rejection never creates another native execution');
  });
});
