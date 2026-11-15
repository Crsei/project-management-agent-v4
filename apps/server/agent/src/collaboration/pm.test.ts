import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, test } from 'node:test';
import { z } from 'zod';
import { collaborationRunSchema, defaultCollaborationResourceLimits, type AgentConfig } from '@agent-workspace/contracts/collaboration';
import type { TaskBrief } from '@agent-workspace/contracts/task-brief';
import { pmToolRequestSchema, type PmToolCallRecord } from '@agent-workspace/contracts/pm-tools';
import { pmCommentAgentOriginSchema } from '../../../../../packages/agent-contracts/src/pm-tool-linkage.ts';
import { pmToolRequestHash, verifyPmToolLinkageBearer } from '../../../../../packages/infrastructure/src/pm-tool-service-auth.ts';
import { closeStore, writeRecord } from '../durable/store.ts';
import type { ChatGeneration } from '../durable/chat-runtime.ts';
import { COLLABORATION_RUNS } from './coordinator.ts';
import { authorizeCollaborationTarget, readCollaborationTaskBrief, readCollaborationDiscussion, publishCollaborationComment, reconcileCollaborationComment, type CollaborationCommentPublication } from './pm.ts';

const actorId = '10000000-0000-4000-8000-000000000001';
const target = { workspaceId: '20000000-0000-4000-8000-000000000001', projectId: 'PRJ-001', taskId: 'TASK-001', taskRevision: 'a'.repeat(64) };
const headers = new Headers({ cookie: 'pm_v4_session=isolated-test', 'x-source-agent-id': 'never-forward' });
let server: Server, directory: string;
let oldUrl: string | undefined, oldDirectory: string | undefined, oldSecret: string | undefined;
let revision: string, currentActor: string, denied: boolean, archived: boolean, truncate: boolean, changeDuringBrief: boolean, badPage: boolean, loseReply: boolean;
let bodies: { path: string; body: unknown; untrusted: string | undefined }[], records: Map<string, PmToolCallRecord>;

