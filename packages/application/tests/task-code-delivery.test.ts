import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskCodeDeliveryService, type DeliveryPorts, type DeliveryTask } from '../src/task-code-delivery.ts';
import type { DeliveryGit, DeliveryTree, TaskCodeDelivery } from '../../contracts/src/task-code-delivery.ts';

function fixture() {
  const records = new Map<string, TaskCodeDelivery>();
  const task: DeliveryTask = { workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', taskId: 'TASK-001', revision: 'revision-1', title: 'Example', description: 'Implement one thing', root: '/project' };
  const input = { ...task, taskRevision: task.revision, id: '11111111-1111-4111-8111-222222222222', baseBranch: 'main' };
  const git: DeliveryGit = { root: task.root, directory: '/delivery', directoryIdentity: '1:2', commonDirectory: '/project/.git', remote: 'https://github.com/o/r.git', owner: 'o', repo: 'r', branch: 'codex/task-001-id', baseBranch: 'main', baseSha: 'base' };
  let tree: DeliveryTree = { head: 'base', fingerprint: 'clean', files: [], diff: '' };
  let remote: string | null = null;
  let deny = false;
  const calls: string[] = [];
  const ports: DeliveryPorts = {
    read: id => structuredClone(records.get(id) ?? null), list: () => structuredClone([...records.values()]), save: v => { records.set(v.id, structuredClone(v)); },
    authorize: async (_scope, write) => { calls.push(write ? 'authorize-write' : 'authorize-read'); if (deny) throw new Error('denied'); return task; },
    prepare: async () => { calls.push('prepare'); return git; }, verify: async () => {}, tree: async () => tree,
    develop: async (_v, provider, model) => { calls.push(`develop:${provider}:${model}`); tree = { head: 'base', fingerprint: 'new', files: ['src/index.ts'], diff: '+code' }; return 'generation'; },
    generation: () => ({ id: 'generation', status: 'completed' }), busy: () => false,
    test: async () => ({ exitCode: 0, outputDigest: 'digest' }),
    commit: async () => { calls.push('commit'); tree = { head: 'commit-sha', fingerprint: 'committed', files: [], diff: '' }; return tree.head; },
    push: async () => { calls.push('push'); remote = 'commit-sha'; }, remoteHead: async () => remote,
    findPr: async () => null, createPr: async () => { calls.push('create-pr'); return { number: 1, url: 'https://github.com/o/r/pull/1' }; },
    feedback: async () => ({ head: 'commit-sha', state: 'open', draft: true, observedAt: 'now', checks: [], reviews: [] }),
  };
  const service = new TaskCodeDeliveryService(ports);
  const developed = async () => { await service.prepare(input); await service.act(input.id, { action: 'develop', providerInstanceId: 'existing-provider', model: 'chosen-model' }); return service.act(input.id, { action: 'refresh' }); };
  const committed = async () => { await developed(); await service.act(input.id, { action: 'test', command: 'test-command', confirm: true }); return service.act(input.id, { action: 'commit', fingerprint: tree.fingerprint, confirm: true }); };
  return { service, ports, records, input, task, calls, developed, committed, setTree: (v: DeliveryTree) => { tree = v; }, deny: () => { deny = true; } };
}
test('task → branch → selected provider → real-command evidence → explicit commit/push/draft → feedback; never task completion', async () => {
  const f = fixture();
  const committed = await f.committed();
  assert.equal(committed.step, 'committed');
  assert.equal(f.calls.includes('push'), false);
  await f.service.act(f.input.id, { action: 'push', head: 'commit-sha', confirm: true });
  assert.equal(f.calls.includes('create-pr'), false);
  await f.service.act(f.input.id, { action: 'draft-pr', head: 'commit-sha', confirm: true });
  const result = await f.service.act(f.input.id, { action: 'refresh' });
  assert.equal(result.step, 'pr'); assert.deepEqual(result.feedback?.checks, []);
  assert.ok(f.calls.includes('develop:existing-provider:chosen-model'));
  assert.equal('status' in result, false); assert.equal('status' in f.task, false);
});
test('same prepare key returns same receipt; another delivery for a task is not silently created', async () => {
  const f = fixture();
  const a = await f.service.prepare(f.input), b = await f.service.prepare(f.input);
  assert.equal(a.id, b.id); assert.equal(f.calls.filter(c => c === 'prepare').length, 1);
  await assert.rejects(f.service.prepare({ ...f.input, id: 'different-id' }), /已有记录/);
  await assert.rejects(f.service.prepare({ ...f.input, baseBranch: 'other' }), /更换范围/);
});
test('stale task, stale tests, read/write denial and wrong phase fail closed', async () => {
  const f = fixture(); await f.developed();
  await assert.rejects(f.service.act(f.input.id, { action: 'push', head: 'base', confirm: true }), /只允许推送/);
  await f.service.act(f.input.id, { action: 'test', command: 'test', confirm: true });
  f.setTree({ head: 'base', fingerprint: 'changed', files: ['src/index.ts'], diff: 'changed' });
  await assert.rejects(f.service.act(f.input.id, { action: 'commit', fingerprint: 'new', confirm: true }), /完全一致/);
  f.task.revision = 'changed';
  await assert.rejects(f.service.act(f.input.id, { action: 'develop', providerInstanceId: 'p', model: 'm' }), /任务版本/);
  f.deny(); await assert.rejects(f.service.inspect(f.input.id), /denied/); await assert.rejects(f.service.list(f.input), /denied/);
});
test('test output never substitutes for process exit and an unchanged worktree', async () => {
  const f = fixture(); await f.developed();
  f.ports.test = async () => { f.setTree({ head: 'base', fingerprint: 'changed', files: ['a'], diff: '' }); return { exitCode: 0, outputDigest: 'all passed' }; };
  const result = await f.service.act(f.input.id, { action: 'test', command: 'test', confirm: true });
  assert.equal(result.test?.passed, false);
});
test('lost push response is reconciled, not replayed, including after service restart', async () => {
  const f = fixture(); await f.committed();
  const push = f.ports.push; f.ports.push = async v => { await push(v); throw new Error('lost response'); };
  const unknown = await f.service.act(f.input.id, { action: 'push', head: 'commit-sha', confirm: true });
  assert.equal(unknown.pending?.action, 'push');
  const restarted = new TaskCodeDeliveryService(f.ports);
  await assert.rejects(restarted.act(f.input.id, { action: 'push', head: 'commit-sha', confirm: true }), /尚未确认/);
  const recovered = await restarted.act(f.input.id, { action: 'refresh' });
  assert.equal(recovered.step, 'pushed'); assert.equal(recovered.pending, undefined);
  assert.equal(f.calls.filter(c => c === 'push').length, 1);
});
test('lost Draft PR response uses the original marker and never creates again', async () => {
  const f = fixture(); await f.committed(); await f.service.act(f.input.id, { action: 'push', head: 'commit-sha', confirm: true });
  f.ports.createPr = async () => { f.calls.push('create-pr'); throw new Error('lost response'); };
  await f.service.act(f.input.id, { action: 'draft-pr', head: 'commit-sha', confirm: true });
  f.ports.findPr = async () => ({ number: 12, url: 'https://github.com/o/r/pull/12' });
  const result = await f.service.act(f.input.id, { action: 'refresh' });
  assert.equal(result.pr?.number, 12); assert.equal(f.calls.filter(c => c === 'create-pr').length, 1);
});
test('unknown test or commit is not inferred from a clean tree or silently retried', async () => {
  const f = fixture(); await f.developed(); f.ports.test = async () => { throw new Error('process lost'); };
  await f.service.act(f.input.id, { action: 'test', command: 'test', confirm: true });
  const v = await f.service.act(f.input.id, { action: 'refresh' }); assert.equal(v.pending?.action, 'test');
  await assert.rejects(f.service.act(f.input.id, { action: 'test', command: 'test', confirm: true }), /尚未确认/);
});
test('concurrent action cannot start a second external effect', async () => {
  const f = fixture(); await f.service.prepare(f.input);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.ports.develop = async () => { await gate; return 'id'; };
  const one = f.service.act(f.input.id, { action: 'develop', providerInstanceId: 'p', model: 'm' });
  await assert.rejects(f.service.act(f.input.id, { action: 'develop', providerInstanceId: 'p', model: 'm' }), /正在执行/);
  release(); await one;
});

test('read-only preflight errors do not poison a task or create unknown side effects', async () => {
  const f = fixture();
  f.ports.preflightPrepare = async () => { throw new Error('missing repository authentication'); };
  await assert.rejects(f.service.prepare(f.input), /authentication/); assert.equal(f.records.size, 0);
  delete f.ports.preflightPrepare;
  await f.service.prepare(f.input);
  f.ports.preflightAction = async () => { throw new Error('provider not ready'); };
  await assert.rejects(f.service.act(f.input.id, { action: 'develop', providerInstanceId: 'p', model: 'm' }), /provider not ready/);
  assert.equal(f.records.get(f.input.id)?.pending, undefined); assert.equal(f.records.get(f.input.id)?.step, 'ready');
});


test('worktree write confirmation is explicit per development attempt, persisted before dispatch, never inherited', async () => {
  const f = fixture(); await f.service.prepare(f.input);
  const seen: Array<boolean | undefined> = [];
  f.ports.develop = async v => { seen.push(f.records.get(v.id)?.worktreeWriteConfirmed); return 'generation'; };
  await f.service.act(f.input.id, { action: 'develop', providerInstanceId: 'p', model: 'm', allowWorktreeWrite: true });
  assert.deepEqual(seen, [true]);
  await f.service.act(f.input.id, { action: 'refresh' });
  await f.service.act(f.input.id, { action: 'develop', providerInstanceId: 'p', model: 'm' });
  assert.deepEqual(seen, [true, false]);
});
