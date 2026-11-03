import { useMemo } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { entityKinds, workflowFor, type EntityKind, type FileRecord, type ProtocolConfiguration } from '@pm-schema';
import { useI18n } from '@/lib/i18n-provider';
import { useWorkspaceStore } from '@/providers/app-providers';
import { usePersonalDashboard, usePmService } from '@/features/pm/service/pm-service';
import { usePmDisplaySetting } from '@/features/pm/service/pm-display-settings';
import { CoreBusinessSections, CoreScheduleView } from '@/features/pm/service/pm-core-extensions';
import { CoreSessionProvider } from './session';
import Workspace, { type CollectionContext, type SettingsSection } from './workspace';
import type { CollectionLayout } from './controller';
import { TaskCreationSurface } from './TaskCreationSurface';
import { safeWorkspaceReturn, taskScope } from './task-collection-model';
import { useTaskScopeClock } from './task-scope-clock';

import { DocumentWorkbench } from './DocumentWorkbench';
import type { DocumentTarget } from './document-workbench-state';
import { documentWorkbenchLocation, documentWorkbenchReturn, documentWorkbenchUrl } from './document-workbench-navigation';
import './markdown.css';
import './document-scope.css';
import './views-scope.css';

export interface ServiceMarkdownProps {
  mode?: 'collection' | 'entity' | 'settings';
  entityKind?: EntityKind | '';
  projectId?: string;
  entityId?: string;
  settingsSection?: SettingsSection;
  initialCreate?: boolean;
}
interface NavigationState { returnTo?: string; collectionContext?: CollectionContext }
const presentationLayouts: Record<string, CollectionLayout> = {
  list: 'list', list1: 'list', list2: 'list', board: 'kanban', kanban: 'kanban', board1: 'kanban', board2: 'kanban', board3: 'kanban', 'dnd-board': 'kanban',
  table: 'table', spreadsheet1: 'table', calendar: 'calendar', calendar1: 'calendar', calendar2: 'calendar', 'hour-calendar': 'calendar', gantt: 'gantt', gantt1: 'gantt',
  graph: 'graph', dependencies: 'graph', tree: 'tree',
};
function coreStatus(value: string, configuration: ProtocolConfiguration, kind: EntityKind | '') {
  if (kind !== 'work_item' || workflowFor(kind, configuration)?.states.some(state => state.id === value)) return value;
  const aliases: Record<string, string> = { draft: 'todo', ready: 'todo', in_review: 'in_progress', cancelled: 'canceled' };
  return aliases[value] || value;
}
export function ServiceMarkdown({ mode = 'collection', entityKind = 'work_item', projectId, entityId, settingsSection, initialCreate = false }: ServiceMarkdownProps) {
  const { workspace, actor, capabilities, loading, error, actorEpoch, refresh } = usePmService();
  const en = useI18n().locale === 'en';
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const issuePresentation = usePmDisplaySetting(workspace?.id, 'issueView');
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode);
  const personal = usePersonalDashboard();
  const today = useTaskScopeClock(personal.error ? undefined : personal.data?.profile.timeZone, personal.dataUpdatedAt);
  const watched = useMemo(() => personal.data && !personal.error ? new Set(personal.data.watches.map(watch => watch.data.taskId)) : null, [personal.data, personal.error]);
  if (loading) return <p role="status" className="p-6">{en ? 'Loading workspace…' : '正在加载工作区…'}</p>;
  if (!workspace || !actor) return error ? <p role="alert" className="p-6">{error.message}</p> : <p role="alert" className="p-6">{en ? 'Sign in and select an accessible workspace first.' : '请先登录并选择有权访问的工作区。'}</p>;
  if (!workspace.capabilities.includes('domain.read')) return <p role="alert" className="p-6">{en ? 'You no longer have access to workspace sources.' : '当前无权读取工作区源码。'}</p>;
  const root = `/pm/${encodeURIComponent(workspaceSlug || workspace.id)}`;
  const projectRoot = projectId ? `${root}/projects/${encodeURIComponent(projectId)}` : root;
  const state = location.state as NavigationState | null;
  const returnTo = params.get('returnTo') || state?.returnTo;
  const safeReturnTo = safeWorkspaceReturn(returnTo, mode === 'entity' ? root : projectRoot, `${projectRoot}/${entityKind === 'document' ? 'documents' : projectId || entityKind === 'work_item' ? 'issues' : 'views'}`);
  const requestedKind = params.get('kind');
  const kind = entityKind === '' && requestedKind && (entityKinds as readonly string[]).includes(requestedKind) ? requestedKind as EntityKind : entityKind;
  const scope = projectId ? 'all' : taskScope(params.get('scope'));
  const personalRoute = mode === 'collection' && kind === 'work_item' && !projectId && scope === 'mine';
  const view = params.get('view') || '';
  const savedViewId = params.get('savedView') || undefined;
  const layout = mode === 'collection' && kind === 'document' ? 'list' : view ? presentationLayouts[view] : savedViewId ? undefined : kind === 'work_item' ? personalRoute ? 'list' : presentationLayouts[issuePresentation] : undefined;
  const sectionParam = params.get('section');
  const section = settingsSection || (sectionParam === 'migrations' || sectionParam === 'diagnostics' ? sectionParam : 'configuration');
  const selectedId = mode === 'entity' ? entityId || '' : mode === 'collection' ? params.get('entity') || '' : '';
  const canWrite = !!actor && capabilities?.business.enabled === true && workspace.capabilities.includes('planning.edit');
  const canLifecycle = !!actor && capabilities?.business.enabled === true && workspace.capabilities.includes('planning.lifecycle');
  const needsPersonal = scope !== 'all' || params.get('overdue') === '1';
  const taskContext = mode === 'collection' && kind === 'work_item' ? { scope, actorId: actor.id, today, watched, pending: needsPersonal && (personal.isPending || !today && !personal.error), error: needsPersonal ? personal.error?.message || '' : '' } : undefined;
  const documentRoute = mode === 'collection' && kind === 'document';
  const documentLocation = documentWorkbenchLocation(params);
  const isDocumentWorkbench = documentRoute && documentLocation.enabled;
  const documentBackParams = new URLSearchParams(params);
  documentBackParams.delete('entity'); documentBackParams.delete('create');
  const documentBack = documentWorkbenchReturn(returnTo || `${location.pathname}${documentBackParams.size ? `?${documentBackParams}` : ''}${location.hash}`, root, `${projectRoot}/documents`);
  function openDocument(target: DocumentTarget, options?: { replace?: boolean; anchor?: string }) {
    let anchor = options?.anchor;
    if (anchor === undefined && options?.replace && location.hash) {
      try { anchor = decodeURIComponent(location.hash.slice(1)); } catch { anchor = location.hash.slice(1); }
    }
    navigate(documentWorkbenchUrl(root, target, documentBack, anchor), { replace: options?.replace, state: { ...state, returnTo: documentBack } });
  }
  function navigateEntity(file: FileRecord, anchor?: string) {
    if (file.entity.entity === 'document') { openDocument({ kind: 'native', id: file.id }, { anchor }); return; }
    if (file.entity.entity === 'project') { navigate(`${root}/projects/${encodeURIComponent(file.id)}`); return; }
    const targetRoot = file.entity.entity === 'work_item' && file.entity.project ? `${root}/projects/${encodeURIComponent(file.entity.project)}` : root;
    const back = isDocumentWorkbench ? documentBack : mode === 'entity' ? safeReturnTo : `${location.pathname}${location.search}${location.hash}`;
    navigate(`${targetRoot}/entities/${encodeURIComponent(file.id)}?${new URLSearchParams({ returnTo: back })}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`, { state: { returnTo: back, collectionContext: state?.collectionContext } });
  }
  function expandCreation(draftId: string) {
    const backParams = new URLSearchParams(params); backParams.delete('create');
    const back = `${location.pathname}${backParams.size ? `?${backParams}` : ''}${location.hash}`;
    navigate(`${projectRoot}/issues/new?${new URLSearchParams({ draft: draftId, returnTo: back })}`, { state: { returnTo: back } });
  }
  function inspect(id: string) {
    if (mode !== 'collection') { select(id); return; }
    const next = new URLSearchParams(params);
    if (id) next.set('entity', id); else next.delete('entity');
    next.delete('create');
    setParams(next, { replace: !id || selectedId === id, state: location.state });
  }
  function select(id: string) {
    if (documentRoute && id && !id.startsWith('source:')) { openDocument({ kind: 'native', id }); return; }
    if (mode === 'collection' && kind === 'work_item' && id && !id.startsWith('source:') && taskOpenMode === 'page') {
      const next = new URLSearchParams({ returnTo: `${location.pathname}${location.search}${location.hash}` });
      navigate(`${projectRoot}/entities/${encodeURIComponent(id)}?${next}`, { state: { returnTo: next.get('returnTo'), collectionContext: state?.collectionContext } });
      return;
    }
    if (mode === 'collection') {
      inspect(id);
    } else if (!id) navigate(safeReturnTo, { replace: true, state: { collectionContext: state?.collectionContext } });
    else if (id.startsWith('source:')) {
      const next = new URLSearchParams({ entity: id });
      navigate(`${projectId ? `${projectRoot}/issues` : `${root}/views`}?${next}`, { state: { collectionContext: state?.collectionContext } });
    } else {
      const next = new URLSearchParams({ returnTo: mode === 'entity' ? safeReturnTo : `${location.pathname}${location.search}${location.hash}` });
      navigate(`${projectRoot}/entities/${encodeURIComponent(id)}?${next}`, { state: { returnTo: next.get('returnTo'), collectionContext: state?.collectionContext } });
    }
  }
  if (isDocumentWorkbench && projectId) return <Navigate to={`${root}/documents${location.search}${location.hash}`} replace state={location.state} />;
  return <div className="markdown-workbench" data-pm-route-page data-pm-task-collection={kind === 'work_item' ? '' : undefined}>
    <CoreSessionProvider key={`${workspace.id}:${actor.id}:${workspace.version}:${actorEpoch}`} hostNamespace={window.location.origin} workspaceId={workspace.id} actorId={actor.id} membershipVersion={workspace.version} actorEpoch={actorEpoch} onAccessFailure={refresh}>
      {isDocumentWorkbench ? <DocumentWorkbench target={documentLocation.target} invalidTarget={documentLocation.invalid} en={en} canWrite={canWrite} canLifecycle={canLifecycle}
        onTargetChange={(target, options) => navigate(documentWorkbenchUrl(root, target, documentBack, options?.anchor), { replace: options?.replace, state: { ...state, returnTo: documentBack } })}
        onExit={() => navigate(documentBack, { state: { collectionContext: state?.collectionContext } })}
        onNavigateEntity={navigateEntity}
        onSettings={() => navigate(`${root}/settings?section=configuration`)}
        renderBusiness={file => <fieldset disabled={capabilities?.business.enabled !== true}><CoreBusinessSections file={file} /></fieldset>}
      /> :
      <Workspace key={`${mode}:${kind}:${projectId || ''}`} mode={mode} entityKind={kind} projectId={projectId} selectedId={selectedId} onSelect={select} onInspect={inspect} layout={layout} viewId={savedViewId} state={mode === 'collection' ? params.get('state') || undefined : undefined} mapStatus={coreStatus} overdue={mode === 'collection' && params.get('overdue') === '1'} initialCreate={mode === 'collection' && (initialCreate || params.get('create') === '1')} canWrite={canWrite} canLifecycle={canLifecycle} en={en} settingsSection={section} collectionContext={mode === 'collection' ? state?.collectionContext : undefined} taskContext={taskContext}

        onDocumentScope={project => navigate(`${project ? `${root}/projects/${encodeURIComponent(project)}` : root}/documents`)}
        onOpenDocument={openDocument}
        onNavigateEntity={navigateEntity}
        onScope={scope => { const next = new URLSearchParams(params); next.set('scope', scope); next.delete('entity'); setParams(next, { state: location.state }); }}
        onRetryPersonal={() => { void personal.refetch(); }}
        onCreatePage={initial => {
          const backParams = new URLSearchParams(params); backParams.delete('create');
          const back = `${location.pathname}${backParams.size ? `?${backParams}` : ''}${location.hash}`;
          const next = new URLSearchParams({ returnTo: back });
          if (scope === 'mine') next.set('assignee', actor.id);
          for (const field of ['project', 'status', 'due', 'priority', 'assignee'] as const) if (initial[field] !== undefined && initial[field] !== '') next.set(field, initial[field]);
          if (initial.watch) next.set('watch', '1');
          navigate(`${projectRoot}/issues/new?${next}`);
        }}
        onNewPage={project => {
          const next = new URLSearchParams({ returnTo: `${location.pathname}${location.search}${location.hash}` });
          if (projectId || project) next.set('project', projectId || project!);
          if (scope === 'mine') next.set('assignee', actor.id);
          if (scope === 'important') next.set('watch', '1');
          navigate(`${projectRoot}/issues/new?${next}`);
        }}
        onExpandCreation={expandCreation}
        onContextRestored={() => { if (state?.collectionContext) navigate(`${location.pathname}${location.search}`, { replace: true, state: { ...state, collectionContext: undefined } }); }}
        onCreateConsumed={() => { if (params.has('create') && !projectId) { const next = new URLSearchParams(params); next.delete('create'); setParams(next, { replace: true, state: location.state }); } }}
        onClose={() => { if (mode === 'entity') navigate(safeReturnTo, { replace: true, state: { collectionContext: state?.collectionContext } }); else select(''); }}
        onAgent={project => {
          const next = new URLSearchParams({ workspace: workspace.id });
          if (project) next.set('project', project);
          next.set('returnTo', `${location.pathname}${location.search}${location.hash}`);
          navigate(`/agent/workspace?${next}`);
        }}
        onExpand={collectionContext => {
          if (!selectedId || selectedId.startsWith('source:')) return;
          const collectionParams = new URLSearchParams(params); collectionParams.delete('create');
          const back = `${location.pathname}${collectionParams.size ? `?${collectionParams}` : ''}${location.hash}`;
          navigate(back, { replace: true, state: { ...state, collectionContext } });
          navigate(`${projectRoot}/entities/${encodeURIComponent(selectedId)}?${new URLSearchParams({ returnTo: back })}`, { state: { returnTo: back, collectionContext } });
        }}
        onSettings={nextSection => { const next = new URLSearchParams({ section: nextSection }); if (mode === 'settings') setParams(next, { replace: true }); else navigate(`${root}/settings?${next}`); }}
        onPresentation={nextLayout => { const next = new URLSearchParams(params); next.set('view', nextLayout); setParams(next, { replace: true, state: location.state }); }}
        onSavedView={id => { const next = new URLSearchParams(params); next.delete('view'); if (id) next.set('savedView', id); else next.delete('savedView'); setParams(next, { replace: true, state: location.state }); }}
        renderSchedule={schedule => personal.error
          ? <div role="alert">{personal.error.message} <button onClick={() => { void personal.refetch(); }}>{en ? 'Retry personal data' : '重试个人数据'}</button></div>
          : !today
            ? <p role="status">{en ? 'Reading your time zone…' : '正在读取个人时区…'}</p>
            : <CoreScheduleView {...schedule} showProject={!projectId} today={today} />}
        renderBusiness={file => <fieldset disabled={capabilities?.business.enabled !== true}><CoreBusinessSections file={file} /></fieldset>}
      />}
    </CoreSessionProvider>
  </div>;
}

