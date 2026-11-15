import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@contracts';
import type { LocalDirectory } from '../../../../../../packages/contracts/src/local-projects';
import { CoreSessionProvider } from '../markdown/session';
import { LocalDirectoryFields } from './local-directory-fields';
import { localProjectApi } from './local-project-api';
import { useLocalProjectSettings } from './local-project-hooks';
import { ProjectLocalLocation } from './project-local-location';
import { usePmEntities, usePmService } from './pm-service';
import { allowed, ServiceGuard, useText } from './pm-ui';
import { pmKeys } from './pm-data';
import './local-projects.css';
import { RadixSelect } from "@/components/ui/radix-select"

export function LocalProjectStorageSettings() {
  const { actor, workspace, actorEpoch, refresh } = usePmService();
  return <ServiceGuard>{actor && workspace && <CoreSessionProvider key={`${actor.id}:${workspace.id}:${workspace.version}:${actorEpoch}`} hostNamespace={window.location.origin} workspaceId={workspace.id} actorId={actor.id} membershipVersion={workspace.version} actorEpoch={actorEpoch} onAccessFailure={refresh}>
    <LocalStorageSettingsContent />
  </CoreSessionProvider>}</ServiceGuard>;
}

function LocalStorageSettingsContent() {
  const service = usePmService();
  const settings = useLocalProjectSettings();
  const projects = usePmEntities('project');
  const queryClient = useQueryClient();
  const { workspaceSlug } = useParams();
  const [params, setParams] = useSearchParams();
  const t = useText();
  const [selection, setSelection] = useState<LocalDirectory>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [projectInput, setProjectInput] = useState(params.get('project') ?? '');
  const root = `/pm/${encodeURIComponent(workspaceSlug || service.workspace?.id || '')}`;
  const data = settings.data;
  const canSaveDefault = data?.enabled === true && data.canManage && allowed(service.workspace, 'access.manage') && allowed(service.workspace, 'planning.edit');
  const projectId = params.get('project') ?? '';
  function selectProject(id: string) {
    setProjectInput(id);
    const next = new URLSearchParams(params);
    if (id) next.set('project', id); else next.delete('project');
    setParams(next, { replace: true });
  }
  async function saveDefault() {
    if (!canSaveDefault || !service.workspace || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const defaultParent = selection?.mode === 'existing' ? selection.path : data.defaultParent;
      if (!defaultParent) throw new Error(t('请输入默认父目录绝对路径。', 'Enter the default parent directory absolute path.'));
      await localProjectApi(service.client, service.workspace.id).saveSettings(defaultParent);
      await queryClient.invalidateQueries({ queryKey: [...pmKeys.workspace(window.location.origin, service.actor!.id, service.workspace.id), 'local-projects', 'settings'] });
      setSelection(undefined);
      setNotice(t('默认父目录已保存，仅影响之后的新草稿；未移动任何项目。', 'Default parent saved. It affects future drafts only; no project was moved.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) await service.refresh();
    } finally { setBusy(false); }
  }
  return <div className="local-project-settings">
    <header><h1 className="text-xl font-semibold">{t('本地项目存储', 'Local project storage')}</h1><p className="local-hint">{t('路径属于运行服务的主机，而不是浏览器设备。项目 Markdown 保持业务权威；数据库及共享工作区台账仍是必需依赖。', 'Paths belong to the service host, not the browser device. Project Markdown remains business authority; SQL and the shared workspace ledger remain required dependencies.')}</p></header>
    <section className="local-project-panel"><h2>{t('三种目录，分别管理', 'Three directories, managed separately')}</h2><dl className="local-facts">
      <dt>{t('项目保存目录', 'Project save directory')}</dt><dd>{t('保存该项目的 .dovspace/.pm/core 与新附件。此页管理默认父目录与已登记项目存储；改默认值不会移动项目。', 'Stores this project’s .dovspace/.pm/core and new attachments. This page manages the default parent and registered project storage; changing the default does not move projects.')}</dd>
      <dt>{t('外部 Markdown 来源', 'External Markdown sources')}</dt><dd>{t('在“文档 → 文档来源设置”关联服务端已有文件夹，按工作区或项目授权读取和编辑普通 Markdown；不是项目存储迁移，也不决定 Agent 的执行目录。', 'Associate existing server folders through Documents → Document source settings. Plain Markdown is read and edited under workspace or project authorization; this is not project storage migration and does not choose an Agent execution directory.')}</dd>
      <dt>{t('Agent 执行目录', 'Agent execution directory')}</dt><dd>{t('由 Agent 文件夹 / Session 单独选择，Files、Git、Provider 与 Terminal 使用其实际执行目录。不会因修改项目默认目录或文档来源而自动改变；目录也不是文件系统沙箱。', 'Selected separately for an Agent folder / Session. Files, Git, Provider and Terminal use that actual execution directory. Project defaults and document sources do not automatically change it; a directory is not a filesystem sandbox.')}</dd>
    </dl><div className="flex flex-wrap gap-3"><Link className="local-button" to={`${root}/documents`}>{t('打开文档页与“文档来源设置”', 'Open Documents and Document source settings')}</Link><Link className="local-button" to="/agent/workspace">{t('打开 Agent 文件夹与会话', 'Open Agent folders and sessions')}</Link></div></section>
    {settings.isPending && <p role="status">{t('正在读取本地配置…', 'Reading local settings…')}</p>}
    {settings.error && <section className="local-notice" role="alert"><p>{settings.error.message}</p><button type="button" className="local-button" onClick={() => { void settings.refetch(); }}>{t('重新读取本地配置', 'Read local settings again')}</button></section>}
    {data && !data.enabled && <section className="local-project-panel"><h2>{t('此部署未启用本地项目目录', 'Local project directories are not enabled')}</h2><p>{t('本地路径选择、初始化和迁移均不可用。既有部署的项目与云端存储能力保持原行为；这里不模拟成功。请由主机管理员启用本地项目存储，并确保 API / Worker 具有真实挂载与目录访问权限。项目保存目录不要求配置 allowedRoots；外部文档来源等独立目录能力仍按各自规则管理。', 'Local path selection, initialization and migration are unavailable. Existing deployment and cloud storage behavior is unchanged; no success is simulated. A host administrator must enable local project storage and give API / Worker real mounts and directory access. Project save directories do not require allowedRoots; separate directory features such as external document sources retain their own rules.')}</p><button type="button" className="local-button" disabled>{t('本地目录选择已禁用', 'Local directory selection disabled')}</button></section>}
    {data?.enabled && !data.canManage && <p className="local-notice" role="status">{t('当前缺少无限制工作区 access.manage，不能查看主机路径或配置本地存储。保存默认父目录还需要工作区范围 planning.edit；项目读写权限不会授予磁盘浏览权。', 'Unrestricted workspace access.manage is missing: host paths and local storage management are unavailable. Saving the default parent also requires workspace-scoped planning.edit; project read/write access does not grant disk browsing.')}</p>}
    {data?.enabled && data.canManage && <>
      <section className="local-project-panel"><h2>{t('首次使用与当前配置', 'First use and current configuration')}</h2><dl className="local-facts">
        <dt>{t('应用数据基目录（非全部数据）', 'Application data base (not all data)')}</dt><dd className="local-path">{data.dataRoot ?? t('未配置', 'Not configured')}</dd>
        <dt>{t('共享核心 / 台账', 'Shared core / ledger')}</dt><dd className="local-path">{data.coreRoot ?? t('未配置', 'Not configured')}</dd>
        <dt>{t('默认项目父目录', 'Default project parent')}</dt><dd className="local-path">{data.defaultParent ?? t('未配置', 'Not configured')}</dd>
        <dt>{t('备份位置', 'Backup location')}</dt><dd className="local-path">{data.backupRoot ?? t('未配置；不能宣称已有备份', 'Not configured; no backup is implied')}</dd>
        <dt>{t('附件保存', 'Attachments')}</dt><dd>{t('每个项目目录内 .dovspace/.pm/attachments；旧附件保留原存储身份', '.dovspace/.pm/attachments in each project; historical attachments retain their storage identity')}</dd>
        <dt>{t('数据库依赖', 'Database dependency')}</dt><dd>PostgreSQL · {t('账号、评论、审核与审计不会搬入项目文件夹', 'Accounts, comments, reviews and audits do not move into project folders')}</dd>
        <dt>{t('存储范围', 'Storage scope')}</dt><dd>{t('项目目录不再受允许根目录限制；基目录只决定默认核心与备份位置。SQL 的物理目录独立；历史附件仍在原 Local/S3 存储，不因更改默认父目录迁移。', 'Project directories are no longer root-restricted; the base only decides default core and backup locations. SQL has a separate physical location. Historical attachments remain in their original Local/S3 storage and do not move when this default changes.')}</dd>
      </dl><p className="local-hint">{t('项目存储可指向服务主机上任意规范绝对目录，但仍拒绝符号链接、系统目录、不可写目录和路径逃逸。容器部署还需保证 API/Worker 看到相同挂载路径。', 'Project storage may target any canonical absolute directory on the service host, but symlinks, system directories, unwritable directories and escapes remain rejected. Container deployments must still expose the same mount path to API and Worker.')}</p></section>
      <section className="local-project-panel"><h2>{t('默认项目父目录', 'Default project parent')}</h2><p>{t('更改默认值不会移动现有项目或覆盖现有创建草稿。', 'Changing the default does not move existing projects or overwrite existing creation drafts.')}</p>{!canSaveDefault && <p className="local-notice" role="status">{!allowed(service.workspace, 'access.manage') ? t('当前缺少无限制工作区 access.manage，默认父目录不可修改。', 'Unrestricted workspace access.manage is missing; the default parent cannot be changed.') : t('路径可读，但保存默认父目录还缺少工作区范围 planning.edit。标准 Admin 模板不自动包含此能力；请在成员管理中显式授权，不会通过此页扩大权限。', 'Host paths are readable, but saving the default parent also requires workspace-scoped planning.edit. The standard Admin template does not include it automatically. An explicit member grant is required; this page never expands permissions.')}</p>}<LocalDirectoryFields value={selection ?? { mode: 'existing', path: data.defaultParent ?? '' }} defaultParent={data.defaultParent} existingOnly disabled={busy || !canSaveDefault} onChange={setSelection} /><button type="button" className="local-button" disabled={busy || !canSaveDefault} onClick={() => { void saveDefault(); }}>{busy ? t('保存中…', 'Saving…') : t('保存默认父目录', 'Save default parent')}</button>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>
      <section className="local-project-panel"><h2>{t('新建与存储维护', 'Creation and storage maintenance')}</h2>{allowed(service.workspace, 'planning.edit') && <Link className="local-button" to={`${root}/views?${new URLSearchParams({ kind: 'project', create: '1', returnTo: `${root}/settings?section=local-storage` })}`}>{t('选择目录并新建项目', 'Choose a directory and create a project')}</Link>}
        <label>{t('选择要查看或维护的项目', 'Choose a project to inspect or maintain')}<RadixSelect value={projectId} onChange={event => selectProject(event.target.value)}><option value="">{t('请选择项目', 'Choose project')}</option>{projectId && !projects.data?.some(project => project.id === projectId) && <option value={projectId}>{projectId} · {t('当前文件可能不可用', 'Current file may be unavailable')}</option>}{projects.data?.map(project => <option key={project.id} value={project.id}>{String(project.data.name ?? project.id)} · {project.id}</option>)}</RadixSelect></label>
        {projects.error && <p role="alert">{projects.error.message}</p>}
        <label>{t('或输入原项目 ID（缺盘时仍可核对）', 'Or enter the original project ID (also works for a missing disk)')}<input value={projectInput} onChange={event => setProjectInput(event.target.value)} placeholder="PRJ-001" /></label><button type="button" className="local-button" disabled={!projectInput.trim()} onClick={() => selectProject(projectInput.trim())}>{t('查看项目存储', 'Inspect project storage')}</button>
      </section>
      {projectId && <ProjectLocalLocation key={projectId} projectId={projectId} />}
    </>}
    <section className="local-project-panel"><h2>{t('协议备份不等于完整恢复', 'Protocol backups are not full recovery')}</h2><p>{t('协议迁移编辑器只保存本次 Markdown 协议迁移的核心文件与配置恢复材料，不包含 PM 与 Agent 的全部数据。单个项目文件夹、备份位置配置或协议迁移记录，都不能证明完整备份已经完成；本页没有可信的“上次完整备份”时间。', 'The protocol migration editor saves only the core-file and configuration restore materials for that Markdown migration, not all PM and Agent data. A project folder, configured backup path or protocol migration record does not prove a full backup exists; this page has no trusted last-full-backup timestamp.')}</p><p>{t('完整 PM + Agent 恢复必须由主机管理员在停写 / 停服维护时处理一致恢复集：PM PostgreSQL、共享核心配置与恢复台账、全部已登记项目的受管核心和引用附件，以及 Agent 私有 SQLite、聊天与其他相关持久数据。桌面版请断开连接、停止本机服务，再在连接窗口底部进入“管理本地数据”；备份前还须确认外部写者已停写。该备份不复制外部代码树、外部文档目录、原生 Provider Home 或浏览器草稿，这些须单独保护；恢复后按原流程重新关联并核对。在线设置页不执行破坏性整机恢复。会话与持久化的统一设计尚未收口。', 'Full PM + Agent recovery requires a consistent recovery set under host-administrator write-stop / offline maintenance: PM PostgreSQL, shared core configuration and recovery ledgers, the managed core and referenced attachments of all registered projects, plus Agent private SQLite, chats and other related persisted data. On desktop, disconnect and stop local services, then use Manage local data at the bottom of the connection window; creating a backup also requires confirming external writers have stopped. That backup excludes external code trees, document-source folders, native Provider Homes and browser drafts, which need separate protection; re-associate and verify them through the existing recovery workflow. Online settings never perform destructive full-system restoration. Unified session and persistence design remains open.')}</p><Link className="local-button" to={`${root}/settings?section=migrations`}>{t('打开协议迁移与恢复材料编辑器', 'Open protocol migrations and restore materials')}</Link></section>
  </div>;
}
