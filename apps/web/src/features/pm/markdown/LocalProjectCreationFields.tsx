import { Link, useParams } from 'react-router';
import type { LocalProjectCreationState } from './creation-controller';
import { LocalDirectoryFields } from '../service/local-directory-fields';
import { usePmService } from '../service/pm-service';
import { useText } from '../service/pm-ui';
import './local-project-creation.css';

export function LocalProjectCreationFields({ controller: c }: { controller: LocalProjectCreationState }) {
  const { actor, workspace, actorEpoch } = usePmService();
  const { workspaceSlug } = useParams();
  const t = useText();
  const settings = c.localSettings.data;
  const draft = c.draft;
  if (!draft || draft.kind !== 'project') return null;
  const root = `/pm/${encodeURIComponent(workspaceSlug || workspace?.id || '')}`;
  if (c.localSettings.error) return <section className="local-project-creation local-project-creation-state local-notice" role="alert"><p>{c.localSettings.error.message}</p><button type="button" className="secondary-button local-button" onClick={() => { void c.localSettings.refetch(); }}>{t('重新读取本地能力', 'Read local capability again')}</button></section>;
  if (!settings) return <p className="local-project-creation local-project-creation-state" role="status">{t('正在读取本地项目存储能力…', 'Reading local project storage capability…')}</p>;
  if (!settings.enabled) return <section className="local-project-creation local-project-creation-state local-notice"><p>{t('此部署未启用本地项目目录。目录选择已禁用；项目继续使用此部署原有存储，不会伪造本地初始化成功。', 'Local project directories are not enabled in this deployment. Folder selection is disabled; projects use the deployment’s existing storage, without simulating local initialization.')}</p><button type="button" className="secondary-button local-button" disabled>{t('本地文件夹选择不可用', 'Local folder selection unavailable')}</button></section>;
  if (!settings.canManage) return <p className="local-project-creation local-project-creation-state local-notice" role="status">{t('此工作区已启用本地项目目录；需要全局 access.manage 与 planning.edit 权限才能选择主机目录并创建项目。当前不能创建无目录绑定的替代项目。', 'This workspace uses local project directories. Unrestricted access.manage and planning.edit are required to choose a host folder and create a project. A project without a directory binding cannot be created instead.')}</p>;
  const editable = !c.busy && c.canWrite && (!draft.attempt || draft.attempt.phase === 'prepared' && !draft.attempt.localDirectory);
  return <section className="local-project-creation" aria-label={t('项目保存位置', 'Project save location')}>
    <header className="local-project-creation-heading">
      <h3>{t('保存位置', 'Save location')}</h3>
      {workspace?.name && <span>{t('工作区', 'Workspace')}: {workspace.name}</span>}
    </header>
    <LocalDirectoryFields key={`${actor?.id}:${workspace?.id}:${workspace?.version}:${actorEpoch}`} value={draft.attempt?.localDirectory ?? draft.localDirectory} defaultParent={settings.defaultParent} disabled={!editable} onChange={c.changeDirectory} />
    <div className="local-actions"><button type="button" className="secondary-button local-button" disabled={!editable} onClick={() => { void c.previewDirectory(); }}>{t('预检并确认最终路径', 'Preview and confirm final path')}</button><Link to={`${root}/settings?section=local-storage`}>{t('本地存储设置', 'Local storage settings')}</Link></div>
    {c.localPreview ? <div className="local-project-creation-preview" role="status">
      <strong>{t('最终绝对路径', 'Final absolute path')}</strong>
      <p className="local-path" data-testid="local-project-final-path">{c.localPreview.path}</p>
      <p className="local-hint">{c.localPreview.exists ? t('将使用已有目录。', 'An existing directory will be used.') : t('将创建新的项目子目录。', 'A new project subdirectory will be created.')}</p>
    </div> : <p className="local-project-creation-pending local-hint" role="status">{t('待预检：选择或输入绝对路径并预检后，才能创建。', 'Preview required: choose or enter an absolute path and preview it before creating.')}</p>}
    <details className="local-project-creation-details">
      <summary>{t('初始化与原文件保护说明', 'Initialization and file protection')}</summary>
      <div className="local-project-creation-explanation">
        <p>{t('工作区', 'Workspace')}: <strong>{workspace?.name ?? workspace?.id}</strong> · <code>{workspace?.id}</code></p>
        <p>{t('这是运行本地服务的主机路径，不是浏览器上传文件夹。输入路径不会扩大服务端授权根范围；符号链接和路径逃逸由服务端拒绝。', 'This is a path on the local service host, not a browser folder upload. Typing a path never expands server-authorized roots; the server rejects symlinks and escapes.')}</p>
        <p>{t('路径及目录身份还会在提交时再次检查。刷新后需要重新预检，原草稿和请求键不变。', 'The path and directory identity are checked again at submission. Refresh requires another preview, retaining the original draft and request key.')}</p>
        {c.localPreview && <div>
          <h4>{t('本次预检将新增', 'This preview will add')}</h4>
          <ul>{c.localPreview.creates.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        </div>}
        <div>
          <h4>{t('不覆盖原文件', 'Existing files are never overwritten')}</h4>
          <p>{t('仅新增项目的 .pm 标记、Markdown、任务/文档和附件目录；不会修改、导入或接管原有 README、代码或其他文件。已有或冲突标记将被拒绝。', 'Only the project .pm marker, Markdown, task/document and attachment directories are added. Existing README, code and other files are not modified, imported or taken over. Existing or conflicting markers are rejected.')}</p>
        </div>
        <div>
          <h4>{t('必需初始化清单', 'Required initialization checklist')}</h4>
          <ul>
            <li>{t('稳定项目 ID、目录映射与身份标记', 'Stable project ID, directory mapping and identity marker')}</li>
            <li>{t('一次写入名称、描述、负责人和日期的项目 Markdown；使用配置工作流初始状态', 'Project Markdown with name, description, owner and dates in one write; configured initial workflow state')}</li>
            <li>{t('空任务/文档目录、项目本地附件绑定与既有权限继承', 'Empty task/document directories, project-local attachment binding and inherited permissions')}</li>
            <li>{t('持久原请求恢复记录、索引、监听和最终磁盘重读', 'Durable original-request recovery, index, watcher and final disk reread')}</li>
          </ul>
        </div>
        <p>{t('文件与数据库不是原子提交；未完成步骤会保持待恢复，不显示为可写成功。不生成样例任务、不初始化 Git、不启动 Agent。数据库账号、评论及审核仍依赖 PostgreSQL；项目文件夹不是完整备份。', 'Files and SQL are not an atomic transaction. Incomplete steps remain recoverable, not writable success. No sample tasks, Git initialization or agents are created. Accounts, comments and reviews still depend on PostgreSQL; a project directory is not a complete backup.')}</p>
      </div>
    </details>
  </section>;
}
