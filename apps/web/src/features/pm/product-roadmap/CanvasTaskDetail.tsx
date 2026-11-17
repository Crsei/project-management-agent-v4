import { useNavigate } from 'react-router';
import { usePmService } from '../service/pm-service';
import { CoreSessionProvider } from '../markdown/session';
import { useWorkspaceController } from '../markdown/controller';
import { EntityDetail } from '../markdown/EntityDetail';
export function CanvasTaskDetail(props: { taskId: string; projectId: string; readOnly: boolean; onClose: () => void }) {
  const { actor, actorEpoch, workspace, refresh } = usePmService();
  if (!actor || !workspace) return null;
  return <CoreSessionProvider hostNamespace={window.location.origin} workspaceId={workspace.id} actorId={actor.id} membershipVersion={workspace.version} actorEpoch={actorEpoch} onAccessFailure={refresh}><TaskContent {...props} canWrite={workspace.capabilities.includes('planning.edit')} /></CoreSessionProvider>;
}
function TaskContent({ taskId, projectId, readOnly, onClose, canWrite }: { taskId: string; projectId: string; readOnly: boolean; onClose: () => void; canWrite: boolean }) {
  const navigate = useNavigate(), { workspace } = usePmService();
  const c = useWorkspaceController({ mode: 'entity', en: false, entityKind: 'work_item', projectId, selectedId: taskId, onSelect: () => {}, onNavigateEntity: f => navigate(`/pm/${workspace!.id}/projects/${projectId}/entities/${f.id}`), canWrite: canWrite && !readOnly, canLifecycle: false });
  if (c.accessError || c.query.error) return <p role="alert">任务当前不可访问，请刷新核对。</p>;
  if (!c.selected) return <p role="status">正在读取节点任务…</p>;
  return <><p className="roadmap-muted">这是画布关联的真实任务。{readOnly ? '运行中只读；请先暂停再修改需求。' : '修改已发布任务会使原运行需求失效，需要重新核对，不会静默继续。'}</p><EntityDetail controller={c} en={false} fullPage onClose={onClose} renderBusiness={() => null} /></>;
}
