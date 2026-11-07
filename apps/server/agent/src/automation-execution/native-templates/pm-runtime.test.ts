import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, test } from 'node:test';
import { setImmediate as flushImmediate } from 'node:timers/promises';
import * as runtime from '../service.ts';
import * as Effect from 'effect/Effect';
import { ProviderInstanceId, ThreadId } from '@t3tools/contracts';
import type { NativeOutputItem } from '@agent-workspace/contracts/output';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { pmAutomationCoverageKindSchema, pmAutomationTemplateIds, pmAutomationSnapshotSchema, pmAutomationPublishSchema, type PmAutomationSnapshot, type PmAutomationSourceRef, type PmAutomationResult, type PmAutomationAgentEvidence } from '../../../../../../packages/contracts/src/automation-pm.ts';
import { restrictPmAnalysisQueries } from '../../providers/t3code/families/claude.ts';
type ClaudeAgentSdkQueryRunnerShape = Parameters<typeof restrictPmAnalysisQueries>[0];
type ClaudeAgentSdkQueryOpenInput = Parameters<ClaudeAgentSdkQueryRunnerShape['open']>[0];
import type { ChatGeneration } from '../../durable/chat-runtime.ts';
import { initializeNativeOutput, emitNativeOutput } from '../../durable/native-output.ts';
import { ensureThread, updateThread } from '../../durable/threads.ts';
import { closeStore, writeRecord, listRecords } from '../../durable/store.ts';
import { makePmProviderRuntimeHost } from '../../providers/t3code/runtime-host.ts';
import { automationRequestFingerprint, pmAnalysisRequestForNativeThread, registerAutomationNativeThread } from '../context.ts';
import { queuePmAgentTerminal, stopPmAgentSignals } from '../pm-signals.ts';
import { collectPmAgentEvidence, pmGenerationTaskAssociations, pmNativeTestEvidence, pmNativeTestsComplete } from './pm-evidence.ts';
import { parsePmPullRequestCoverage, collectPmPullRequestEvidence } from './pm-external.ts';
import { pmAnalysisProviderSupport } from './pm-analysis-policy.ts';
import { resolvePmAnalysisChatSnapshot } from './pm-analysis-chat.ts';
import { createPmAutomationBridge, preparedPmAutomationResult } from './pm-bridge.ts';
import { createNativeTemplateState } from './state.ts';
import { resolveNativeTemplateHandler } from './registry.ts';
import type { NativeTemplateContext } from './ports.ts';
import { chatOnlyEnvironment } from '../../durable/execution.testkit.ts';