/** The full task route uses the same session, authority and draft as every entry. */
export function ServiceTaskCreationPage() {
  const service = usePmService();
  const en = useI18n().locale === 'en';
  const { workspaceSlug, projectId } = useParams<{ workspaceSlug: string; projectId: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const root = `/pm/${encodeURIComponent(workspaceSlug || service.workspace?.id || '')}`;
  const projectRoot = projectId ? `${root}/projects/${encodeURIComponent(projectId)}` : root;
  const creationProject = projectId || params.get('project') || undefined;
  const scope = projectId ? 'all' : taskScope(params.get('scope'));
  const back = safeWorkspaceReturn(params.get('returnTo'), projectRoot, scope === 'mine' ? `${projectRoot}/issues?scope=mine` : undefined);
  if (service.loading) return <p role="status" className="p-6">{en ? 'Loading workspace…' : '正在加载工作区…'}</p>;
  if (!service.workspace || !service.actor || !service.workspace.capabilities.includes('domain.read')) return <p role="alert" className="p-6">{service.error?.message || (en ? 'This workspace is unavailable or not authorized.' : '工作区不可用或没有读取权限。')}</p>;
  const returnUrl = new URL(back, window.location.origin);
  const fromMine = !projectId && taskScope(params.get('scope') ?? (returnUrl.pathname === `${root}/issues` ? returnUrl.searchParams.get('scope') : null)) === 'mine';
  const assignee = params.has('assignee') ? params.get('assignee') || undefined : fromMine ? service.actor.id : undefined;
  return <div className="markdown-workbench task-create-page" data-pm-route-page>
    <CoreSessionProvider key={`${service.workspace.id}:${service.actor.id}:${service.workspace.version}:${service.actorEpoch}`} hostNamespace={window.location.origin} workspaceId={service.workspace.id} actorId={service.actor.id} membershipVersion={service.workspace.version} actorEpoch={service.actorEpoch} onAccessFailure={service.refresh}>
      <TaskCreationSurface key={`${creationProject || ''}:${params.get('draft') || ''}`} mode="page" projectId={projectId} draftId={params.get('draft') || undefined} initial={{ ...(creationProject ? { project: creationProject } : {}), ...(params.get('due') ? { due: params.get('due')! } : {}), ...(params.get('status') ? { status: params.get('status')! } : {}), ...(params.get('priority') ? { priority: params.get('priority')! } : {}), ...(assignee ? { assignee } : {}), watch: params.get('watch') === '1' }} onClose={() => navigate(back)} onCreated={file => navigate(`${projectRoot}/entities/${encodeURIComponent(file.id)}?${new URLSearchParams({ returnTo: back })}`, { replace: true, state: { returnTo: back } })} />
    </CoreSessionProvider>
  </div>;
}
