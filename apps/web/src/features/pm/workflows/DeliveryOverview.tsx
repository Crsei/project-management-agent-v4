import { Check, Circle, GitPullRequest, ShieldCheck, Sparkles } from 'lucide-react';
import type { WorkflowGraph, WorkflowRun } from '../../../../../../packages/contracts/src/task-workflow';
import type { TaskCodeDelivery } from '../../../../../../packages/contracts/src/task-code-delivery';
import { deliveryPhases, deliveryTaskStatusLabel } from './workflow-presentation';

export function DeliveryOverview({ graph, run, delivery, taskStatus, repository, catalogKnown }: { graph?: WorkflowGraph; run: WorkflowRun | null; delivery: TaskCodeDelivery | null; taskStatus: string; repository?: string | null; catalogKnown: boolean }) {
  const taskLabel = deliveryTaskStatusLabel(taskStatus);
  return <section className="delivery-overview" aria-label="任务交付概览">
    <div className="delivery-eyebrow"><Sparkles size={14} /> TASK → VERIFIED DELIVERY <span>{taskLabel}</span></div>
    <h3>{!catalogKnown ? '交付记录待核对' : run ? run.status === 'completed' ? '成果已交接，等待你的判断' : run.status === 'paused' || run.status === 'failed' ? '执行已停下，先核对再继续' : '让进展与成果，都留在任务里' : '把需求交给 Agent，把成果留给团队'}</h3>
    <p>{!catalogKnown ? '正在读取任务关联的运行记录；刷新不会重复启动交付。' : run ? '任务状态、执行进度与交付证据分别记录，不用“运行成功”替代验收。' : '选一个流程，确认执行范围。系统处理分支、测试和 Draft PR，你关注需求与验收。'}</p>
    <ol className="delivery-phases" aria-label="交付阶段">{deliveryPhases(run?.graph ?? graph, run).map((phase, i) => <li key={phase.label} data-phase={phase.state}><span>{phase.state === 'done' ? <Check size={13} /> : i + 1}</span>{phase.label}</li>)}</ol>
    {run && <div className="delivery-evidence" aria-label="真实交付证据">
      <div><ShieldCheck size={16} /><small>本次测试记录</small><strong>{!delivery ? '记录待读取' : delivery.test ? delivery.test.passed ? '通过' : '未通过' : '尚无结果'}</strong><small>{delivery?.test?.command ?? '等待执行验证'}</small></div>
      <div><GitPullRequest size={16} /><small>可审查的成果</small>{!delivery ? <strong>记录待读取</strong> : delivery.pr ? <a href={delivery.pr.url} target="_blank" rel="noreferrer">Draft PR #{delivery.pr.number}</a> : <strong>尚未创建 PR</strong>}<small>{repository ?? '仓库待核对'}</small></div>
      <div><Circle size={16} /><small>GitHub CI 快照</small><strong>{!delivery ? '记录待读取' : !delivery.feedback ? '尚无结果' : delivery.feedback.head !== delivery.head ? '提交不匹配' : `${delivery.feedback.checks.filter(c => c.conclusion === 'success' && ['completed', 'success'].includes(c.status)).length} / ${delivery.feedback.checks.length} 项成功`}</strong><small>{delivery?.head ? `SHA ${delivery.head.slice(0, 8)}` : '绑定当前交付提交，不等于业务验收'}</small></div>
    </div>}
  </section>;
}