const at = '2026-11-01T08:00:00.000Z';
const request = (): StudioExecutionRequest => ({ executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1, config: { name: 'PM analysis test', description: '', projectId: 'PRJ-001', tags: [], templateId: 'pm-project-digest', templateVersion: '1.0.0', templateInputs: {}, action: { kind: 'template', templateId: 'pm-project-digest', arguments: {}, repositories: [], plugins: [], providerInstanceId: null, model: null, options: {}, timeoutSeconds: 30 }, trigger: { kind: 'manual' }, dailyLimit: 2, cooldownMinutes: 0 }, trigger: 'test', payload: null, issuedAt: at });
const source = (req: StudioExecutionRequest, kind: PmAutomationSourceRef['kind'], id: string): PmAutomationSourceRef => ({ refId: `${kind}:${id}`, kind, id, revision: '1', actorId: req.actorId, workspaceId: req.workspaceId, projectId: req.projectId, label: id, url: null, updatedAt: at });
function snapshot(req: StudioExecutionRequest): PmAutomationSnapshot {
  const project = source(req, 'project', req.projectId), workflow = source(req, 'workflow', 'workflow');
  return pmAutomationSnapshotSchema.parse({ templateId: req.config.action.kind === 'template' ? req.config.action.templateId : '', executionId: req.executionId, actorId: req.actorId, workspaceId: req.workspaceId, projectId: req.projectId, observedAt: at, args: {}, sources: [project, workflow], project: { id: req.projectId, sourceRefId: project.refId, revision: '1', title: 'Authorized project', description: '', goals: [], createdAt: at, updatedAt: at, archived: false }, workflow: { sourceRefId: workflow.refId, statuses: [], readyStatusId: null, reviewStatusId: null }, tasks: [], documents: [], relationships: [], comments: [], activities: [], sessions: [], executions: [], pullRequests: [], milestones: [], coverage: pmAutomationCoverageKindSchema.options.map(source => ({ source, status: 'complete', observedRecords: source === 'project' || source === 'workflow' ? 1 : 0, totalRecords: source === 'project' || source === 'workflow' ? 1 : 0, reason: null })), timeWindow: null, lastVisitAt: null, before: null, after: null, event: null });
}
function context(req: StudioExecutionRequest): NativeTemplateContext {
  return { request: req, arguments: req.config.action.kind === 'template' ? req.config.action.arguments : {}, signal: new AbortController().signal, now: new Date(at), log() {}, state: createNativeTemplateState(req), requestJson: async () => { throw new Error('Unexpected external read'); }, fetchPublic: async () => { throw new Error('Unexpected public read'); }, runAgent: async () => { throw new Error('Deterministic handler must not invoke a model'); } };
}
function generation(req: StudioExecutionRequest, id = '66666666-6666-4666-8666-666666666666'): ChatGeneration {
  return { id, threadId: 'scoped-thread', messageId: `answer:${id}`, parentId: null, status: 'completed', createdAt: at, endedAt: '2026-11-01T08:01:00.000Z', seq: 0, request: { id: 'scoped-thread', messages: [{ id: `question:${id}`, role: 'user', parts: [{ type: 'text', text: 'Investigate this task' }] }] }, providerInstanceId: 'fixture', providerInstanceRevision: 1, modelId: 'fixture', temperature: 0, executionSnapshot: { path: '/unused-private-scratch', environment: chatOnlyEnvironment() }, pmOperations: [{ actorId: req.actorId, target: { workspaceId: req.workspaceId, projectId: req.projectId } }], output: { id: `answer:${id}`, role: 'assistant', parts: [{ type: 'text', text: 'No verification claim is inferred from this prose.' }] }, pmReferences: [{ kind: 'issue', id: 'TASK-001', workspaceId: req.workspaceId, projectId: req.projectId, revision: 'task-r1', availability: 'available', reason: null, title: 'Actual linked task' }] };
}
let directory: string;
const previousData = process.env.AGENT_WORKSPACE_DATA_DIR, previousSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
const originalFetch = globalThis.fetch;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'pm-native-runtime-')); process.env.AGENT_WORKSPACE_DATA_DIR = directory; process.env.PM_AUTOMATION_SERVICE_SECRET = 'test-only-pm-runtime-service-secret-32bytes'; });
afterEach(async () => { await stopPmAgentSignals(); closeStore(); globalThis.fetch = originalFetch; if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData; if (previousSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = previousSecret; await rm(directory, { recursive: true, force: true }); });

test('all24 native IDs resolve actual evaluator-backed handlers, and invalid explicit scope never widens', () => {
  for (const id of pmAutomationTemplateIds) assert.equal(typeof resolveNativeTemplateHandler(id, {}), 'function');
  assert.throws(() => resolveNativeTemplateHandler('pm-project-digest', { taskIds: [] }), /taskIds/);
});

test('test evidence comes from recognized native runner receipts, not assistant prose or a successful echo', () => {
  const item: NativeOutputItem = { id: 'cmd', type: 'command_execution', status: 'completed', input: 'node --test suite.test.js', exitCode: 0, output: 'TAP version 13\nok 1 - explicit check\nok 2 - omitted capability # SKIP not configured\n1..2\n' };
  const tests = pmNativeTestEvidence(item, 'test-ref');
  assert.deepEqual(tests.map(value => value.status), ['passed', 'skipped']);
  assert.equal(pmNativeTestsComplete(item, tests), true);
  assert.deepEqual(pmNativeTestEvidence({ ...item, input: 'echo fabricated', output: 'ok 1 - fake\n1..1' }, 'ref'), []);
  assert.deepEqual(pmNativeTestEvidence({ ...item, outputTruncated: true }, 'ref'), []);
  assert.deepEqual(pmNativeTestEvidence({ ...item, type: 'assistant_message' }, 'ref'), []);
  assert.equal(pmNativeTestsComplete({ ...item, output: 'ok 1 - partial\n1..2' }, tests.slice(0, 1)), false);
});

test('Agent facts enforce actor/project scope and immutable actual task refs; current thread title/binding is not evidence', () => {
  const req = request(); ensureThread('scoped-thread', 'TASK-999 is only a title');
  const run = generation(req); writeRecord('chat:generations', run.id, run);
  initializeNativeOutput(run.id, run.threadId);
  emitNativeOutput(run.id, { type: 'item.upsert', item: { id: 'machine', type: 'command_execution', status: 'completed', input: 'node --test actual.test.js', output: 'TAP version 13\nok 1 - actual assertion\n1..1\n', exitCode: 0 } });
  emitNativeOutput(run.id, { type: 'item.upsert', item: { id: 'diff', type: 'file_change', status: 'completed', changes: [{ path: 'src/actual.ts', operation: 'update' }] } });
  const foreign = generation({ ...req, actorId: '77777777-7777-4777-8777-777777777777' }, '77777777-7777-4777-8777-777777777777'); writeRecord('chat:generations', foreign.id, foreign);
  const legacy = generation(req, '88888888-8888-4888-8888-888888888888'); delete legacy.pmOperations; writeRecord('chat:generations', legacy.id, legacy);
  const evidence = collectPmAgentEvidence(req);
  assert.deepEqual(evidence.executions.map(value => value.id), [run.id]);
  assert.equal(evidence.executions[0]?.taskId, 'TASK-001'); assert.equal(evidence.executions[0]?.taskRevision, 'task-r1');
  assert.equal(evidence.executions[0]?.testsComplete, true); assert.equal(evidence.executions[0]?.tests[0]?.name, 'actual assertion');
  assert.deepEqual(evidence.executions[0]?.diffPaths, ['src/actual.ts']);
  assert.deepEqual(pmGenerationTaskAssociations({ ...run, pmReferences: [] }, req), []);
  assert.deepEqual(pmGenerationTaskAssociations(run, { workspaceId: 'another-workspace', projectId: req.projectId }), []);
  assert.ok(evidence.coverage.some(value => value.status === 'partial' && value.reason?.includes('actor identity')));
  assert.ok(evidence.sources.every(value => value.actorId === req.actorId && value.projectId === req.projectId));
});

test('PR acceptance table retains exact criteria and raw source evidence without converting filenames into test success', () => {
  const body = '| Acceptance criterion | Covered | Evidence |\n| --- | --- | --- |\n| Exact criterion. | yes | [test](https://example.test/check) |\n| Exact criterion? | no | missing assertion |\n| Unproven | yes | |';
  const rows = parsePmPullRequestCoverage(body, 'pr-ref');
  assert.deepEqual(rows.map(row => [row.criterion, row.covered]), [['Exact criterion.', true], ['Exact criterion?', false], ['Unproven', null]]);
  assert.ok(rows.every(row => row.sourceRefId === 'pr-ref' && body.includes(row.evidence)));
  assert.deepEqual(parsePmPullRequestCoverage('changed src/requirement.ts, all tests passed', 'ref'), []);
});

test('authenticated PR collection uses GET-only selected repo/head and rejects a moving metadata snapshot', async () => {
  const req = request(); if (req.config.action.kind !== 'template') throw new Error('fixture'); req.config.action.templateId = 'pm-pr-acceptance-coverage'; req.config.action.arguments = { taskIds: ['TASK-001'], repository: { provider: 'github', repository: 'owner/repo', ref: null, pullRequestNumber: 7 } };
  const ctx = context(req), paths: string[] = []; let metadata = 0;
  ctx.requestJson = async <T>(_provider: 'github' | 'gitlab', apiPath: string, options?: { method?: string }) => { assert.equal(options?.method ?? 'GET', 'GET'); paths.push(apiPath); if (apiPath.includes('/files?')) return [{ filename: 'src/real.ts' }] as T; metadata++; return { number: 7, html_url: 'https://github.com/owner/repo/pull/7', title: 'PR', body: '| Criterion | Covered | Evidence |\n| --- | --- | --- |\n| exact | no | no check yet |', updated_at: at, changed_files: 1, head: { sha: (metadata === 1 ? 'a' : 'b').repeat(40) } } as T; };
  const evidence: PmAutomationAgentEvidence = { sources: [], sessions: [], executions: [], pullRequests: [], coverage: [] };
  await collectPmPullRequestEvidence(ctx, evidence);
  assert.equal(evidence.pullRequests.length, 0); assert.equal(evidence.coverage[0]?.status, 'unavailable');
  assert.deepEqual(paths, ['/repos/owner/repo/pulls/7', '/repos/owner/repo/pulls/7/files?per_page=100&page=1', '/repos/owner/repo/pulls/7']);
});

test('Claude original query runner enforces no tools only for a private trusted binding; normal Chat retains its exact options', async () => {
  const host = makePmProviderRuntimeHost(), instanceId = ProviderInstanceId.make('claude-fixture'), threadId = ThreadId.make('analysis-thread');
  const captured: ClaudeAgentSdkQueryOpenInput[] = [];
  const original = { open: (input: ClaudeAgentSdkQueryOpenInput) => Effect.sync(() => { captured.push(input); return {}; }) } as unknown as ClaudeAgentSdkQueryRunnerShape;
  const runner = restrictPmAnalysisQueries(original, host, instanceId);
  const input = { threadId, providerSessionId: 'fixture-session', options: { sessionId: 'native-session', model: 'fixture-model', cwd: '/private/empty', permissionMode: 'default', tools: { type: 'preset', preset: 'claude_code' }, settingSources: ['project'], mcpServers: { unsafe: { command: 'unsafe' } }, hooks: {}, extraArgs: { 'dangerously-skip-permissions': null } } } as unknown as ClaudeAgentSdkQueryOpenInput;
  await Effect.runPromise(runner.open(input)); assert.equal(captured[0], input);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* host.bind({ providerInstanceId: instanceId, threadId, executionId: 'original-execution', promptAuthorization: 'technical-no-tools', cwd: '/private/empty', nativePermissions: 'deny-ungranted', instructionText: '', mcpServers: [] });
    yield* runner.open(input);
  })));
  const restricted = captured[1]!.options;
  assert.deepEqual(restricted.tools, []); assert.deepEqual(restricted.mcpServers, {}); assert.deepEqual(restricted.settingSources, []); assert.deepEqual(restricted.plugins, []);
  assert.equal(restricted.hooks, undefined); assert.equal(restricted.extraArgs, undefined); assert.deepEqual(restricted.settings, { disableAllHooks: true });
  assert.equal(pmAnalysisProviderSupport('claude').available, true); assert.equal(pmAnalysisProviderSupport('codex').available, false);
});

