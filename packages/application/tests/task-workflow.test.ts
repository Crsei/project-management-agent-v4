import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowProblems, workflowTemplates, workflowTaskRevision, workflowGraphSchema, workflowStartSchema, workflowControlSchema, type WorkflowDefinition, type WorkflowGraph, type WorkflowRun, type WorkflowStart } from '../../contracts/src/task-workflow.ts';
import type { TaskCodeDelivery, DeliveryTree } from '../../contracts/src/task-code-delivery.ts';
import { TaskWorkflowService, type WorkflowPorts } from '../src/task-workflow.ts';
import { TaskCodeDeliveryService, type DeliveryPorts } from '../src/task-code-delivery.ts';

const scope = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', taskId: 'TASK-001' };
const id = '11111111-1111-4111-8111-222222222222';
function fixture(template = 'builtin-deliver') {
  const definitions = new Map<string, WorkflowDefinition>(), runs = new Map<string, WorkflowRun>(), deliveries = new Map<string, TaskCodeDelivery>();
  const calls: string[] = [];
  let taskStatus = 'todo';
  const receipts = new Map<string, { status: 'applied'; revision: string; commandId: string }>();
  let taskRevision = 'r1', allow = true, repo = 'owner/repo', generation = 'completed', testExit = 0, ci: 'success' | 'pending' | 'failure' | 'empty' = 'success', ciHead = 'b'.repeat(40), remote: string | null = null;
  let clock = Date.now();
  let tree: DeliveryTree = { head: 'a'.repeat(40), fingerprint: 'initial', files: [], diff: '' };
  const authorize = async () => { if (!allow) throw new Error('denied'); return { ...scope, revision: taskRevision, title: 'Implement', description: 'Test it', root: '/repo', status: taskStatus }; };
  const dp: DeliveryPorts = {
    read: key => structuredClone(deliveries.get(key) ?? null), list: () => structuredClone([...deliveries.values()]), save: v => deliveries.set(v.id, structuredClone(v)), authorize, expectedTaskRevision: v => runs.has(v.id) ? workflowTaskRevision(runs.get(v.id)!) : v.taskRevision,
    prepare: async () => { calls.push('prepare'); return { root: '/repo', directory: '/worktree', directoryIdentity: '1:2', commonDirectory: '/repo/.git', remote: 'git@github.com:owner/repo.git', owner: 'owner', repo: 'repo', baseBranch: 'main', baseSha: 'a'.repeat(40), branch: 'codex/task-id' }; },
    verify: async () => {}, tree: async () => tree, busy: () => false,
    develop: async v => { calls.push('agent'); if (v.worktreeWriteConfirmed) tree = { ...tree, fingerprint: 'modified', files: ['src/a.js'], diff: '+a' }; return 'g1'; },
    generation: () => ({ id: 'g1', status: generation }),
    test: async () => { calls.push('test'); return { exitCode: testExit, outputDigest: 'digest' }; },
    commit: async () => { calls.push('commit'); tree = { head: 'b'.repeat(40), fingerprint: 'committed', files: [], diff: '' }; return tree.head; },
    push: async () => { calls.push('push'); remote = tree.head; }, remoteHead: async () => remote,
    findPr: async () => null, createPr: async () => { calls.push('pr'); return { number: 1, url: 'https://github.com/owner/repo/pull/1' }; },
    feedback: async () => ({ head: ciHead, state: 'open', draft: true, observedAt: new Date(clock).toISOString(), reviews: [], checks: ci === 'empty' ? [] : [{ name: 'test', status: ci === 'pending' ? 'in_progress' : 'completed', conclusion: ci === 'pending' ? null : ci }] }),
  };
  const delivery = new TaskCodeDeliveryService(dp);
  const p: WorkflowPorts = { readDefinition: key => structuredClone(definitions.get(key) ?? null), definitions: () => structuredClone([...definitions.values()]), saveDefinition: v => definitions.set(v.id, structuredClone(v)),
    readRun: key => structuredClone(runs.get(key) ?? null), runs: () => structuredClone([...runs.values()]), saveRun: v => { assert.equal(v.version, (runs.get(v.id)?.version ?? 0) + 1); runs.set(v.id, structuredClone(v)); },
    transition: async (request, reconcile) => {
      const key = `${request.runId}:${request.nodeId}`;
      const prior = receipts.get(key); if (prior) return prior;
      if (reconcile) return { status: 'not_found' };
      assert.equal(request.revision, taskRevision);
      assert.ok(request.phase === 'start' ? ['todo', 'in_progress'].includes(taskStatus) : taskStatus === 'in_progress');
      calls.push(`state-${request.phase}`); taskStatus = request.phase === 'start' ? 'in_progress' : 'review'; taskRevision = `state-${receipts.size + 1}`;
      const receipt = { status: 'applied' as const, revision: taskRevision, commandId: key }; receipts.set(key, receipt); return receipt;
    },
    authorize, repository: async () => repo, provider: async () => {}, delivery, readDelivery: dp.read, now: () => clock };
  const service = new TaskWorkflowService(p);
  const input: WorkflowStart = { ...scope, id, taskRevision: 'r1', definitionId: template, definitionVersion: 1, baseBranch: 'main', repository: 'owner/repo', providerInstanceId: 'codex', model: 'selected', executionSelection: { version: 2, agentWorkspaceId: 'agent-folder', agentWorkspaceRevision: 1 }, consent: { execute: true, worktreeWrite: template !== 'builtin-analysis', commit: true, push: true, draftPr: true, taskStatus: true } };
  const stepUntil = async (predicate: (r: WorkflowRun) => boolean) => { for (let i = 0; i < 25; i++) { const r = await service.tick(id); if (predicate(r)) return r; } throw new Error('condition not reached'); };
  return { service, p, dp, input, calls, runs, definitions, deliveries, stepUntil, set: { tree: (v: Partial<DeliveryTree>) => { tree = { ...tree, ...v }; }, deny: () => { allow = false; }, revision: () => { taskRevision = 'external-edit'; }, status: (v: string) => { taskStatus = v; taskRevision = 'external-state'; }, repo: () => { repo = 'owner/other'; }, generation: (v: string) => { generation = v; }, test: (v: number) => { testExit = v; }, ci: (v: typeof ci) => { ci = v; }, ciHead: () => { ciHead = 'other'; }, advance: (ms: number) => { clock += ms; } } };
}

