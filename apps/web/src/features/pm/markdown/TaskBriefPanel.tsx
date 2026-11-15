import { useEffect, useRef, useState } from 'react';
import type { TaskBrief, TaskBriefSourceRef, TaskBriefStage, TaskBriefStatement, TaskKnowledgePage } from '@agent-workspace/contracts/task-brief';
import type { WorkspaceController } from './controller';
import { usePmService, usePrivateQuery } from '../service/pm-service';
import { allowed } from '../service/pm-ui';
import { BriefReadNotice, BriefStageField, useGuidanceOnline, useGuidanceRevalidation } from './task-brief-ui';
import { guidanceReadFailure, guidanceSnapshot, knowledgeProjectScope } from './task-brief-presentation';
import { BriefSourceButton, TaskBriefSource } from './TaskBriefSource';
import './task-brief.css';

type Search = { query: string; projectIds: string[]; cursor?: string };

function Statements({ title, items, en, onSource }: { title: string; items: TaskBriefStatement[]; en: boolean; onSource: (source: TaskBriefSourceRef) => void }) {
  return <section className="task-brief-statements"><h4>{title}</h4>{items.length ? <ul>{items.map((item, index) => <li key={index}><p>{item.text}</p><div className="task-brief-sources">{item.sourceRefs.map((source, i) => <BriefSourceButton key={i} source={source} en={en} onOpen={onSource} />)}</div></li>)}</ul> : <p className="task-brief-note">{en ? 'Not explicitly stated in the readable source. This is a gap, not an empty confirmed requirement.' : '可读来源未明确声明；这是信息缺口，不代表已确认「无要求」。'}</p>}</section>;
}