test('public thread custom metadata cannot forge PM analysis admission, and bound analysis uses empty private data cwd without project mapping', async () => {
  const req = request(); ensureThread('claimed-analysis', 'Claim');
  updateThread('claimed-analysis', { custom: { automationExecutionId: req.executionId, pmAnalysis: true, nativeChildKey: 'claimed' } });
  assert.equal(pmAnalysisRequestForNativeThread('claimed-analysis', 'caller-key'), null);
  assert.equal(await resolvePmAnalysisChatSnapshot('claimed-analysis', 'caller-key'), null);
  writeRecord('pm-automation:executions', req.executionId, { request: req, fingerprint: automationRequestFingerprint(req), phase: 'running' });
  registerAutomationNativeThread(req, 'server-analysis', 'server-key', true);
  globalThis.fetch = async input => { assert.ok(new URL(String(input)).pathname.endsWith('/snapshot')); return Response.json(snapshot(req)); };
  const scoped = await resolvePmAnalysisChatSnapshot('server-analysis', 'server-key');
  assert.ok(scoped?.path.startsWith(path.join(directory, 'pm-analysis', req.executionId))); assert.notEqual(scoped?.path, process.cwd());
  assert.deepEqual(scoped?.environment, chatOnlyEnvironment());
  globalThis.fetch = async () => Response.json(snapshot({ ...req, projectId: 'PRJ-002' }));
  await assert.rejects(resolvePmAnalysisChatSnapshot('server-analysis', 'server-key'), /immutable analysis scope/);
});

