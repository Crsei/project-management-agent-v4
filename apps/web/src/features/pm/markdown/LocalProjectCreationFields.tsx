import { Link, useParams } from 'react-router';
import { Asterisk } from 'lucide-react';
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
      <h3>{t('保存位置', 'Save location')} <span className="local-project-creation-required"><Asterisk size={11} aria-hidden="true" />{t('必填', 'Required')}</span></h3>
      {workspace?.name && <span>{t('工作区', 'Workspace')}: {workspace.name}</span>}
    </header>
    <LocalDirectoryFields key={`${actor?.id}:${workspace?.id}:${workspace?.version}:${actorEpoch}`} value={draft.attempt?.localDirectory ?? draft.localDirectory} defaultParent={settings.defaultParent} disabled={!editable} onChange={c.changeDirectory} />
    {draft.attempt && !editable && <p className="local-hint" role="status">{t('原请求的保存模式与路径已冻结。请使用下方原请求核对／恢复操作；不会改换目录或重新建项。', 'The original request’s save mode and path are frozen. Check or recover that request below; its directory is never replaced and no duplicate project is created.')}</p>}
    <div className="local-actions"><Link to={`${root}/settings?section=local-storage`}>{t('本地存储设置', 'Local storage settings')}</Link></div>
  </section>;
}
