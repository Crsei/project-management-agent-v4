import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Entity } from '@contracts';
import { Link } from 'react-router';
import { ArrowDown, ArrowUp, ArrowUpRight, Archive, Briefcase, Code2, Copy, FolderKanban, Globe, Layers, Link2, MoreHorizontal, Palette, Pencil, Rocket, RotateCcw, Share2, Star, Target, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CoreSessionProvider } from '../markdown/session';
import { usePmCommand, usePmEntities, usePmService, useProjectExtras } from './pm-service';
import { allowed, string, useText } from './pm-ui';
import { projectArchived, stableProjectPath } from './project-menu-model';
import { ProjectSettingsDialog } from './project-settings-dialog';
import { ProjectDuplicateDialog } from './project-duplicate-dialog';
import { ProjectLifecycleDialog, type ProjectLifecycleAction } from './project-lifecycle-dialog';
import { ProjectShareDialog } from './project-share-dialog';
import { useProjectSidebarOrder } from './project-sidebar-order';
import styles from './project-menu.module.css';

type DialogAction = 'settings' | 'share' | 'duplicate' | ProjectLifecycleAction;
type MenuContext = {
  projects: Entity[];
  orderedProjects: Entity[];
  pending: boolean;
  orderPending: boolean;
  orderError: string | null;
  orderNotice: string | null;
  canFavorite: (id: string) => boolean;
  favorite: (id: string) => boolean | undefined;
  toggleFavorite: (id: string) => void;
  openDialog: (id: string, action: DialogAction) => void;
  moveProject: (id: string, direction: 'up' | 'down') => void;
  copyLink: (id: string) => void;
  favoritesLoading: boolean;
  favoritesError: string | null;
};
const Context = createContext<MenuContext | null>(null);
export function useProjectMenuActions() {
  const value = useContext(Context);
  if (!value) throw new Error('Project menus require the workspace ServiceProjectMenuProvider.');
  return value;
}

