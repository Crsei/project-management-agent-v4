import type { ReactNode } from "react"

export type DemoTab = "today" | "projects" | "agent" | "me"
export type DemoPage = DemoTab | "project" | "task" | "changes" | "chat" | "result"
export type DemoScenario = "ready" | "empty" | "loading" | "error" | "offline" | "stale" | "forbidden" | "unknown" | "long"
export type DemoTheme = "light" | "dark" | "system"
export interface DemoLocation { page: DemoPage; id?: string }
export interface DemoController {
  location: DemoLocation
  tab: DemoTab
  scenario: DemoScenario
  navigate: (location: DemoLocation) => void
  back: () => void
  setScenario: (scenario: DemoScenario) => void
  referencedTask: boolean
  referenceTask: () => void
  draft: string
  setDraft: (value: string) => void
  previewStep: number
  advancePreview: () => void
  taskFilter: string
  setTaskFilter: (value: string) => void
  acknowledged: boolean
  acknowledge: () => void
}
export interface DemoShellProps {
  controller: DemoController
  children: ReactNode
  theme: DemoTheme
  setTheme: (theme: DemoTheme) => void
  reset: () => void
}
export const DEMO_TASK_ID = "DEMO-104"
export const DEMO_PROJECT_ID = "DEMO-P01"
export const DEMO_SESSION_ID = "DEMO-S01"
export const DEMO_TASK_TITLE = "完善移动端附件与离线说明"
export const DEMO_PROJECT_TITLE = "Dovspace 移动体验"
export const scenarioLabels: Record<DemoScenario, string> = {
  ready: "正常预览", empty: "空内容", loading: "加载中", error: "读取失败",
  offline: "手机离线", stale: "快照过期", forbidden: "无权访问", unknown: "结果未知", long: "长内容",
}
export function pageTab(page: DemoPage): DemoTab {
  if (page === "chat" || page === "result") return "agent"
  if (page === "project" || page === "task" || page === "changes") return "projects"
  return page
}
