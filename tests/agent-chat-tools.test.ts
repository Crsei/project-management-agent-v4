import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../packages/pm-core/index.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { agentChatToolDefinitions, AGENT_CHAT_TOOL_NAMES, parseAgentChatToolInput, assertAgentToolRecord, assertAgentToolOrdinaryMutation } from '../packages/application/src/agent-chat-tools.ts';

const revision = 'a'.repeat(64);
test('registered PM schemas reject model identity, protected fields, raw patches and unsupported actions', () => {
  assert.equal(AGENT_CHAT_TOOL_NAMES.length, 13);
  for (const definition of agentChatToolDefinitions) {
    assert.equal(definition.function.strict, true);
    assert.equal(definition.function.parameters.additionalProperties, false);
    assert.deepEqual(new Set(definition.function.parameters.required), new Set(Object.keys(definition.function.parameters.properties ?? {})));
  }
  const update = { id: 'TASK-001', revision, title: 'Safe edit', description: null, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null };
  for (const forbidden of [{ actorId: 'admin' }, { approved: true }, { status: 'done' }, { archived: true }, { project: 'PRJ-002' }, { raw: 'arbitrary YAML' }, { changes: { status: 'done' } }]) {
    assert.throws(() => parseAgentChatToolInput('pm_update_task', { ...update, ...forbidden }), (error: unknown) => error instanceof DomainError && error.code === 'agent_tool_invalid_input');
  }
  assert.throws(() => parseAgentChatToolInput('pm_save_document', { id: '../../secret', revision, body: '' }));
  assert.throws(() => parseAgentChatToolInput('pm_add_relation', { sourceId: 'TASK-001', targetId: 'TASK-002', relation: 'project', revision, targetRevision: revision }));
  assert.throws(() => parseAgentChatToolInput('pm_query', { entity: null, projectId: null, query: null, after: null, limit: 1000 }));
  assert.throws(() => parseAgentChatToolInput('pm_create_project', { title: 'Project', description: '', goal: null, localDirectory: '/etc' }));
});

test('workspace binding is a frozen eligible project set, not implicit access to future projects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pm-agent-tool-policy-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  const first = await workspace.createEntity({ entity: 'project', title: 'Bound project' });
  const second = await workspace.createEntity({ entity: 'project', title: 'Not bound' });
  const scope = { kind: 'workspace' as const, projectIds: [first.id] };
  assertAgentToolRecord(scope, first);
  assert.throws(() => assertAgentToolRecord(scope, second), (error: unknown) => error instanceof DomainError && error.code === 'not_found_or_forbidden');
  for (const change of [{ status: 'completed' }, { archived: true }, { project: second.id }]) {
    assert.throws(() => assertAgentToolOrdinaryMutation(first, { ...first.entity, ...change }), (error: unknown) => error instanceof DomainError && error.code === 'agent_tool_protected_action');
  }
});
