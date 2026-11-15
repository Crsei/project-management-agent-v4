import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { DomainError, type Capability } from '../../../../packages/domain/src/core.ts';
import { agentChatToolResultSchema, type AgentChatToolResult } from '../../../../packages/agent-contracts/src/pm-tool-result.ts';
import { parseConfiguration, workflowFor, type ProtocolConfiguration } from '../../../../packages/pm-schema/index.ts';
import { Workspace, WorkspaceError } from '../../../../packages/pm-core/index.ts';
import { createAgentChatTools, type AgentChatToolContext } from '../src/agent-chat-tools.ts';

const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
const actor = { id: '0196c319-8b1d-7000-8000-000000000010', email: 'fixture@example.invalid', name: 'Workflow reader' };
const customConfiguration = () => parseConfiguration({ schema: 'pm/config/v1', workflows: { work_item: {
  initial: 'awaiting_materials',
  states: [
    { id: 'awaiting_materials', label: '等待资料', category: 'unstarted' },
    { id: 'crafting', label: '制作中', category: 'started' },
    { id: 'inspecting', label: '核对中', category: 'started' },
    { id: 'sealed', label: '已封存交付', category: 'completed' },
  ],
  transitions: [{ from: 'awaiting_materials', to: 'crafting' }, { from: 'crafting', to: 'inspecting' }, { from: 'inspecting', to: 'sealed' }],
  default_targets: { started: 'crafting' },
} }, custom_fields: [{ name: 'x-private-config', label: 'Unrelated workspace field', type: 'text', entities: ['project'], default: 'NOT-WORKFLOW-DATA' }] });