test('task and canvas templates parse and validate; strict schemas reject unsupported inputs and reserved node IDs', () => {
  for (const def of workflowTemplates) { workflowGraphSchema.parse(def.draft); assert.deepEqual(workflowProblems(def.draft), []); }
  const graph = structuredClone(workflowTemplates[0]!.draft); graph.nodes[0]!.id = 'constructor'; assert.equal(workflowGraphSchema.safeParse(graph).success, false);
  assert.equal(workflowStartSchema.safeParse({ ...fixture().input, credential: 'not allowed' }).success, false);
});
test('validator rejects cycles, missing nodes, duplicate exits, disconnected nodes and wrong execution ordering', () => {
  const a = structuredClone(workflowTemplates[2]!.draft); a.edges[0]!.target = a.nodes[0]!.id; assert.ok(workflowProblems(a).length);
  const b = structuredClone(workflowTemplates[2]!.draft); b.edges[0]!.target = 'absent'; assert.ok(workflowProblems(b).length);
  const c = structuredClone(workflowTemplates[2]!.draft); c.edges.push({ ...c.edges[0]!, id: 'extra' }); assert.ok(workflowProblems(c).length);
  const d = structuredClone(workflowTemplates[2]!.draft); d.nodes.find(n => n.kind === 'test')!.kind = 'approval'; d.nodes.find(n => n.kind === 'approval')!.config = {}; assert.match(workflowProblems(d).join(','), /test/);
  const e = structuredClone(workflowTemplates[2]!.draft); e.nodes.find(n => n.kind === 'agent')!.config = { mode: 'analyze' }; assert.match(workflowProblems(e).join(','), /develop/);
});
test('drafts may be incomplete; publish validates; published snapshots are immutable and CAS enforced', async () => {
  const f = fixture(); const graph = structuredClone(workflowTemplates[1]!.draft);
  const v1 = await f.service.saveDefinition({ ...scope, id, expectedRevision: 0, graph, publish: true });
  graph.name = 'Changed';
  const v2 = await f.service.saveDefinition({ ...scope, id, expectedRevision: v1.revision, graph, publish: true });
  assert.notEqual(v2.versions[0]!.graph.name, v2.versions[1]!.graph.name);
  await assert.rejects(f.service.saveDefinition({ ...scope, id, expectedRevision: 1, graph, publish: true }), /已变化/);
  graph.edges = [];
  const draft = await f.service.saveDefinition({ ...scope, id, expectedRevision: 2, graph, publish: false }); assert.equal(draft.versions.length, 2);
  await assert.rejects(f.service.saveDefinition({ ...scope, id, expectedRevision: 3, graph, publish: true }), /出口/);
});
test('full automatic delivery uses pinned graph, separate consents, verified tests and current HEAD CI; never completes PM task', async () => {
  const f = fixture(); await f.service.start(f.input);
  const result = await f.stepUntil(r => r.status === 'completed');
  assert.deepEqual(f.calls, ['prepare', 'agent', 'test', 'commit', 'push', 'pr']);
  assert.equal(result.input.taskRevision, 'r1'); assert.equal(result.graph.name, '开发并交付');
  assert.equal(f.deliveries.get(id)?.feedback?.checks[0]?.conclusion, 'success');
  await f.service.tick(id); assert.equal(f.calls.filter(c => c === 'pr').length, 1);
});
test('analysis never grants worktree writes or publishes; validation stops before Git publishing', async () => {
  const a = fixture('builtin-analysis'); await a.service.start(a.input); await a.stepUntil(r => r.status === 'completed');
  assert.deepEqual(a.calls, ['prepare', 'agent']); assert.equal(a.deliveries.get(id)?.worktreeWriteConfirmed, false); assert.equal(a.deliveries.get(id)?.developmentPurpose, 'analysis');
  const b = fixture('builtin-validate'); await b.service.start(b.input); await b.stepUntil(r => r.status === 'completed'); assert.deepEqual(b.calls, ['prepare', 'agent', 'test']);
});
test('missing consent, repository mismatch, changed requirements, existing manual delivery and duplicate task runs rejected', async () => {
  for (const key of ['worktreeWrite', 'commit', 'push', 'draftPr'] as const) { const f = fixture(); f.input.consent[key] = false; await assert.rejects(f.service.start(f.input), /授权/); assert.deepEqual(f.calls, []); }
  const a = fixture(); a.set.repo(); await assert.rejects(a.service.start(a.input), /仓库/);
  const b = fixture(); b.set.revision(); await assert.rejects(b.service.start(b.input), /版本/);
  const c = fixture(); await c.p.delivery.prepare({ ...scope, id, taskRevision: 'r1', baseBranch: 'main', executionSelection: c.input.executionSelection! }); await assert.rejects(c.service.start(c.input), /已有/);
  const d = fixture(); const first = await d.service.start(d.input); assert.deepEqual(await d.service.start(d.input), first);
  await assert.rejects(d.service.start({ ...d.input, baseBranch: 'other' }), /改变参数/);
  await assert.rejects(d.service.start({ ...d.input, id: 'different' }), /已有/);
});
test('every background step checks current auth, task version and repository', async () => {
  for (const mutate of ['deny', 'revision', 'repo'] as const) {
    const f = fixture(); await f.service.start(f.input); await f.service.tick(id); f.set[mutate](); const r = await f.service.tick(id);
    assert.equal(r.status, 'paused'); assert.equal(f.calls.length, 0);
  }
});
test('Agent failure, failed test and no CI are not success; deadline terminates empty CI', async () => {
  const a = fixture(); a.set.generation('failed'); await a.service.start(a.input); await a.stepUntil(r => r.status === 'failed'); assert.ok(!a.calls.includes('test'));
  const b = fixture(); b.set.test(1); await b.service.start(b.input); await b.stepUntil(r => r.status === 'failed'); assert.ok(!b.calls.includes('commit'));
  const c = fixture(); c.set.ci('empty'); await c.service.start(c.input); await c.stepUntil(r => r.status === 'waiting' && r.current.startsWith('ci')); c.set.advance(16 * 60000); assert.equal((await c.service.tick(id)).status, 'failed');
  const d = fixture(); d.set.ciHead(); await d.service.start(d.input); assert.equal((await d.stepUntil(r => r.status === 'paused')).status, 'paused');
});
test('re-entry after lost push response reconciles exact remote head and never repeats push', async () => {
  const f = fixture(); const push = f.dp.push; f.dp.push = async v => { await push(v); throw new Error('response lost'); };
  await f.service.start(f.input); const paused = await f.stepUntil(r => r.status === 'paused'); assert.equal(f.calls.filter(c => c === 'push').length, 1);
  await f.service.control(id, 'resume', paused.version); await f.stepUntil(r => r.status === 'completed'); assert.equal(f.calls.filter(c => c === 'push').length, 1);
});
test('unknown test or crash before effect never automatically retries', async () => {
  const f = fixture(); f.dp.test = async () => { f.calls.push('test'); throw new Error('lost'); };
  await f.service.start(f.input); const paused = await f.stepUntil(r => r.status === 'paused');
  await f.service.control(id, 'resume', paused.version); await f.service.tick(id); assert.equal(f.calls.filter(c => c === 'test').length, 1); assert.equal(f.runs.get(id)?.status, 'paused');
  const b = fixture(); await b.service.start(b.input); await b.service.tick(id); const r = b.runs.get(id)!; r.nodes[r.current] = { state: 'running', startedAt: new Date().toISOString() };
  assert.equal((await b.service.tick(id)).status, 'paused'); assert.deepEqual(b.calls, []);
});
function conditionalGraph(): WorkflowGraph {
  const graph = structuredClone(workflowTemplates[1]!.draft), end = graph.nodes.at(-1)!;
  graph.nodes.push({ id: 'judge', label: '判断测试', kind: 'condition', x: 0, y: 0, config: { source: 'test' } }, { id: 'human', label: '人工处理', kind: 'approval', x: 0, y: 0, config: {} }, { id: 'badend', label: '失败结束', kind: 'end', x: 0, y: 0, config: { outcome: 'failure' } });
  graph.edges.at(-1)!.target = 'judge';
  graph.edges.push({ id: 'passedge', source: 'judge', target: end.id, port: 'pass' }, { id: 'failede', source: 'judge', target: 'human', port: 'fail' }, { id: 'humanend', source: 'human', target: 'badend', port: 'next' }); return graph;
}
test('condition uses structured test result; approval waits and CAS protects continuation; unchosen nodes never succeed', async () => {
  const f = fixture(); f.set.test(1); const graph = conditionalGraph(); assert.deepEqual(workflowProblems(graph), []);
  await f.service.saveDefinition({ ...scope, id, expectedRevision: 0, graph, publish: true }); f.input.definitionId = id;
  await f.service.start(f.input); const waiting = await f.stepUntil(r => r.current === 'human' && r.status === 'waiting');
  assert.equal(waiting.nodes['end4'], undefined); await assert.rejects(f.service.control(id, 'approve', waiting.version - 1), /更新/);
  await f.service.control(id, 'approve', waiting.version); assert.equal((await f.service.tick(id)).status, 'failed'); assert.ok(!f.calls.includes('commit'));
});
test('running graph remains fixed after publishing a new template version; other project cannot read or overwrite definition', async () => {
  const f = fixture(); const graph = structuredClone(workflowTemplates[1]!.draft);
  await f.service.saveDefinition({ ...scope, id, expectedRevision: 0, graph, publish: true }); f.input.definitionId = id;
  await f.service.start(f.input); graph.name = 'future'; await f.service.saveDefinition({ ...scope, id, expectedRevision: 1, graph, publish: true });
  assert.notEqual((await f.service.read(id)).graph.name, 'future');
  await assert.rejects(f.service.saveDefinition({ ...scope, projectId: 'PRJ-002', id, expectedRevision: 2, graph, publish: false }), /不属于/);
});
test('pause is not cancellation and concurrent ticks cannot duplicate side effects', async () => {
  const f = fixture(); await f.service.start(f.input); await f.service.tick(id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const prep = f.dp.prepare; f.dp.prepare = async (...args) => { await gate; return prep(...args); };
  const one = f.service.tick(id); await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(f.service.tick(id), /正在推进/); release(); const r = await one;
  const paused = await f.service.control(id, 'pause', r.version); assert.equal(paused.status, 'paused'); await f.service.tick(id); assert.deepEqual(f.calls, ['prepare']);
});

test('templates remain editable without Git readiness and catalogue identifies manual delivery', async () => {
  const f = fixture(); f.p.repository = async () => { throw new Error('no origin'); };
  const catalog = await f.service.catalog(scope);
  assert.equal(catalog.repository, null); assert.equal(catalog.definitions.length, workflowTemplates.length); assert.equal(catalog.hasManualDelivery, false);
  await f.p.delivery.prepare({ ...scope, id, taskRevision: 'r1', baseBranch: 'main', executionSelection: f.input.executionSelection! });
  assert.equal((await f.service.catalog(scope)).hasManualDelivery, true);
});

test('rebound project directory pauses even when remote owner/repository stays identical', async () => {
  const f = fixture(); await f.service.start(f.input); await f.service.tick(id);
  const authorize = f.p.authorize; f.p.authorize = async (...args) => ({ ...await authorize(...args), root: '/other' });
  const r = await f.service.tick(id); assert.equal(r.status, 'paused'); assert.deepEqual(f.calls, []);
  await assert.rejects(f.service.control(id, 'resume', r.version), /仓库/);
});

test('a success conclusion on an unfinished check is not CI success', async () => {
  const f = fixture(); const feedback = f.dp.feedback;
  f.dp.feedback = async (...args) => { const result = await feedback(...args); result.checks[0]!.status = 'in_progress'; return result; };
  await f.service.start(f.input);
  const r = await f.stepUntil(v => v.current.startsWith('ci') && v.status === 'waiting');
  assert.equal(r.nodes[r.current]?.outcome, undefined);
});

test('v2 auto start and confirmed review keep input immutable and accept only owned revision receipts', async () => {
  const f = fixture(); f.input.definitionVersion = 2;
  await f.service.start(f.input);
  const waiting = await f.stepUntil(r => r.transitions?.[r.current]?.state === 'awaiting');
  assert.equal((await f.p.authorize(scope, false)).status, 'in_progress');
  assert.equal(waiting.input.taskRevision, 'r1'); assert.equal(waiting.acceptedTaskRevision, 'state-1');
  assert.ok(f.calls.indexOf('state-start') < f.calls.indexOf('agent'));
  assert.equal((await f.p.delivery.inspect(id)).taskChanged, false);
  await assert.rejects(f.service.control(id, 'confirm-transition', waiting.version - 1), /更新/);
  await f.service.control(id, 'confirm-transition', waiting.version);
  const done = await f.stepUntil(r => r.status === 'completed');
  assert.equal((await f.p.authorize(scope, false)).status, 'review');
  assert.equal(done.acceptedTaskRevision, 'state-2'); assert.equal(done.input.taskRevision, 'r1');
  await f.service.tick(id); assert.equal(f.calls.filter(c => c.startsWith('state-')).length, 2);
});
test('state linkage requires separate consent and invalid nodes/targets cannot publish', async () => {
  const f = fixture(); f.input.definitionVersion = 2; f.input.consent.taskStatus = false;
  await assert.rejects(f.service.start(f.input), /单独确认/); assert.deepEqual(f.calls, []);
  const graph = structuredClone(workflowTemplates[0]!.draft);
  graph.nodes[2]!.config.taskTransition = { phase: 'start', mode: 'auto' };
  assert.ok(workflowProblems(graph).some(p => p.includes('状态联动')));
  assert.equal(workflowGraphSchema.safeParse({ ...graph, nodes: graph.nodes.map(n => ({ ...n, config: { taskTransition: { phase: 'done', mode: 'auto' } } })) }).success, false);
});
test('lost PM response is reconciled by original receipt without replaying transition or Agent', async () => {
  const f = fixture(); f.input.definitionVersion = 2;
  const transition = f.p.transition!; let writes = 0;
  f.p.transition = async (input, reconcile) => { const result = await transition(input, reconcile); if (!reconcile) { writes++; throw new Error('lost response'); } return result; };
  await f.service.start(f.input); const paused = await f.stepUntil(r => r.status === 'paused');
  assert.equal(writes, 1); assert.ok(!f.calls.includes('agent'));
  await f.service.control(id, 'resume', paused.version);
  await f.stepUntil(r => r.transitions?.[r.current]?.state === 'awaiting');
  assert.equal(writes, 1); assert.equal(f.calls.filter(c => c === 'agent').length, 1);
});
test('missing transition receipt never accepts a coincidental manual state or repeats the write', async () => {
  const f = fixture(); f.input.definitionVersion = 2; let writes = 0;
  f.p.transition = async (_input, reconcile) => { if (reconcile) return { status: 'not_found' }; writes++; throw new Error('before dispatch'); };
  await f.service.start(f.input); const paused = await f.stepUntil(r => r.status === 'paused');
  f.set.status('in_progress');
  await assert.rejects(f.service.control(id, 'resume', paused.version), /收据/);
  assert.equal(writes, 1); assert.ok(!f.calls.includes('agent'));
});
test('external edit or cancellation after owned status transition still stops later effects', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); f.input.definitionVersion = 2; await f.service.start(f.input);
    await f.stepUntil(r => !!r.nodes.agent2);
    if (cancel) f.set.status('canceled'); else f.set.revision();
    assert.equal((await f.service.tick(id)).status, 'paused'); assert.ok(!f.calls.includes('test'));
    assert.equal((await f.p.delivery.inspect(id)).taskChanged, true);
  }
});
test('failed CI and stale remote head cannot advance task to review', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture(); f.input.definitionVersion = 2; if (mismatch) f.set.ciHead(); else f.set.ci('failure');
    await f.service.start(f.input); await f.stepUntil(r => r.status === 'paused' || r.status === 'failed');
    assert.equal((await f.p.authorize(scope, false)).status, 'in_progress'); assert.ok(!f.calls.includes('state-review'));
  }
});

