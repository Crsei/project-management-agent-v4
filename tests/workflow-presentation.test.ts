import { taskStateLabel } from '../apps/web/src/features/pm/markdown/task-status-label.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryPhases, providerReadinessHint, deliveryTaskStatusLabel, workflowNodeMessage } from '../apps/web/src/features/pm/workflows/workflow-presentation.ts';
import { workflowTemplates, type WorkflowRun } from '../packages/contracts/src/task-workflow.ts';

test('presentation never invents completion and analysis omits publication/test stages', () => {
  assert.ok(deliveryPhases().every(phase => phase.state === 'pending'));
  const graph = workflowTemplates[0]!.draft;
  assert.deepEqual(deliveryPhases(graph).map(p => p.label), ['准备环境', 'Agent 分析', '结果交接']);
  const run = { graph, nodes: {}, status: 'completed', current: 'end3' } as unknown as WorkflowRun;
  assert.ok(deliveryPhases(graph, run).every(phase => phase.state === 'pending'));
  assert.match(providerReadinessHint('workspace routing discovery timed out'), /网络\/代理/);
  assert.match(providerReadinessHint('CLI not found'), /安装/);
});

test('execution messages distinguish running from unexecuted and preserve recorded evidence', () => {
  const run = { nodes: {}, current: 'agent', status: 'running' } as unknown as WorkflowRun;
  assert.match(workflowNodeMessage(run, 'agent'), /正在执行/);
  assert.match(workflowNodeMessage(run, 'pr'), /未执行/);
  run.status = 'waiting';
  assert.match(workflowNodeMessage(run, 'agent'), /等待/);
  run.nodes.agent = { state: 'waiting', startedAt: '2026-11-01T00:00:00Z', message: '原始运行记录' };
  assert.equal(workflowNodeMessage(run, 'agent'), '原始运行记录');
  assert.equal(deliveryTaskStatusLabel('in_progress'), '进行中');
  assert.equal(deliveryTaskStatusLabel('in progress'), '进行中');
  assert.equal(deliveryTaskStatusLabel('custom'), 'custom');
});

test('default review labels are localized without replacing project-authored labels', () => {
  assert.equal(taskStateLabel({ id: 'review', label: 'review' }, false), '待审核');
  assert.equal(taskStateLabel({ id: 'review', label: 'review' }, true), 'Awaiting review');
  assert.equal(taskStateLabel({ id: 'review', label: '安全复核' }, false), '安全复核');
});
