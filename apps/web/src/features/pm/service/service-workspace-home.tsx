import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError as PmApiError } from '@contracts';
import { workflowFor, type FileRecord } from '@pm-schema';
import { ArrowDown, ArrowRight, ArrowUpRight, CalendarDays, CheckCheck, CircleCheck, CircleDashed, Clock3, FolderKanban, FolderPlus, History, Plus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CountUp } from '@/components/ui/count-up';
import { useI18n } from '@/lib/i18n-provider';
import { useWorkspaceStore } from '@/providers/app-providers';
import { ApiError as CoreApiError } from '../markdown/api';
import { CoreSessionProvider, useCoreSession, useSessionDrafts } from '../markdown/session';
import { useTaskScopeClock } from '../markdown/task-scope-clock';
import { actionLabels } from './activity-action-labels';
import { useWorkspaceActivity } from './pm-activity-hooks';
import { usePersonalDashboard, usePmService, usePrivateQuery } from './pm-service';
import { allowed, ServiceGuard, useText } from './pm-ui';
import { usePmNoticeCenter } from './pm-notice-center';
import { teamTaskCreateProjectProblem } from './team-task-actions-model';
import { workspaceHomeModel, type HomeTaskTab } from './workspace-home-model';
import styles from './service-workspace-home.module.css';

const defaultStateLabels: Record<string, { en: string; zh: string }> = {
  todo: { en: 'To do', zh: '待办' }, 'in progress': { en: 'In progress', zh: '进行中' },
  done: { en: 'Done', zh: '已完成' }, canceled: { en: 'Canceled', zh: '已取消' },
  planned: { en: 'Planned', zh: '规划中' }, active: { en: 'Active', zh: '进行中' },
  'on hold': { en: 'On hold', zh: '已暂停' }, completed: { en: 'Completed', zh: '已完成' },
};

/** Workspace landing page; Dashboard and its independent variants remain separate. */
export function ServiceWorkspaceHome() {
  const service = usePmService();
  const t = useText();
  return <ServiceGuard>{service.actor && service.workspace && (service.workspace.capabilities.includes('domain.read')
    ? <CoreSessionProvider key={`${service.actor.id}:${service.workspace.id}:${service.workspace.version}:${service.actorEpoch}`} hostNamespace={window.location.origin} actorId={service.actor.id} workspaceId={service.workspace.id} membershipVersion={service.workspace.version} actorEpoch={service.actorEpoch} onAccessFailure={service.refresh}>
      <WorkspaceHomeContent />
    </CoreSessionProvider>
    : <div className={styles.unavailable} role="alert"><FolderKanban size={24} aria-hidden="true" /><h1>{t('首页不可用', 'Home unavailable')}</h1><p>{t('当前没有读取工作区业务数据的权限。', 'You do not have permission to read workspace data.')}</p>{allowed(service.workspace, 'access.manage') && <Link to={`/pm/${encodeURIComponent(service.workspace.id)}/members`}>{t('管理工作区成员', 'Manage workspace members')}</Link>}</div>)}</ServiceGuard>;
}