test('manual development waits before dispatch; auto review works without a confirmation node', async () => {
  const f = fixture(); const graph = structuredClone(workflowTemplates[2]!.draft);
  graph.nodes.find(n => n.kind === 'agent')!.config.taskTransition!.mode = 'confirm';
  graph.nodes.find(n => n.kind === 'ci')!.config.taskTransition!.mode = 'auto';
  const definitionId = 'manual-start-auto-review';
  f.definitions.set(definitionId, { id: definitionId, ...scope, revision: 1, draft: graph, versions: [{ version: 1, graph, publishedAt: new Date().toISOString() }] });
  f.input.definitionId = definitionId; await f.service.start(f.input);
  const waiting = await f.stepUntil(r => r.transitions?.[r.current]?.state === 'awaiting');
  assert.ok(!f.calls.includes('agent')); assert.equal((await f.p.authorize(scope, false)).status, 'todo');
  assert.equal((await f.service.tick(id)).version, waiting.version);
  await f.service.control(id, 'confirm-transition', waiting.version);
  await f.stepUntil(r => r.status === 'completed');
  assert.equal((await f.p.authorize(scope, false)).status, 'review');
});
test('manual review confirmation rechecks current CI rather than accepting the earlier snapshot', async () => {
  const f = fixture(); f.input.definitionVersion = 2; await f.service.start(f.input);
  const waiting = await f.stepUntil(r => r.transitions?.[r.current]?.state === 'awaiting');
  f.set.ciHead(); await f.service.control(id, 'confirm-transition', waiting.version);
  assert.equal((await f.service.tick(id)).status, 'paused');
  assert.equal((await f.p.authorize(scope, false)).status, 'in_progress'); assert.ok(!f.calls.includes('state-review'));
});

