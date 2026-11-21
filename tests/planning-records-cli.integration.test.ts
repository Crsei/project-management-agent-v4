import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import Fastify from 'fastify';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { accessCommands, getMembership } from '../packages/application/src/access.ts';
import { intentCommands } from '../packages/application/src/intent.ts';
import { planningCommands } from '../packages/application/src/planning.ts';
import { createDeliveryCommands } from '../packages/application/src/delivery.ts';
import { runCommand, requestHash } from '../packages/application/src/kernel.ts';
import { listEntities } from '../packages/application/src/queries.ts';
import { readExternalReceipt, recordExternalReceipt } from '../packages/application/src/core-bridge.ts';
import type { CoreAccess, SqlExecutor } from '../packages/application/src/ports.ts';
import type { AgentChatToolContext } from '../packages/application/src/agent-chat-tools.ts';
import { emptyRoadmap } from '../packages/contracts/src/product-roadmap.ts';
import type { Actor, Command, Entity } from '../packages/domain/src/core.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { CoreWorkspacePool, authorizeCoreScope } from '../apps/server/pm/src/routes/core-routes.ts';
import { executeCoreCommand, isCoreCommand, isCoreEntityKind, listCoreEntities, readCoreEntity, coreVersion } from '../apps/server/pm/src/core-adapter.ts';
import { createPlanningRecordsToolFamily } from '../apps/server/pm/src/agent-tools/agent-tool-planning-records.ts';
import { createProductRoadmapService } from '../apps/server/pm/src/product-roadmap-service.ts';
import { registerProductRoadmapRoutes } from '../apps/server/pm/src/routes/product-roadmap-routes.ts';
import { PlanningRecordsToolResultSchema } from '../packages/agent-contracts/src/pm-tool-planning-records.ts';
import { PlanningRecordsToolInputSchemas } from '../packages/application/src/agent-tool-planning-records.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test('T23–25 real application services: delivery identity, intent receipts, publication closure, no duplicate or automatic Done', { timeout: 120000 }, async t => {
  assert.ok(databaseUrl, 'Real isolated PostgreSQL is required; missing database is not acceptance');
  const schema = `test_planning_records_${randomUUID().replaceAll('-', '')}`, bootstrap = createPool(databaseUrl);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema},public`);
  const database = createPool(url.toString()), root = await mkdtemp(join(tmpdir(), 'pm-planning-records-'));
  const cores = new CoreWorkspacePool(join(root, 'core'), database), store = new LocalBlobStore(join(root, 'blobs'));
  t.after(async () => { await cores.close(); await database.end(); await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); await bootstrap.end(); await rm(root, { recursive: true, force: true }); });
  await migrate(database); await store.init();
  const owner = await createUser(database, { email: `${randomUUID()}@example.test`, name: 'Planning operator', password: 'isolated-planning-records-password' });
  const reviewer = await createUser(database, { email: `${randomUUID()}@example.test`, name: 'Human reviewer', password: 'isolated-planning-records-password' });
  const ws = await createWorkspace(database, owner.id, 'Planning records fixture'), workspace = await cores.get(ws.id);
  const project = await workspace.createEntity({ entity: 'project', title: 'Product', status: 'active' });
  const other = await workspace.createEntity({ entity: 'project', title: 'Outside explicit tool target' });
  const work = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Deliverable', body: 'Deliver this scope\n\n- [ ] Verified result' });
  const registry = { ...accessCommands, ...planningCommands, ...intentCommands, ...createDeliveryCommands(store) };
  async function coreFor(actor: Actor, sql: SqlExecutor = database): Promise<CoreAccess> {
    const scope = await authorizeCoreScope(sql, actor, ws.id, 'domain.read');
    return {
      handles: (id, kind) => kind ? isCoreEntityKind(kind) : /^[A-Z]/.test(id),
      async get(id, kind) { const item = readCoreEntity(workspace, scope, id); if (kind && item.kind !== kind) throw new DomainError('not_found_or_forbidden'); return item; },
      async list(kind) { return (await listCoreEntities(workspace, scope, { kind })).items; },
      async records() { return workspace.snapshot().files.filter(row => scope.allows(row)); },
      async sprintHistory() { return workspace.sprintHistory(); }, configuration: () => workspace.configuration().config,
    };
  }
  async function execute(actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) {
    if (!isCoreCommand(command.commandType)) return runCommand(database, actor, workspaceId, command, registry, sql => coreFor(actor, sql), undefined, checkAuthorization);
    const hash = requestHash(command as unknown as Record<string, unknown>), prior = await readExternalReceipt(database, actor, workspaceId, command.commandId, hash);
    if (prior) return prior;
    const scope = await authorizeCoreScope(database, actor, workspaceId, 'domain.read');
    const receipt = await executeCoreCommand({ workspace, scope, principal: actor, command, pool: database, ...(checkAuthorization ? { checkAuthorization } : {}) }, command.commandId);
    await recordExternalReceipt(database, actor, workspaceId, command, receipt);
    return receipt;
  }
  async function command(commandType: string, payload: Record<string, unknown>, targetId?: string, expectedVersions: Record<string, number> = {}, actor = owner) {
    const result = await execute(actor, ws.id, { commandId: randomUUID(), commandType, projectId: project.id, ...(targetId ? { targetId } : {}), expectedVersions, payload });
    assert.equal(result.status, 'committed', JSON.stringify(result)); return result.result as Record<string, Entity>;
  }
  const family = createPlanningRecordsToolFamily({ database: () => database, coreWorkspaces: cores, executeCommand: execute });
  function context(actor = owner): AgentChatToolContext { return { actor, workspaceId: ws.id, operationId: randomUUID(), threadId: randomUUID(), messageId: randomUUID(), scope: { kind: 'projects', projectIds: [project.id] } }; }
  const write = (payload: Record<string, unknown>, targetId: string | null = null, expectedVersions: { id: string; version: number }[] = []) => ({ projectId: project.id, targetId, expectedVersions, payload });
  const parse = (value: unknown) => PlanningRecordsToolResultSchema.parse(value);

  // Choose the explicit visible project after real service-generated UUIDs are known,
  // so the lower-ordered unauthorized project deterministically precedes its first row.
  const pagingRows: Entity[] = [];
  for (const projectId of [project.id, other.id]) {
    for (let index = 0; index < 2; index++) {
      const seeded = await execute(owner, ws.id, { commandId: randomUUID(), commandType: 'CreateConversation', projectId, payload: { title: `Pagination ${projectId} ${index}` } });
      assert.equal(seeded.status, 'committed'); pagingRows.push(seeded.result as Entity);
    }
  }
  pagingRows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hiddenProjectId = pagingRows[0]!.projectId!, visibleProjectId = hiddenProjectId === project.id ? other.id : project.id;
  const visibleRows = pagingRows.filter(row => row.projectId === visibleProjectId), hiddenRow = pagingRows[0]!;
  const pager = await createUser(database, { email: `${randomUUID()}@example.test`, name: 'Scoped page reader', password: 'isolated-planning-page-password' });
  const pagingGrant = await runCommand(database, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: pager.id, capabilities: ['domain.read'], projectIds: [project.id, other.id] } }, accessCommands);
  assert.equal(pagingGrant.status, 'committed');
  const pageContext: AgentChatToolContext = { ...context(pager), scope: { kind: 'projects', projectIds: [visibleProjectId] } };
  const pageInput = { resource: 'conversation', projectId: null, limit: 1, after: null };
  const firstPage = parse(await family.execute('pm_list_planning_records', pageInput, pageContext));
  if (firstPage.kind !== 'planning_records') throw new Error('Expected actual scoped conversation page');
  assert.deepEqual(firstPage.records.map(row => row.id), [visibleRows[0]!.id], 'invisible lower UUIDs cannot occupy the bounded page');
  const scopedCursor = firstPage.nextCursor; assert.ok(scopedCursor);
  const decodedCursor = JSON.parse(Buffer.from(scopedCursor, 'base64url').toString('utf8')) as { id: string; scopeHash: string };
  assert.equal(decodedCursor.id, visibleRows[0]!.id); assert.equal(decodedCursor.scopeHash.length, 64);
  await family.authorizeResult!('pm_list_planning_records', pageInput, firstPage, pageContext);
  const secondPage = parse(await family.execute('pm_list_planning_records', { ...pageInput, after: scopedCursor }, pageContext));
  if (secondPage.kind !== 'planning_records') throw new Error('Expected second authorized page');
  assert.deepEqual(secondPage.records.map(row => row.id), [visibleRows[1]!.id]); assert.equal(secondPage.nextCursor, null);
  const forgedCursor = Buffer.from(JSON.stringify({ ...decodedCursor, kind: 'conversation', projectId: null, visibility: 'visible', id: hiddenRow.id })).toString('base64url');
  await assert.rejects(family.execute('pm_list_planning_records', { ...pageInput, after: forgedCursor }, pageContext), { code: 'validation_failed' });
  await assert.rejects(family.authorizeResult!('pm_list_planning_records', pageInput, { ...firstPage, records: [], nextCursor: forgedCursor }, pageContext), { code: 'validation_failed' });
  await assert.rejects(family.execute('pm_list_planning_records', { ...pageInput, after: scopedCursor }, { ...pageContext, scope: { kind: 'projects', projectIds: [hiddenProjectId] } }), { code: 'validation_failed' });
  const nativePage = await listEntities(database, pager, ws.id, { kind: 'conversation', limit: 1 });
  assert.equal(nativePage.items[0]!.id, hiddenRow.id, 'native unscoped pagination still follows all current native membership projects');
  assert.ok(nativePage.nextCursor);
  const nativeCursor = JSON.parse(Buffer.from(nativePage.nextCursor, 'base64url').toString('utf8')) as { scopeHash?: string };
  assert.equal(nativeCursor.scopeHash, undefined, 'native cursor representation is unchanged');
  await assert.rejects(family.execute('pm_list_planning_records', { ...pageInput, after: nativePage.nextCursor }, pageContext), { code: 'validation_failed' });
  await assert.rejects(family.authorizeResult!('pm_list_planning_records', pageInput, { ...firstPage, records: [], nextCursor: nativePage.nextCursor }, pageContext), { code: 'validation_failed' });
  const pagingMember = await getMembership(database, pager, ws.id);
  const narrowedGrant = await runCommand(database, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [pager.id]: pagingMember.version }, payload: { userId: pager.id, capabilities: ['domain.read'], projectIds: [visibleProjectId] } }, accessCommands);
  assert.equal(narrowedGrant.status, 'committed');
  await assert.rejects(family.execute('pm_list_planning_records', { ...pageInput, after: scopedCursor }, pageContext), { code: 'validation_failed' });
  await assert.rejects(family.authorizeResult!('pm_list_planning_records', pageInput, firstPage, pageContext), { code: 'validation_failed' });
  const intersected = parse(await family.execute('pm_list_planning_records', { ...pageInput, limit: 20 }, { ...pageContext, scope: { kind: 'projects', projectIds: [visibleProjectId, hiddenProjectId] } }));
  if (intersected.kind !== 'planning_records') throw new Error('Expected native membership intersection');
  assert.deepEqual(intersected.records.map(row => row.id), visibleRows.map(row => row.id), 'stale explicit scope cannot restore revoked native access');
  const workspaceConversation = await execute(owner, ws.id, { commandId: randomUUID(), commandType: 'CreateConversation', payload: { title: 'Workspace-level pagination record' } });
  assert.equal(workspaceConversation.status, 'committed');
  const workspaceRow = workspaceConversation.result as Entity;
  const workspacePage = parse(await family.execute('pm_list_planning_records', { ...pageInput, limit: 20 }, { ...context(), scope: { kind: 'workspace', projectIds: [visibleProjectId] } }));
  if (workspacePage.kind !== 'planning_records') throw new Error('Expected workspace-level authorized records');
  assert.deepEqual(workspacePage.records.map(row => row.id).sort(), [...visibleRows.map(row => row.id), workspaceRow.id].sort(), 'workspace scope retains null-project records without admitting other projects');
  const projectPage = parse(await family.execute('pm_list_planning_records', { ...pageInput, limit: 20 }, { ...context(), scope: { kind: 'projects', projectIds: [visibleProjectId] } }));
  if (projectPage.kind !== 'planning_records') throw new Error('Expected narrowed project records');
  assert.deepEqual(projectPage.records.map(row => row.id), visibleRows.map(row => row.id), 'project scope excludes workspace-level records before pagination');
  const nativeWorkspacePage = await listEntities(database, owner, ws.id, { kind: 'conversation', limit: 20 });
  assert.equal(nativeWorkspacePage.items.length, pagingRows.length + 1, 'native workspace list still includes both native projects and workspace-level rows');

  const conversationContext = context(), conversationArgs = write({ title: 'Human requirements' });
  const conversation = parse(await family.execute('pm_create_conversation', conversationArgs, conversationContext));
  assert.equal(conversation.kind, 'planning_record_receipt');
  if (conversation.kind !== 'planning_record_receipt') throw new Error('Expected real conversation receipt');
  const discussion = conversation.records[0]!; assert.equal(discussion.resource, 'conversation'); assert.equal(discussion.createdBy, owner.id);
  const message = parse(await family.execute('pm_append_conversation_message', write({ content: 'Explicit source requirements' }, discussion.id, [{ id: discussion.id, version: discussion.version }]), context()));
  assert.equal(message.kind, 'planning_record_receipt');
  if (message.kind !== 'planning_record_receipt' || message.records[0]?.resource !== 'conversation') throw new Error('Expected authored message');
  const sourceMessage = message.records[0].messages[0]!; assert.equal(sourceMessage.authorId, owner.id);
  const proposed = parse(await family.execute('pm_propose_intent', write({ summary: 'Accepted product change', goal: 'Keep the actual authored source', conversationId: discussion.id, sourceMessageRefs: [{ messageId: sourceMessage.id, contentVersion: sourceMessage.contentVersion }] }), context()));
  if (proposed.kind !== 'planning_record_receipt' || proposed.records[0]?.resource !== 'intent') throw new Error('Expected intent');
  const intent = proposed.records[0];
  await assert.rejects(family.execute('pm_revise_intent', write({ summary: intent.summary, goal: intent.goal, revision: intent.revision + 1 }, intent.id, [{ id: intent.id, version: intent.version }]), context()));
  const accepted = parse(await family.execute('pm_accept_intent', write({ revision: intent.revision, reason: 'Explicit decider action', basisRefs: [] }, intent.id, [{ id: intent.id, version: intent.version }]), context()));
  if (accepted.kind !== 'planning_record_receipt') throw new Error('Expected decision receipt');
  const decision = accepted.records.find(row => row.resource === 'decision'); assert.ok(decision && decision.resource === 'decision'); assert.equal(decision.actorId, owner.id);
  const taskContext = context(), conversion = write({ title: 'Converted native task', description: 'Original intent and decision', acceptanceCriteria: [], intentId: intent.id, acceptedRevision: intent.revision, decisionId: decision.id });
  const created = parse(await family.execute('pm_create_task_from_intent', conversion, taskContext));
  if (created.kind !== 'planning_record_receipt') throw new Error('Expected conversion receipt');
  assert.ok(created.generatedTask?.id.startsWith('TASK-'));
  const recovered = parse(await family.recover('pm_create_task_from_intent', conversion, taskContext));
  if (recovered.kind !== 'planning_record_receipt') throw new Error('Expected original receipt');
  assert.equal(recovered.generatedTask?.id, created.generatedTask?.id);
  await assert.rejects(family.execute('pm_create_task_from_intent', conversion, context()), /rejected/);

  const uploaded = await command('StageUpload', { fileName: 'verification.txt', mediaType: 'text/plain', contentBase64: Buffer.from('real immutable verification').toString('base64') });
  const registered = await command('RegisterArtifact', { title: 'Verification', kind: 'test', uploadId: uploaded.upload!.id }, undefined, { [uploaded.upload!.id]: uploaded.upload!.version });
  const version = registered.artifactVersion!;
  const evidence = parse(await family.execute('pm_record_evidence', write({ subjectRefs: [work.id], method: 'Human-observed verification', scope: 'Exact delivery', result: 'pass', observedAt: new Date().toISOString(), artifactVersionRefs: [version.id] }), context()));
  if (evidence.kind !== 'planning_record_receipt' || evidence.records[0]?.resource !== 'evidence') throw new Error('Expected real evidence');
  const taskVersion = coreVersion(workspace.get(work.id).revision);
  const submission = parse(await family.execute('pm_submit_work_item_result', write({ contentRevision: taskVersion, artifactVersionIds: [version.id], evidenceIds: [evidence.records[0].id] }, work.id, [{ id: work.id, version: taskVersion }]), context()));
  if (submission.kind !== 'planning_record_receipt') throw new Error('Expected submission');
  const submitted = submission.records.find(row => row.resource === 'submission'); assert.ok(submitted && submitted.resource === 'submission');
  const largeTask = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Native long-scope task', body: `${'x'.repeat(65000)}\n\n- [ ] Retain immutable full scope` });
  const largeVersion = coreVersion(largeTask.revision);
  const largeSubmission = parse(await family.execute('pm_submit_work_item_result', write({ contentRevision: largeVersion, artifactVersionIds: [version.id], evidenceIds: [] }, largeTask.id, [{ id: largeTask.id, version: largeVersion }]), context()));
  if (largeSubmission.kind !== 'planning_record_receipt') throw new Error('Expected actual bounded long-scope submission');
  const largeSnapshot = largeSubmission.records.find(row => row.resource === 'submission'); assert.ok(largeSnapshot && largeSnapshot.resource === 'submission');
  assert.equal(largeSnapshot.snapshotTruncated, true); assert.equal(largeSubmission.truncated, true);
  assert.equal(largeSnapshot.workScopeSnapshot.description.length, 64000, 'model result is explicitly bounded without rejecting the committed native submission');
  assert.equal(workspace.get(work.id).entity.status, 'todo', 'submitting never completes or transitions the core task');
  await runCommand(database, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: reviewer.id, capabilities: ['domain.read', 'delivery.review'], projectIds: [project.id] } }, accessCommands);
  const reviewInput = { criterionResults: submitted.workScopeSnapshot.acceptanceCriteria.map(row => ({ criterionId: row.id, result: 'pass', basisRefs: [version.id], explanation: 'Actual human verification' })), verdict: 'passed', reason: 'Reviewed by separate authenticated human' };
  const review = await command('RecordReview', reviewInput, submitted.id, { [submitted.id]: submitted.version, [work.id]: taskVersion }, reviewer);
  assert.equal(review.review!.data.reviewerId, reviewer.id);
  const readReview = { resource: 'review', id: review.review!.id, messageOffset: 0, messageLimit: 20 }, reviewContext = context(reviewer);
  const storedReview = await family.execute('pm_read_planning_record', readReview, reviewContext);
  await family.authorizeResult!('pm_read_planning_record', readReview, storedReview, reviewContext);
  assert.equal(workspace.get(work.id).entity.status, 'todo', 'passing human review never marks task Done');
  const duplicateReview = await execute(reviewer, ws.id, { commandId: randomUUID(), commandType: 'RecordReview', projectId: project.id, targetId: submitted.id, expectedVersions: { [submitted.id]: submitted.version, [work.id]: taskVersion }, payload: reviewInput });
  assert.equal(duplicateReview.status, 'rejected'); assert.equal(duplicateReview.error?.code, 'review_already_recorded');
  assert.equal(Object.hasOwn(PlanningRecordsToolInputSchemas, 'pm_record_review'), false, 'model tool cannot impersonate human approval');
  const changed = await workspace.save(work.id, workspace.get(work.id).raw.replace('Deliver this scope', 'Changed human requirements'), workspace.get(work.id).revision);
  const staleReview = await execute(reviewer, ws.id, { commandId: randomUUID(), commandType: 'RecordReview', projectId: project.id, targetId: submitted.id, expectedVersions: { [submitted.id]: submitted.version, [work.id]: coreVersion(changed.revision) }, payload: reviewInput });
  assert.equal(staleReview.error?.code, 'submission_snapshot_mismatch');

  const roadmap = createProductRoadmapService({ database: () => database, coreWorkspaces: cores });
  const plan = emptyRoadmap(); for (const key of Object.keys(plan.brief) as (keyof typeof plan.brief)[]) plan.brief[key] = `Explicit ${key}`;
  const first = randomUUID(), second = randomUUID();
  plan.nodes = [{ id: first, title: 'Foundation', outcome: 'Working contract', acceptance: 'Contract persists', nonGoals: '', stage: 'Build', dependsOn: [], x: 0, y: 0 }, { id: second, title: 'Dependent feature', outcome: 'Integrated result', acceptance: 'Uses foundation', nonGoals: '', stage: 'Build', dependsOn: [first], x: 100, y: 100 }];
  const caller = { actor: owner, workspaceId: ws.id, projectId: project.id };
  const saved = await roadmap.act(caller, { action: 'save', commandId: randomUUID(), revision: workspace.get(project.id).revision, plan });
  const releaseId = randomUUID(), publish = { action: 'publish' as const, commandId: randomUUID(), revision: saved.revision, releaseId, confirm: true as const };
  await roadmap.act(caller, publish);
  const api = Fastify(); t.after(() => api.close());
  registerProductRoadmapRoutes(api, { database: () => database, coreWorkspaces: cores, actor: async () => owner });
  const inspectPath = `/api/v1/workspaces/${ws.id}/projects/${project.id}/product-roadmap/inspect`;
  const confirmedPublication = await api.inject({ method: 'POST', url: inspectPath, payload: publish });
  assert.equal(confirmedPublication.statusCode, 200, confirmedPublication.body);
  assert.equal(confirmedPublication.json().status, 'confirmed');
  const absentPublication = await api.inject({ method: 'POST', url: inspectPath, payload: { ...publish, commandId: randomUUID() } });
  assert.equal(absentPublication.json().status, 'unknown', 'absent native receipt is never proof of rejection or a reason to replay');
  const batchContext = context(), batch = { projectId: project.id, releaseId, nodeIds: [second], confirm: true };
  const mapped = parse(await family.execute('pm_materialize_roadmap', batch, batchContext));
  if (mapped.kind !== 'planning_roadmap') throw new Error('Expected dedicated roadmap result');
  assert.deepEqual(mapped.dependencyClosure, [first, second]); assert.equal(mapped.idMap.length, 2);
  const parent = mapped.idMap.find(row => row.nodeId === first)!, child = mapped.idMap.find(row => row.nodeId === second)!;
  assert.deepEqual(workspace.get(child.taskId).entity.blocked_by, [parent.taskId]);
  const same = parse(await family.execute('pm_materialize_roadmap', batch, context()));
  if (same.kind !== 'planning_roadmap') throw new Error('Expected original mapping');
  assert.deepEqual(same.idMap, mapped.idMap);
  assert.ok(await family.recover('pm_materialize_roadmap', batch, batchContext), 'no-write recovery proves original per-node journals');
  const beforeCount = workspace.items({ entity: 'work_item', project: project.id, archived: 'include' }).length;
  await roadmap.recover(caller, publish);
  assert.equal(workspace.items({ entity: 'work_item', project: project.id, archived: 'include' }).length, beforeCount);
  const draft = { ...plan, brief: { ...plan.brief, idea: 'Next draft, not an overwrite' } };
  const latest = await roadmap.read(owner, ws.id, project.id);
  const revised = await roadmap.act(caller, { action: 'save', commandId: randomUUID(), revision: latest.revision, plan: draft });
  assert.equal(revised.store.releases[0]!.plan.brief.idea, plan.brief.idea);
  await workspace.patch(parent.taskId, { title: 'Changed requirements' }, workspace.get(parent.taskId).revision);
  assert.equal((await roadmap.read(owner, ws.id, project.id)).tasks[releaseId]!.find(row => row.taskId === parent.taskId)!.drifted, true);
  assert.equal(workspace.get(child.taskId).entity.status, 'todo');
  await assert.rejects(family.execute('pm_read_roadmap', { projectId: other.id }, context()));
  const reviewerMembership = await getMembership(database, reviewer, ws.id);
  const revoked = await runCommand(database, owner, ws.id, { commandId: randomUUID(), commandType: 'SetWorkspaceMember', expectedVersions: { [reviewer.id]: reviewerMembership.version }, payload: { userId: reviewer.id, capabilities: [], projectIds: [project.id] } }, accessCommands);
  assert.equal(revoked.status, 'committed');
  await assert.rejects(family.execute('pm_read_planning_record', readReview, context(reviewer)));
  await assert.rejects(family.authorizeResult!('pm_read_planning_record', readReview, storedReview, reviewContext), 'stored approval history is withheld after current PM access revocation');
  await assert.rejects(family.authorizeResult!('pm_create_conversation', conversationArgs, conversation, { ...conversationContext, scope: { kind: 'projects', projectIds: [other.id] } }));
});
