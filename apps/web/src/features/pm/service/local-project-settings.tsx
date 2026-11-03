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
  const projectId = params.get('project') ?? '';
  function selectProject(id: string) {
    setProjectInput(id);
    const next = new URLSearchParams(params);
    if (id) next.set('project', id); else next.delete('project');
    setParams(next, { replace: true });
  }
  async function saveDefault() {
    if (!data?.enabled || !data.canManage || !service.workspace || busy) return;
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
    {settings.isPending && <p role="status">{t('正在读取本地配置…', 'Reading local settings…')}</p>}
    {settings.error && <section className="local-notice" role="alert"><p>{settings.error.message}</p><button type="button" className="local-button" onClick={() => { void settings.refetch(); }}>{t('重新读取本地配置', 'Read local settings again')}</button></section>}
    {data && !data.enabled && <section className="local-project-panel"><h2>{t('此部署未启用本地项目目录', 'Local project directories are not enabled')}</h2><p>{t('本地路径选择、初始化和迁移均不可用。既有部署的项目与云端存储能力保持原行为；这里不模拟成功。请由本机管理员配置可信允许根目录后启用。', 'Local path selection, initialization and migration are unavailable. Existing deployment and cloud storage behavior is unchanged; no success is simulated. A host administrator must configure trusted allowed roots to enable local storage.')}</p><button type="button" className="local-button" disabled>{t('本地目录选择已禁用', 'Local directory selection disabled')}</button></section>}
    {data?.enabled && !data.canManage && <p className="local-notice" role="status">{t('本地目录已启用，但只有具备工作区全局 access.manage 的已认证管理员可以查看或配置主机路径。项目读写权限不会授予磁盘浏览权。', 'Local directories are enabled, but only authenticated administrators with unrestricted workspace access.manage may view or configure host paths. Project read/write access does not grant disk browsing.')}</p>}
    {data?.enabled && data.canManage && <>
      <section className="local-project-panel"><h2>{t('首次使用与当前配置', 'First use and current configuration')}</h2><dl className="local-facts">
        <dt>{t('应用数据基目录（非全部数据）', 'Application data base (not all data)')}</dt><dd className="local-path">{data.dataRoot ?? t('未配置', 'Not configured')}</dd>
        <dt>{t('共享核心 / 台账', 'Shared core / ledger')}</dt><dd className="local-path">{data.coreRoot ?? t('未配置', 'Not configured')}</dd>
        <dt>{t('默认项目父目录', 'Default project parent')}</dt><dd className="local-path">{data.defaultParent ?? t('未配置', 'Not configured')}</dd>
        <dt>{t('备份位置', 'Backup location')}</dt><dd className="local-path">{data.backupRoot ?? t('未配置；不能宣称已有备份', 'Not configured; no backup is implied')}</dd>
        <dt>{t('附件保存', 'Attachments')}</dt><dd>{t('每个项目目录内的 .pm/attachments；旧附件保留原存储身份', '.pm/attachments in each project; historical attachments retain their storage identity')}</dd>
        <dt>{t('数据库依赖', 'Database dependency')}</dt><dd>PostgreSQL · {t('账号、评论、审核与审计不会搬入项目文件夹', 'Accounts, comments, reviews and audits do not move into project folders')}</dd>
        <dt>{t('存储范围', 'Storage scope')}</dt><dd>{t('基目录只决定默认核心与备份位置；显式核心根覆盖值以上方实际路径为准。SQL 的物理目录独立；历史附件仍在原 Local/S3 存储，不因更改默认父目录迁移。', 'The base determines default core and backup locations; an explicit core-root override is reflected in the actual path above. SQL has a separate physical location. Historical attachments remain in their original Local/S3 storage and do not move when this default changes.')}</dd>
      </dl><p className="local-notice">{t('项目文件夹不是完整备份。完整备份必须包含 PostgreSQL、共享台账、全部已登记项目目录以及所有引用附件。此页不提供虚假的系统文件管理器或备份执行按钮。', 'A project folder is not a complete backup. Full backups include PostgreSQL, the shared ledger, every registered project directory and all referenced attachments. This page does not offer fake OS file-manager or backup-execution buttons.')}</p><details><summary>{t('可信允许根目录（只能由本机配置授权）', 'Trusted allowed roots (authorized only by host configuration)')}</summary><ul>{data.allowedRoots.map(path => <li key={path} className="local-path">{path}</li>)}</ul></details></section>
      <section className="local-project-panel"><h2>{t('默认项目父目录', 'Default project parent')}</h2><p>{t('更改默认值不会移动现有项目或覆盖现有创建草稿。', 'Changing the default does not move existing projects or overwrite existing creation drafts.')}</p><LocalDirectoryFields value={selection ?? { mode: 'existing', path: data.defaultParent ?? '' }} defaultParent={data.defaultParent} existingOnly disabled={busy} onChange={setSelection} /><button type="button" className="local-button" disabled={busy} onClick={() => { void saveDefault(); }}>{busy ? t('保存中…', 'Saving…') : t('保存默认父目录', 'Save default parent')}</button>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>
      <section className="local-project-panel"><h2>{t('新建与存储维护', 'Creation and storage maintenance')}</h2>{allowed(service.workspace, 'planning.edit') && <Link className="local-button" to={`${root}/views?${new URLSearchParams({ kind: 'project', create: '1', returnTo: `${root}/settings?section=local-storage` })}`}>{t('选择目录并新建项目', 'Choose a directory and create a project')}</Link>}
        <label>{t('选择要查看或维护的项目', 'Choose a project to inspect or maintain')}<RadixSelect value={projectId} onChange={event => selectProject(event.target.value)}><option value="">{t('请选择项目', 'Choose project')}</option>{projectId && !projects.data?.some(project => project.id === projectId) && <option value={projectId}>{projectId} · {t('当前文件可能不可用', 'Current file may be unavailable')}</option>}{projects.data?.map(project => <option key={project.id} value={project.id}>{String(project.data.name ?? project.id)} · {project.id}</option>)}</RadixSelect></label>
        {projects.error && <p role="alert">{projects.error.message}</p>}
        <label>{t('或输入原项目 ID（缺盘时仍可核对）', 'Or enter the original project ID (also works for a missing disk)')}<input value={projectInput} onChange={event => setProjectInput(event.target.value)} placeholder="PRJ-001" /></label><button type="button" className="local-button" disabled={!projectInput.trim()} onClick={() => selectProject(projectInput.trim())}>{t('查看项目存储', 'Inspect project storage')}</button>
      </section>
      {projectId && <ProjectLocalLocation key={projectId} projectId={projectId} />}
    </>}
  </div>;
}