beforeEach(async () => {
  oldUrl = process.env.PM_API_URL; oldDirectory = process.env.AGENT_WORKSPACE_DATA_DIR; oldSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
  directory = await mkdtemp(join(tmpdir(), 'collaboration-pm-'));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.PM_AUTOMATION_SERVICE_SECRET = 'isolated-collaboration-pm-adapter-proof-secret'.repeat(3);
  revision = target.taskRevision; currentActor = actorId; denied = archived = truncate = changeDuringBrief = badPage = loseReply = false; bodies = []; records = new Map();
  server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const input: unknown = raw ? JSON.parse(raw) : undefined;
    const path = new URL(request.url!, 'http://fixture');
    bodies.push({ path: request.url!, body: input, untrusted: request.headers['x-source-agent-id'] as string | undefined });
    response.setHeader('content-type', 'application/json');
    if (denied) { response.writeHead(403).end(JSON.stringify({ error: { code: 'permission_denied' } })); return; }
    if (path.pathname === '/api/v1/agent-contexts/authorize') {
      response.end(JSON.stringify({ actorId: currentActor, scope: input })); return;
    }
    if (path.pathname.includes('/core/files/')) {
      const task = path.pathname.endsWith(target.taskId);
      response.end(JSON.stringify({ id: task ? target.taskId : target.projectId, revision: task ? revision : 'b'.repeat(64), entity: { entity: task ? 'work_item' : 'project', ...(task ? { project: target.projectId } : {}), archived } })); return;
    }
    if (path.pathname.endsWith('/brief')) {
      const text = 'Complete current body with its final constraint.';
      const brief: TaskBrief = { schemaVersion: 1, stage: 'development', generatedAt: new Date().toISOString(),
        task: { workspaceId: target.workspaceId, projectId: target.projectId, taskId: target.taskId, revision: target.taskRevision, title: 'Current task', body: text, bodyOffset: 0, bodyLength: text.length, nextBodyOffset: null },
        goals: [], acceptanceCriteria: [], constraints: [], nonGoals: [], relations: [], guidance: [], sources: [], gaps: [],
        truncation: { truncated: truncate, body: truncate, statements: false, relations: false, message: truncate ? 'Incomplete' : null }, dispatchable: !truncate, authorityNotice: 'PM is authoritative' };
      if (changeDuringBrief) revision = 'c'.repeat(64);
      response.end(JSON.stringify(brief)); return;
    }
    if (path.pathname.endsWith('/comments')) {
      const after = path.searchParams.get('after'), id = after ? '30000000-0000-4000-8000-000000000002' : '30000000-0000-4000-8000-000000000001';
      response.end(JSON.stringify({ taskId: badPage ? 'TASK-002' : target.taskId, projectId: target.projectId,
        items: [{ id, workspaceId: target.workspaceId, projectId: target.projectId, taskId: target.taskId, authorId: actorId, version: 2,
          content: after ? null : 'Current PM comment, not private history', deletedAt: after ? new Date().toISOString() : null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), origin: null }], nextCursor: after ? null : id })); return;
    }
    const operation = pmToolRequestSchema.parse(input);
    if (path.pathname.endsWith('/call') || path.pathname.endsWith('/result')) {
      const proof = request.headers['x-pm-tool-linkage'];
      assert.equal(typeof proof, 'string');
      assert.equal(verifyPmToolLinkageBearer(proof as string, actorId, pmToolRequestHash(operation, actorId), operation.linkage!), true);
      if (!records.has(operation.operationId) && path.pathname.endsWith('/result')) {
        response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found_or_forbidden' } })); return;
      }
      if (!records.has(operation.operationId)) {
        const origin = pmCommentAgentOriginSchema.parse({ ...operation.linkage!.collaboration, operationId: operation.operationId, threadId: operation.threadId, generationId: operation.generationId });
        const id = randomUUID(), { content } = z.object({ content: z.string() }).parse(operation.arguments);
        records.set(operation.operationId, { operationId: operation.operationId, name: operation.name, actorId, threadId: operation.threadId, messageId: operation.messageId,
          generationId: operation.generationId, workspaceId: target.workspaceId, target: operation.target, status: 'succeeded', error: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          linkage: operation.linkage!, result: { kind: 'comment', items: [{ id, taskId: target.taskId, projectId: target.projectId, authorId: actorId, origin, version: 1, deletedAt: null, content }], nextCursor: null, truncated: false, sources: [],
            receipt: { kind: 'command', commandId: operation.operationId, operationId: operation.operationId, action: 'CreateTaskComment', targetId: id, revision: '1', linkage: operation.linkage! } } });
      }
      if (loseReply && path.pathname.endsWith('/call')) { loseReply = false; response.destroy(); return; }
      response.end(JSON.stringify(records.get(operation.operationId))); return;
    }
    response.writeHead(404).end('{}');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
  closeStore();
  if (oldUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = oldUrl;
  if (oldDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldDirectory;
  if (oldSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = oldSecret;
  await rm(directory, { recursive: true, force: true });
});

function fixedPublication(): CollaborationCommentPublication {
  const at = new Date().toISOString(), threadId = 'actual-session', generationId = 'actual-generation', inputMessageId = 'actual-input', messageId = 'actual-assistant-output';
  const config: AgentConfig = { name: 'Reviewer', role: 'Review', instructions: 'Only report actual observations', providerInstanceId: 'provider', model: 'model', modelOptions: [], interactionMode: 'default', temperature: 1,
    owner: { label: 'Operator', actorId }, allowedProjectIds: [target.projectId], capabilityBindings: { restriction: 'observe', mcp: [], skills: [], hostTools: [] }, resourceLimits: defaultCollaborationResourceLimits, executionMode: 'write' };
  const run = collaborationRunSchema.parse({ id: 'actual-run', revision: 1, requestId: 'actual-request', requestFingerprint: 'e'.repeat(64), target,
    definition: { kind: 'agent', agentId: 'actual-agent', agentVersion: 2 }, goal: 'Review same work', input: '', actorId, rootRunId: 'actual-run', parentRunId: null, delegationId: null, depth: 0,
    status: 'succeeded', createdAt: at, updatedAt: at, startedAt: at, finishedAt: at, deadlineAt: at,
    executionSelection: { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null }, executionEnvironment: null, directoryIdentity: null,
    agentVersions: [{ agentId: 'actual-agent', workspaceId: target.workspaceId, version: 2, config, createdBy: actorId, createdAt: at }], teamVersion: null, capabilityManifests: [], taskBrief: null,
    resourceLimits: defaultCollaborationResourceLimits, executionMode: 'write', threadId, generationId, inputMessageId, operationRefs: [], resultRefs: [], wait: null, error: null, cancellation: null });
  writeRecord(COLLABORATION_RUNS, run.id, run);
  const generation: ChatGeneration = { id: generationId, threadId, messageId, inputMessageId, traceId: randomUUID(), parentId: null, status: 'completed', createdAt: at, endedAt: at, seq: 0,
    request: { id: threadId, messages: [{ id: inputMessageId, role: 'user', parts: [{ type: 'text', text: 'Actual isolated run input' }] }] }, providerInstanceId: 'provider', providerInstanceRevision: 1, modelId: 'model', temperature: 1 };
  writeRecord('chat:generations', generationId, generation);
  return { runId: run.id, agentId: 'actual-agent', agentVersion: 2, delegationId: null, target, threadId, messageId, generationId, actorId, operationId: randomUUID(), content: 'Short explicit public result only.' };
}

test('authorizes the actual PM actor, current target and immutable brief revision', async () => {
  assert.deepEqual(await authorizeCollaborationTarget(target, headers, actorId), { actorId });
  revision = 'b'.repeat(64);
  await assert.rejects(authorizeCollaborationTarget(target, headers), { code: 'task_revision_changed' });
  revision = target.taskRevision; archived = true;
  await assert.rejects(authorizeCollaborationTarget(target, headers), { code: 'collaboration_target_unavailable' });
  archived = false; currentActor = randomUUID();
  await assert.rejects(authorizeCollaborationTarget(target, headers, actorId), { code: 'collaboration_actor_changed' });
  assert.ok(bodies.every(body => body.untrusted === undefined));
});

test('reads the complete brief and rejects truncation or a revision change during the read', async () => {
  const value = await readCollaborationTaskBrief(target, headers);
  assert.equal(value.brief.task.body, 'Complete current body with its final constraint.');
  truncate = true;
  await assert.rejects(readCollaborationTaskBrief(target, headers), { code: 'task_brief_incomplete' });
  truncate = false; changeDuringBrief = true;
  await assert.rejects(readCollaborationTaskBrief(target, headers), { code: 'task_revision_changed' });
});

test('uses the same current PM discussion after brief drift, including pages, human authors and deleted tombstones', async () => {
  revision = 'd'.repeat(64);
  const first = await readCollaborationDiscussion(target, headers, { limit: 1 });
  assert.equal(first.items[0]!.content, 'Current PM comment, not private history'); assert.equal(first.items[0]!.authorId, actorId); assert.ok(first.nextCursor);
  const last = await readCollaborationDiscussion(target, headers, { after: first.nextCursor!, limit: 1 });
  assert.equal(last.items[0]!.content, null); assert.ok(last.items[0]!.deletedAt); assert.equal(last.nextCursor, null);
  badPage = true;
  await assert.rejects(readCollaborationDiscussion(target, headers), { code: 'collaboration_discussion_mismatch' });
  denied = true;
  await assert.rejects(readCollaborationDiscussion(target, headers), { code: 'pm_reference_forbidden' });
});

test('signs only a real durable Run/generation binding, including completed generations, and reconciles only the original operation', async () => {
  const input = fixedPublication();
  await assert.rejects(publishCollaborationComment({ ...input, agentId: 'client-spoof' }, headers), { code: 'collaboration_origin_unverified' });
  assert.equal(bodies.length, 0);
  const created = await publishCollaborationComment(input, headers);
  assert.equal(created.status, 'succeeded'); assert.equal(records.size, 1);
  revision = 'f'.repeat(64);
  await assert.rejects(publishCollaborationComment({ ...input, operationId: randomUUID() }, headers), { code: 'task_revision_changed' });
  assert.equal((await reconcileCollaborationComment(input, headers)).status, 'succeeded');
  assert.equal(records.size, 1);
  await assert.rejects(reconcileCollaborationComment({ ...input, operationId: randomUUID() }, headers), { code: 'not_found_or_forbidden' });
  assert.equal(records.size, 1);
  assert.ok(bodies.filter(body => body.path.endsWith('/result')).length >= 2);
});

test('lost publication reply never creates a second comment or retries the /call endpoint', async () => {
  const input = fixedPublication(); loseReply = true;
  await assert.rejects(publishCollaborationComment(input, headers));
  assert.equal(records.size, 1);
  const recovered = await reconcileCollaborationComment(input, headers);
  assert.equal(recovered.operationId, input.operationId); assert.equal(recovered.status, 'succeeded');
  assert.equal(bodies.filter(body => body.path.endsWith('/call')).length, 1);
  assert.equal(bodies.filter(body => body.path.endsWith('/result')).length, 1);
  assert.equal(records.size, 1);
  denied = true;
  await assert.rejects(reconcileCollaborationComment(input, headers), { code: 'pm_reference_forbidden' });
});
