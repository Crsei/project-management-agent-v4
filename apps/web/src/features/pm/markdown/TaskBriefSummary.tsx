import type { TaskBrief } from '@contracts';
import type { WorkspaceController } from './controller';
import { usePrivateQuery } from '../service/pm-service';
import { guidanceReadFailure } from './task-brief-presentation';

const stageLabels: Record<TaskBrief['stage'], { en: string; zh: string }> = {
  analysis: { en: 'Analysis', zh: '分析' },
  development: { en: 'Development', zh: '开发' },
  review: { en: 'Review', zh: '评审' },
  recovery: { en: 'Recovery', zh: '恢复' },
};

export function TaskBriefSummary({ controller: c, en, onOpen }: { controller: WorkspaceController; en: boolean; onOpen: () => void }) {
  const task = c.selected;
  const projectId = task?.entity.project;
  const t = (english: string, zh: string) => en ? english : zh;
  const brief = usePrivateQuery<TaskBrief>([...c.session.queryKey.slice(0, 4), 'task-guidance', projectId, task?.id, task?.revision, 'brief', 'analysis', 0], 'domain.read', projectId, (client, workspaceId, signal) => client.taskBrief(workspaceId, projectId!, task!.id, { revision: task!.revision, stage: 'analysis', bodyOffset: 0 }, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) }), !!task && !!projectId);
  if (!task || !projectId) return null;
  const denied = guidanceReadFailure(brief.error) === 'access';
  return <section className="issue-context-card issue-brief-summary" aria-label={t('Task execution brief', '任务执行简报')}>
    <header className="issue-context-card-heading"><h3>{t('Execution brief', '执行简报')}</h3><span>{t('Read only', '只读')}</span></header>
    {brief.isPending && <p className="issue-context-muted">{t('Loading brief…', '正在读取简报…')}</p>}
    {brief.error && <p className="issue-context-muted">{denied ? t('Brief access is unavailable.', '简报不可访问。') : t('Brief is unavailable.', '简报暂不可用。')}</p>}
    {brief.data && <>
      <p className="issue-context-muted">{en ? stageLabels[brief.data.stage].en : stageLabels[brief.data.stage].zh} · {brief.data.goals.length} {t('goals', '目标')} · {brief.data.gaps.length} {t('gaps', '缺口')}</p>
      <button type="button" className="issue-context-link" onClick={onOpen}>{t('View full brief', '查看详细简报')}</button>
    </>}
  </section>;
}