test('v3 waits for named required CI even if another discovered check succeeded', async () => {
  const f = fixture(); f.input.definitionVersion = 3;
  const original = f.dp.feedback;
  f.dp.feedback = async value => ({ ...await original(value), checks: [{ name: 'lint', status: 'completed', conclusion: 'success' }] });
  await f.service.start(f.input);
  const waiting = await f.stepUntil(r => r.current === 'ci7' && r.status === 'waiting');
  assert.match(waiting.message!, /test/); assert.ok(!waiting.transitions?.ci7);
  assert.equal((await f.p.authorize(scope, false)).status, 'in_progress');
  f.dp.feedback = original;
  const confirm = await f.stepUntil(r => r.transitions?.ci7?.state === 'awaiting');
  await f.service.control(id, 'confirm-transition', confirm.version);
  assert.equal((await f.stepUntil(r => r.status === 'completed')).acceptedTaskRevision, 'state-2');
});
test('required CI never silently succeeds when a check is missing until timeout', async () => {
  const f = fixture(); f.input.definitionVersion = 3; f.set.ci('empty');
  await f.service.start(f.input); await f.stepUntil(r => r.current === 'ci7' && r.status === 'waiting');
  f.set.advance(16 * 60_000);
  assert.equal((await f.service.tick(id)).status, 'failed'); assert.ok(!f.calls.includes('state-review'));
  assert.equal(workflowTemplates[2]!.versions[1]!.graph.nodes.find(n => n.kind === 'ci')!.config.requiredChecks, undefined);
});
test('explicit replacement Session preserves immutable workflow input/nodes and delivery evidence without replay', async () => {
  const f = fixture(); await f.service.start(f.input);
  const completed = await f.stepUntil(run => run.status === 'completed');
  const before = structuredClone(completed), calls = [...f.calls], delivery = f.deliveries.get(id)!;
  const selection = { ...f.input.executionSelection!, agentWorkspaceRevision: 2 };
  const replaced = await f.service.replaceSession(id, completed.version, selection);
  assert.deepEqual(replaced.input, before.input);
  assert.deepEqual(replaced.nodes, before.nodes);
  assert.equal(replaced.status, before.status);
  assert.deepEqual(replaced.executionSelection, selection);
  assert.deepEqual(f.deliveries.get(id)!.previousThreadIds, [delivery.threadId]);
  assert.deepEqual(f.deliveries.get(id)!.git, delivery.git);
  assert.deepEqual(f.deliveries.get(id)!.test, delivery.test);
  assert.deepEqual(f.calls, calls);
  await assert.rejects(f.service.replaceSession(id, completed.version, selection), /已更新/);
});
test('historical workflow receipts stay readable while background execution pauses before any node side effect', async () => {
  const f = fixture(); await f.service.start(f.input);
  const run = f.runs.get(id)!;
  run.input = { ...run.input, executionSelection: { version: 1 } } as unknown as WorkflowRun['input'];
  let receivedSelection: unknown = 'not-called';
  const authorize = f.p.authorize;
  f.p.authorize = async (target, write) => { receivedSelection = target.executionSelection; return authorize(target, write); };
  assert.deepEqual(await f.service.read(id), run);
  assert.equal(receivedSelection, undefined, 'Historical reads authorize the PM task, never resolve old directory data');
  const paused = await f.service.tick(id);
  assert.equal(paused.status, 'paused'); assert.match(paused.message!, /历史工作流/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.service.control(id, 'resume', paused.version), /历史工作流/);
  assert.equal((await f.service.read(id)).input.executionSelection?.version, 1);
});
test('workflow catalogue without an explicit Agent folder never probes the server cwd or a PM-derived repository', async () => {
  const f = fixture(); let probes = 0;
  f.p.repository = async () => { probes++; return 'server/process-cwd'; };
  const catalog = await f.service.catalog(scope);
  assert.equal(probes, 0); assert.equal(catalog.repository, null); assert.equal(catalog.defaultBase, null);
  assert.equal(catalog.definitions.length, workflowTemplates.length);
});

