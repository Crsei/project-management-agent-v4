import type { WorkflowGraph, WorkflowKind, WorkflowRun } from '../../../../../../packages/contracts/src/task-workflow.ts';

const phases: { label: string; kinds: WorkflowKind[] }[] = [
  { label: '准备环境', kinds: ['task', 'prepare'] },
  { label: 'Agent 开发', kinds: ['agent'] },
  { label: '自动验证', kinds: ['test'] },
  { label: '发布成果', kinds: ['commit', 'push', 'pr'] },
  { label: 'CI 与交接', kinds: ['ci', 'approval', 'end'] },
];
export function deliveryPhases(graph?: WorkflowGraph, run?: WorkflowRun | null) {
  return phases.flatMap(phase => {
    const nodes = graph?.nodes.filter(node => phase.kinds.includes(node.kind));
    if (nodes && !nodes.length) return [];
    const state = !run || !nodes ? 'pending' : nodes.some(n => run.nodes[n.id]?.state === 'failed') ? 'failed'
      : nodes.every(n => run.nodes[n.id]?.state === 'succeeded') ? 'done'
      : nodes.some(n => n.id === run.current) && !['failed', 'completed'].includes(run.status) ? 'active' : 'pending';
    const label = nodes?.some(n => n.kind === 'agent') && nodes.every(n => n.config.mode === 'analyze') ? 'Agent 分析' : phase.kinds.includes('ci') && nodes && !nodes.some(n => n.kind === 'ci') ? '结果交接' : phase.label;
    return [{ label, state }];
  });
}
export function providerReadinessHint(message?: string) {
  if (/routing discovery.*timed out|fetch failed|connect.*timeout/i.test(message ?? '')) return 'Provider 无法连通账号服务。请检查 Agent 所在机器的网络/代理；已登录不等于可执行。';
  if (/not found|未安装/i.test(message ?? '')) return '尚未安装对应 CLI，请到 Agent 设置完成安装。';
  return message || '请到 Agent 设置检查安装、登录和原生会话状态。';
}

export function deliveryTaskStatusLabel(status: string): string {
  return ({ todo: '待办', 'in progress': '进行中', in_progress: '进行中', review: '待审核', done: '已完成', canceled: '已取消' } as Record<string, string>)[status] ?? status;
}
export function workflowNodeMessage(run: WorkflowRun, nodeId: string): string {
  const message = run.nodes[nodeId]?.message;
  if (message) return message;
  if (run.current === nodeId && run.status === 'running') return '正在执行，等待结果…';
  if (run.current === nodeId && run.status === 'waiting') return '等待外部结果或确认';
  return '未执行 / 未选中路径';
}
