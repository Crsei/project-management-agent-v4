import { useEffect, useState, useSyncExternalStore } from 'react';
import { taskBriefStageSchema, type TaskBriefStage } from '@agent-workspace/contracts/task-brief';
import { RadixSelect } from '@/components/ui/radix-select';
import { guidanceReadFailure } from './task-brief-presentation';

const subscribeOnline = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => { window.removeEventListener('online', notify); window.removeEventListener('offline', notify); };
};
export function useGuidanceOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/** Reconnection alone cannot make a pre-disconnection snapshot current again. */
export function useGuidanceRevalidation(online: boolean, updatedAt: number) {
  const [disconnectedAt, setDisconnectedAt] = useState(0);
  useEffect(() => { if (!online) setDisconnectedAt(Date.now()); }, [online]);
  return disconnectedAt > updatedAt;
}

export function BriefStageField({ stage, onChange, en }: { stage: TaskBriefStage; onChange: (stage: TaskBriefStage) => void; en: boolean }) {
  const labels: Record<TaskBriefStage, string> = en
    ? { analysis: 'Analysis · scope and gaps', development: 'Development · requirements and constraints', review: 'Review · acceptance and evidence', recovery: 'Recovery · original operations and handoff' }
    : { analysis: '分析 · 目标与缺口', development: '开发 · 要求与约束', review: '审查 · 验收与证据', recovery: '恢复 · 原操作与交接' };
  return <label className="task-brief-stage">{en ? 'Guidance stage' : '引导阶段'}<RadixSelect aria-label={en ? 'Guidance stage' : '引导阶段'} value={stage} onChange={event => {
    const parsed = taskBriefStageSchema.safeParse(event.target.value);
    if (parsed.success) onChange(parsed.data);
  }}>{taskBriefStageSchema.options.map(value => <option key={value} value={value}>{labels[value]}</option>)}</RadixSelect></label>;
}

export function BriefReadNotice({ error, loading, stale, online, hasData, en }: { error: unknown; loading: boolean; stale: boolean; online: boolean; hasData: boolean; en: boolean }) {
  const failure = guidanceReadFailure(error);
  return <>
    {loading && <p role="status">{en ? 'Reading authorized snapshot…' : '正在读取当前授权快照…'}</p>}
    {!online && <p className="task-brief-warning" role="status">{en ? 'Offline. Any retained snapshot is out of date; no current result is available.' : '连接已断开；保留的快照已标记过期，不能视为当前结果。'}</p>}
    {error != null && <p role="alert" className="task-brief-error">{failure === 'access'
      ? (en ? 'Access expired or source is no longer readable. Sensitive content has been cleared; sign in or recheck access.' : '登录或读取权限已失效，或来源不再可读；敏感内容已清理，请重新登录或核对权限。')
      : failure === 'conflict'
        ? (en ? 'The task revision, source or execution identity changed. Refresh the task and original record before reading again.' : '任务版本、来源或执行身份已变化；请先刷新任务与原记录后重新读取。')
        : `${en ? 'Read failed; the service did not return a current result.' : '读取失败，服务未返回当前结果。'} ${error instanceof Error ? error.message : ''}`}</p>}
    {stale && hasData && <p className="task-brief-warning" role="status">{en ? 'STALE · showing the last successful snapshot, not a successful refresh.' : '已过期 · 当前显示上次成功快照，不代表刷新成功。'}</p>}
    {!hasData && !loading && !error && online && <p role="status">{en ? 'No authorized snapshot has been read.' : '尚未读取授权快照。'}</p>}
  </>;
}