export function TaskBriefPanel({ controller: c, en, focusSection = 'brief', embedded = false }: { controller: WorkspaceController; en: boolean; focusSection?: 'brief' | 'knowledge'; embedded?: boolean }) {
  const { workspace } = usePmService();
  const online = useGuidanceOnline();
  const knowledgeSection = useRef<HTMLElement | null>(null);
  const [stage, setStage] = useState<TaskBriefStage>('analysis');
  const [bodyOffset, setBodyOffset] = useState(0);
  const [queryText, setQueryText] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [search, setSearch] = useState<Search | null>(null);
  const [source, setSource] = useState<TaskBriefSourceRef | null>(null);
  const [accessFailure, setAccessFailure] = useState<Error | null>(null);
  const [sourceFailure, setSourceFailure] = useState<Error | null>(null);
  const task = c.selected!;
  const projectId = task.entity.project!;
  const prefix = [...c.session.queryKey.slice(0, 4), 'task-guidance', projectId, task.id, task.revision];
  const brief = usePrivateQuery<TaskBrief>([...prefix, 'brief', stage, bodyOffset], 'domain.read', projectId, (client, workspaceId, signal) => client.taskBrief(workspaceId, projectId, task.id, { revision: task.revision, stage, bodyOffset }, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) }));
  const briefView = guidanceSnapshot(brief.data, brief.error, online, useGuidanceRevalidation(online, brief.dataUpdatedAt));
  const permittedProjects = c.projects.filter(file => allowed(workspace, 'domain.read', file.id));
  const projectIds = knowledgeProjectScope(projectId, selectedProjects, permittedProjects.map(file => file.id));
  const knowledge = usePrivateQuery<TaskKnowledgePage>([...prefix, 'knowledge', search], 'domain.read', projectId, (client, workspaceId, signal) => client.searchTaskKnowledge(workspaceId, projectId, task.id, { revision: task.revision, query: search!.query, projectIds: search!.projectIds, limit: 10, ...(search?.cursor ? { cursor: search.cursor } : {}) }, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) }), !!search && !!briefView.data && !accessFailure && !sourceFailure);
  const knowledgeView = guidanceSnapshot(knowledge.data, knowledge.error, online, useGuidanceRevalidation(online, knowledge.dataUpdatedAt));
  const blockedError = accessFailure ?? sourceFailure ?? (guidanceReadFailure(brief.error) === 'access' ? brief.error : guidanceReadFailure(knowledge.error) === 'access' ? knowledge.error : null);
  useEffect(() => {
    const denied = [brief.error, knowledge.error].find(error => guidanceReadFailure(error) === 'access');
    if (denied) setAccessFailure(denied);
  }, [brief.error, knowledge.error]);
  const value = blockedError ? undefined : briefView.data;
  const hasValue = !!value;
  useEffect(() => {
    if (focusSection !== 'knowledge' || !hasValue) return;
    const frame = requestAnimationFrame(() => knowledgeSection.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [focusSection, hasValue]);
  const results = blockedError ? undefined : knowledgeView.data;
  const t = (english: string, zh: string) => en ? english : zh;
  const refresh = async () => {
    const result = await brief.refetch();
    if (result.error || !result.data) return;
    setSearch(null); setAccessFailure(null); setSourceFailure(null); setSource(null);
  };
  return <section className="task-brief" id={`task-brief-${task.id}`} aria-label={t('Task execution brief', '任务执行简报')} data-testid="task-execution-brief">
    {!embedded && <header className="task-brief-heading"><h3>{t('Execution brief', '执行简报')}</h3><span>{t('Read only · no model dispatch', '只读 · 不派发模型')}</span></header>}
    {!embedded && <p className="task-brief-note">{t('Derived from the saved Markdown task. Viewing, refreshing and changing stage never create a session, run a model or change PM status.', '从已保存的 Markdown 任务派生；查看、刷新和切换阶段不创建会话、不运行模型、不修改 PM 状态。')}</p>}
    {(c.draft || c.ahead || c.writesBlocked) && <p className="task-brief-warning">{t('The brief uses the saved revision, not unsaved or unconfirmed edits. Reconcile the task before execution.', '简报仅使用已保存版本，不包含未保存或待确认的编辑；执行前请先核对任务。')}</p>}
    <div className="task-brief-toolbar"><BriefStageField stage={stage} onChange={next => { setStage(next); setBodyOffset(0); }} en={en} /><button type="button" disabled={brief.isFetching} onClick={() => void refresh()}>{t('Refresh brief', '刷新简报')}</button><button type="button" disabled={c.query.isFetching} onClick={() => void c.query.refetch()}>{t('Reload task revision', '重新读取任务版本')}</button></div>
    {sourceFailure && <p className="task-brief-warning">{t('The source changed. Old excerpts have been cleared; refresh the brief and explicitly search again.', '来源已变化，旧片段已清理；请刷新简报后重新明确检索。')}</p>}
    <BriefReadNotice error={blockedError ?? brief.error} loading={brief.isFetching} stale={briefView.stale} online={online} hasData={!!value} en={en} />
    {value && <>
      <p>{value.task.taskId} · {value.task.title}<br /><span>{t('Saved task revision', '已保存任务版本')} <code>{value.task.revision}</code></span><br /><span>{t('Generated', '生成时间')} {value.generatedAt} · {value.stage}</span></p>
      <p className="task-brief-note">{value.authorityNotice}</p>
      <Statements title={t('Goals', '目标')} items={value.goals} en={en} onSource={setSource} />
      <Statements title={t('Acceptance criteria', '验收标准')} items={value.acceptanceCriteria} en={en} onSource={setSource} />
      <Statements title={t('Constraints', '约束')} items={value.constraints} en={en} onSource={setSource} />
      <Statements title={t('Non-goals', '非目标')} items={value.nonGoals} en={en} onSource={setSource} />
      <section><h4>{t('Stage guidance · not additional permission', '阶段指导 · 不是额外授权')}</h4><ul>{value.guidance.map((line, i) => <li key={i}>{line}</li>)}</ul></section>
      <section><h4>{t('Gaps in the authorized scope', '授权范围内的缺口')}</h4>{value.gaps.length ? <ul>{value.gaps.map((gap, i) => <li key={i}><code>{gap.code}</code> · {gap.message}</li>)}</ul> : <p>{t('No gaps reported by this deterministic extraction; this is not a model assessment of completeness.', '本次确定性提取未报告缺口；不代表模型已评估需求完整。')}</p>}</section>
      <p className={value.truncation.truncated || !value.dispatchable ? 'task-brief-warning' : 'task-brief-note'}>{t('Clipping', '裁剪')}: {value.truncation.truncated ? t('Yes', '有') : t('None reported', '未报告')} · {t('body / statements / relations', '正文／条目／关系')}: {[value.truncation.body, value.truncation.statements, value.truncation.relations].map(flag => flag ? '✓' : '—').join(' / ')}{value.truncation.message && ` · ${value.truncation.message}`}<br />{value.dispatchable ? t('This brief is complete enough for the server dispatch check; no execution is authorized here.', '此简报符合服务端派发完整性检查；此处不授予执行权限。') : t('This clipped or incomplete brief cannot be dispatched. Read the source or reduce context explicitly.', '此简报存在裁剪或不完整，不能用于派发；请读取来源或显式缩小上下文。')}</p>
      <details><summary>{t('Original task body', '任务原文')} · {value.task.bodyOffset}–{value.task.bodyOffset + value.task.body.length} / {value.task.bodyLength}</summary><pre>{value.task.body || t('(Empty body)', '（正文为空）')}</pre><div className="task-brief-toolbar">{bodyOffset > 0 && <button type="button" onClick={() => setBodyOffset(0)}>{t('Read from start', '从头读取')}</button>}{value.task.nextBodyOffset !== null && <button type="button" onClick={() => setBodyOffset(value.task.nextBodyOffset!)}>{t('Continue reading task body', '继续读取任务正文')}</button>}</div></details>
      <details><summary>{t('Source references and formal relations', '来源引用与正式关系')}</summary><div className="task-brief-sources">{value.sources.map((ref, i) => <BriefSourceButton key={i} source={ref} en={en} onOpen={setSource} />)}</div>{value.relations.length > 0 && <ul>{value.relations.map((relation, i) => <li key={i}>{relation.direction} · {relation.relation} <BriefSourceButton source={relation.source} en={en} onOpen={setSource} /> → <BriefSourceButton source={relation.target} en={en} onOpen={setSource} /></li>)}</ul>}</details>
      <section ref={knowledgeSection} className="task-brief-knowledge" aria-label={t('Scoped knowledge search', '明确范围的知识检索')}><h4>{t('Knowledge candidates · explicit scope', '知识候选 · 明确范围')}</h4>
        <form onSubmit={event => { event.preventDefault(); if (queryText.trim()) { setSource(null); setSearch({ query: queryText.trim(), projectIds }); } }}>
          <label>{t('Search terms', '检索词')}<input value={queryText} maxLength={500} onChange={event => setQueryText(event.target.value)} placeholder={t('Enter explicit terms from this task', '输入与此任务有关的明确词语')} /></label>
          <p>{t('Always includes the current project', '始终包含当前项目')}: <code>{projectId}</code></p>
          <details><summary>{t('Explicitly include other readable projects', '显式加入其他可读项目')}</summary><p className="task-brief-note">{t('Nothing is selected automatically. The server rechecks every selected project; these choices grant no new access.', '不会自动选择其他项目；服务端逐项重新核验，勾选不授予额外权限。')}</p>{permittedProjects.filter(file => file.id !== projectId).map(file => <label className="task-brief-project" key={file.id}><input type="checkbox" checked={selectedProjects.includes(file.id)} disabled={!selectedProjects.includes(file.id) && projectIds.length >= 20} onChange={event => setSelectedProjects(previous => event.target.checked ? [...previous, file.id] : previous.filter(id => id !== file.id))} />{file.entity.title} · {file.id}</label>)}</details>
          <p>{t('Request scope', '将检索的范围')}: {projectIds.join(', ')}</p><button type="submit" disabled={!queryText.trim() || knowledge.isFetching}>{t('Search authorized knowledge', '检索授权知识')}</button>
        </form>
        {!search && <p className="task-brief-note">{t('Enter terms and explicitly search. No background cross-project search is performed.', '输入检索词并明确点击检索；不在后台检索跨项目资料。')}</p>}
        {search && <BriefReadNotice error={knowledge.error} loading={knowledge.isFetching} stale={knowledgeView.stale} online={online} hasData={!!results} en={en} />}
        {guidanceReadFailure(knowledge.error) === 'conflict' && <p className="task-brief-warning">{t('The result cursor or source version expired. Submit Search again to start from the first page; do not reuse the old cursor.', '结果游标或来源版本已过期。请重新点击检索从第一页开始，不要沿用旧游标。')}</p>}
        {results && <>
          <p>{t('Result scope', '结果范围')}: {results.projectIds.join(', ')} · “{results.query}” · {results.generatedAt}<br />{results.authorityNotice}</p>
          <p className="task-brief-note">{t('Deterministic lexical candidates. Retrieval order is not evidence of validity or applicability.', '确定性词法候选；排序不代表知识有效或适用于当前任务。')}</p>
          {results.items.length ? <ul>{results.items.map((candidate, i) => <li key={i}>
            <BriefSourceButton source={candidate.source} en={en} onOpen={setSource} /><pre>{candidate.excerpt}</pre>
            <p>{t('Validity / applicability: needs review', '有效性／适用性：待复核')} · {candidate.reason}</p>
            <p>{t('Matched terms', '命中词')}: {candidate.matchedTerms.join(', ')}</p>
            {candidate.validitySignals.length > 0 && <Statements title={t('Invalidation / supersession signals · source text, not an automatic verdict', '失效／替代线索 · 原文资料，不是自动判定')} items={candidate.validitySignals} en={en} onSource={setSource} />}
            {candidate.truncation.truncated && <p className="task-brief-warning">{t('Excerpt or validity signals clipped; open the readable source to continue. Next body offset', '片段或有效性线索已裁剪；请打开可读来源继续核对。后续正文偏移')}: {candidate.truncation.nextBodyOffset ?? '—'}</p>}
          </li>)}</ul> : <p>{t('No candidates matched in the explicitly authorized scope. This is not proof that no relevant knowledge exists.', '明确授权范围内未匹配候选；不代表不存在相关知识。')}</p>}
          {results.nextCursor && <button type="button" disabled={knowledge.isFetching} onClick={() => setSearch({ query: results.query, projectIds: results.projectIds, cursor: results.nextCursor! })}>{t('Next result page (same query / scope)', '下一页候选（保持原检索词／范围）')}</button>}
        </>}
      </section>
      {source && <TaskBriefSource key={JSON.stringify(source)} source={source} controller={c} en={en} onClose={() => setSource(null)} onAccessFailure={setAccessFailure} onSourceChanged={setSourceFailure} />}
    </>}
  </section>;
}
