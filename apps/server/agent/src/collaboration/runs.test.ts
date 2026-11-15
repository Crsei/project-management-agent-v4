import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { pmReferenceResolveRequestSchema } from '@agent-workspace/contracts/pm-references';
import { collaborationDelegationSchema, defaultCollaborationResourceLimits, type AgentConfig, type CreateRun } from '@agent-workspace/contracts/collaboration';
import type { TaskBrief } from '@agent-workspace/contracts/task-brief';
import type { PmToolCallRecord } from '@agent-workspace/contracts/pm-tools';
import { pmToolRequestSchema } from '@agent-workspace/contracts/pm-tools';
import { openAgentWorkspace } from '../agent-workspaces.ts';
import { codexAdapter } from '../providers/drivers/codex.ts';
import { createProviderInstance } from '../providers/instances.ts';
import { startPmProviderApplication, stopPmProviderApplication } from '../providers/t3code/application.ts';
import { providerApplicationOptions } from '../providers/t3code/production.ts';
import { chatRequestIdentity, getChatGeneration, lookupChatSubmission, stopChatRuntime } from '../durable/chat-runtime.ts';
import { closeStore, getDatabase, listRecords, readRecord, writeRecord } from '../durable/store.ts';
import { getStoreIdentity } from '../durable/persistence-schema.ts';
import { getThread } from '../durable/threads.ts';
import { beginThreadDeletion, commitThreadDeletion } from '../durable/thread-lifecycle.ts';
import { COLLABORATION_RUNS } from './coordinator.ts';
import { createAgentDefinition, createTeamDefinition, updateAgentDefinition } from './definitions.ts';
import { cancelCollaborationRun, createCollaborationRun, getCollaborationGenerationContext, getCollaborationNativeOutput, invokeCollaborationTool, listCollaborationDelegations, listCollaborationRunsForInbox, projectCollaborationResultRefs, readCollaborationRun, startCollaborationRuntime, stopCollaborationRuntime, waitForCollaborationRunTerminal } from './runs.ts';

const actorId = '10000000-0000-4000-8000-000000000001';
const target = { workspaceId: '20000000-0000-4000-8000-000000000001', projectId: 'PRJ-001', taskId: 'TASK-001', taskRevision: 'a'.repeat(64) };

