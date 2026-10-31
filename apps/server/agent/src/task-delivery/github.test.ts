import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { DeliveryGitHub } from './github.ts';
const value = { id: 'delivery-id', taskId: 'TASK-001', title: 'Task', taskRevision: 'rev', head: 'sha', git: { owner: 'o', repo: 'r', branch: 'codex/task-001', baseBranch: 'main' }, pr: { number: 1 } } as TaskCodeDelivery;
const pr = { number: 1, html_url: 'https://github.com/o/r/pull/1', body: 'PM-Delivery: delivery-id', draft: true, state: 'open', merged: false, head: { sha: 'sha', ref: 'codex/task-001', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
test('create always requests a draft; find matches marker, repo, base, branch and head', async () => {
  const requests: unknown[] = [];
  const client = new DeliveryGitHub(async (path, input) => { requests.push(input); return path.includes('?') ? [pr] : pr; });
  assert.equal((await client.create(value)).number, 1);
  assert.equal((requests[0] as { draft: boolean }).draft, true);
  assert.equal((await client.find(value))?.number, 1);
  await assert.rejects(new DeliveryGitHub(async () => [{ ...pr, body: 'wrong' }]).find(value), /不匹配/);
  await assert.rejects(new DeliveryGitHub(async () => [pr, pr]).find(value), /唯一/);
});
test('empty CI/reviews remain empty; feedback follows changed remote head without claiming old tests apply', async () => {
  const client = new DeliveryGitHub(async path => path.includes('check-runs') ? { check_runs: [] } : path.includes('/statuses?') || path.includes('/reviews?') ? [] : { ...pr, head: { ...pr.head, sha: 'new-sha' } });
  const result = await client.feedback(value); assert.equal(result.head, 'new-sha'); assert.deepEqual(result.checks, []); assert.deepEqual(result.reviews, []);
});
test('CI and reviews paginate completely and duplicate status contexts use newest first', async () => {
  const paths: string[] = [];
  const client = new DeliveryGitHub(async path => {
    paths.push(path);
    if (path.includes('check-runs')) return { check_runs: path.includes('&page=1') ? Array.from({ length: 100 }, (_, i) => ({ name: `check-${i}`, status: 'completed', conclusion: 'success' })) : [{ name: 'last', status: 'completed', conclusion: 'failure' }] };
    if (path.includes('/statuses?')) return [{ context: 'ci', state: 'failure' }, { context: 'ci', state: 'success' }];
    if (path.includes('/reviews?')) return [{ id: 2, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', commit_id: 'old', body: 'fix it' }];
    return pr;
  });
  const result = await client.feedback(value);
  assert.equal(result.checks.length, 102); assert.equal(result.checks.at(-1)?.conclusion, 'failure'); assert.equal(result.reviews[0]?.commit, 'old');
  assert.ok(paths.some(p => p.includes('page=2')));
});
test('snapshot head race and incomplete pagination fail closed', async () => {
  let reads = 0;
  const client = new DeliveryGitHub(async path => {
    if (path.includes('check-runs')) return { check_runs: [] };
    if (path.includes('?')) return [];
    reads++; return reads === 1 ? pr : { ...pr, head: { ...pr.head, sha: 'raced' } };
  });
  await assert.rejects(client.feedback(value), /读取期间/);
  await assert.rejects(new DeliveryGitHub(async path => path.includes('check-runs') ? { check_runs: Array(100).fill({}) } : path.includes('?') ? [] : pr).feedback(value), /不完整/);
});
