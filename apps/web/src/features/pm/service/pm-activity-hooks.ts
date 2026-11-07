import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type MemberDirectory } from '@contracts';
import type { WorkspaceSnapshot } from '@pm-schema';
import { ApiError as CoreApiError, createCoreClient } from '../markdown/api';
import { pmKeys, readAllChanges, refreshPmSnapshots } from './pm-data';
import { isAccessError } from './pm-errors';
import { usePersonalDashboard, usePmService, usePrivateQuery } from './pm-service';
import { allowed, useText } from './pm-ui';
import { activityProjects, readActivityAudits, readActivityCommentTargets, workspaceActivityEntries, type ActivityEntry, type ActivityPerson } from './workspace-activity-model';

export type WorkspaceActivity = {
  entries: ActivityEntry[];
  people: ActivityPerson[];
  timeZone: string | undefined;
  actorId: string | undefined;
  isPending: boolean;
  isFetching: boolean;
  error: Error | null;
  notices: string[];
  refetch: () => void;
};

/** One authorized PM identity, existing provider SSE, and no business writes. */
export function useWorkspaceActivity(options: { recentLimit?: number } = {}): WorkspaceActivity {
  const recentLimit = options.recentLimit;
  const service = usePmService();
  const { actor, workspace } = service;
  const t = useText();
  const key = pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none');
  // These workspace queries are project-filtered by the server, not unrestricted reads.
  const canRead = workspace?.capabilities.includes('domain.read') === true;
  const canReadAudit = canRead && workspace?.capabilities.includes('audit.read') === true;
  const canReadDirectory = allowed(workspace, 'access.manage') || workspace?.capabilities.includes('directory.read') === true;
  const queryClient = useQueryClient();
  const events = service.coreEvents;
  const actorId = actor?.id;
  const workspaceId = workspace?.id;
  const [nativeConnection, setNativeConnection] = useState<{ events: EventSource; connected: boolean } | null>(null);
  useEffect(() => {
    if (!events || !actorId || !workspaceId || !canRead) return;
    const scopeKey = pmKeys.workspace(window.location.origin, actorId, workspaceId);
    let timer: number | undefined;
    let fullSnapshot = false;
    const queueSnapshot = (full: boolean) => {
      fullSnapshot ||= full;
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        const prefix = fullSnapshot ? scopeKey : [...scopeKey, 'workspace-activity'];
        fullSnapshot = false;
        // Plain invalidation can reuse an initial in-flight multi-page snapshot.
        // Cancel it first, then reread a finite, newly pinned history.
        void refreshPmSnapshots(queryClient, prefix);
      }, 75);
    };
    const ready = () => { setNativeConnection({ events, connected: true }); queueSnapshot(true); };
    const change = () => {
      setNativeConnection(previous => previous?.events === events && previous.connected ? previous : { events, connected: true });
      queueSnapshot(false);
    };
    const disconnected = () => setNativeConnection({ events, connected: false });
    events.addEventListener('ready', ready);
    events.addEventListener('change', change);
    events.addEventListener('error', disconnected);
    return () => {
      window.clearTimeout(timer);
      events.removeEventListener('ready', ready);
      events.removeEventListener('change', change);
      events.removeEventListener('error', disconnected);
    };
  }, [events, actorId, workspaceId, canRead, queryClient]);
  const nativeConnected = nativeConnection?.events === events ? nativeConnection.connected : events?.readyState === 1;
  // Same core key as CoreSessionProvider: authorized snapshot, including archives.
  const core = usePrivateQuery<WorkspaceSnapshot>([...key, 'core'], 'domain.read', undefined, async (_client, workspaceId, signal) => {
    try { return await createCoreClient(workspaceId).workspace(signal); }
    catch (cause) {
      if (cause instanceof CoreApiError && [401, 403, 404].includes(cause.status)) throw new ApiError(cause.status, { error: { code: cause.status === 401 ? 'unauthenticated' : 'not_found_or_forbidden' } });
      throw cause;
    }
  }, canRead);
  const projects = useMemo(() => activityProjects(core.data?.files ?? [], workspace?.projectIds ?? null), [core.data, workspace?.projectIds]);
  const changes = usePrivateQuery(pmKeys.changes(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'domain.read', undefined,
    (client, workspaceId, signal) => readAllChanges(client, workspaceId, undefined, signal), canRead);
  const audit = usePrivateQuery([...key, 'workspace-activity', 'audit', projects, recentLimit ?? 'all'], 'audit.read', undefined,
    (client, workspaceId, signal) => readActivityAudits(projects,
      (projectId, cursor, pageSignal) => client.getProjectAudit(workspaceId, projectId, { limit: Math.min(recentLimit ?? 100, 100), ...(cursor ? { cursor } : {}) }, { signal: pageSignal }),
      signal, recentLimit),
    canReadAudit && !!core.data);
  const directory = usePrivateQuery<MemberDirectory>([...key, 'members', 'directory'], allowed(workspace, 'access.manage') ? 'access.manage' : 'directory.read', undefined,
    (client, workspaceId, signal) => client.getMemberDirectory(workspaceId, { signal }), canRead && canReadDirectory);
  const personal = usePersonalDashboard(canRead);
  const references = useMemo(() => {
    const result = new Map<string, { projectId: string; commentId: string }>();
    for (const entry of audit.data ?? []) if (entry.targetKind === 'task_comment') result.set(`${entry.projectId}:${entry.targetId}`, { projectId: entry.projectId, commentId: entry.targetId });
    const audited = new Set(audit.data ? projects : []);
    for (const event of changes.data?.events ?? []) if (event.aggregateKind === 'task_comment' && event.projectId && !audited.has(event.projectId)) result.set(`${event.projectId}:${event.aggregateId}`, { projectId: event.projectId, commentId: event.aggregateId });
    return [...result.values()].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.commentId.localeCompare(b.commentId));
  }, [audit.data, changes.data, projects]);
  const taskScope = useMemo(() => core.data?.files.filter(file => file.entity.entity === 'work_item').map(file => [file.id, file.entity.project]).sort((a, b) => a[0]!.localeCompare(b[0]!)) ?? [], [core.data]);
  const comments = usePrivateQuery([...key, 'workspace-activity', 'comment-targets', references, taskScope], 'domain.read', undefined,
    (client, workspaceId, signal) => readActivityCommentTargets({ workspaceId, projectIds: workspace?.projectIds ?? null }, core.data?.files ?? [], references,
      async (taskId, projectId, after, pageSignal) => {
        try { return await client.getTaskComments(workspaceId, taskId, { projectId, limit: 100, ...(after ? { after } : {}) }, { signal: pageSignal }); }
        catch (cause) {
          // A moved task's old comments deliberately remain in their original audience.
          // This is an unresolved link, never an invented empty comment history.
          if (cause instanceof ApiError && cause.code === 'task_comment_project_changed') return null;
          throw cause;
        }
      }, signal), canRead && !!core.data && references.length > 0);
  const failures = [service.error, core.error, audit.error, changes.error, comments.error, directory.error, personal.error];
  const lostAccess = failures.some(isAccessError);
  const people = useMemo<ActivityPerson[]>(() => {
    if (!canRead || lostAccess || !actor || !workspace) return [];
    const members = !directory.error ? directory.data?.members.map(member => ({ id: member.userId, name: member.name })) ?? [] : [];
    if (!members.some(member => member.id === actor.id)) members.push({ id: actor.id, name: actor.name });
    return members.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [actor, workspace, canRead, lostAccess, directory.data, directory.error]);
  const profile = !personal.error && personal.data && personal.data.profile.userId === actor?.id ? personal.data.profile
    : !directory.error && directory.data && directory.data.selfProfile.userId === actor?.id ? directory.data.selfProfile : undefined;
  const timeZone = profile?.timeZone;
  const linksAvailable = !!core.data && !core.error && !core.isFetching;
  const entries = useMemo(() => !canRead || lostAccess || !workspace || !actor ? [] : workspaceActivityEntries({
    workspaceId: workspace.id, projectIds: workspace.projectIds, files: core.data?.files ?? [],
    audits: audit.data ?? [], auditedProjectIds: audit.data ? projects : [], events: changes.data?.events ?? [],
    commentTargets: comments.error || comments.isFetching ? [] : comments.data ?? [], people, canReadAudit, linksAvailable,
  }), [canRead, lostAccess, workspace, actor, core.data, audit.data, projects, changes.data, comments.data, comments.error, comments.isFetching, people, canReadAudit, linksAvailable]);
  const notices: string[] = [];
  if (actor && workspace && !canRead) notices.push(t('当前没有读取工作区活动所需的 domain.read 权限。', 'domain.read permission is required to read workspace activity.'));
  if (canRead) {
    notices.push(t('仅覆盖当前授权范围（含可读取的归档项目）；已删除项目无法通过现有项目审计接口查询。', 'Only currently authorized scope is included, including readable archived projects. The existing audit API cannot query deleted projects.'));
    notices.push(canReadAudit
      ? t('同一项目优先使用审计记录，不再重复合并变更流。审计只记录受控写入；外部文件修改及离线中间版本不补造操作者或历史。', 'Audit records replace change-stream metadata for the same project to avoid duplicate writes. Audit covers controlled writes; actors and offline intermediate history are not invented for external file edits.')
      : t('没有 audit.read 时只展示保留的变更元数据；明确的生命周期事件可筛为状态变化，但不推造操作者或 before/after 差异。', 'Without audit.read, only retained change metadata is shown. Explicit lifecycle events can be filtered as status changes, but actors and before/after differences are never inferred.'));
    if (changes.data?.historyTruncated) notices.push(t('变更流保留窗口之前的元数据已过期；项目审计历史不受此保留窗口限制。', 'Metadata before the change-stream retention window has expired. Project audit history is independent of that retention window.'));
    if (!timeZone && !personal.isPending && !directory.isPending) notices.push(t('个人时区当前不可用；日期分组明确使用 UTC。', 'Your personal time zone is unavailable; date groups explicitly use UTC.'));
    if (!canReadDirectory || directory.error) notices.push(t('部分成员姓名不可用；历史操作者不会用其他成员或当前任务作者代替。', 'Some member names are unavailable; historical actors are never replaced with another member or the current task author.'));
    if (!linksAvailable && !core.isPending && !core.isFetching) notices.push(t('无法核验当前对象，来源链接暂不可用。', 'Current targets cannot be verified, so source links are unavailable.'));
    if (entries.some(entry => entry.href === null)) notices.push(t('部分历史对象已删除、隐藏、缺失或无法按当前权限解析，因此不提供链接。', 'Some historical targets are deleted, hidden, missing, or unresolved under current access and are not linked.'));
    if (failures.some(Boolean) && !lostAccess && entries.length) notices.push(t('部分读取失败，当前显示的历史快照可能过期；请刷新重试。', 'Some reads failed. The displayed historical snapshot may be stale; refresh to retry.'));
    if (!nativeConnected || !['live', 'idle', 'signed-out'].includes(service.streamState)) notices.push(t('实时订阅尚未就绪或已断开；当前快照可能过期，可手动刷新。', 'Live updates are not ready or disconnected. This snapshot may be stale; refresh manually.'));
  }
  const refresh = service.refresh;
  const refetch = useCallback(() => { void refresh().catch(() => {}); }, [refresh]);
  return {
    entries, people, timeZone, actorId: actor?.id,
    isPending: service.loading || core.isPending || changes.isPending || canReadAudit && !!core.data && audit.isPending,
    isFetching: core.isFetching || changes.isFetching || audit.isFetching || comments.isFetching || directory.isFetching || personal.isFetching,
    error: failures.find((failure): failure is Error => failure !== null) ?? null,
    notices, refetch,
  };
}
