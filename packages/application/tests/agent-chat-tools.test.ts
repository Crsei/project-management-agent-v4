import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentChatToolDefinitions, agentChatToolInputSchemas, parseAgentChatToolInput } from '../src/agent-chat-tools.ts';
import { pmToolTargetSchema } from '../../agent-contracts/src/pm-tools.ts';

const target = { workspaceId: '33333333-3333-4333-8333-333333333333', projectId: 'PRJ-001' };

test('provider native definitions require explicit target and preserve their business argument schemas', () => {
  for (const definition of agentChatToolDefinitions) {
    const schema = definition.function.parameters;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['target', 'arguments']);
    assert.deepEqual(Object.keys(schema.properties ?? {}), ['target', 'arguments']);
    const targetSchema = schema.properties!.target!;
    assert.equal(typeof targetSchema, 'object');
    if (typeof targetSchema !== 'object') throw new Error('Expected a target JSON schema');
    assert.equal(targetSchema.additionalProperties, false);
    assert.deepEqual(targetSchema.required, ['workspaceId', 'projectId']);
    assert.deepEqual(Object.keys(targetSchema.properties ?? {}), ['workspaceId', 'projectId']);
  }
  const args = { id: 'TASK-001', bodyOffset: 0, bodyLimit: 1000 };
  assert.deepEqual(parseAgentChatToolInput('pm_read', args), args);
  assert.throws(() => parseAgentChatToolInput('pm_read', { target, arguments: args }));
  assert.throws(() => parseAgentChatToolInput('pm_read', { ...args, workspaceId: target.workspaceId }));
  assert.equal(agentChatToolInputSchemas.pm_read.safeParse(args).success, true);
});

test('target requires an explicit nullable project and rejects legacy or forged scope fields', () => {
  assert.deepEqual(pmToolTargetSchema.parse(target), target);
  assert.deepEqual(pmToolTargetSchema.parse({ ...target, projectId: null }), { ...target, projectId: null });
  for (const invalid of [
    { workspaceId: target.workspaceId },
    { ...target, workspaceId: '' },
    { ...target, scope: { kind: 'workspace', projectIds: [] } },
    { ...target, projectIds: ['PRJ-001', 'PRJ-002'] },
  ]) assert.equal(pmToolTargetSchema.safeParse(invalid).success, false);
});
