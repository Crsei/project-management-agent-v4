import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { chatOnlyExecutionSelection } from '../../agent-contracts/src/execution.ts';
import { studioConfigSchema, studioDefinitionSchema, studioExecutionSchema, type StudioConfig } from '../../contracts/src/automation-studio.ts';
import { prepareDeliverySchema, deliveryActionSchema } from '../../contracts/src/task-code-delivery.ts';
import { workflowStartSchema, workflowControlSchema } from '../../contracts/src/task-workflow.ts';
import { DomainError } from '../../domain/src/core.ts';
import { studioDefinitionDto, studioDirectorySelection, studioExecutionDto, type StudioDefinitionRow, type StudioExecutionRow } from '../src/automation-studio-store.ts';

const selection = { version: 2 as const, agentWorkspaceId: 'explicit-agent-folder', agentWorkspaceRevision: 1 };
const config: StudioConfig = { name: 'Historical definition', description: '', projectId: 'PRJ-001', tags: [], templateId: null, trigger: { kind: 'manual' }, dailyLimit: 10, cooldownMinutes: 0, action: { kind: 'prompt', providerInstanceId: 'provider', model: 'model', options: {}, prompt: 'Read authorized business context', repositories: [], plugins: [], timeoutSeconds: 60 } };

describe('business directory cutover contracts and immutable history', () => {
  it('keeps unsupported selections queryable as forensic data without mutating or executing them', () => {
    const historicalSelection = { version: 1, codeWorkspaceId: 'retired', codeWorkspaceRevision: 4, rootIds: ['first', 'second'], primaryRootId: 'second' };
    const historical = { ...config, action: { ...config.action, executionSelection: historicalSelection } } as unknown as StudioConfig;
    const original = JSON.stringify(historical), now = new Date();
    const definition: StudioDefinitionRow = { id: randomUUID(), workspace_id: randomUUID(), actor_id: randomUUID(), project_id: config.projectId, revision: 4, config: historical, status: 'enabled', created_at: now, updated_at: now, last_run_at: null, next_due_at: null, deleted_at: null };
    const readable = studioDefinitionSchema.parse(studioDefinitionDto(definition));
    assert.deepEqual(readable.historicalExecutionSelection, historicalSelection); assert.equal(readable.executionUnavailableReason, 'agent_workspace_selection_required');
    assert.equal(readable.config.action.executionSelection, undefined); assert.equal(studioConfigSchema.safeParse(historical).success, false);
    assert.throws(() => studioDirectorySelection(historical), error => error instanceof DomainError && error.code === 'agent_workspace_selection_required');
    const execution: StudioExecutionRow = { id: randomUUID(), workspace_id: definition.workspace_id, actor_id: definition.actor_id, project_id: config.projectId, definition_id: definition.id, definition_revision: 4, config_snapshot: historical, trigger: 'manual', request_id: randomUUID(), payload: null, source_key: null, status: 'completed', created_at: now, started_at: now, finished_at: now, dispatched_at: now, budget_consumed: true, external_execution_id: 'original-outcome', thread_id: 'historical-thread', error: null, summary: 'Original business result', lease_token: null, lease_until: null };
    const result = studioExecutionSchema.parse(studioExecutionDto(execution));
    assert.deepEqual(result.historicalExecutionSelection, historicalSelection); assert.equal(result.summary, 'Original business result'); assert.equal(result.externalExecutionId, 'original-outcome');
    assert.equal(JSON.stringify(historical), original); assert.deepEqual(definition.config.action.executionSelection, historicalSelection); assert.deepEqual(execution.config_snapshot.action.executionSelection, historicalSelection);
  });
  it('requires explicit Agent folders for repository/script execution without choosing any PM or scratch directory', () => {
    const script: StudioConfig = { ...config, action: { kind: 'script', entrypoint: 'main.py', setup: '', content: 'print("explicit")', bundleRef: null, files: [], repositories: [], plugins: [], timeoutSeconds: 60 } };
    assert.throws(() => studioDirectorySelection(script), error => error instanceof DomainError && error.code === 'agent_workspace_selection_required');
    assert.throws(() => studioDirectorySelection({ ...script, action: { ...script.action, executionSelection: chatOnlyExecutionSelection() } }));
    assert.deepEqual(studioDirectorySelection({ ...script, action: { ...script.action, executionSelection: selection } }), selection);
    assert.equal(studioDirectorySelection(config), null); assert.equal(studioDirectorySelection({ ...config, action: { ...config.action, executionSelection: chatOnlyExecutionSelection() } }), null);
  });
  it('requires non-chat-only v2 selections for new delivery/workflow commands but not historical result types', () => {
    const target = { workspaceId: randomUUID(), projectId: 'PRJ-001', taskId: 'TASK-001' };
    const prepare = { ...target, id: randomUUID(), taskRevision: 'task-revision', baseBranch: 'main' };
    const workflow = { ...prepare, definitionId: 'workflow', definitionVersion: 1, repository: 'org/repo', providerInstanceId: 'provider', model: 'model', consent: { execute: true, worktreeWrite: true, commit: false, push: false, draftPr: false } };
    for (const executionSelection of [undefined, chatOnlyExecutionSelection(), { version: 1, codeWorkspaceId: 'retired', codeWorkspaceRevision: 1, rootIds: ['root'], primaryRootId: 'root' }]) {
      assert.equal(prepareDeliverySchema.safeParse({ ...prepare, executionSelection }).success, false);
      assert.equal(workflowStartSchema.safeParse({ ...workflow, executionSelection }).success, false);
      assert.equal(deliveryActionSchema.safeParse({ action: 'new-session', confirm: true, executionSelection }).success, false);
      assert.equal(workflowControlSchema.safeParse({ action: 'new-session', version: 1, confirm: true, executionSelection }).success, false);
    }
    assert.equal(prepareDeliverySchema.safeParse({ ...prepare, executionSelection: selection }).success, true);
    assert.equal(workflowStartSchema.safeParse({ ...workflow, executionSelection: selection }).success, true);
  });
});