test('changed requirement replacement preserves workflow CAS and immutable input, while resume still refuses old requirements', async () => {
  const f = fixture('builtin-validate'); await f.service.start(f.input);
  await f.service.tick(id); await f.service.tick(id);
  const paused = await f.service.control(id, 'pause', f.runs.get(id)!.version);
  const original = structuredClone(paused), delivery = f.deliveries.get(id)!;
  f.set.revision();
  const replacement = await f.service.replaceSession(id, paused.version, f.input.executionSelection!);
  assert.deepEqual(replacement.input, original.input); assert.deepEqual(replacement.nodes, original.nodes);
  assert.equal(replacement.status, 'paused');
  assert.notEqual(f.deliveries.get(id)!.threadId, delivery.threadId);
  assert.equal(f.deliveries.get(id)!.taskRevision, f.input.taskRevision);
  await assert.rejects(f.service.control(id, 'resume', replacement.version), { code: 'task_changed' });
  await assert.rejects(f.service.replaceSession(id, paused.version, f.input.executionSelection!), { code: 'workflow_conflict' });
  assert.deepEqual(f.calls, ['prepare']);
});

test('green remote CI cannot advance a workflow after a local worktree change', async () => {
  const f = fixture(); f.input.definitionVersion = 2; await f.service.start(f.input);
  await f.stepUntil(run => run.graph.nodes.find(node => node.id === run.current)?.kind === 'ci');
  f.dp.tree = async () => ({ head: 'b'.repeat(40), fingerprint: 'edited-after-commit', files: ['src/unverified.ts'], diff: '+unverified' });
  const paused = await f.service.tick(id);
  assert.equal(paused.status, 'paused'); assert.match(paused.message!, /陈旧/);
  assert.ok(!f.calls.includes('state-review'));
  assert.equal((await f.p.authorize(scope, false)).status, 'in_progress');
});

