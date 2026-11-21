import assert from 'node:assert/strict';
import test from 'node:test';
import { agentChatContextSourceSchema, type AgentChatContextSource } from '../../../packages/agent-contracts/src/pm-tool-result.ts';
import { deduplicateBriefContextSources } from '../../../apps/server/pm/src/agent-tools/agent-chat-tools.ts';

const source = agentChatContextSourceSchema.parse({ kind: 'task', workspaceId: '33333333-3333-4333-8333-333333333333', projectId: 'PRJ-001', entityId: 'TASK-001', title: 'Migration decision', revision: 'a'.repeat(64), truncated: false });

test('brief source projection retains every differing metadata field, including revision, title and truncation', () => {
  const variants: AgentChatContextSource[] = [
    { ...source, kind: 'document' },
    { ...source, workspaceId: '44444444-4444-4444-8444-444444444444' },
    { ...source, projectId: 'PRJ-002' },
    { ...source, entityId: 'TASK-002' },
    { ...source, title: 'Migration decision — superseded' },
    { ...source, revision: 'b'.repeat(64) },
    { ...source, truncated: true },
  ];
  const input = [source, { ...source }, ...variants, { ...source }, ...variants.map(item => ({ ...item }))];
  const before = structuredClone(input);
  const result = deduplicateBriefContextSources(input);
  assert.deepEqual(result, [source, ...variants]);
  assert.equal(result[0], source, 'Retain the first object, not a reconstructed metadata summary');
  for (const [index, variant] of variants.entries()) assert.equal(result[index + 1], variant);
  assert.deepEqual(input, before, 'Do not mutate original metadata or its list');
});

test('equal metadata is independent of object key insertion order and first-occurrence order is preserved', () => {
  const reordered: AgentChatContextSource = { truncated: source.truncated, revision: source.revision, title: source.title, entityId: source.entityId, projectId: source.projectId, workspaceId: source.workspaceId, kind: source.kind };
  const other = Object.freeze({ ...source, entityId: 'TASK-002' });
  const frozen = Object.freeze([other, Object.freeze(reordered), Object.freeze({ ...other }), Object.freeze(source)]);
  const result = deduplicateBriefContextSources(frozen);
  assert.deepEqual(result, [other, reordered]);
  assert.equal(result[0], other); assert.equal(result[1], reordered);
  assert.notEqual(result, frozen);
});
