import { Link, useParams } from 'react-router';
import type { LocalProjectCreationState } from './creation-controller';
import { LocalDirectoryFields } from '../service/local-directory-fields';
import { usePmService } from '../service/pm-service';
import { useText } from '../service/pm-ui';

export function LocalProjectCreationFields({ controller: c }: { controller: LocalProjectCreationState }) {
  const { actor, workspace, actorEpoch } = usePmService();
  const { workspaceSlug } = useParams();
  const t = useText();
  const settings = c.localSettings.data;
  const draft = c.draft;
  if (!draft || draft.kind !== 'project') return null;
  const root = `/pm/${encodeURIComponent(workspaceSlug || workspace?.id || '')}`;
  if (c.localSettings.error) return <section className="local-notice" role="alert"><p>{c.localSettings.error.message}</p><button type="button" className="secondary-button local-button" onClick={() => { void c.localSettings.refetch(); }}>{t('重新读取本地能力', 'Read local capability again')}</button></section>;
  if (!settings) return <p role="status">{t('正在读取本地项目存储能力…', 'Reading local project storage capability…')}</p>;
  if (!settings.enabled) return <section className="local-notice"><p>{t('此部署未启用本地项目目录。目录选择已禁用；项目继续使用此部署原有存储，不会伪造本地初始化成功。', 'Local project directories are not enabled in this deployment. Folder selection is disabled; projects use the deployment’s existing storage, without simulating local initialization.')}</p><button type="button" className="secondary-button local-button" disabled>{t('本地文件夹选择不可用', 'Local folder selection unavailable')}</button></section>;
  if (!settings.canManage) return <p className="local-notice" role="status">{t('此工作区已启用本地项目目录；需要全局 access.manage 与 planning.edit 权限才能选择主机目录并创建项目。当前不能创建无目录绑定的替代项目。', 'This workspace uses local project directories. Unrestricted access.manage and planning.edit are required to choose a host folder and create a project. A project without a directory binding cannot be created instead.')}</p>;
  const editable = !c.busy && c.canWrite && (!draft.attempt || draft.attempt.phase === 'prepared' && !draft.attempt.localDirectory);
  return <section className="local-initialization" aria-label={t('本地项目初始化', 'Local project initialization')}>
    <h3>{t('项目保存位置与初始化', 'Project location and initialization')}</h3>
    <p>{t('工作区', 'Workspace')}: <strong>{workspace?.name ?? workspace?.id}</strong> · <code>{workspace?.id}</code></p>
    <LocalDirectoryFields key={`${actor?.id}:${workspace?.id}:${workspace?.version}:${actorEpoch}`} value={draft.attempt?.localDirectory ?? draft.localDirectory} defaultParent={settings.defaultParent} disabled={!editable} onChange={c.changeDirectory} />
    <div className="local-actions"><button type="button" className="secondary-button local-button" disabled={!editable} onClick={() => { void c.previewDirectory(); }}>{t('预检并确认最终路径', 'Preview and confirm final path')}</button><Link to={`${root}/settings?section=local-storage`}>{t('本地存储设置', 'Local storage settings')}</Link></div>
    {c.localPreview ? <div className="local-notice" role="status"><strong>{t('最终绝对路径', 'Final absolute path')}</strong><p className="local-path" data-testid="local-project-final-path">{c.localPreview.path}</p><p>{c.localPreview.exists ? t('将使用已有目录。', 'An existing directory will be used.') : t('将创建新的项目子目录。', 'A new project subdirectory will be created.')}</p><ul>{c.localPreview.creates.map(path => <li key={path}><code>{path}</code></li>)}</ul></div> : <p className="local-hint">{t('选择或输入绝对路径并预检后，才能创建。路径及目录身份还会在提交时再次检查。刷新后需要重新预检，原草稿和请求键不变。', 'Choose or enter an absolute path and preview it before creating. The path and directory identity are checked again at submission. Refresh requires another preview, retaining the original draft and request key.')}</p>}
    <div className="local-notice"><strong>{t('不覆盖原文件', 'Existing files are never overwritten')}</strong><p>{t('仅新增项目的 .pm 标记、Markdown、任务/文档和附件目录；不会修改、导入或接管原有 README、代码或其他文件。已有或冲突标记将被拒绝。', 'Only the project .pm marker, Markdown, task/document and attachment directories are added. Existing README, code and other files are not modified, imported or taken over. Existing or conflicting markers are rejected.')}</p></div>
    <div><h3>{t('必需初始化清单', 'Required initialization checklist')}</h3><ul>
      <li>{t('稳定项目 ID、目录映射与身份标记', 'Stable project ID, directory mapping and identity marker')}</li>
      <li>{t('一次写入名称、描述、负责人和日期的项目 Markdown；使用配置工作流初始状态', 'Project Markdown with name, description, owner and dates in one write; configured initial workflow state')}</li>
      <li>{t('空任务/文档目录、项目本地附件绑定与既有权限继承', 'Empty task/document directories, project-local attachment binding and inherited permissions')}</li>
      <li>{t('持久原请求恢复记录、索引、监听和最终磁盘重读', 'Durable original-request recovery, index, watcher and final disk reread')}</li>
    </ul></div>
    <p className="local-hint">{t('文件与数据库不是原子提交；未完成步骤会保持待恢复，不显示为可写成功。不生成样例任务、不初始化 Git、不启动 Agent。数据库账号、评论及审核仍依赖 PostgreSQL；项目文件夹不是完整备份。', 'Files and SQL are not an atomic transaction. Incomplete steps remain recoverable, not writable success. No sample tasks, Git initialization or agents are created. Accounts, comments and reviews still depend on PostgreSQL; a project directory is not a complete backup.')}</p>
  </section>;
}