function WorkspaceHomeContent() {
  const { actor, workspace, capabilities, error: serviceError } = usePmService();
  const session = useCoreSession();
  const [sourceDrafts] = useSessionDrafts();
  const core = usePrivateQuery(session.queryKey.slice(0, -2), 'domain.read', undefined, async (_client, _workspaceId, signal) => {
    try { return await session.api.workspace(signal); }
    catch (cause) {
      if (cause instanceof CoreApiError && [401, 403, 404].includes(cause.status)) throw new PmApiError(cause.status, { error: { code: cause.status === 401 ? 'unauthenticated' : 'not_found_or_forbidden', message: cause.message } });
      throw cause;
    }
  });
  const personal = usePersonalDashboard();
  // Same merged audit/change snapshot as the Activity page, bounded to the newest
  // seven per project: enough to derive a correct workspace-wide top seven.
  const activity = useWorkspaceActivity({ recentLimit: 7 });
  const profile = !personal.error && personal.data && personal.data.profile.userId === actor?.id ? personal.data.profile : undefined;
  const today = useTaskScopeClock(profile?.timeZone, personal.dataUpdatedAt);
  const model = useMemo(() => core.data && actor && workspace ? workspaceHomeModel(core.data, actor.id, workspace.projectIds, today) : null, [core.data, actor, workspace, today]);
  const filesById = useMemo(() => new Map(core.data?.files.map(file => [file.id, file])), [core.data]);
  const recent = activity.entries.slice(0, 7);
  const [tab, setTab] = useState<HomeTaskTab>('todo');
  const [allMine, setAllMine] = useState(false);
  const [allDeadlines, setAllDeadlines] = useState({ today: false, tomorrow: false, week: false });
  const tabRefs = useRef<Partial<Record<HomeTaskTab, HTMLButtonElement | null>>>({});
  const [now, setNow] = useState(() => Date.now());
  const navigate = useNavigate();
  const location = useLocation();
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode);
  const en = useI18n().locale === 'en';
  const t = useText();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    const focus = () => setNow(Date.now());
    window.addEventListener('focus', focus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, []);
  if (!actor || !workspace) return null;
  const root = `/pm/${encodeURIComponent(workspace.id)}`;
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const locale = en ? 'en-US' : 'zh-CN';
  const hour = profile ? Number(new Intl.DateTimeFormat('en-US', { timeZone: profile.timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now)) : null;
  const greeting = hour === null ? t('你好', 'Hello') : hour < 12 ? t('早上好', 'Good morning') : hour < 18 ? t('下午好', 'Good afternoon') : t('晚上好', 'Good evening');
  const name = profile?.name || actor.name;
  const dateLabel = today ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${today}T12:00:00Z`)) : null;
  const formatDue = (date: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
  const configurationInvalid = core.data?.configurationErrors.some(issue => issue.severity === 'error') === true;
  const createUnavailable = capabilities?.business.enabled !== true || !!serviceError || !!core.error || !core.data || configurationInvalid;
  const writableProjects = model?.projects.filter(file => allowed(workspace, 'planning.edit', file.id) && !teamTaskCreateProjectProblem(core.data, file.id, sourceDrafts)) || [];
  const canCreateTask = !createUnavailable && writableProjects.length > 0;
  const canCreateProject = !createUnavailable && allowed(workspace, 'planning.edit');
  const canManageMembers = allowed(workspace, 'access.manage') && capabilities?.business.enabled === true;
  const taskCreateReason = !workspace.capabilities.includes('planning.edit') ? t('当前为只读权限。', 'Your access is read-only.') : createUnavailable ? t('请先恢复工作区读取与服务能力。', 'Restore the workspace read and service availability first.') : t('需要可写、未结束且未归档的授权项目。', 'A writable, nonterminal, unarchived authorized project is required.');
  const taskHref = (file: FileRecord) => {
    const projectRoot = `${root}/projects/${encodeURIComponent(file.entity.project!)}`;
    return taskOpenMode === 'panel' ? `${projectRoot}/issues?${new URLSearchParams({ entity: file.id, returnTo })}` : `${projectRoot}/entities/${encodeURIComponent(file.id)}?${new URLSearchParams({ returnTo })}`;
  };
  const statusLabel = (file: FileRecord) => {
    const state = core.data && workflowFor(file.entity.entity, core.data.configuration)?.states.find(item => item.id === file.entity.status);
    if (!state) return file.entity.status || t('状态未知', 'Unknown status');
    return defaultStateLabels[state.label]?.[en ? 'en' : 'zh'] || state.label;
  };
  const mine = model?.mine[tab];
  const tabs: { id: HomeTaskTab; label: string }[] = [{ id: 'todo', label: t('待办', 'To do') }, { id: 'overdue', label: t('逾期', 'Overdue') }, { id: 'completed', label: t('已完成', 'Completed') }];
  function selectTab(next: HomeTaskTab) { setTab(next); setAllMine(false); }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, current: HomeTaskTab) {
    const index = tabs.findIndex(item => item.id === current);
    const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : undefined;
    if (!next) return;
    event.preventDefault(); selectTab(next.id); tabRefs.current[next.id]?.focus();
  }
  return <main className={styles.page} data-pm-page="workspace-home" aria-label={t('工作区首页', 'Workspace home')}>
    <div className={styles.workbench}>
      <header className={styles.heading}>
        <div className={styles.welcome}><h1>{greeting}{name ? `, ${name}` : ''}</h1>{dateLabel && <p><time dateTime={today!}>{dateLabel}</time></p>}{profile && <span className={styles.zone}>{profile.timeZone}</span>}</div>
        <div className={styles.actions}>
          {canManageMembers && <Button variant="outline" size="sm" onClick={() => navigate(`${root}/members?tab=members&panel=invitations`)}><Users size={14} aria-hidden="true" />{t('成员与邀请', 'Members & invites')}</Button>}
          {allowed(workspace, 'planning.edit') && <Button variant="outline" size="sm" disabled={!canCreateProject} title={!canCreateProject ? t('工作区数据或服务能力尚不可用。', 'Workspace data or service availability is not ready.') : undefined} onClick={() => navigate(`${root}/views?${new URLSearchParams({ kind: 'project', create: '1', returnTo })}`, { state: { returnTo } })}><FolderPlus size={14} aria-hidden="true" />{t('新建项目', 'New project')}</Button>}
          <Button size="sm" disabled={!canCreateTask} title={!canCreateTask ? taskCreateReason : undefined} aria-describedby={!canCreateTask ? 'home-create-reason' : undefined} onClick={() => navigate(`${root}/issues/new?${new URLSearchParams({ returnTo })}`, { state: { returnTo } })}><Plus size={15} aria-hidden="true" />{t('新建任务', 'New task')}</Button>
        </div>
      </header>
      {!canCreateTask && <p id="home-create-reason" className={styles.scopeNote} role="status">{taskCreateReason}</p>}
      <div className={styles.contextLine}><Link to={`${root}/issues?project=`}>{t('全部任务', 'All tasks')}<ArrowUpRight size={13} aria-hidden="true" /></Link></div>
      <HomeReadNotice label={t('工作区任务与项目', 'Workspace tasks and projects')} pending={core.isPending} error={core.error} stale={!!core.data} retry={() => { void core.refetch(); }} />
      <HomeReadNotice label={t('个人资料与时区', 'Personal profile and time zone')} pending={personal.isPending} error={personal.error} stale={false} retry={() => { void personal.refetch(); }} />
      {configurationInvalid && <div className={styles.readNotice} role="alert"><span>{t('工作流配置无效，统计与日期分组不可用，不会使用默认规则推算。', 'Workflow configuration is invalid. Counts and date groups are unavailable; default completion rules are not substituted.')}</span><Link to={`${root}/settings?section=configuration`}>{t('查看工作流', 'Review workflow')}</Link><button onClick={() => { void core.refetch(); }}>{t('重试读取', 'Retry read')}</button></div>}
      {!!model?.excludedSources && <p className={styles.scopeNote} role="status">{t(`有 ${model.excludedSources} 份无效、过期或不支持的源码未计入统计；请查看源码诊断。`, `${model.excludedSources} invalid, stale or unsupported sources are excluded from counts. Review source diagnostics.`)} <Link to={`${root}/settings?section=diagnostics`}>{t('查看诊断', 'Diagnostics')}</Link></p>}
      <section className={styles.stats} aria-label={t('授权范围统计', 'Authorized scope statistics')}>
        {[
          { label: t('活跃项目', 'Active projects'), Icon: FolderKanban, value: model?.activeProjects.length, detail: undefined },
          { label: t('开放任务', 'Open tasks'), Icon: CircleDashed, value: model?.open.length, detail: model ? t(`${model.open.filter(file => file.entity.assignee === actor.id).length} 项分派给你`, `${model.open.filter(file => file.entity.assignee === actor.id).length} assigned to you`) : undefined },
          { label: t('已完成', 'Completed'), Icon: CircleCheck, value: model?.completed.length, detail: undefined },
          { label: t('逾期', 'Overdue'), Icon: Clock3, value: model?.overdue?.length, detail: undefined },
        ].map(({ label, Icon, value, detail }, index) => <div className={styles.stat} key={label}><span className={styles.statLabel}><Icon size={15} aria-hidden="true" />{label}</span><strong className={index === 3 && value ? styles.overdueCount : ''}><CountUp value={value} /></strong>{detail && <span className={styles.statDetail}>{detail}</span>}</div>)}
      </section>
      <div className={styles.columns}>
        <div className={styles.stack}>
          <section className={styles.panel} aria-labelledby="home-my-tasks">
            <div className={styles.panelHeader}><h2 id="home-my-tasks">{t('我的任务', 'My tasks')}</h2><div className={styles.tabs} role="tablist" aria-label={t('我的任务状态', 'My task state')}>{tabs.map(item => <button key={item.id} ref={element => { tabRefs.current[item.id] = element; }} type="button" role="tab" id={`home-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="home-my-task-list" tabIndex={tab === item.id ? 0 : -1} onKeyDown={event => tabKey(event, item.id)} onClick={() => selectTab(item.id)}>{item.label}<span>{model?.mine[item.id]?.length ?? '—'}</span></button>)}</div></div>
            <div id="home-my-task-list" role="tabpanel" aria-labelledby={`home-tab-${tab}`} tabIndex={0}>
              {!model || !mine ? <p className={styles.empty} role="status">{core.error || configurationInvalid || personal.error && tab !== 'completed' ? t('任务范围暂不可用，请使用上方对应重试入口。', 'This task scope is unavailable. Use the corresponding retry above.') : t('正在读取任务与个人日期范围…', 'Reading tasks and your personal date scope…')}</p> : mine.length ? <ul data-pm-stagger className={styles.taskList}>{(allMine ? mine : mine.slice(0, 7)).map(file => <li key={file.id}><Link className={styles.taskRow} to={taskHref(file)} state={{ returnTo }}><span className={styles.taskIcon}>{tab === 'completed' ? <CircleCheck size={15} aria-hidden="true" /> : <CircleDashed size={15} aria-hidden="true" />}</span><span className={styles.taskMain}><span className={styles.taskTitle}>{file.entity.title}</span><span className={styles.taskMeta}>{file.id}<span aria-hidden="true"> · </span>{filesById.get(file.entity.project!)?.entity.title || file.entity.project}<span aria-hidden="true"> · </span>{statusLabel(file)}</span></span><span className={`${styles.taskDue} ${today && file.entity.due && file.entity.due < today && tab !== 'completed' ? styles.danger : ''}`}>{file.entity.due ? <time dateTime={file.entity.due}>{formatDue(file.entity.due)}</time> : t('未排期', 'No due date')}</span><ArrowUpRight className={styles.rowArrow} size={13} aria-hidden="true" /></Link></li>)}</ul> : <div className={styles.empty}><CheckCheck size={24} aria-hidden="true" /><strong>{tab === 'overdue' ? t('没有逾期任务', 'Nothing overdue') : tab === 'completed' ? t('暂无已完成任务', 'No completed tasks') : t('暂无待办任务', 'No upcoming tasks')}</strong></div>}
              {!!mine && mine.length > 7 && <button className={styles.expandRow} onClick={() => setAllMine(value => !value)} aria-expanded={allMine}>{allMine ? t('收起任务', 'Show fewer tasks') : t(`查看此分组全部 ${mine.length} 项任务`, `View all ${mine.length} tasks in this group`)}<ArrowDown size={13} aria-hidden="true" /></button>}
            </div>
          </section>
          <section className={styles.panel} aria-labelledby="home-project-progress">
            <div className={styles.panelHeader}><h2 id="home-project-progress">{t('项目进度', 'Project progress')}</h2><Link className={styles.panelLink} to={`${root}/projects`}>{t('全部项目', 'All projects')}<ArrowRight size={13} aria-hidden="true" /></Link></div>
            {!model ? <p className={styles.empty} role="status">{core.error || configurationInvalid ? t('项目统计不可用。', 'Project counts unavailable.') : t('正在读取项目…', 'Reading projects…')}</p> : !model.activeProjects.length ? <div className={styles.empty}><FolderKanban size={24} aria-hidden="true" /><strong>{t('暂无活跃项目', 'No active projects')}</strong></div> : <ul data-pm-stagger className={styles.projectList}>{model.activeProjects.slice(0, 6).map(project => <li className={styles.projectRow} key={project.file.id}><div className={styles.projectIdentity}><Link to={`${root}/projects/${encodeURIComponent(project.file.id)}?${new URLSearchParams({ returnTo })}`} state={{ returnTo }}><FolderKanban size={15} aria-hidden="true" /><span>{project.file.entity.title}</span></Link><span className={styles.status}>{statusLabel(project.file)}</span></div><div className={styles.progress}><div className={styles.progressTrack} role="progressbar" aria-label={t(`${project.file.entity.title}任务完成率`, `${project.file.entity.title} task completion`)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={project.percent ?? undefined} aria-valuetext={project.percent === null ? t('暂无可统计任务', 'No eligible tasks') : `${project.completed}/${project.total}`}><span style={{ width: `${project.percent ?? 0}%` }} /></div><span>{project.percent === null ? '—' : `${project.percent}%`}</span><small>{project.completed}/{project.total}</small></div><span className={styles.projectDue}>{project.file.entity.due ? <><span>{t('截止', 'Due')} </span><time dateTime={project.file.entity.due}>{formatDue(project.file.entity.due)}</time></> : t('未排期', 'Not scheduled')}</span></li>)}</ul>}
          </section>
        </div>
        <div className={styles.stack}>
          <section className={styles.panel} aria-labelledby="home-deadlines">
            <div className={styles.panelHeader}><h2 id="home-deadlines">{t('即将截止', 'Upcoming deadlines')}</h2><Link className={styles.panelLink} to={`${root}/issues?view=calendar&project=`}><CalendarDays size={13} aria-hidden="true" />{t('日历', 'Calendar')}</Link></div>
            {!model?.deadlines ? <p className={styles.empty} role="status">{core.error || configurationInvalid || personal.error ? t('截止分组不可用，请重试工作区或个人资料读取。', 'Deadline groups unavailable. Retry the workspace or personal profile read.') : t('正在按个人时区读取截止日期…', 'Reading deadlines in your personal time zone…')}</p> : <div className={styles.deadlines}>{model.deadlines.map(group => <section key={group.id} className={styles.deadlineGroup} aria-labelledby={`home-deadline-${group.id}`}><h3 id={`home-deadline-${group.id}`}>{group.id === 'today' ? t('今天', 'Today') : group.id === 'tomorrow' ? t('明天', 'Tomorrow') : t('未来 7 天（后天起）', 'Next 7 days (after tomorrow)')}<span>{group.files.length}</span></h3>{group.files.length ? <><ul>{(allDeadlines[group.id] ? group.files : group.files.slice(0, 4)).map(file => <li key={file.id}><Link to={taskHref(file)} state={{ returnTo }} className={styles.deadlineRow}><span className={styles.deadlineDot} aria-hidden="true" /><span className={styles.taskMain}><span className={styles.taskTitle}>{file.entity.title}</span><span className={styles.taskMeta}>{filesById.get(file.entity.project!)?.entity.title || file.entity.project}</span></span><time dateTime={file.entity.due!}>{formatDue(file.entity.due!)}</time></Link></li>)}</ul>{group.files.length > 4 && <button className={styles.moreDeadlines} aria-expanded={allDeadlines[group.id]} onClick={() => setAllDeadlines(previous => ({ ...previous, [group.id]: !previous[group.id] }))}>{allDeadlines[group.id] ? t('收起', 'Show fewer') : t(`另有 ${group.files.length - 4} 项`, `${group.files.length - 4} more`)}</button>}</> : <p className={styles.nothingDue}>{t('没有即将截止的任务', 'Nothing due')}</p>}</section>)}</div>}
            <p className={styles.panelFootnote}><Link to={`${root}/issues?overdue=1&project=`}>{t('查看逾期', 'View overdue')}</Link></p>
          </section>
          <section className={styles.panel} aria-labelledby="home-activity">
            <div className={styles.panelHeader}><h2 id="home-activity">{t('最近动态', 'Recent activity')}</h2><Link className={styles.panelLink} to={`${root}/notifications`}>{t('查看全部', 'View all')}<ArrowRight size={13} aria-hidden="true" /></Link></div>
            <div className={styles.activityBody}><HomeReadNotice label={t('最近动态', 'Recent activity')} pending={activity.isPending} error={activity.error} stale={recent.length > 0} retry={activity.refetch} />{!activity.isPending && (recent.length ? <ol data-pm-stagger className={styles.activityList}>{recent.map(entry => {
              const action = actionLabels[entry.action];
              const verb = action ? t(action[0], action[1]) : entry.category === 'status' ? t('更改了状态，位于', 'changed the status of') : t('记录了动态，位于', 'recorded activity on');
              const name = entry.actorId !== null && entry.actorId === actor.id ? t('你', 'You') : entry.actorName || t('未知操作者', 'Someone');
              const title = entry.targetTitle || entry.targetId || t('未知对象', 'Unknown target');
              return <li key={entry.id} data-activity-source={entry.source}><span className={styles.activityIcon}><History size={13} aria-hidden="true" /></span><div className={styles.activityMain}><span className={styles.eventType} title={entry.action}>{name} {verb}</span>{entry.href ? <Link to={entry.href} state={{ returnTo }}>{title}</Link> : <span>{title}</span>}<ActivityTime occurredAt={entry.occurredAt} timeZone={profile?.timeZone} locale={locale} /></div></li>;
            })}</ol> : <div className={styles.empty}><History size={24} aria-hidden="true" /><strong>{t('暂无可见动态', 'No activity yet')}</strong></div>)}</div>
          </section>
        </div>
      </div>
    </div>
  </main>;
}

