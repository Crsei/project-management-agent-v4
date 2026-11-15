import type { TaskBrief } from '../../agent-contracts/src/task-brief.ts';
import type { DeliveryTree, TaskCodeDelivery } from '../../contracts/src/task-code-delivery.ts';
import type { TaskExecutionBrief, TaskExecutionEvidence, TaskExecutionOperation, TaskExecutionSentInput } from '../../contracts/src/task-execution-brief.ts';
import { workflowTaskRevision, type WorkflowRun } from '../../contracts/src/task-workflow.ts';

export type ExecutionBriefObservation = {
  delivery: TaskCodeDelivery;
  currentTask: TaskBrief;
  workflow: WorkflowRun | null;
  tree: DeliveryTree | null;
  /** Recomputed against the test's original HEAD so committing unchanged content does not invalidate its coverage. */
  testCoverageFingerprint: string | null;
  generation: { id: string; status: string } | null;
  operations?: TaskExecutionOperation[];
  sentInputs?: TaskExecutionSentInput[];
  observedAt: string;
};
const reconcileSteps: Record<string, string> = {
  prepare: '人工核对原 delivery 的独立分支、worktree 与目录身份；不要重新创建。',
  develop: '按原 generationKey / generationId 查询生成收据；未知不等于进程已结束，不派发替代生成。',
  test: '核对原验证进程及其退出收据；丢失结果保持未知，不由简报重跑命令。',
  commit: '用原提交 marker、父 SHA、fingerprint 与干净工作树核对原提交，不重新 commit。',
  push: '只查询原远端分支 SHA 并与原 head 核对；不要再次 push 或换 operation 身份。',
  'draft-pr': '按原 repo/head/base 与 delivery marker 查询原 PR；无法唯一确定时停止，不再次创建。',
};

