import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyCandidate, parseCandidate, planningPrompt, readCandidate, type PlanningRecord, type PlanningHistory } from '../apps/web/src/features/pm/product-roadmap/agent-planning.ts';
import { feedbackScenario } from '../apps/web/src/features/pm/product-roadmap/model.ts';
const plan = () => feedbackScenario(randomUUID);
const node = (key = 'T1', dependsOn: string[] = []) => ({ key, title: '提交并查看反馈', outcome: '客户提交，管理员看到持久化反馈', acceptance: '提交有效内容后刷新可见；空标题被拒绝', nonGoals: '支付', stage: 'M1 · 闭环', dependsOn });
const raw = (nodes = [node()], questions: string[] = []) => JSON.stringify({ summary: '先验证反馈能被接收和处理', questions, nodes });
const record = (): PlanningRecord => ({ threadId: randomUUID(), messageId: randomUUID(), snapshot: plan(), revision: 'rev1', provider: 'codex', model: 'test' });
test('strict candidates accept JSON or one fence, reject extras, malformed and empty output', () => {
  assert.equal(parseCandidate('```json\n' + raw() + '\n```').nodes.length, 1);
  assert.throws(() => parseCandidate('说明：' + raw()));
  assert.throws(() => parseCandidate(JSON.stringify({ ...JSON.parse(raw()), execute: true })));
  assert.throws(() => parseCandidate(raw([])));
  assert.equal(parseCandidate(raw([], ['谁可以查看反馈？'])).questions.length, 1);
  assert.throws(() => parseCandidate('x'.repeat(240001)));
});
test('reject duplicate keys, self, missing, duplicate dependencies and cycles', () => {
  for (const nodes of [[node(), node()], [node('T1', ['T1'])], [node('T1', ['missing'])], [node(), node('T2', ['T1', 'T1'])], [node('T1', ['T2']), node('T2', ['T1'])]]) assert.throws(() => parseCandidate(raw(nodes)));
});
test('application preserves PRD and reused node IDs, maps dependencies and never mutates source', () => {
  const r = record(), original = JSON.stringify(r.snapshot), old = r.snapshot.nodes[0]!.id;
  const candidate = parseCandidate(raw([node(old), node('T2', [old])]));
  const applied = applyCandidate(candidate, r, r.snapshot, r.revision, randomUUID);
  assert.equal(applied.nodes[0]!.id, old);
  assert.deepEqual(applied.nodes[1]!.dependsOn, [old]);
  assert.deepEqual(applied.brief, r.snapshot.brief);
  assert.equal(JSON.stringify(r.snapshot), original);
});
test('stale revisions, manual edits, missing PRD and unresolved questions cannot overwrite drafts', () => {
  const r = record(), c = parseCandidate(raw());
  assert.throws(() => applyCandidate(c, r, r.snapshot, 'rev2', randomUUID));
  const changed = structuredClone(r.snapshot); changed.nodes[0]!.title = '手动保留';
  assert.throws(() => applyCandidate(c, r, changed, r.revision, randomUUID));
  assert.throws(() => applyCandidate(parseCandidate(raw([node()], ['确认范围？'])), r, r.snapshot, r.revision, randomUUID));
  r.snapshot.brief.idea = '';
  assert.throws(() => applyCandidate(c, r, r.snapshot, r.revision, randomUUID));
});
test('only the completed generation assistant output can become a candidate', () => {
  const h: PlanningHistory = { latestGeneration: { id: 'g', messageId: 'a', status: 'completed' }, messages: [{ id: 'a', content: { role: 'assistant', parts: [{ type: 'text', text: raw() }] } }] };
  assert.equal(readCandidate(h)?.nodes.length, 1);
  assert.equal(readCandidate({ ...h, activeGenerationId: 'g' }), null);
  assert.equal(readCandidate({ ...h, latestGeneration: null }), null);
  assert.throws(() => readCandidate({ ...h, messages: [] }));
  for (const status of ['failed', 'interrupted', 'cancelled']) assert.throws(() => readCandidate({ ...h, latestGeneration: { ...h.latestGeneration!, status } }));
});
test('prompt includes user snapshot and constraints, not source authorization', () => {
  const p = plan(), prompt = planningPrompt(p, '先做演示');
  assert.ok(prompt.includes('不发布任务')); assert.ok(prompt.includes('不能把假设变事实'));
  assert.ok(prompt.includes('节点文案面向功能设计')); assert.ok(prompt.includes('不要在每个节点重复'));
  assert.ok(prompt.includes(JSON.stringify({ plan: p, instruction: '先做演示' })));
});

test('planning candidate cannot silently discard the adopted product design',()=>{
  const source=record();source.snapshot.design={versionId:randomUUID(),sha256:'a'.repeat(64),title:'已采用设计',notes:'保留体验基调'};
  const result=applyCandidate(parseCandidate(raw()),source,source.snapshot,source.revision,randomUUID);
  assert.deepEqual(result.design,source.snapshot.design);
});
