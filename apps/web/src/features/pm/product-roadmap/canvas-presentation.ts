import type { CanvasNodeRun, CanvasRun, CanvasStart } from '../../../../../../packages/contracts/src/product-canvas.ts';

/** Presentation only: never use this classification to authorize or repair a run. */
export function canvasIssue(message: string) {
  if (/工作目录身份发生变化|worktree_changed/.test(message)) return {
    kind: 'environment', title: '构建环境需要恢复',
    description: '构建已暂停以保护现有内容。请联系维护人员核对并恢复环境，再刷新进度；无需重新创建画布。',
    resumeBlocked: true,
  };
  if (/GitHub 操作未确认|结果未确认|结果未知|原请求|原启动/.test(message)) return {
    kind: 'unknown', title: '正在等待结果核对',
    description: '上一次操作的结果尚未确认。请先刷新进度，不要重复启动或上传。',
    resumeBlocked: false,
  };
  if (/权限|授权|登录|认证/.test(message)) return {
    kind: 'access', title: '需要检查访问权限',
    description: '请确认登录状态和项目访问权限；如果仍不可用，请联系维护人员检查构建服务。',
    resumeBlocked: false,
  };
  return {
    kind: 'attention', title: '需要核对构建状态',
    description: '请先刷新进度。若仍无法继续，请将下方诊断详情交给维护人员处理；不要重新启动同一构建。',
    resumeBlocked: false,
  };
}

export function canvasProgress(run: CanvasRun) {
  const verified = run.nodes.filter(n => n.phase === 'verified').length;
  const current = run.nodes.find(n => ['creating', 'ready', 'starting', 'running'].includes(n.phase));
  const feature = run.plan.nodes.find(n => n.id === current?.nodeId)?.title;
  const issue = canvasIssue(run.message);
  const title = run.status === 'completed' ? '构建检查通过，等待你验收'
    : run.status === 'running' ? '正在构建产品'
    : issue.resumeBlocked ? issue.title : '构建已暂停';
  const description = run.status === 'completed' ? '请从“查看产品”核对预览条件并体验。检查通过不代表产品已验收或上线。'
    : run.status === 'running' ? '系统会按功能顺序实现并检查，后续功能沿用前面已核验的成果。'
    : issue.resumeBlocked ? issue.description
    : /已暂停后续派发/.test(run.message) ? '已暂停后续功能；正在执行的操作可能仍在结束中。继续前会先核对结果，不会从头开始。'
    : /用户暂停|已请求暂停|画布已暂停|服务已重启/.test(run.message) ? '已有进度已保留。继续时会先核对原构建，不会从头开始。' : issue.description;
  return { title, description, verified, total: run.nodes.length, feature, resumeBlocked: run.status === 'paused' && issue.resumeBlocked };
}

export function canvasNodeLabel(node: CanvasNodeRun, run: CanvasRun): string {
  if (node.phase === 'verified') return '检查通过';
  if (node.phase === 'pending') return '尚未开始';
  if (run.status === 'paused') return canvasIssue(run.message).resumeBlocked ? '等待环境恢复' : '已暂停';
  return node.phase === 'running' ? '正在构建' : '准备构建';
}

export type BuildConsent = { build: boolean; commit: boolean; upload: boolean };
// Preserve every backend permission, with separate explicit commit and push choices.
export function canvasConsent(value: BuildConsent): CanvasStart['consent'] | null {
  if (!value.build || !value.commit || !value.upload) return null;
  return { execute: true, worktreeWrite: true, createTasks: true, taskStatus: true, commit: true, push: true, draftPr: true };
}