async function fixture(t: TestContext, configuration?: ProtocolConfiguration) {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-agent-workflow-'));
  const workspace = new Workspace(root);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  await workspace.init();
  if (configuration) await workspace.saveConfiguration(configuration, workspace.configuration().revision);
  const project = await workspace.createEntity({ entity: 'project', title: 'Readable project' });
  const other = await workspace.createEntity({ entity: 'project', title: 'Other project' });
  const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Configured task' });
  let capabilities: Capability[] = ['domain.read'];
  let projects: string[] | null = [project.id];
  const sql: string[] = [];
  let historyHead = 0;
  // Only authorization/audit SQL is simulated. Every configuration, source and transition uses the actual core.
  const query = async (text: string) => {
    sql.push(text);
    if (/SELECT m\.\* FROM memberships/.test(text)) return { rows: [{ user_id: actor.id, workspace_id: workspaceId, capabilities, project_ids: projects, version: 1, revoked_at: null }], rowCount: 1 };
    if (/UPDATE workspaces SET service_fact_head/.test(text)) return { rows: [{ sequence: '1' }], rowCount: 1 };
    if (/UPDATE workspaces SET change_history_head/.test(text)) return { rows: [{ head: String(++historyHead) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const database = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const tools = createAgentChatTools({
    database: () => database,
    coreWorkspaces: { get: async () => { await workspace.rescan(); return workspace; }, rootFor: () => root } as never,
    executeCommand: async () => { throw new Error('Workflow discovery does not issue commands'); },
    readCommandReceipt: async () => null,
    readComments: async () => { throw new Error('Workflow discovery does not read comments'); },
    localProjects: { enabled: false, defaultParent: null },
  });
  const context = (projectIds = [project.id]): AgentChatToolContext => ({
    actor, workspaceId, operationId: randomUUID(), threadId: 'workflow-thread', messageId: 'workflow-message', scope: { kind: 'projects', projectIds },
  });
  return { root, workspace, project, other, task, tools, context, sql,
    allow(caps: Capability[], projectIds: string[] | null = [project.id]) { capabilities = caps; projects = projectIds; } };
}

function workflowResult(result: AgentChatToolResult) {
  const parsed = agentChatToolResultSchema.parse(result);
  if (parsed.kind !== 'workflow') assert.fail('Expected the configured workflow result');
  return parsed;
}

test('read-only discovery returns configured IDs, labels, categories, transitions and provenance without business writes', async t => {
  const configuration = customConfiguration();
  const f = await fixture(t, configuration);
  const statePath = path.join(f.root, '.pm/state/state.json');
  const configPath = path.join(f.root, '.pm/config.yaml');
  const before = { state: await readFile(statePath, 'utf8'), config: await readFile(configPath, 'utf8'), sources: f.workspace.snapshot().files.map(file => [file.id, file.raw, file.revision]) };
  const result = workflowResult(await f.tools.execute('pm_read_workflow', { projectId: f.project.id }, f.context()));
  assert.deepEqual(result.items, []);
  assert.equal(result.receipt, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.workflow.projectId, f.project.id);
  assert.equal(result.workflow.workspaceId, workspaceId);
  assert.equal(result.workflow.entity, 'work_item');
  assert.equal(result.workflow.initial, f.task.entity.status);
  assert.deepEqual(result.workflow.states, configuration.workflows.work_item!.states);
  assert.deepEqual(result.workflow.transitions, configuration.workflows.work_item!.transitions);
  assert.deepEqual(result.workflow.defaultTargets, { started: 'crafting' });
  assert.equal(result.workflow.configuration.source, 'workspace');
  assert.equal(result.workflow.configuration.revision, f.workspace.configuration().revision);
  assert.match(result.workflow.configuration.workflowRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.sources.map(source => [source.kind, source.workspaceId, source.projectId, source.revision]), [
    ['project', workspaceId, f.project.id, f.project.revision],
    ['workflow', workspaceId, f.project.id, result.workflow.configuration.workflowRevision],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /NOT-WORKFLOW-DATA|custom_fields|x-private-config/);
  assert.deepEqual({ state: await readFile(statePath, 'utf8'), config: await readFile(configPath, 'utf8'), sources: f.workspace.snapshot().files.map(file => [file.id, file.raw, file.revision]) }, before);
  assert.ok(f.sql.every(text => /^SELECT m\.\* FROM memberships/.test(text)), 'Read does not issue mutation SQL');
  assert.equal(f.tools.recoveryIdentity('pm_read_workflow', { projectId: f.project.id }, f.context()), null);
  assert.equal(await f.tools.recover('pm_read_workflow', { projectId: f.project.id }, f.context()), null);
  const repeated = workflowResult(await f.tools.execute('pm_read_workflow', { projectId: f.project.id }, f.context()));
  assert.deepEqual(repeated, result);
});

test('native workflow state IDs are preserved without truncation or whitespace normalization', async t => {
  const status = ` ${'crafting-'.repeat(32)} `;
  const configuration = customConfiguration();
  const workflow = configuration.workflows.work_item!;
  workflow.states[1]!.id = status;
  workflow.transitions[0]!.to = status;
  workflow.transitions[1]!.from = status;
  workflow.default_targets!.started = status;
  const f = await fixture(t, configuration);
  const result = workflowResult(await f.tools.execute('pm_read_workflow', { projectId: f.project.id }, f.context()));
  assert.equal(result.workflow.states[1]!.id, status);
  assert.equal(result.workflow.transitions[0]!.to, status);
  assert.equal(result.workflow.defaultTargets?.started, status);
  f.allow(['domain.read', 'planning.edit']);
  await f.tools.execute('pm_transition_task', { id: f.task.id, revision: f.task.revision, status }, f.context());
  assert.equal(f.workspace.get(f.task.id).entity.status, status);
});

test('discovery uses effective native defaults without creating configuration or inventing preferences', async t => {
  const f = await fixture(t);
  const read = async () => workflowResult(await f.tools.execute('pm_read_workflow', { projectId: f.project.id }, f.context()));
  const result = await read();
  const native = workflowFor('work_item', f.workspace.configuration().config)!;
  assert.equal(result.workflow.initial, native.initial);
  assert.deepEqual(result.workflow.states, native.states);
  assert.deepEqual(result.workflow.transitions, native.transitions);
  assert.deepEqual(result.workflow.defaultTargets, native.default_targets ?? null);
  assert.equal(result.workflow.configuration.source, 'builtin');
  assert.equal(result.workflow.configuration.revision, 'absent');
  await assert.rejects(readFile(path.join(f.root, '.pm/config.yaml')), { code: 'ENOENT' });
  const config = customConfiguration();
  delete config.workflows.work_item;
  await f.workspace.saveConfiguration(config, 'absent');
  const inherited = await read();
  assert.equal(inherited.workflow.configuration.source, 'workspace', 'The native save materializes defaults in workspace configuration');
  assert.notEqual(inherited.workflow.configuration.revision, 'absent');
  assert.equal(inherited.workflow.configuration.workflowRevision, result.workflow.configuration.workflowRevision);
  const explicit = f.workspace.configuration();
  delete native.default_targets;
  explicit.config.workflows.work_item = native;
  await f.workspace.saveConfiguration(explicit.config, explicit.revision);
  const unpreferred = await read();
  assert.equal(unpreferred.workflow.configuration.source, 'workspace');
  assert.equal(unpreferred.workflow.defaultTargets, null);
});

test('current read capability, native membership, explicit project binding and project entity type are required', async t => {
  const f = await fixture(t, customConfiguration());
  const denied = (error: unknown) => error instanceof DomainError && error.code === 'not_found_or_forbidden' && error.status === 404;
  await assert.rejects(f.tools.execute('pm_read_workflow', { projectId: f.other.id }, f.context([f.other.id])), denied);
  f.allow(['domain.read'], null);
  await assert.rejects(f.tools.execute('pm_read_workflow', { projectId: f.other.id }, f.context()), denied);
  await assert.rejects(f.tools.execute('pm_read_workflow', { projectId: f.task.id }, f.context([f.project.id, f.task.id])), denied);
  await assert.rejects(f.tools.execute('pm_read_workflow', { projectId: 'PRJ-999999' }, f.context(['PRJ-999999'])), denied);
  f.allow([]);
  await assert.rejects(f.tools.execute('pm_read_workflow', { projectId: f.project.id }, f.context()),
    (error: unknown) => error instanceof DomainError && error.code === 'permission_denied');
  assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
});

test('invalid current configuration cannot masquerade as its retained last-good workflow', async t => {
  const f = await fixture(t, customConfiguration());
  await writeFile(path.join(f.root, '.pm/config.yaml'), 'schema: pm/config/v1\nworkflows: [\n');
  await assert.rejects(f.tools.execute('pm_read_workflow', { projectId: f.project.id }, f.context()),
    (error: unknown) => error instanceof DomainError && error.code === 'agent_context_unavailable');
  assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
});

test('discovered custom workflow never bypasses native transition validation, CAS or actor capabilities', async t => {
  const f = await fixture(t, customConfiguration());
  const result = workflowResult(await f.tools.execute('pm_read_workflow', { projectId: f.project.id }, f.context()));
  assert.equal(result.workflow.states.find(state => state.category === 'completed')?.id, 'sealed');
  await assert.rejects(f.tools.execute('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'crafting' }, f.context()),
    (error: unknown) => error instanceof DomainError && error.code === 'permission_denied');
  f.allow(['domain.read', 'planning.edit', 'workitem.complete']);
  await assert.rejects(f.tools.execute('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'sealed' }, f.context()),
    (error: unknown) => error instanceof WorkspaceError && error.diagnostics.some(issue => issue.code === 'TRANSITION_NOT_ALLOWED'));
  assert.equal(f.workspace.get(f.task.id).revision, f.task.revision);
  await f.tools.execute('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'crafting' }, f.context());
  await assert.rejects(f.tools.execute('pm_transition_task', { id: f.task.id, revision: f.task.revision, status: 'inspecting' }, f.context()),
    (error: unknown) => error instanceof WorkspaceError && error.status === 409);
  const crafting = f.workspace.get(f.task.id);
  await f.tools.execute('pm_transition_task', { id: crafting.id, revision: crafting.revision, status: 'inspecting' }, f.context());
  const inspecting = f.workspace.get(f.task.id);
  f.allow(['domain.read', 'planning.edit']);
  await assert.rejects(f.tools.execute('pm_transition_task', { id: inspecting.id, revision: inspecting.revision, status: 'sealed' }, f.context()),
    (error: unknown) => error instanceof DomainError && error.code === 'permission_denied');
  assert.equal(f.workspace.get(inspecting.id).revision, inspecting.revision);
  f.allow(['domain.read', 'workitem.complete']);
  const completed = await f.tools.execute('pm_transition_task', { id: inspecting.id, revision: inspecting.revision, status: 'sealed' }, f.context());
  assert.equal(completed.kind, 'lifecycle');
  assert.equal(completed.receipt?.action, 'UpdateCoreProperties');
  assert.equal(f.workspace.get(inspecting.id).entity.status, 'sealed');
});