test('PM result lost response reconciles original immutable identity across store restart, never a second model/result', async () => {
  const req = request(), ctx = context(req), frozen = snapshot(req); let stored = false, published: PmAutomationResult | null = null, posts = 0;
  globalThis.fetch = async (input, init) => {
    const operation = new URL(String(input)).pathname.split('/').at(-1);
    if (operation === 'snapshot') { if (init?.method === 'POST') stored = true; return stored ? Response.json(frozen) : new Response(null, { status: 404 }); }
    if (operation === 'result' && init?.method === 'GET') return published ? Response.json(published) : new Response(null, { status: 404 });
    assert.equal(operation, 'result'); posts++; published = pmAutomationPublishSchema.parse(JSON.parse(String(init?.body))).result; throw new Error('response lost after accepted original result');
  };
  const bridge = createPmAutomationBridge(ctx); await bridge.snapshot();
  const result: PmAutomationResult = { templateId: frozen.templateId, executionId: req.executionId, observedAt: frozen.observedAt, summary: 'Actual bounded empty analysis', findings: [], candidates: [], coverage: frozen.coverage, gaps: [] };
  await assert.rejects(bridge.publish(result), /unconfirmed/); closeStore();
  assert.deepEqual(preparedPmAutomationResult(req), result);
  await createPmAutomationBridge(ctx).publish(result); assert.equal(posts, 1);
  const changed = structuredClone(req); changed.config.description = 'different immutable definition';
  assert.throws(() => preparedPmAutomationResult(changed), /different immutable inputs/);
});

