import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { pmToolCallRecordSchema, type PmToolRequest } from '../../../packages/agent-contracts/src/pm-tools.ts';
import { taskBriefSchema } from '../../../packages/agent-contracts/src/task-brief.ts';
import type { AgentChatContextSource } from '../../../packages/agent-contracts/src/pm-tool-result.ts';
import type { FileRecord } from '../../../packages/pm-schema/index.ts';
import { parseBenchmarkConfig } from '../benchmark.config.ts';
import { createFixtureManager } from '../fixtures/manager.ts';
import { STANDARD_BODY } from './corpus.ts';

test('real PM brief preserves distinct current sources and partial-context flags, then rechecks saved-result visibility after a native authorization shrink', { timeout: 900_000 }, async () => {
  const manager = createFixtureManager(parseBenchmarkConfig());
  const fixture = await manager.reset({ runId: `brief-source-projection-${randomUUID()}` });
  try {
    const projectId = fixture.targets['beacon-receipt']!.projectId!;
    const core = `/api/v1/workspaces/${fixture.workspaceId}/core`;
    async function createTask(title: string, body: string, targetProjectId = projectId) {
      return manager.request<FileRecord>(fixture, `${core}/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'work_item', project: targetProjectId, title, body } });
    }
    const peer = await createTask('Migration decision', 'Current dependency: do not infer completion from a source reference.');
    const created = await createTask('Migration decision', STANDARD_BODY);
    const task = await manager.request<FileRecord>(fixture, `${core}/entities/${created.id}`, { method: 'PATCH', headers: { 'Idempotency-Key': randomUUID() }, body: { revision: created.revision, changes: { blocked_by: [peer.id] } } });
    const originalBody = task.entity.body;
    const toolBase = `/api/v1/workspaces/${fixture.workspaceId}/agent-tools`;
    async function readBrief(bodyLimit: number | null, cookie?: string) {
      const operation = pmToolCallRecordSchema.parse(await manager.request(fixture, `${toolBase}/call`, { method: 'POST', ...(cookie ? { headers: { cookie } } : {}), body: { operationId: randomUUID(), name: 'pm_task_brief', executionRoot: 'external', threadId: '', messageId: '', generationId: '', target: { workspaceId: fixture.workspaceId, projectId }, arguments: { projectId, taskId: task.id, revision: task.revision, stage: 'development', bodyOffset: null, bodyLimit } } }));
      assert.equal(operation.status, 'succeeded');
      if (operation.result?.kind !== 'task_brief') assert.fail('Expected a real authoritative PM brief result');
      const result = operation.result;
      const query = new URLSearchParams({ revision: task.revision, stage: 'development', ...(bodyLimit === null ? {} : { bodyLimit: String(bodyLimit) }) });
      const authoritative = taskBriefSchema.parse(await manager.request(fixture, `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectId}/tasks/${task.id}/brief?${query}`, cookie ? { headers: { cookie } } : {}));
      assert.deepEqual({ ...result.brief, generatedAt: '' }, { ...authoritative, generatedAt: '' }, 'Every original brief field, internal source occurrence and locator is unchanged, apart from the read timestamp');
      const originalMetadata: AgentChatContextSource[] = authoritative.sources.map(ref => ({ kind: ref.kind === 'work_item' ? 'task' : ref.kind, workspaceId: ref.workspaceId, projectId: ref.projectId, entityId: ref.entityId, title: ref.title, revision: ref.revision, truncated: authoritative.truncation.truncated }));
      // Independent full-value equality, not the production serialized-key implementation.
      const expected = originalMetadata.filter((item, index) => originalMetadata.findIndex(other => isDeepStrictEqual(item, other)) === index);
      assert.deepEqual(result.sources, expected, 'Retain the first occurrence in order and every non-equal source');
      assert.ok(originalMetadata.length > result.sources.length, 'Exercise actual repeated metadata, not an empty-source success');
      assert.ok(result.sources.some(source => source.entityId === task.id));
      assert.ok(result.sources.some(source => source.entityId === peer.id));
      assert.equal(result.nextCursor, null); assert.equal(result.truncated, result.brief.truncation.truncated);
      for (const statement of [...result.brief.goals, ...result.brief.acceptanceCriteria, ...result.brief.constraints, ...result.brief.nonGoals]) for (const source of statement.sourceRefs) {
        assert.equal(source.entityId, task.id); assert.equal(source.revision, task.revision);
        if (source.location.type === 'body') assert.equal(originalBody.slice(source.location.offset, source.location.offset + source.location.length), statement.text);
      }
      return result;
    }
    const full = await readBrief(null);
    assert.equal(full.brief.task.body, originalBody); assert.equal(full.brief.dispatchable, true);
    assert.ok(full.sources.every(source => source.truncated === false));
    assert.deepEqual(full.sources.filter(source => source.entityId === task.id).map(source => [source.title, source.revision]), [[task.entity.title, task.revision]]);
    assert.deepEqual(full.sources.filter(source => source.entityId === peer.id).map(source => [source.title, source.revision]), [[peer.entity.title, peer.revision]], 'Same-name objects retain distinct actual IDs/revisions');
    const partial = await readBrief(64);
    assert.equal(partial.brief.task.body, originalBody.slice(0, 64)); assert.equal(partial.brief.dispatchable, false); assert.equal(partial.brief.truncation.body, true);
    assert.ok(partial.sources.every(source => source.truncated === true), 'A truncated read cannot reuse or merge untruncated metadata');
    assert.equal(partial.brief.constraints[0]?.text, full.brief.constraints[0]?.text, 'Off-page negative constraints remain in the inner brief');
    const changed = await manager.request<FileRecord>(fixture, `${core}/entities/${peer.id}`, { method: 'PATCH', headers: { 'Idempotency-Key': randomUUID() }, body: { revision: peer.revision, changes: { title: 'Migration decision — revised dependency' } } });
    const revised = await readBrief(null);
    assert.notEqual(changed.revision, peer.revision);
    assert.deepEqual(revised.sources.filter(source => source.entityId === peer.id).map(source => [source.title, source.revision]), [[changed.entity.title, changed.revision]], 'Fresh title/revision metadata survives the same service projection');
    assert.ok(!revised.sources.some(source => source.entityId === peer.id && source.revision === peer.revision));
    assert.ok(revised.brief.relations.some(relation => relation.target.entityId === peer.id && relation.target.revision === changed.revision));
    const reader = await manager.provisionProjectReader(fixture, { projectIds: [projectId] });
    const restricted = await readBrief(null, reader.cookie);
    assert.deepEqual(restricted.sources, revised.sources, 'The common projection preserves the same currently authorized source set for a real project-limited member');
    const after = await manager.request<FileRecord>(fixture, `${core}/files/${task.id}`);
    assert.equal(after.raw, task.raw); assert.equal(after.revision, task.revision);

    // A real two-project grant shrinks through the native versioned membership command.
    // The raw brief initially has a cross-project source; no workspace-wide or write grant is needed.
    const otherProjectId = fixture.targets['atlas-plan']!.projectId!;
    assert.notEqual(otherProjectId, projectId);
    const revokedText = 'AUTHORIZATION-SHRINK-PRIVATE-SOURCE: never disclose this dependency after its project grant is removed.';
    const crossPeer = await createTask('Authorization shrink decision', revokedText, otherProjectId);
    const crossCreated = await createTask('Authorization shrink decision', STANDARD_BODY);
    const crossTask = await manager.request<FileRecord>(fixture, `${core}/entities/${crossCreated.id}`, { method: 'PATCH', headers: { 'Idempotency-Key': randomUUID() }, body: { revision: crossCreated.revision, changes: { blocked_by: [crossPeer.id] } } });
    const shrinkingReader = await manager.provisionProjectReader(fixture, { projectIds: [projectId, otherProjectId] });
    const readerHeaders = { cookie: shrinkingReader.cookie };
    const crossBriefRoute = `/api/v1/workspaces/${fixture.workspaceId}/projects/${projectId}/tasks/${crossTask.id}/brief?${new URLSearchParams({ revision: crossTask.revision, stage: 'development' })}`;
    const expanded = taskBriefSchema.parse(await manager.request(fixture, crossBriefRoute, { headers: readerHeaders }));
    assert.ok(expanded.sources.some(source => source.entityId === crossTask.id && source.revision === crossTask.revision));
    assert.ok(expanded.sources.some(source => source.entityId === crossPeer.id && source.projectId === otherProjectId && source.revision === crossPeer.revision), 'The pre-shrink brief really contains the related same-name source from the second authorized project');
    function briefRequest(source: FileRecord): PmToolRequest {
      const sourceProjectId = String(source.entity.project);
      return { operationId: randomUUID(), name: 'pm_task_brief', executionRoot: 'external', threadId: '', messageId: '', generationId: '', target: { workspaceId: fixture.workspaceId, projectId: sourceProjectId }, arguments: { projectId: sourceProjectId, taskId: source.id, revision: source.revision, stage: 'development', bodyOffset: null, bodyLimit: null } };
    }
    const originalRequest = briefRequest(crossPeer);
    const original = pmToolCallRecordSchema.parse(await manager.request(fixture, `${toolBase}/call`, { method: 'POST', headers: readerHeaders, body: originalRequest }));
    assert.equal(original.status, 'succeeded');
    if (original.result?.kind !== 'task_brief') assert.fail('Expected an actual pre-shrink tool operation');
    assert.deepEqual(original.commandIds, []);
    const members = await manager.request<{ userId: string; version: number; projectIds: string[] | null; capabilities: string[] }[]>(fixture, `/api/v1/workspaces/${fixture.workspaceId}/members`);
    const member = members.find(candidate => candidate.userId === shrinkingReader.actorId);
    assert.ok(member);
    assert.deepEqual(member.projectIds, [projectId, otherProjectId]); assert.deepEqual(member.capabilities, ['domain.read']);
    const shrinkCommandId = randomUUID();
    const shrink = await manager.request<{ status: string }>(fixture, `/api/v1/workspaces/${fixture.workspaceId}/commands`, { method: 'POST', body: { commandId: shrinkCommandId, commandType: 'SetWorkspaceMember', targetId: shrinkingReader.actorId, expectedVersions: { [shrinkingReader.actorId]: member.version }, payload: { userId: shrinkingReader.actorId, capabilities: ['domain.read'], projectIds: [projectId] } } });
    assert.equal(shrink.status, 'committed');
    const shrunk = await manager.snapshot(fixture);
    const currentMember = shrunk.tables.memberships?.find(row => row.user_id === shrinkingReader.actorId);
    assert.deepEqual(currentMember?.project_ids, [projectId]); assert.equal(currentMember?.version, member.version + 1);
    assert.deepEqual(currentMember?.capabilities, ['domain.read']);
    const historicalResponse = await fetch(`${fixture.pm.baseUrl}${toolBase}/result`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { ...readerHeaders, 'content-type': 'application/json' }, body: JSON.stringify(originalRequest) });
    const historicalBody = await historicalResponse.text();
    assert.equal(historicalResponse.status, 404, 'A saved successful operation is not a retained read grant after project authorization shrinks');
    const historicalError: unknown = JSON.parse(historicalBody);
    assert.ok(historicalError && typeof historicalError === 'object' && 'error' in historicalError);
    assert.ok(historicalError.error && typeof historicalError.error === 'object' && 'code' in historicalError.error);
    assert.equal(historicalError.error.code, 'not_found_or_forbidden');
    const currentRequest = briefRequest(crossTask);
    const current = pmToolCallRecordSchema.parse(await manager.request(fixture, `${toolBase}/call`, { method: 'POST', headers: readerHeaders, body: currentRequest }));
    assert.equal(current.status, 'succeeded');
    if (current.result?.kind !== 'task_brief') assert.fail('Expected a current authorized task brief');
    const narrowed = taskBriefSchema.parse(await manager.request(fixture, crossBriefRoute, { headers: readerHeaders }));
    assert.equal(current.result.brief.task.revision, crossTask.revision);
    assert.equal(narrowed.task.body, crossTask.entity.body);
    assert.ok(narrowed.sources.every(source => source.projectId === projectId));
    assert.ok(current.result.sources.every(source => source.projectId === projectId));
    for (const payload of [historicalBody, JSON.stringify(current.result), JSON.stringify(narrowed)]) {
      for (const forbidden of [crossPeer.id, crossPeer.revision, otherProjectId, revokedText]) assert.ok(!payload.includes(forbidden), 'Neither old result access nor fresh inner/outer brief sources may reveal the removed project');
    }
    const final = await manager.snapshot(fixture);
    assert.deepEqual(final.entities, shrunk.entities, 'Permission revalidation and fresh briefs do not mutate any business source');
    for (const table of ['command_receipts', 'project_audit', 'service_fact_events', 'change_history_entries']) assert.deepEqual(final.tables[table], shrunk.tables[table], `No extra business write or dispatch in ${table}`);
    const savedBefore = shrunk.tables.pm_agent_tool_operations?.find(row => row.operation_id === originalRequest.operationId);
    const savedAfter = final.tables.pm_agent_tool_operations?.find(row => row.operation_id === originalRequest.operationId);
    assert.equal(savedBefore?.status, 'succeeded');
    assert.deepEqual(savedAfter, savedBefore, 'Denied visibility never rewrites the original successful operation fact');
    const priorOperations = new Set(shrunk.tables.pm_agent_tool_operations?.map(row => row.operation_id));
    assert.deepEqual(final.tables.pm_agent_tool_operations?.filter(row => !priorOperations.has(row.operation_id)).map(row => [row.operation_id, row.name]), [[currentRequest.operationId, 'pm_task_brief']], 'Only the explicitly requested new read operation is created');
    assert.deepEqual(current.commandIds, []); assert.equal(current.result.receipt, undefined);
  } finally { await manager.destroy(fixture); }
});