test('canvas preset advances start and review with scoped consent, not business completion', async () => {
  const f = fixture('builtin-canvas-deliver');
  await f.service.start(f.input);
  const result = await f.stepUntil(r => r.status === 'completed');
  assert.equal(result.status, 'completed');
  assert.equal(f.calls.filter(c => c === 'state-start').length, 1);
  assert.equal(f.calls.filter(c => c === 'state-review').length, 1);
  assert.ok(!f.calls.some(c => c === 'state-done'));
  const g = fixture('builtin-canvas-deliver');
  g.set.ci('failure'); await g.service.start(g.input);
  await g.stepUntil(r => r.status === 'failed');
  assert.ok(!g.calls.includes('state-review'));
});

function enableLocal(f: ReturnType<typeof fixture>) {
  f.dp.verifyLocal = async () => { f.calls.push('local-verify'); return { executor: 'linux-bwrap-node24-v1', passed: true, exitCode: 0, outputDigest: 'local-proof', counts: { tests: 4, pass: 4, skipped: 0, cancelled: 0, todo: 0, fail: 0 } }; };
}

async function failedLocalTest() {
  const f = fixture('builtin-canvas-local'); enableLocal(f); f.set.test(1);
  await f.service.start(f.input); const failed = await f.stepUntil(r => r.status === 'failed');
  assert.equal(failed.current, 'test3');
  return { ...f, failed };
}
test('explicit source repair records a new test attempt, preserves failure and resumes without redeveloping', async () => {
  const f = await failedLocalTest(), prior = structuredClone(f.deliveries.get(id)!.test);
  f.set.tree({ fingerprint: 'fixed' }); f.set.test(0);
  const r = await f.service.control(id, 'retry-test', f.failed.version);
  assert.equal(r.status, 'paused'); assert.equal(r.current, 'testRepair1');
  assert.deepEqual(r.input, f.failed.input); assert.deepEqual(r.nodes.test3, f.failed.nodes.test3);
  assert.deepEqual(r.testRepairs?.[0]?.previousTest, prior); assert.deepEqual(r.testRepairs?.[0]?.previousGraph, f.failed.graph);
  assert.equal(r.nodes.testRepair1, undefined); assert.equal(f.calls.filter(c => c === 'test').length, 1);
  assert.deepEqual(await f.service.control(id, 'retry-test', r.version), r);
  await assert.rejects(f.service.control(id, 'retry-test', f.failed.version), /版本|更新/);
  await f.service.control(id, 'resume', r.version);
  const done = await f.stepUntil(v => v.status === 'completed');
  assert.equal(done.nodes.test3?.state, 'failed'); assert.equal(done.nodes.testRepair1?.state, 'succeeded');
  assert.equal(f.calls.filter(c => c === 'test').length, 2); assert.equal(f.calls.filter(c => c === 'agent').length, 1);
  assert.equal(f.calls.filter(c => c === 'commit').length, 1); assert.equal(f.calls.filter(c => c === 'push').length, 1);
  assert.equal(f.calls.filter(c => c === 'pr').length, 1); assert.equal((await f.p.authorize(scope, false)).status, 'review');
});
test('test repair rejects unchanged content, unknown effects, stale task, denied access and changed HEAD', async () => {
  for (const bad of ['unchanged', 'pending', 'revision', 'deny', 'head', 'generation', 'committed'] as const) {
    const f = await failedLocalTest();
    if (bad !== 'unchanged') f.set.tree({ fingerprint: 'fixed' });
    if (bad === 'pending') f.deliveries.get(id)!.pending = { action: 'test', at: 'now' };
    if (bad === 'revision') f.set.revision(); if (bad === 'deny') f.set.deny();
    if (bad === 'head') f.set.tree({ head: 'c'.repeat(40) });
    if (bad === 'generation') f.deliveries.get(id)!.generationStatus = 'running';
    if (bad === 'committed') f.deliveries.get(id)!.step = 'committed';
    await assert.rejects(f.service.control(id, 'retry-test', f.failed.version));
    assert.equal(f.runs.get(id)?.testRepairs, undefined); assert.equal(f.calls.filter(c => c === 'test').length, 1);
  }
});
test('repair confirmation is bound to exact source and each repeated failure remains distinct', async () => {
  const changed = await failedLocalTest(); changed.set.tree({ fingerprint: 'fixed' });
  const ready = await changed.service.control(id, 'retry-test', changed.failed.version);
  changed.set.tree({ fingerprint: 'changed-after-confirmation' });
  await changed.service.control(id, 'resume', ready.version);
  assert.equal((await changed.service.tick(id)).status, 'paused'); assert.equal(changed.calls.filter(c => c === 'test').length, 1);
  const f = await failedLocalTest(); f.set.tree({ fingerprint: 'first-fix' });
  const repair = await f.service.control(id, 'retry-test', f.failed.version); await f.service.control(id, 'resume', repair.version);
  const failedAgain = await f.service.tick(id); assert.equal(failedAgain.status, 'failed'); assert.equal(failedAgain.nodes.testRepair1?.state, 'failed');
  f.set.tree({ fingerprint: 'second-fix' });
  const second = await f.service.control(id, 'retry-test', failedAgain.version);
  assert.equal(second.current, 'testRepair2'); assert.equal(second.testRepairs?.length, 2);
  assert.equal(second.nodes.test3?.state, 'failed'); assert.equal(second.nodes.testRepair1?.state, 'failed');
});
test('repair endpoint contract requires exact action, version and explicit confirmation', () => {
  assert.ok(workflowControlSchema.safeParse({ action: 'retry-test', version: 1, confirm: true }).success);
  for (const value of [{ action: 'retry-test', version: 1 }, { action: 'retry-test', version: 1, confirm: false }, { action: 'retry-test', version: 1, confirm: true, skipTests: true }]) assert.equal(workflowControlSchema.safeParse(value).success, false);
});
test('explicit cloud-to-local amendment preserves original input, failed CI record and graph; completes with real local evidence only', async () => {
  const f = fixture('builtin-canvas-deliver'); enableLocal(f); f.set.ci('empty'); await f.service.start(f.input);
  await f.stepUntil(r => r.status === 'waiting' && r.current.startsWith('ci'));
  f.set.advance(31 * 60_000); const failed = await f.service.tick(id); assert.equal(failed.status, 'failed');
  const original = structuredClone(failed), v = await f.service.useLocalVerification(id, failed.version);
  assert.equal(v.status, 'paused'); assert.equal(v.current, 'localVerification'); assert.deepEqual(v.input, original.input);
  assert.deepEqual(v.localSwitch?.previousGraph, original.graph); assert.deepEqual(v.nodes[original.current], original.nodes[original.current]);
  assert.equal(v.nodes[original.current]?.state, 'failed'); assert.equal(v.nodes.localVerification, undefined);
  assert.deepEqual(await f.service.useLocalVerification(id, v.version), v);
  await assert.rejects(f.service.useLocalVerification(id, failed.version), /版本/);
  await f.service.control(id, 'resume', v.version); const complete = await f.stepUntil(r => r.status === 'completed');
  assert.equal(complete.nodes.localVerification?.state, 'succeeded'); assert.equal(complete.nodes[original.current]?.state, 'failed');
  assert.deepEqual(f.deliveries.get(id)?.feedback?.checks, []); assert.equal(f.calls.filter(c => c === 'agent').length, 1);
  assert.equal(f.calls.filter(c => c === 'local-verify').length, 1); assert.ok(f.calls.includes('state-review'));
});
test('local preset never requires cloud CI, but skipped tests or changed PR head cannot pass review', async () => {
  for (const bad of ['none', 'skipped', 'head'] as const) {
    const f = fixture('builtin-canvas-local'); enableLocal(f); f.set.ci('empty');
    if (bad === 'skipped') f.dp.verifyLocal = async () => ({ executor: 'linux-bwrap-node24-v1', passed: true, exitCode: 0, outputDigest: 'bad', counts: { tests: 2, pass: 1, skipped: 1, cancelled: 0, todo: 0, fail: 0 } });
    if (bad === 'head') f.set.ciHead();
    await f.service.start(f.input); const r = await f.stepUntil(r => ['failed', 'completed'].includes(r.status));
    assert.equal(r.status, bad === 'none' ? 'completed' : 'failed'); assert.equal(f.calls.includes('state-review'), bad === 'none');
  }
});
test('migration rejects running/early failure, unknown side effects, dirty tree, changed task and denied authority', async () => {
  const early = fixture('builtin-canvas-deliver'); await early.service.start(early.input);
  await assert.rejects(early.service.useLocalVerification(id, early.runs.get(id)!.version));
  for (const bad of ['pending', 'dirty', 'task', 'deny'] as const) {
    const f = fixture('builtin-canvas-deliver'); f.set.ci('empty'); await f.service.start(f.input); const r = await f.stepUntil(r => r.status === 'waiting');
    const paused = await f.service.control(id, 'pause', r.version);
    if (bad === 'pending') f.deliveries.get(id)!.pending = { action: 'verify-local', at: 'now' };
    if (bad === 'dirty') f.dp.tree = async () => ({ head: 'b'.repeat(40), fingerprint: 'dirty', files: ['file'], diff: '' });
    if (bad === 'task') f.set.revision(); if (bad === 'deny') f.set.deny();
    await assert.rejects(f.service.useLocalVerification(id, paused.version)); assert.equal(f.runs.get(id)?.localSwitch, undefined);
  }
});
