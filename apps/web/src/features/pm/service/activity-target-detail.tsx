import type { ReactNode } from "react"
import { AlertTriangle, LoaderCircle } from "lucide-react"
import { useNavigate, useParams } from "react-router"
import type { EntityKind, FileRecord } from "@pm-schema"
import { useI18n } from "@/lib/i18n-provider"
import { CoreBusinessSections } from "./pm-core-extensions"
import { usePmService } from "./pm-service"
import { CoreSessionProvider } from "../markdown/session"
import { useWorkspaceController } from "../markdown/controller"
import { EntityDetail } from "../markdown/EntityDetail"
import "../markdown/markdown.css"
import "../markdown/document-scope.css"
import "../markdown/views-scope.css"

/** The same entity inspector the task board and collection pages open on the right. */
export function ActivityTargetDetail({ entityId, entityKind, projectId, onClose }: {
  entityId: string
  entityKind: EntityKind
  projectId: string
  onClose: () => void
}) {
  const { workspace, actor, capabilities, actorEpoch, refresh } = usePmService()
  const en = useI18n().locale === "en"
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  if (!workspace || !actor) return <p role="alert" className="p-6 text-sm">{en ? "Sign in and select an accessible workspace first." : "请先登录并选择有权访问的工作区。"}</p>
  const root = `/pm/${encodeURIComponent(workspaceSlug || workspace.id)}`
  const returnTo = `${root}/projects/${encodeURIComponent(projectId)}/activity`
  const canWrite = capabilities?.business.enabled === true && workspace.capabilities.includes("planning.edit")
  const canLifecycle = capabilities?.business.enabled === true && workspace.capabilities.includes("planning.lifecycle")
  return <CoreSessionProvider
    key={`${workspace.id}:${actor.id}:${workspace.version}:${actorEpoch}`}
    hostNamespace={window.location.origin}
    workspaceId={workspace.id}
    actorId={actor.id}
    membershipVersion={workspace.version}
    actorEpoch={actorEpoch}
    onAccessFailure={refresh}
  >
    <div className="markdown-workbench">
      <DetailSurface entityId={entityId} entityKind={entityKind} projectId={projectId} en={en} canWrite={canWrite} canLifecycle={canLifecycle} root={root} returnTo={returnTo} onClose={onClose} renderBusiness={file => <fieldset disabled={capabilities?.business.enabled !== true}><CoreBusinessSections file={file} /></fieldset>} />
    </div>
  </CoreSessionProvider>
}

function DetailSurface({ entityId, entityKind, projectId, en, canWrite, canLifecycle, root, returnTo, onClose, renderBusiness }: {
  entityId: string
  entityKind: EntityKind
  projectId: string
  en: boolean
  canWrite: boolean
  canLifecycle: boolean
  root: string
  returnTo: string
  onClose: () => void
  renderBusiness: (file: FileRecord) => ReactNode
}) {
  const navigate = useNavigate()
  const controller = useWorkspaceController({
    mode: "entity",
    en,
    entityKind,
    projectId,
    selectedId: entityId,
    onSelect: () => {},
    onNavigateEntity: file => {
      const targetRoot = file.entity.project ? `${root}/projects/${encodeURIComponent(file.entity.project)}` : root
      navigate(`${targetRoot}/entities/${encodeURIComponent(file.id)}?${new URLSearchParams({ returnTo })}`, { state: { returnTo } })
    },
    canWrite,
    canLifecycle,
  })
  // The inspector renders before the scoped workspace query settles; do not
  // report a missing entity until the authoritative snapshot has loaded.
  const loadError = controller.accessError || (controller.query.isError && !controller.query.data ? controller.query.error : null)
  if (loadError) return <div className="loading-screen" role="alert">
    <AlertTriangle size={28} />
    <h2>{en ? "Entity unavailable" : "对象不可用"}</h2>
    <p>{loadError.message}</p>
    <div><button type="button" className="secondary-button" onClick={() => { void controller.refresh() }}>{en ? "Retry" : "重试"}</button><button type="button" className="text-button" onClick={onClose}>{en ? "Close" : "关闭"}</button></div>
  </div>
  if (controller.query.isPending) return <div className="loading-screen" role="status"><LoaderCircle size={24} className="spin" /><p>{en ? "Loading entity…" : "正在加载对象…"}</p></div>
  return <EntityDetail controller={controller} en={en} onClose={onClose} renderBusiness={renderBusiness} />
}