/** Pure derivation: reading a brief cannot refresh a receipt, dispatch a model or replay an effect. */
export function deriveTaskExecutionBrief(input: ExecutionBriefObservation): TaskExecutionBrief {
  const { delivery: d, currentTask, tree, workflow, generation } = input;
  const expectedRevision = workflow ? workflowTaskRevision(workflow) : d.taskRevision;
  const changed = currentTask.task.revision !== expectedRevision;
  const evidence: TaskExecutionEvidence[] = [];
  const test = d.test;
  const testStatus: TaskExecutionEvidence['status'] = !test || !tree ? 'unknown'
    : changed || (test.taskRevision !== undefined && test.taskRevision !== expectedRevision) ? 'stale'
    : !test.taskRevision || !test.head || input.testCoverageFingerprint === null ? 'unknown'
    : test.head !== tree.head && d.head !== tree.head ? 'stale'
    : input.testCoverageFingerprint !== test.fingerprint ? 'stale' : test.exitCode === null ? 'unknown' : test.passed ? 'passed' : 'failed';
  evidence.push({ kind: 'test', status: testStatus, taskRevision: test?.taskRevision ?? null, head: test?.head ?? null,
    fingerprint: test?.fingerprint ?? null, observedAt: test?.at ?? null,
    summary: test ? `${test.command} · exit ${test.exitCode ?? 'unknown'}；只覆盖该命令和绑定的版本/代码，不证明全部验收。` : '没有验证进程收据；模型声明或 generation 成功不是测试证据。' });
  const feedback = d.feedback;
  const remoteCoverage = !tree || !feedback ? 'unknown' : changed || tree.files.length > 0 || feedback.head !== tree.head ||
    feedback.taskRevision !== undefined && feedback.taskRevision !== expectedRevision || feedback.fingerprint !== undefined && feedback.fingerprint !== tree.fingerprint ? 'stale'
    : !feedback.taskRevision || !feedback.fingerprint ? 'unknown' : null;
  const requiredChecks = workflow?.graph.nodes.filter(node => node.kind === 'ci').flatMap(node => node.config.requiredChecks ?? []) ?? [];
  const checks = feedback?.checks ?? [];
  const missing = requiredChecks.filter(name => !checks.some(check => check.name === name));
  const failedChecks = checks.some(check => check.conclusion !== null && !['success', 'pending'].includes(check.conclusion));
  const passedChecks = checks.length > 0 && missing.length === 0 && checks.every(check => check.conclusion === 'success' && ['completed', 'success'].includes(check.status));
  evidence.push({ kind: 'ci', status: remoteCoverage ?? (failedChecks ? 'failed' : passedChecks ? 'passed' : 'unknown'),
    taskRevision: feedback?.taskRevision ?? null, head: feedback?.head ?? null, fingerprint: feedback?.fingerprint ?? null,
    observedAt: feedback?.observedAt ?? null, summary: !feedback ? '没有 GitHub CI 快照。' : !checks.length ? '未发现 CI，不算通过。'
      : `${checks.map(check => `${check.name}: ${check.conclusion ?? check.status}`).join('；')}${missing.length ? `；缺少必需检查：${missing.join('、')}` : ''}；仅代表已采集快照，读取简报不会刷新远端。` });
  const latestReviews = new Map<string, NonNullable<typeof feedback>['reviews'][number]>();
  for (const review of feedback?.reviews ?? []) {
    if (review.commit !== feedback?.head || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    if ((latestReviews.get(review.author)?.id ?? -1) < review.id) latestReviews.set(review.author, review);
  }
  const reviews = [...latestReviews.values()];
  evidence.push({ kind: 'review', status: remoteCoverage ?? (reviews.some(review => review.state === 'CHANGES_REQUESTED') ? 'failed'
    : reviews.some(review => review.state === 'APPROVED') ? 'passed' : feedback?.reviews.length ? 'stale' : 'unknown'),
    taskRevision: feedback?.taskRevision ?? null, head: feedback?.head ?? null, fingerprint: feedback?.fingerprint ?? null,
    observedAt: feedback?.observedAt ?? null, summary: '只统计快照内同一 HEAD、每位作者最新的 GitHub Review；旧提交批准、模型文字和工作流人工确认都不是当前业务审核。' });
  const operations = [...(input.operations ?? [])];
  if (d.pending) operations.unshift({ identity: `${d.id}:${d.pending.action}:${d.pending.at}`, action: d.pending.action,
    state: d.pending.action === 'develop' && generation && ['queued', 'running'].includes(generation.status) ? 'running' : 'unknown',
    at: d.pending.at, head: d.pending.head ?? null, fingerprint: d.pending.fingerprint ?? null,
    nextStep: reconcileSteps[d.pending.action]! });
  if (generation || d.generationId || d.generationKey) operations.push({ identity: d.generationKey ?? d.generationId!, action: 'generation',
    state: !generation ? 'unknown' : ['queued', 'running'].includes(generation.status) ? 'running' : 'known', at: d.updatedAt,
    head: null, fingerprint: null, nextStep: reconcileSteps.develop! });
  for (const [nodeId, transition] of Object.entries(workflow?.transitions ?? {})) if (transition.request) operations.push({
    identity: transition.commandId ?? `${transition.request.runId}:${nodeId}:${transition.request.phase}`, action: 'task-transition',
    state: transition.state === 'applied' ? 'known' : 'unknown', at: transition.appliedAt ?? transition.confirmedAt ?? workflow!.updatedAt,
    head: null, fingerprint: null, nextStep: '只查询原 runId/nodeId/phase 的 PM 转换收据；未知转换不重新提交，人工需求变更必须重新规划。',
  });
  const nextSteps = [
    ...(changed ? ['当前任务版本已变化：停止旧开发、恢复、测试及发布；先读取新需求和差异、重新规划，原任务快照与操作身份不能改绑。'] : []),
    ...(!tree ? ['当前 Git 观察不可用，所有当前验证均未知；重新核对目录身份与仓库，不沿用旧通过结论。'] : []),
    ...operations.filter(operation => operation.state !== 'known').map(operation => `${operation.identity}：${operation.nextStep}`),
    '先按当前授权核对仓库、版本、工作树和验收覆盖。读取或生成简报不授权、不创建 Session、不执行或重放任何操作。',
    '需要新 Session 时使用原交付/工作流的显式操作；该操作会持久化新会话与交接，但不会启动模型。后续执行仍须原权限、目录、CAS、幂等与确认。',
    '源码观察、测试/CI/Review、模型建议和 PM 业务状态分别报告；工作流或 generation 结束不是任务完成。',
  ];
  return { schemaVersion: 1, stage: currentTask.stage, generatedAt: input.observedAt, currentTask,
    originalTask: { workspaceId: d.workspaceId, projectId: d.projectId, taskId: d.taskId, revision: d.taskRevision, title: d.title, body: d.description },
    taskVersion: { originalRevision: d.taskRevision, expectedRevision, currentRevision: currentTask.task.revision, changed },
    execution: { deliveryId: d.id, deliveryVersion: d.version, step: d.step, recordedHead: d.head ?? null, pullRequest: d.pr ?? null,
      workflow: workflow ? { id: workflow.id, version: workflow.version, status: workflow.status, currentNodeId: workflow.current, definitionId: workflow.input.definitionId, definitionVersion: workflow.input.definitionVersion } : null,
      sessionId: d.threadId, previousSessionIds: d.previousThreadIds ?? [],
      generation: generation || d.generationId || d.generationKey ? { id: generation?.id ?? d.generationId ?? null, key: d.generationKey ?? null, status: generation?.status ?? 'unknown' } : null },
    repository: { status: tree ? 'observed' : 'unknown', repository: d.git ? `${d.git.owner}/${d.git.repo}` : null,
      branch: d.git?.branch ?? null, baseBranch: d.baseBranch, baseSha: d.git?.baseSha ?? null,
      head: tree?.head ?? null, fingerprint: tree?.fingerprint ?? null, changedFiles: tree?.files ?? [], observedAt: input.observedAt,
      reason: tree ? null : '未能取得当前已核验 worktree 的 Git 观察；历史收据不代替当前代码事实。' },
    evidence, operations, nextSteps, history: { sentInputs: input.sentInputs ?? [] } };
}