/** Mount once around the real workspace shell, never once per row or project. */
export function ServiceProjectMenuProvider({ children }: { children: ReactNode }) {
  const service = usePmService();
  return <ProjectMenuHost key={`${service.actor?.id ?? 'anonymous'}:${service.workspace?.id ?? 'none'}:${service.actorEpoch}`} >{children}</ProjectMenuHost>;
}
function ProjectMenuHost({ children }: { children: ReactNode }) {
  const service = usePmService();
  const projects = usePmEntities('project');
  const extras = useProjectExtras();
  const command = usePmCommand();
  const t = useText();
  const [selection, setSelection] = useState<{ project: Entity; action: DialogAction } | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const favoritePending = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const authorized = useMemo(() => (projects.data ?? []).filter(project => project.kind === 'project' && allowed(service.workspace, 'domain.read', project.id)), [projects.data, service.workspace]);
  const active = useMemo(() => authorized.filter(project => !projectArchived(project)), [authorized]);
  const order = useProjectSidebarOrder(active);
  const project = selection ? authorized.find(candidate => candidate.id === selection.project.id) ?? (allowed(service.workspace, 'domain.read', selection.project.id) ? selection.project : undefined) : undefined;
  const pending = command.pending || !!command.unknownCommand;
  const identity = `${service.actor?.id}:${service.workspace?.id}:${service.actorEpoch}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const favorite = (id: string) => extras.error ? undefined : extras.data?.projects.find(row => row.projectId === id)?.favorite?.data.favorite ?? (extras.data?.projects.some(row => row.projectId === id) ? false : undefined);
  const canFavorite = (id: string) => !pending && !extras.error && !!extras.data?.projects.some(row => row.projectId === id) && authorized.some(row => row.id === id) && allowed(service.workspace, 'domain.read', id) && service.capabilities?.business.enabled === true;
  function openDialog(id: string, action: DialogAction) {
    const target = authorized.find(candidate => candidate.id === id);
    if (target && !command.pending) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelection({ project: target, action });
    }
  }
  function toggleFavorite(id: string) {
    if (!canFavorite(id) || favoritePending.current) return;
    const target = authorized.find(candidate => candidate.id === id);
    const current = extras.data?.projects.find(row => row.projectId === id)?.favorite;
    if (!target) return;
    favoritePending.current = true; setFeedback(null);
    void command.execute({ commandId: crypto.randomUUID(), commandType: 'SetProjectFavorite', targetId: id, projectId: id, expectedVersions: { [id]: target.version, ...(current ? { [current.id]: current.version } : {}) }, payload: { favorite: !current?.data.favorite } }).then(() => {
      if (latestIdentity.current === identity) setFeedback({ error: false, text: current?.data.favorite ? t('已从个人收藏移除。', 'Removed from your favorites.') : t('已加入个人收藏。', 'Added to your favorites.') });
    }).catch(cause => {
      if (latestIdentity.current === identity) setFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }).finally(() => { favoritePending.current = false; });
  }
  function moveProject(id: string, direction: 'up' | 'down') {
    void order.moveProject(id, direction);
  }
  function copyLink(id: string) {
    if (!service.workspace || !authorized.some(candidate => candidate.id === id)) return;
    const url = new URL(stableProjectPath(service.workspace.id, id), window.location.origin).href;
    void (async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error(t('浏览器不支持剪贴板写入。请从项目页地址栏复制真实链接。', 'Clipboard writing is unavailable. Copy the real link from the project address bar.'));
        await navigator.clipboard.writeText(url);
        if (latestIdentity.current === identity) setFeedback({ error: false, text: t('已复制项目链接。', 'Project link copied.') });
      } catch (cause) { if (latestIdentity.current === identity) setFeedback({ error: true, text: `${cause instanceof Error ? cause.message : String(cause)} ${url}` }); }
    })();
  }
  const value: MenuContext = { projects: authorized, orderedProjects: order.orderedProjects, pending, orderPending: order.pending, orderError: order.error, orderNotice: order.notice, canFavorite, favorite, toggleFavorite, openDialog, moveProject, copyLink, favoritesLoading: extras.isPending && !extras.data, favoritesError: extras.error?.message ?? null };
  const close = (open: boolean) => {
    if (open) return;
    const target = opener.current;
    setSelection(null);
    requestAnimationFrame(() => { if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true }); });
  };
  const unknownCopy = command.unknownCommand?.commandType === 'DuplicateProject' ? command.unknownCommand : undefined;
  return <Context.Provider value={value}>{children}
    {(feedback || unknownCopy) && <aside aria-live="polite" className="fixed right-3 bottom-3 z-50 max-h-48 w-[calc(100%-1.5rem)] max-w-sm space-y-2 overflow-auto rounded-lg border bg-surface p-3 text-sm shadow-sm" data-testid="project-menu-feedback">
      {feedback && <div className="flex items-start gap-2"><p role={feedback.error ? 'alert' : 'status'} className="min-w-0 flex-1 [overflow-wrap:anywhere]">{feedback.text}</p><Button size="icon" variant="ghost" aria-label={t('关闭提示', 'Dismiss notice')} onClick={() => setFeedback(null)}><X aria-hidden="true" className="size-3.5" /></Button></div>}
      {unknownCopy && <><p>{t('原项目复制尚待核对；新写入已阻止，关闭弹窗或刷新不会重发。', 'The original project copy needs reconciliation. New writes are blocked; closing a dialog or reloading never resends it.')}</p><Button size="sm" variant="outline" disabled={!unknownCopy.targetId || !authorized.some(row => row.id === unknownCopy.targetId)} onClick={() => { if (unknownCopy.targetId) openDialog(unknownCopy.targetId, 'duplicate'); }}>{t('打开原复制恢复', 'Open original copy recovery')}</Button></>}
    </aside>}
    {project && selection?.action === 'share' && <ProjectShareDialog project={project} open onOpenChange={close} />}
    {project && selection?.action === 'duplicate' && <ProjectDuplicateDialog key={project.id} project={project} open onOpenChange={close} />}
    {project && selection && selection.action !== 'share' && selection.action !== 'duplicate' && service.actor && service.workspace && <CoreSessionProvider hostNamespace={window.location.origin} workspaceId={service.workspace.id} actorId={service.actor.id} membershipVersion={service.workspace.version} actorEpoch={service.actorEpoch} onAccessFailure={service.refresh}>
      {selection.action === 'settings' ? <ProjectSettingsDialog project={project} open onOpenChange={close} /> : <ProjectLifecycleDialog key={`${project.id}:${selection.action}`} project={project} action={selection.action} open onOpenChange={close} />}
    </CoreSessionProvider>}
  </Context.Provider>;
}

/** All ten reference entries share the same real-service implementation. */
export function ProjectMenuButton({ projectId, className = '' }: { projectId: string; className?: string }) {
  const menu = useProjectMenuActions();
  const service = usePmService();
  const command = usePmCommand();
  const t = useText();
  const project = menu.projects.find(candidate => candidate.id === projectId);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openDialog = (action: DialogAction) => { setOpen(false); requestAnimationFrame(() => { trigger.current?.focus(); menu.openDialog(projectId, action); }); };
  const name = string(project?.data.name) || projectId;
  const archived = project ? projectArchived(project) : false;
  const position = menu.orderedProjects.findIndex(candidate => candidate.id === projectId);
  const canEdit = !!project && !archived && allowed(service.workspace, 'planning.edit', projectId) && service.capabilities?.business.enabled === true;
  const canLifecycle = !!project && allowed(service.workspace, 'planning.lifecycle', projectId) && service.capabilities?.business.enabled === true;
  const blocked = menu.pending;
  return <DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuTrigger render={<Button ref={trigger} type="button" variant="ghost" size="icon" className={`${styles.trigger} ${className}`} aria-label={`${t('项目操作', 'Project actions')}: ${name}`} data-testid={`project-menu-${projectId}`} disabled={!project} onClick={event => event.stopPropagation()} />}><MoreHorizontal aria-hidden="true" className="size-4" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className={styles.menu} onClick={event => event.stopPropagation()} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} aria-label={`${t('项目操作', 'Project actions')}: ${name}`}>
      <DropdownMenuGroup aria-label={t('项目操作', 'Project actions')}>
        <DropdownMenuItem render={<Link to={service.workspace ? stableProjectPath(service.workspace.id, projectId) : '#'} data-navigation-close />}><ArrowUpRight aria-hidden="true" />{t('打开', 'Open')}</DropdownMenuItem>
        <DropdownMenuItem disabled={!menu.canFavorite(projectId)} onSelect={() => menu.toggleFavorite(projectId)}><Star aria-hidden="true" className={menu.favorite(projectId) ? 'fill-current' : ''} />{menu.favorite(projectId) ? t('从收藏移除', 'Remove from favorites') : t('添加到收藏', 'Add to favorites')}</DropdownMenuItem>
        <DropdownMenuItem disabled={blocked || !canEdit} onSelect={() => openDialog('settings')}><Pencil aria-hidden="true" />{t('重命名与编辑', 'Rename & edit')}</DropdownMenuItem>
        <DropdownMenuItem disabled={command.pending} onSelect={() => openDialog('share')}><Share2 aria-hidden="true" />{t('分享', 'Share')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => menu.copyLink(projectId)}><Link2 aria-hidden="true" />{t('复制链接', 'Copy link')}</DropdownMenuItem>
        <DropdownMenuItem disabled={blocked || !canEdit || service.workspace?.projectIds !== null} onSelect={() => openDialog('duplicate')}><Copy aria-hidden="true" />{t('复制项目', 'Duplicate')}</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator className={styles.separator} />
      <DropdownMenuGroup aria-label={t('个人侧栏顺序', 'Personal sidebar order')}>
        <DropdownMenuItem disabled={blocked || menu.orderPending || position <= 0} onSelect={() => menu.moveProject(projectId, 'up')}><ArrowUp aria-hidden="true" />{t('在侧栏上移', 'Move up in sidebar')}</DropdownMenuItem>
        <DropdownMenuItem disabled={blocked || menu.orderPending || position < 0 || position >= menu.orderedProjects.length - 1} onSelect={() => menu.moveProject(projectId, 'down')}><ArrowDown aria-hidden="true" />{t('在侧栏下移', 'Move down in sidebar')}</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator className={styles.separator} />
      <DropdownMenuGroup aria-label={t('项目生命周期', 'Project lifecycle')}>
        <DropdownMenuItem disabled={blocked || !canLifecycle} onSelect={() => openDialog(archived ? 'restore' : 'archive')}>{archived ? <RotateCcw aria-hidden="true" /> : <Archive aria-hidden="true" />}{archived ? t('恢复已归档项目', 'Restore archived project') : t('归档项目', 'Archive project')}</DropdownMenuItem>
        <DropdownMenuItem disabled={blocked || !canLifecycle} onSelect={() => openDialog('delete')} className="text-destructive data-highlighted:text-destructive"><Trash2 aria-hidden="true" />{t('删除项目', 'Delete project')}</DropdownMenuItem>
      </DropdownMenuGroup>
      {blocked && <p role="status" className={styles.hint}>{t('已有写入处理中或结果未知；请先核对原请求。', 'A write is pending or unknown. Reconcile the original request first.')}</p>}
      {menu.favoritesLoading && <p role="status" className={styles.hint}>{t('正在读取个人收藏…', 'Loading personal favorites…')}</p>}
      {menu.favoritesError && <p role="alert" className={styles.hint}>{menu.favoritesError}</p>}
      {!canEdit && <p className={styles.hint}>{t('编辑需要未归档项目与计划编辑权限；永久删除须先归档且无引用。', 'Editing requires an unarchived project and planning-edit permission. Permanent deletion requires archive-first and no references.')}</p>}
      {!canLifecycle && <p className={styles.hint}>{t('归档、恢复与删除需要当前项目生命周期管理权限。', 'Archiving, restoring and deleting require current project lifecycle-management permission.')}</p>}
      {menu.orderError && <p role="alert" className={styles.hint}>{menu.orderError}</p>}
      {menu.orderNotice && <p role="status" className={styles.hint}>{menu.orderNotice}</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

const icons = { folder: FolderKanban, briefcase: Briefcase, layers: Layers, rocket: Rocket, globe: Globe, target: Target, code: Code2, palette: Palette };
/** Only fixed bundled SVGs and validated hex colors reach the navigation DOM. */
export function ProjectIdentityIcon({ project, className = '' }: { project: Entity; className?: string }) {
  const icon = string(project.data.icon);
  const Icon = Object.hasOwn(icons, icon) ? icons[icon as keyof typeof icons] : FolderKanban;
  const color = string(project.data.color);
  return <span className={`${styles.token} ${className}`} style={/^#[0-9a-fA-F]{6}$/.test(color) ? { color } : undefined} aria-hidden="true"><Icon /></span>;
}