test('real Chat/SQLite Run closure: asynchronous deduped delegation, serial Team handoff, revision guard and observed tree cancellation', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'collaboration-runs-'));
  const oldEnvironment = { directory: process.env.AGENT_WORKSPACE_DATA_DIR, roots: process.env.AGENT_WORKSPACE_ALLOWED_ROOTS, pm: process.env.PM_API_URL, secret: process.env.PM_AUTOMATION_SERVICE_SECRET };
  const originalFetch = globalThis.fetch, originalCheck = codexAdapter.check, originalRun = codexAdapter.run;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  process.env.PM_API_URL = 'http://127.0.0.1:1';
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-run-test-not-a-production-secret'.repeat(4);
  const records = new Map<string, PmToolCallRecord>();
  let revision = target.taskRevision;
  let mode: 'delegate' | 'sequential' | 'cancel' | 'revision' | 'budget' | 'disabled' | 'source-revoked' = 'delegate';
  let denyRelated = false;
  const privateRelatedText = 'private-related-project-B-output';
  let sawActualResponse = false, nativeActive = 0, maximumNativeActive = 0;
  const childStarted = Promise.withResolvers<void>();
  let pendingAuthorization: { entered: () => void; release: Promise<void> } | null = null;
  globalThis.fetch = async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/api/v1/agent-contexts/authorize') {
      const barrier = pendingAuthorization; pendingAuthorization = null;
      if (barrier) { barrier.entered(); await barrier.release; }
      const scope = z.object({ workspaceId: z.string(), projectId: z.string().nullable() }).parse(body);
      if (scope.projectId === 'PRJ-002' && denyRelated) return Response.json({ error: 'permission_denied' }, { status: 403 });
      return Response.json({ actorId, scope: body });
    }
    if (url.pathname.includes('/core/files/')) {
      const task = url.pathname.endsWith(target.taskId);
      return Response.json({ id: task ? target.taskId : target.projectId, revision: task ? revision : 'b'.repeat(64), entity: { entity: task ? 'work_item' : 'project', ...(task ? { project: target.projectId } : {}) } });
    }
    if (url.pathname.endsWith('/agent-references/resolve')) {
      const { references } = pmReferenceResolveRequestSchema.parse(body);
      return Response.json({ items: references.map(reference => ({ ...reference, title: 'Isolated task', revision, availability: 'available', reason: null })) });
    }
    if (url.pathname.endsWith('/brief')) {
      const text = 'Change the isolated artifact, then review the exact same directory. Final constraint: do not mark the Issue complete.';
      const brief: TaskBrief = { schemaVersion: 1, stage: 'development', generatedAt: new Date().toISOString(),
        task: { workspaceId: target.workspaceId, projectId: target.projectId, taskId: target.taskId, revision, title: 'Isolated task', body: text, bodyOffset: 0, bodyLength: text.length, nextBodyOffset: null },
        goals: [], acceptanceCriteria: [], constraints: [], nonGoals: [], relations: [], guidance: [],
        sources: mode === 'source-revoked' ? [{ workspaceId: target.workspaceId, projectId: 'PRJ-002', entityId: 'TASK-002', kind: 'work_item', revision: 'b'.repeat(64), title: 'Related source', location: { type: 'body', offset: 0, length: 10 } }] : [], gaps: [],
        truncation: { truncated: false, body: false, statements: false, relations: false, message: null }, dispatchable: true, authorityNotice: 'Controlled PM source' };
      return Response.json(brief);
    }
    if (url.pathname.endsWith('/call') || url.pathname.endsWith('/result')) {
      const operation = pmToolRequestSchema.parse(body);
      if (!records.has(operation.operationId)) {
        assert.equal(url.pathname.endsWith('/call'), true, 'result lookup never dispatches a missing operation');
        const commentId = randomUUID();
        records.set(operation.operationId, { operationId: operation.operationId, name: operation.name, actorId, threadId: operation.threadId,
          messageId: operation.messageId, generationId: operation.generationId, workspaceId: target.workspaceId, target: operation.target,
          status: 'succeeded', error: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), linkage: operation.linkage!,
          result: { kind: 'comment', items: [{ id: commentId, taskId: target.taskId, projectId: target.projectId, authorId: actorId, version: 1, deletedAt: null,
            content: z.object({ content: z.string() }).parse(operation.arguments).content, origin: { ...operation.linkage!.collaboration!, operationId: operation.operationId, threadId: operation.threadId, generationId: operation.generationId } }],
            nextCursor: null, truncated: false, sources: [], receipt: { kind: 'command', commandId: operation.operationId, operationId: operation.operationId,
              action: 'CreateTaskComment', targetId: commentId, revision: '1', linkage: operation.linkage! } } });
      }
      return Response.json(records.get(operation.operationId));
    }
    throw new Error(`Unexpected isolated PM request: ${url.pathname}`);
  };
  try {
    await startPmProviderApplication(providerApplicationOptions);
    const workspace = openAgentWorkspace({ path: directory, name: 'Real temporary Run directory' });
    createProviderInstance({ instanceId: 'collaboration-controlled', driver: 'codex', label: 'Controlled Run fixture', config: { binaryPath: join(directory, 'not-a-real-cli'), homePath: join(directory, 'native-home') }, environment: [] });
    codexAdapter.check = async () => ({ installation: { status: 'installed', checkedAt: new Date().toISOString() }, authentication: 'authenticated', nativeSessionReady: true,
      models: [{ id: 'controlled-model', label: 'Controlled model', source: 'discovered', temperature: false }], methods: [], canLogout: false,
      capabilities: { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: 'native', portableHandoff: true } });
    codexAdapter.run = async (context, options) => {
      nativeActive++; maximumNativeActive = Math.max(maximumNativeActive, nativeActive);
      try {
        assert.equal(context.cwd, directory);
        const generationId = context.execution!.generationId;
        const binding = getCollaborationGenerationContext(generationId)!;
        assert.ok(binding);
        const provenance = readRecord<{ generationId: string; messageIds: string[] }>('pm-content-provenance', generationId);
        assert.equal(provenance?.generationId, generationId, 'actual accepted provenance must exist before the native Provider can start');
        assert.ok(binding.inputMessageId && provenance?.messageIds.includes(binding.inputMessageId));
        if (binding.agentId !== 'reviewer' && options.prompt.includes('Actual server-observed child responses')) {
          assert.ok(options.prompt.includes('reviewed exact artifact'));
          sawActualResponse = true;
        } else if (binding.agentId !== 'reviewer') {
          await writeFile(join(context.cwd, 'artifact.txt'), 'actual isolated code version');
          if (mode === 'delegate' || mode === 'cancel') {
            const invocation = { generationId, callId: 'original-provider-tool-call', tool: 'delegate_task' as const,
              arguments: { agentId: 'reviewer', agentVersion: 1, goal: 'Review exact artifact', input: 'Read the actual artifact in the inherited directory.' } };
            const accepted = await invokeCollaborationTool(invocation);
            const duplicate = await invokeCollaborationTool(invocation);
            assert.equal(duplicate.delegationId, accepted.delegationId); assert.equal(duplicate.childRunId, accepted.childRunId);
            assert.equal(accepted.asynchronous, true); assert.equal(accepted.status, 'queued');
            await assert.rejects(invokeCollaborationTool({ ...invocation, arguments: { ...invocation.arguments, goal: 'Different request' } }), { code: 'delegation_idempotency_conflict' });
          }
          if (mode === 'budget' || mode === 'disabled') {
            const rejected = { generationId, callId: 'rejected-original-call', tool: 'delegate_task' as const,
              arguments: { agentId: 'reviewer', agentVersion: 1, goal: 'Must not create a child', input: '' } };
            const code = mode === 'budget' ? 'run_limit' : 'definition_not_active';
            await assert.rejects(invokeCollaborationTool(rejected), { code });
            await assert.rejects(invokeCollaborationTool(rejected), { code });
          }
          if (mode === 'revision') revision = 'c'.repeat(64);
          if (mode === 'source-revoked') denyRelated = true;
        } else {
          assert.equal(await readFile(join(context.cwd, 'artifact.txt'), 'utf8'), 'actual isolated code version');
          if (mode === 'delegate') await assert.rejects(invokeCollaborationTool({ generationId, callId: 'cycle', tool: 'ask_agent', arguments: { agentId: 'developer', agentVersion: 1, goal: 'Invalid ancestor cycle', input: '' } }), { code: 'delegation_cycle' });
          if (mode === 'cancel') {
            childStarted.resolve();
            const aborted = Promise.withResolvers<never>();
            const onAbort = () => aborted.reject(new Error('Controlled child stopped'));
            options.signal!.addEventListener('abort', onAbort, { once: true });
            try { options.signal!.throwIfAborted(); await aborted.promise; } finally { options.signal!.removeEventListener('abort', onAbort); }
          }
        }
        const text = mode === 'source-revoked' ? privateRelatedText : binding.agentId === 'reviewer' ? 'reviewed exact artifact' : 'developer observed result';
        options.onText?.(text);
        options.onEvent?.({ type: 'item.upsert', item: { id: 'actual-native-final', type: 'assistant_message', status: 'completed', phase: 'final_answer', text } });
        return { text };
      } finally { nativeActive--; }
    };
    const authority = { workspaceId: target.workspaceId, actorId };
    const config: AgentConfig = { name: 'Developer', role: 'Developer', instructions: 'Work only on the explicit isolated task.', providerInstanceId: 'collaboration-controlled', model: 'controlled-model',
      modelOptions: [], interactionMode: 'default', temperature: 1, owner: { label: 'Fixture', actorId }, allowedProjectIds: [target.projectId],
      capabilityBindings: { restriction: 'observe', mcp: [], skills: [], hostTools: ['delegate_task', 'ask_agent'] }, resourceLimits: { ...defaultCollaborationResourceLimits, maxDurationMs: 30_000 }, executionMode: 'write' };
    createAgentDefinition({ id: 'developer', requestId: 'create-developer', workspaceId: target.workspaceId, config }, authority);
    createAgentDefinition({ id: 'reviewer', requestId: 'create-reviewer', workspaceId: target.workspaceId, config: { ...config, name: 'Reviewer', role: 'Reviewer' } }, authority);
    const headers = new Headers({ cookie: 'pm_v4_session=isolated-run' });
    const makeRequest = (): CreateRun => ({ id: randomUUID(), requestId: randomUUID(), target, definition: { kind: 'agent', agentId: 'developer', agentVersion: 1 },
      executionSelection: { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision }, goal: 'Implement and review isolated artifact', input: '' });
    await t.test('real generations and child result return; original keys never dispatch twice', async () => {
      const request = makeRequest();
      const accepted = await createCollaborationRun(request, headers);
      assert.equal((await createCollaborationRun(request, headers)).id, accepted.id);
      await assert.rejects(createCollaborationRun({ ...request, input: 'changed' }, headers), { code: 'run_idempotency_conflict' });
      const completed = await waitForCollaborationRunTerminal(accepted.id);
      assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
      assert.equal(sawActualResponse, true); assert.equal(maximumNativeActive, 1);
      const delegations = listCollaborationDelegations(accepted.id);
      assert.equal(delegations.length, 1); assert.equal(delegations[0]!.status, 'succeeded'); assert.ok(delegations[0]!.responsePublishedAt);
      assert.ok(delegations[0]!.childRunId);
      const rejection = listCollaborationDelegations(delegations[0]!.childRunId).find(item => item.childRunId === null)!;
      assert.equal(rejection.error?.code, 'delegation_cycle');
      assert.equal(collaborationDelegationSchema.safeParse({ ...rejection, status: 'queued' }).success, false);
      for (const operation of completed.operationRefs.filter(item => item.kind === 'chat_acceptance')) assert.equal(lookupChatSubmission(completed.threadId!, operation.operationId).status, 'accepted');
      assert.ok(completed.resultRefs.every(result => getChatGeneration(result.generationId)?.status === 'completed'));
      const deletionId = randomUUID(), thread = getThread(completed.threadId!)!;
      const deletion = beginThreadDeletion(completed.threadId!, deletionId, { lifecycleRevision: thread.lifecycleRevision ?? 0, confirm: true, expectedGenerationId: null, stopActive: false }, null);
      assert.equal(deletion.state, 'stopping');
      assert.equal(commitThreadDeletion(completed.threadId!, deletionId).state, 'committed');
      assert.equal(getThread(completed.threadId!), null);
      const retained = await getCollaborationNativeOutput(completed.id, completed.generationId!, headers);
      assert.equal(retained.status, 'completed'); assert.ok(retained.items.some(item => item.text === 'developer observed result'));
      assert.equal(getThread(completed.threadId!), null, 'Run evidence projection never resurrects a deleted Session');
    });
    await t.test('Sequential Team actually executes and hands off the same directory result', async () => {
      mode = 'sequential';
      createTeamDefinition({ id: 'sequential-team', requestId: 'create-sequential-team', workspaceId: target.workspaceId,
        config: { name: 'Sequential fixture', description: '', members: [{ agentId: 'developer', agentVersion: 1 }, { agentId: 'reviewer', agentVersion: 1 }], strategy: 'sequential', supervisorAgentId: null,
          allowedProjectIds: [target.projectId], resourceLimits: config.resourceLimits } }, authority);
      const accepted = await createCollaborationRun({ ...makeRequest(), definition: { kind: 'team', teamId: 'sequential-team', teamVersion: 1 } }, headers);
      const completed = await waitForCollaborationRunTerminal(accepted.id);
      assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
      assert.equal(listCollaborationDelegations(accepted.id).length, 1);
      assert.ok(completed.resultRefs.some(result => result.summary === 'reviewed exact artifact'));
    });
    await t.test('Supervisor Team uses its fixed supervisor and real bounded child execution', async () => {
      mode = 'delegate'; sawActualResponse = false;
      createTeamDefinition({ id: 'supervisor-team', requestId: 'create-supervisor-team', workspaceId: target.workspaceId,
        config: { name: 'Supervisor fixture', description: '', members: [{ agentId: 'developer', agentVersion: 1 }, { agentId: 'reviewer', agentVersion: 1 }], strategy: 'supervisor', supervisorAgentId: 'developer',
          allowedProjectIds: [target.projectId], resourceLimits: config.resourceLimits } }, authority);
      const accepted = await createCollaborationRun({ ...makeRequest(), definition: { kind: 'team', teamId: 'supervisor-team', teamVersion: 1 } }, headers);
      const completed = await waitForCollaborationRunTerminal(accepted.id);
      assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
      assert.equal(sawActualResponse, true);
      assert.equal(listCollaborationDelegations(accepted.id).length, 1);
    });
    await t.test('revoking a linked source withholds the retained private summary from shared PM comments', async () => {
      mode = 'source-revoked'; denyRelated = false;
      try {
        const accepted = await createCollaborationRun(makeRequest(), headers);
        const completed = await waitForCollaborationRunTerminal(accepted.id);
        assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
        assert.equal(completed.resultRefs.at(-1)?.summary, privateRelatedText, 'retained private evidence remains the original fact');
        const visible = await projectCollaborationResultRefs(completed.resultRefs, completed.rootRunId, headers);
        assert.equal(visible.at(-1)?.summary, null);
        assert.notEqual(visible.at(-1)?.visibility, 'visible');
        const published = completed.operationRefs.filter(item => item.kind === 'comment').flatMap(item => {
          const record = records.get(item.operationId);
          return record?.result?.kind === 'comment' ? record.result.items.map(comment => comment.content ?? '') : [];
        }).join('\n');
        assert.ok(published.includes('withheld'));
        assert.equal(published.includes(privateRelatedText), false);
      } finally { denyRelated = false; }
    });
    await t.test('exhausted total budget is a durable rejected call, not a fake child or success', async () => {
      mode = 'budget';
      createAgentDefinition({ id: 'limited-developer', requestId: 'create-limited-developer', workspaceId: target.workspaceId,
        config: { ...config, resourceLimits: { ...config.resourceLimits, maxRuns: 1 } } }, authority);
      const accepted = await createCollaborationRun({ ...makeRequest(), definition: { kind: 'agent', agentId: 'limited-developer', agentVersion: 1 } }, headers);
      const completed = await waitForCollaborationRunTerminal(accepted.id);
      assert.equal(completed.status, 'failed');
      const attempts = listCollaborationDelegations(accepted.id);
      assert.equal(attempts.length, 1); assert.equal(attempts[0]!.childRunId, null); assert.equal(attempts[0]!.error?.code, 'run_limit');
    });
    await t.test('disabled target cannot gain a child by replaying its rejected original call', async () => {
      mode = 'disabled';
      updateAgentDefinition('reviewer', { requestId: 'disable-reviewer', revision: 1, state: 'disabled' }, authority);
      const accepted = await createCollaborationRun(makeRequest(), headers);
      const completed = await waitForCollaborationRunTerminal(accepted.id);
      assert.equal(completed.status, 'failed');
      const attempts = listCollaborationDelegations(accepted.id);
      assert.equal(attempts.length, 1); assert.equal(attempts[0]!.childRunId, null); assert.equal(attempts[0]!.error?.code, 'definition_not_active');
      updateAgentDefinition('reviewer', { requestId: 'enable-reviewer', revision: 2, state: 'active' }, authority);
    });
    await t.test('task revision drift refuses further work and does not report business success', async () => {
      mode = 'revision';
      const accepted = await createCollaborationRun(makeRequest(), headers);
      const completed = await waitForCollaborationRunTerminal(accepted.id);
      assert.equal(completed.status, 'failed');
      assert.equal(completed.error?.code, 'task_revision_changed');
      revision = target.taskRevision;
    });
    await t.test('parent cancellation waits for a real active child stop and records both terminals', async () => {
      mode = 'cancel';
      const accepted = await createCollaborationRun(makeRequest(), headers);
      await childStarted.promise;
      const parent = readCollaborationRun(accepted.id)!;
      const cancelled = await cancelCollaborationRun(parent.id, { requestId: randomUUID(), revision: parent.revision, generationId: parent.generationId }, headers);
      assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.cancellation?.observedAt);
      const child = listCollaborationDelegations(parent.id)[0]!;
      assert.ok(child.childRunId);
      assert.equal(readCollaborationRun(child.childRunId)?.status, 'cancelled');
      assert.equal(getChatGeneration(readCollaborationRun(child.childRunId)!.generationId!)?.status, 'cancelled');
      assert.equal(nativeActive, 0);
    });
    await t.test('shutdown drains pending admission and explicit restart accepts only new work', async () => {
      mode = 'sequential';
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      pendingAuthorization = { entered: entered.resolve, release: release.promise };
      const original = makeRequest();
      const rejected = assert.rejects(createCollaborationRun(original, headers), { code: 'collaboration_stopping' });
      await entered.promise;
      let stopped = false;
      const shutdown = stopCollaborationRuntime().then(() => { stopped = true; });
      try {
        const turn = Promise.withResolvers<void>(); setImmediate(turn.resolve); await turn.promise;
        assert.equal(stopped, false, 'Shutdown must retain the pending original admission barrier.');
      } finally { release.resolve(); await rejected; await shutdown; }
      assert.equal(readCollaborationRun(original.id), null, 'A pre-shutdown request must not cross into the next lifecycle.');
      await assert.rejects(createCollaborationRun(makeRequest(), headers), { code: 'collaboration_stopping' });
      await startCollaborationRuntime({ newLifecycle: true });
      const fresh = await createCollaborationRun(makeRequest(), headers);
      assert.equal((await waitForCollaborationRunTerminal(fresh.id)).status, 'succeeded');
    });
    await t.test('fresh-process startup marks an accepted queued checkpoint interrupted without replay', async () => {
      const source = listCollaborationRunsForInbox().find(run => run.parentRunId === null)!;
      const before = listRecords('chat:generations').length;
      const identity = getStoreIdentity(getDatabase());
      for (const [submissionId, restoreEpoch] of [['safe-original', identity.restoreEpoch], ['uncertain-original', identity.restoreEpoch + 1]] as const) {
        const threadId = 'never-accepted-thread';
        writeRecord('chat:requests', chatRequestIdentity({ id: threadId, idempotencyKey: submissionId, messages: [] }), {
          version: 1, threadId, submissionId, inputMessageId: `input:${submissionId}`, fingerprint: 'e'.repeat(64),
          state: 'resolving', storeId: identity.storeId, restoreEpoch,
        });
      }
      writeRecord(COLLABORATION_RUNS, 'restart-checkpoint', { ...source, id: 'restart-checkpoint', rootRunId: 'restart-checkpoint', revision: 1,
        requestId: 'restart-checkpoint', parentRunId: null, delegationId: null, status: 'queued', threadId: null, generationId: null, inputMessageId: null,
        operationRefs: [], resultRefs: [], cancellation: null, error: null, finishedAt: null, startedAt: null });
      await stopCollaborationRuntime(); await stopChatRuntime(); closeStore();
      const runtimeUrl = new URL('../durable/chat-runtime.ts', import.meta.url).href;
      const storeUrl = new URL('../durable/store.ts', import.meta.url).href;
      const runsUrl = new URL('./runs.ts', import.meta.url).href;
      const code = `import {startChatRuntime,stopChatRuntime,lookupChatSubmission} from ${JSON.stringify(runtimeUrl)};
        import {startCollaborationRuntime,stopCollaborationRuntime,readCollaborationRun} from ${JSON.stringify(runsUrl)};
        import {listRecords,closeStore} from ${JSON.stringify(storeUrl)};
        let network = 0; globalThis.fetch = async () => { network++; throw new Error('Recovery must not contact PM or a Provider'); };
        await startChatRuntime(); await startCollaborationRuntime();
        const run=readCollaborationRun('restart-checkpoint'); const generations=listRecords('chat:generations').length;
        const safe=lookupChatSubmission('never-accepted-thread','safe-original').status, uncertain=lookupChatSubmission('never-accepted-thread','uncertain-original').status;
        await stopCollaborationRuntime(); await stopChatRuntime(); closeStore();
        console.log(JSON.stringify({status:run.status,threadId:run.threadId,generationId:run.generationId,generations,network,safe,uncertain}));`;
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PM_AUTOMATION_SERVICE_SECRET: '' }, timeout: 15_000 });
      assert.deepEqual(JSON.parse(result.stdout.trim()), { status: 'interrupted', threadId: null, generationId: null, generations: before, network: 0, safe: 'not_accepted', uncertain: 'unknown' });
    });
  } finally {
    await stopCollaborationRuntime(); await stopChatRuntime(); await stopPmProviderApplication();
    codexAdapter.check = originalCheck; codexAdapter.run = originalRun; globalThis.fetch = originalFetch; closeStore();
    for (const [name, value] of Object.entries({ AGENT_WORKSPACE_DATA_DIR: oldEnvironment.directory, AGENT_WORKSPACE_ALLOWED_ROOTS: oldEnvironment.roots, PM_API_URL: oldEnvironment.pm, PM_AUTOMATION_SERVICE_SECRET: oldEnvironment.secret })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