function HomeReadNotice({ label, pending, error, stale, retry }: { label: string; pending: boolean; error: Error | null; stale: boolean; retry: () => void }) {
  const en = useI18n().locale === 'en';
  const { upsert, resolve } = usePmNoticeCenter();
  const retryRef = useRef(retry); retryRef.current = retry;
  const key = `home-read:${label}`;
  useEffect(() => {
    if (pending) upsert({ key: `${key}:pending`, severity: 'info', title: `${label} · ${en ? 'Loading…' : '正在读取…'}`, source: 'read', silent: true, transient: true });
    else resolve(`${key}:pending`);
    if (error) upsert({ key: `${key}:error`, severity: 'error', title: `${label} · ${en ? 'Read failed' : '读取失败'}`, detail: `${error.message}${stale ? (en ? ' The previous snapshot is retained and may be stale.' : ' 已保留上次快照，可能已过期。') : ''}`, source: 'read', sticky: true, action: { label: en ? 'Retry read' : '重试读取', run: () => retryRef.current() } });
    else resolve(`${key}:error`);
  }, [en, error, key, label, pending, resolve, stale, upsert]);
  return null;
}

function ActivityTime({ occurredAt, timeZone, locale }: { occurredAt: string; timeZone: string | undefined; locale: string }) {
  const t = useText();
  if (!timeZone) return <span className={styles.activityTime}>{t('正在等待个人时区', 'Waiting for your time zone')}</span>;
  return <time className={styles.activityTime} dateTime={occurredAt}>{new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(occurredAt))}</time>;
}
