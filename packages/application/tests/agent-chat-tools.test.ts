import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_CHAT_TOOL_REGISTRY, agentChatToolDefinitions, agentChatToolInputSchemas, parseAgentChatToolInput } from '../src/agent-chat-tools.ts';
import { pmToolTargetSchema } from '../../agent-contracts/src/pm-tools.ts';
import { DomainError } from '../../domain/src/core.ts';

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

test('query input bounds are actionable without echoing argument values or unknown fields', () => {
  const query = { entity: 'work_item', projectId: null, query: null, after: null, limit: 20 };
  assert.deepEqual(parseAgentChatToolInput('pm_query', query), query);
  for (const limit of [100, 0, 1.5]) {
    assert.throws(() => parseAgentChatToolInput('pm_query', { ...query, limit }), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'agent_tool_invalid_input');
      assert.match(error.message, /limit:/);
      assert.match(error.message, /limit 1–20/);
      assert.match(error.message, /nextCursor.*after/);
      if (limit === 100) assert.match(error.message, /at most 20/);
      return true;
    });
  }
  const secret = 'PRIVATE-ARGUMENT-MUST-NOT-LEAK';
  assert.throws(() => parseAgentChatToolInput('pm_query', { ...query, entity: secret, [secret]: secret }), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.match(error.message, /entity:/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  const read = { id: 'TASK-001', bodyOffset: 0, bodyLimit: 12001 };
  assert.throws(() => parseAgentChatToolInput('pm_read', read), (error: unknown) => error instanceof DomainError && /bodyLimit: must be at most 12000/.test(error.message));
});

test('workflow discovery requires a project argument and only native read permission', () => {
  const args = { projectId: 'PRJ-002' };
  assert.deepEqual(parseAgentChatToolInput('pm_read_workflow', args), args);
  for (const invalid of [{}, { projectId: null }, { projectId: 'TASK-002', status: 'done' }, { ...args, actorId: 'admin' }]) {
    assert.throws(() => parseAgentChatToolInput('pm_read_workflow', invalid),
      (error: unknown) => error instanceof DomainError && error.code === 'agent_tool_invalid_input');
  }
  const tool = AGENT_CHAT_TOOL_REGISTRY.find(entry => entry.name === 'pm_read_workflow');
  assert.ok(tool);
  assert.equal(tool.write, false);
  assert.deepEqual(tool.capabilities, ['domain.read']);
  const definition = agentChatToolDefinitions.find(entry => entry.function.name === tool.name);
  assert.ok(definition);
  assert.deepEqual(definition.function.parameters.required, ['target', 'arguments']);
});

test('all-kind typed mutation inputs preserve explicit native null and empty arrays without accepting lifecycle escape fields', () => {
  const revision = 'a'.repeat(64);
  for (const entity of ['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal']) {
    assert.equal(parseAgentChatToolInput('pm_query', { entity, projectId: null, query: null, after: null, limit: 20 }).entity, entity);
  }
  const fields = [{ field: 'labels', value: [] }, { field: 'owner', value: null }, { field: 'x-score', value: 0 }, { field: 'x-enabled', value: false }];
  assert.deepEqual(parseAgentChatToolInput('pm_update_entity', { id: 'REQ-001', revision, fields }).fields, fields);
  assert.throws(() => parseAgentChatToolInput('pm_update_entity', { id: 'REQ-001', revision, fields: [{ field: 'labels', value: {} }] }));
  assert.throws(() => parseAgentChatToolInput('pm_update_entity', { id: 'REQ-001', revision, fields: [{ field: 'labels', value: [] }, { field: 'labels', value: [] }] }));
  assert.throws(() => parseAgentChatToolInput('pm_create_entity', { entity: 'goal', projectId: 'PRJ-001', title: 'Goal', body: '', fields: [], status: 'completed' }));
  assert.equal(AGENT_CHAT_TOOL_REGISTRY.find(tool => tool.name === 'pm_save_configuration')?.scope, 'workspace-admin');
  assert.deepEqual(AGENT_CHAT_TOOL_REGISTRY.find(tool => tool.name === 'pm_transition_entity')?.capabilities, ['domain.read'], 'State-category capability is checked against the exact native target, not a guessed generic edit grant');
});