test('terminal signal outbox is durable/idempotent and suppresses legacy or automation-origin sessions', () => {
  const req = request(); ensureThread('scoped-thread', 'Normal Chat');
  const run = generation(req); writeRecord('chat:generations', run.id, run);
  queuePmAgentTerminal(run); queuePmAgentTerminal(run); closeStore();
  assert.equal(listRecords('pm-automation:agent-signal-outbox').length, 1);
  const legacy = generation(req, '99999999-9999-4999-8999-999999999999'); delete legacy.pmOperations; queuePmAgentTerminal(legacy);
  updateThread('scoped-thread', { custom: { automationExecutionId: req.executionId } }); queuePmAgentTerminal({ ...run, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(listRecords('pm-automation:agent-signal-outbox').length, 1);
  updateThread('scoped-thread', { custom: {} });
  writeRecord('pm-automation:executions', req.executionId, { request: req, fingerprint: automationRequestFingerprint(req), phase: 'running' });
  registerAutomationNativeThread(req, run.threadId, 'server-automation-origin');
  queuePmAgentTerminal({ ...run, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', request: { ...run.request, idempotencyKey: 'server-automation-origin' } });
  assert.equal(listRecords('pm-automation:agent-signal-outbox').length, 1);
});
test('one ordinary Session emits independent PM receipts only for its explicit authorized operation targets', () => {
  const req = request(); ensureThread('scoped-thread', 'Independent Session');
  const run = generation(req);
  run.pmOperations!.push({ actorId: req.actorId, target: { workspaceId: req.workspaceId, projectId: 'PRJ-002' } });
  run.pmOperations!.push(run.pmOperations![0]!);
  writeRecord('chat:generations', run.id, run);
  queuePmAgentTerminal(run);
  const events = listRecords<{ event: { projectId: string; eventId: string } }>('pm-automation:agent-signal-outbox');
  assert.deepEqual(events.map(record => record.event.projectId).sort(), ['PRJ-001', 'PRJ-002']);
  assert.equal(new Set(events.map(record => record.event.eventId)).size, 2);
  assert.equal(collectPmAgentEvidence({ ...req, projectId: 'PRJ-002' }).executions[0]?.taskId, null, 'TASK-001 from the first PM target is never joined to the second');
});

test('explicit PR ref mismatch is reported rather than silently capturing another branch', async () => {
  const req = request();
  if (req.config.action.kind !== 'template') throw new Error('fixture');
  req.config.action.arguments = { taskIds: ['TASK-001'], repository: { provider: 'github', repository: 'owner/repo', ref: 'expected-branch', pullRequestNumber: 7 } };
  const ctx = context(req); let calls = 0;
  ctx.requestJson = async <T>() => { calls++; return { number: 7, html_url: 'https://github.com/owner/repo/pull/7', title: 'PR', body: '', updated_at: at, changed_files: 0, head: { sha: 'a'.repeat(40), ref: 'another-branch' } } as T; };
  const evidence: PmAutomationAgentEvidence = { sources: [], sessions: [], executions: [], pullRequests: [], coverage: [] };
  await collectPmPullRequestEvidence(ctx, evidence);
  assert.equal(calls, 1); assert.deepEqual(evidence.pullRequests, []);
  assert.match(evidence.coverage[0]!.reason!, /ref does not match/);
});

test('deterministic native execution reaches PM result without any Provider, Chat or project file-area resolution', { timeout: 5000 }, async () => {
  const req = request(), frozen = snapshot(req), paths: string[] = [];
  let stored = false, published: PmAutomationResult | null = null;
  const delivered = Promise.withResolvers<void>();
  globalThis.fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname; paths.push(pathname);
    if (pathname.endsWith('/snapshot')) {
      if (init?.method === 'POST') stored = true;
      return stored ? Response.json(frozen) : new Response(null, { status: 404 });
    }
    if (pathname.endsWith('/result') && init?.method === 'GET') return published ? Response.json(published) : new Response(null, { status: 404 });
    if (pathname.endsWith('/result') && init?.method === 'POST') {
      published = pmAutomationPublishSchema.parse(JSON.parse(String(init.body))).result;
      delivered.resolve(); return Response.json(published);
    }
    throw new Error(`Unexpected scope/Provider endpoint ${pathname}`);
  };
  await runtime.startAutomationExecutionRuntime();
  try {
    await runtime.dispatchAutomationExecution(req);
    await delivered.promise;
    await flushImmediate();
    const result = await runtime.queryAutomationExecution(req);
    assert.equal(result.status, 'completed'); assert.equal(result.threadId, null);
    assert.ok(paths.every(pathname => pathname.includes('/automations/pm/executions/')));
    assert.deepEqual(listRecords('chat:generations'), []);
    assert.deepEqual(await runtime.queryAutomationExecution(req), result);
  } finally { await runtime.stopAutomationExecutionRuntime(); }
});
