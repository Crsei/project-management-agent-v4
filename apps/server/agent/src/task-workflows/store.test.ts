import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workflowStore } from './store.ts';
import { deliveryStore } from '../task-delivery/binding.ts';
import { closeStore, getDatabase } from '../durable/store.ts';
import { startTaskWorkflows, stopTaskWorkflows, assertWorkflowRunner } from './runner.ts';
import { workflowTemplates, type WorkflowRun, type WorkflowStart } from '../../../../../packages/contracts/src/task-workflow.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';

test('SQLite namespaces persist independent graph/run records, enforce CAS and cross-mode task uniqueness; restart pauses without credentials or effect replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pm-workflow-store-')), old = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  const input: WorkflowStart = { id: '11111111-1111-4111-8111-222222222222', workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', taskId: 'TASK-001', taskRevision: 'r1', definitionId: 'builtin-deliver', definitionVersion: 1, repository: 'owner/repo', baseBranch: 'main', providerInstanceId: 'codex', model: 'fixture', consent: { execute: true, worktreeWrite: true, commit: true, push: true, draftPr: true } };
  const graph = structuredClone(workflowTemplates[2]!.draft);
  const run: WorkflowRun = { id: input.id, version: 1, input, projectRoot: '/repo', graph, status: 'running', current: graph.nodes[0]!.id, nodes: {}, createdAt: 'now', updatedAt: 'now' };
  const delivery: TaskCodeDelivery = { id: 'manual', workspaceId: input.workspaceId, projectId: input.projectId, taskId: input.taskId, taskRevision: input.taskRevision, baseBranch: 'main', version: 1, title: 'Fixture', description: '', threadId: 'fixture', step: 'preparing', createdAt: 'now', updatedAt: 'now' };
  try {
    workflowStore.saveDefinition({ id: 'def', workspaceId: input.workspaceId, projectId: input.projectId, revision: 1, draft: graph, versions: [{ version: 1, graph, publishedAt: 'now' }] });
    workflowStore.saveRun(run);
    assert.throws(() => workflowStore.saveRun(run), /版本/);
    assert.throws(() => workflowStore.saveRun({ ...run, id: 'another' }), /已有/);
    assert.throws(() => deliveryStore.save(delivery), /工作流/);
    deliveryStore.save({ ...delivery, id: run.id }); // owned delivery is allowed
    closeStore();
    assert.deepEqual(workflowStore.readRun(run.id)?.graph, graph);
    assert.equal(workflowStore.readDefinition('def')?.versions.length, 1);
    startTaskWorkflows();
    assert.equal(workflowStore.readRun(run.id)?.status, 'paused');
    assert.match(workflowStore.readRun(run.id)!.message!, /服务已重启/);
    assertWorkflowRunner(); await stopTaskWorkflows(); assert.throws(assertWorkflowRunner, /尚未启动/);
    const row = getDatabase().prepare('SELECT value FROM records WHERE namespace = ? AND key = ?').get('task-workflow-runs-v1', run.id);
    assert.ok(!String(row?.value).includes('authorization')); assert.ok(!String(row?.value).includes('cookie'));
    const other = { ...delivery, id: 'manual-other', taskId: 'TASK-002' }; deliveryStore.save(other);
    assert.throws(() => workflowStore.saveRun({ ...run, id: 'another', input: { ...input, id: 'another', taskId: 'TASK-002' } }), /手动交付/);
  } finally { await stopTaskWorkflows(); closeStore(); if (old === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = old; await rm(root, { recursive: true, force: true }); }
});
