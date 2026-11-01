import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { emptyRoadmap, type RoadmapPlan } from '../../../../../packages/contracts/src/product-roadmap.ts';
import { checkRoadmapBase, confirmedDelivery, inspectRoadmapDelivery, roadmapSuggestedBase, type RoadmapDeliveryPorts } from './roadmap.ts';

test('real Git ancestry gates sequential task baselines and integrated preview; CI/status alone never imply integration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-git-'));
  const run = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  try {
    run('init', '-q'); run('config', 'user.name', 'Isolated fixture'); run('config', 'user.email', 'fixture@example.test');
    run('commit', '--allow-empty', '-qm', 'first'); const first = run('rev-parse', 'HEAD');
    run('commit', '--allow-empty', '-qm', 'second'); const second = run('rev-parse', 'HEAD');
    run('checkout', '--orphan', 'unrelated'); run('commit', '--allow-empty', '-qm', 'unrelated'); const unrelated = run('rev-parse', 'HEAD');
    const workspaceId = randomUUID(), projectId = 'PRJ-001', releaseId = randomUUID(), ids = [randomUUID(), randomUUID()];
    const plan: RoadmapPlan = { ...emptyRoadmap(), nodes: ids.map((id, index) => ({ id, title: `Task ${index}`, outcome: 'Outcome', acceptance: 'Verify', nonGoals: '', stage: 'M1', dependsOn: index ? [ids[0]!] : [], x: 0, y: 0 })) };
    const records = [first, second].map((head, index): TaskCodeDelivery => ({ id: randomUUID(), workspaceId, projectId, taskId: `TASK-00${index + 1}`, taskRevision: 'rev', title: `Task ${index}`, description: '', baseBranch: 'main', threadId: `fixture-${index}`, createdAt: `2026-11-02T00:00:0${index}Z`, updatedAt: '2026-11-02T00:00:00Z', step: 'pr', version: 1,
      git: { root, directory: root, directoryIdentity: 'fixture', commonDirectory: root, remote: 'https://github.com/example/fixture.git', owner: 'example', repo: 'fixture', baseBranch: 'main', baseSha: first, branch: `task-${index}` },
      head, pr: { number: index + 1, url: `https://github.com/example/fixture/pull/${index + 1}` }, test: { passed: true, fingerprint: 'fingerprint', command: 'npm test', exitCode: 0, outputDigest: 'test', at: '2026-11-02T00:00:00Z' }, feedback: { head, state: 'open', draft: true, observedAt: '2026-11-02T00:00:00Z', checks: [{ name: 'test', status: 'completed', conclusion: 'success' }], reviews: [] } }));
    const rows = records.map((r, i) => ({ nodeId: ids[i], taskId: r.taskId, title: r.title, revision: 'rev', archived: false, drifted: false, status: 'review' }));
    const ports: RoadmapDeliveryPorts = {
      request: async endpoint => endpoint.endsWith('/product-roadmap') ? { projectId, archived: false, store: { schema: 'pm/product-roadmap/v1', draft: plan, releases: [{ id: releaseId, plan, publishedAt: '2026-11-02T00:00:00Z', publishedBy: 'fixture' }] }, tasks: { [releaseId]: rows } } : { entity: { 'x-pm-roadmap-origin': { releaseId, nodeId: ids[1] } } },
      list: () => records, authorize: async scope => ({ ...scope, root, revision: 'rev', title: 'Task', description: '' }), revision: r => r.taskRevision,
      git: async (_cwd, ...args) => args[0] === 'remote' ? 'https://github.com/example/fixture.git' : run(...args), verify: async () => {}, feedback: async r => r.feedback!,
    };
    const scope = { workspaceId, projectId, releaseId }, task = { workspaceId, projectId, taskId: records[1]!.taskId, root, revision: 'rev', title: 'Next', description: '' };
    assert.equal(await roadmapSuggestedBase(task, new Headers(), ports), 'task-0');
    await checkRoadmapBase(task, 'main', new Headers(), second, ports);
    await assert.rejects(checkRoadmapBase(task, 'main', new Headers(), unrelated, ports), /不包含前置成果/);
    const integrated = await inspectRoadmapDelivery(scope, new Headers(), true, ports);
    assert.equal(integrated.eligible, true); assert.equal(integrated.candidate?.head, second); assert.ok(integrated.items.every(i => i.included));
    records[1]!.head = unrelated; records[1]!.feedback!.head = unrelated;
    assert.equal((await inspectRoadmapDelivery(scope, new Headers(), false, ports)).eligible, false);
    records[1]!.head = second; records[1]!.feedback!.head = second;
    records[0]!.feedback!.checks = [];
    assert.equal(confirmedDelivery(records[0]!), false);
    await assert.rejects(checkRoadmapBase(task, 'main', new Headers(), second, ports));
    assert.equal((await inspectRoadmapDelivery(scope, new Headers(), false, ports)).eligible, false);
    records[0]!.feedback!.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }]; rows[0]!.drifted = true;
    assert.equal((await inspectRoadmapDelivery(scope, new Headers(), false, ports)).eligible, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
