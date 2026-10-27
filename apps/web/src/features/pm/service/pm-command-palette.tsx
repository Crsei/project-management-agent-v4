import { useState } from "react"
import { Command } from "cmdk"
import { useHotkeys } from "react-hotkeys-hook"
import { useLocation, useNavigate } from "react-router"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { useWorkspaceStore } from "@/providers/app-providers"
import { usePmEntities, usePmService } from "./pm-service"

export function PmCommandPalette() {
  const [open, setOpen] = useState(false)
  const { workspace, capabilities } = usePmService()
  const projects = usePmEntities("project")
  const items = usePmEntities("work_item")
  const navigate = useNavigate()
  const location = useLocation()
  const en = useI18n().locale === "en"
  const taskOpenMode = useWorkspaceStore(state => state.taskOpenMode)
  useHotkeys("mod+k", () => setOpen(value => !value), { preventDefault: true, enableOnFormTags: true })
  const base = `/pm/${encodeURIComponent(workspace?.id ?? "")}`
  const go = (path: string) => { setOpen(false); navigate(path) }
  const openEntity = (id: string, kind: "project" | "work_item") => {
    setOpen(false)
    const returnTo = location.pathname.startsWith(`${base}/entities/`)
      ? typeof location.state?.returnTo === "string" ? location.state.returnTo : `${base}/views`
      : `${location.pathname}${location.search}`
    navigate(kind === "work_item" && taskOpenMode === "panel" ? `${base}/issues?${new URLSearchParams({ entity: id, returnTo })}` : `${base}/${kind === "project" ? "projects" : "entities"}/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo })}`, { state: { returnTo } })
  }
  return <>
    <Button variant="outline" onClick={() => setOpen(true)} aria-label={en ? "Search and commands" : "搜索与命令"}>
      <Search aria-hidden="true" className="size-4" /><span className="hidden sm:inline">{en ? "Search" : "搜索"}</span><kbd className="text-xs text-muted-foreground">⌘/Ctrl K</kbd>
    </Button>
    <Command.Dialog open={open} onOpenChange={setOpen} label={en ? "Workspace command menu" : "工作区命令菜单"} overlayClassName="fixed inset-0 z-50" contentClassName="fixed left-1/2 top-[15vh] z-50 w-[min(560px,90vw)] -translate-x-1/2 rounded-panel border bg-surface p-3 text-foreground shadow-xl">
      <Command.Input aria-label={en ? "Search projects and tasks" : "搜索项目与任务"} placeholder={en ? "Search projects, tasks or pages…" : "搜索项目、任务或页面…"} className="h-11 w-full border-b bg-transparent px-3 outline-none" />
      <Command.List className="max-h-[55vh] overflow-auto py-2 [&_[cmdk-item]]:cursor-pointer [&_[cmdk-item]]:rounded-control [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2 [&_[cmdk-item][data-selected=true]]:bg-selection [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
        <Command.Empty className="p-4 text-sm text-muted-foreground">{en ? "No matching results" : "没有匹配结果"}</Command.Empty>
        <Command.Group heading={en ? "Navigation" : "导航"}>
          <Command.Item onSelect={() => go("/pm")}>{en ? "Switch workspace" : "切换工作区"}</Command.Item>
          {workspace && [["home", en ? "Home" : "首页"], ["dashboard", en ? "Overview" : "概览"], ["projects", en ? "Projects" : "项目"], ["issues", en ? "Tasks" : "任务"], ["documents", en ? "Documents" : "文档"], ["views", en ? "Views" : "视图"], ["members?tab=members", en ? "Members & teams" : "成员与团队"], ["members?tab=teams", en ? "Team management" : "团队管理"], ["members?tab=workload", en ? "Workload & capacity" : "工作量与容量"], ["notifications", en ? "Activity" : "活动"], ["whiteboard", en ? "Personal whiteboard" : "个人白板"], ["settings/general", en ? "Settings" : "设置"]].map(([path, label]) => <Command.Item key={path} onSelect={() => go(`${base}/${path}`)}>{label}</Command.Item>)}
          <Command.Item onSelect={() => go("/lab/pm/execra-ai/projects")}>{en ? "Component showcase · example data" : "组件展示 · 示例数据"}</Command.Item>
        </Command.Group>
        {workspace && <Command.Group heading={en ? "Task scopes and creation" : "任务范围与创建"}>
          {capabilities?.business.enabled && workspace.capabilities.includes("planning.edit") && <Command.Item onSelect={() => go(`${base}/issues/new?${new URLSearchParams({ returnTo: `${location.pathname}${location.search}` })}`)}>{en ? "Create task" : "新建任务"}</Command.Item>}
          {capabilities?.business.enabled && workspace.capabilities.includes("planning.edit") && workspace.projectIds === null && <Command.Item onSelect={() => go(`${base}/views?${new URLSearchParams({ kind: "project", create: "1", returnTo: `${location.pathname}${location.search}` })}`)}>{en ? "Create project · choose directory" : "新建项目 · 选择目录"}</Command.Item>}
          {[["all", en ? "All tasks" : "全部任务"], ["mine", en ? "My Tasks" : "我的任务"], ["important", en ? "Important / Watching" : "重要 / 我关注的"]].map(([scope, label]) => <Command.Item key={scope} value={`tasks ${scope} ${label}`} onSelect={() => go(`${base}/issues?scope=${scope}`)}>{label}</Command.Item>)}
          {workspace.capabilities.includes("access.manage") && workspace.projectIds === null && <Command.Item onSelect={() => go(`${base}/members?tab=members&panel=invitations`)}>{en ? "Member invitations" : "成员邀请"}</Command.Item>}
        </Command.Group>}
        {workspace && <Command.Group heading={en ? "Settings" : "设置"}>
          {[["general", en ? "General" : "通用设置"], ["profile", en ? "Profile" : "个人资料"], ["billing", en ? "Billing" : "账单与支付"], ["plans", en ? "Plans" : "套餐"], ["plugins", en ? "Plugins" : "插件中心"], ["notifications", en ? "Notification preferences" : "通知偏好"]].map(([path, label]) => <Command.Item key={path} value={`settings ${path} ${label}`} onSelect={() => go(`${base}/settings/${path}`)}>{label}</Command.Item>)}
          <Command.Item onSelect={() => go(`${base}/settings?section=local-storage`)}>{en ? "Local project storage" : "本地项目存储"}</Command.Item>
        </Command.Group>}
        <Command.Group heading={en ? "Projects" : "项目"}>{projects.data?.map(project => <Command.Item key={project.id} value={`${project.id} ${project.data.name}`} onSelect={() => openEntity(project.id, "project")}>{String(project.data.name ?? project.id)}</Command.Item>)}</Command.Group>
        <Command.Group heading={en ? "Tasks" : "任务"}>{items.data?.map(item => <Command.Item key={item.id} value={`${item.id} ${item.data.title}`} onSelect={() => openEntity(item.id, "work_item")}>{String(item.data.title ?? item.id)}</Command.Item>)}</Command.Group>
      </Command.List>
    </Command.Dialog>
  </>
}
