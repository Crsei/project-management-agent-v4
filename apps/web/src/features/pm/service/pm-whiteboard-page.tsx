import { lazy, Suspense } from "react"
import { useI18n } from "@/lib/i18n-provider"
import { useSearchParams } from "react-router"
import { usePmEntities, usePmService } from "./pm-service"

const Whiteboard = lazy(() => import("../components/service-whiteboard").then(module => ({ default: module.ServiceWhiteboard })))

export function PmWhiteboardPage() {
  const { actor, workspace, loading } = usePmService()
  const [params] = useSearchParams()
  const projectId = params.get("projectId")
  const projects = usePmEntities("project")
  const en = useI18n().locale === "en"
  if (loading) return <p role="status" className="p-6">{en ? "Loading workspace…" : "正在加载工作区…"}</p>
  if (!actor || !workspace) return <p role="alert" className="p-6">{en ? "Sign in and select an accessible workspace first." : "请先登录并选择有权访问的工作区。"}</p>
  if (projectId && !projects.data?.some(project => project.id === projectId)) return <p role="alert" className="p-6">{en ? "Project unavailable. Return to an accessible project before opening its canvas." : "项目不可访问，请从有权访问的项目进入白板。"}</p>
  return <main data-pm-route-page className="flex min-h-0 flex-1 flex-col overflow-auto">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-5 py-3"><h1 className="font-semibold">{en ? "Personal whiteboard" : "个人白板"}</h1><p className="text-xs text-muted-foreground">{en ? "Stored in this browser only · Export a backup before clearing browser data" : "仅保存在此浏览器 · 清理浏览器数据前请导出备份"}</p></header>
    <Suspense fallback={<p role="status" className="p-6">{en ? "Loading canvas…" : "正在加载画布…"}</p>}><Whiteboard storageKey={`pm:whiteboard:${window.location.origin}:${actor.id}:${workspace.id}:${projectId ?? "workspace"}`} /></Suspense>
  </main>
}
