import type { ComposerHost } from "../composer-workspace-view"

/** Private page host contract; execution and persistence stay outside the View. */
export type RemainingPageProps = {
  scenario: string
  active: boolean
  host: ComposerHost
  cache: Map<string, unknown>
}

export const remainingPageScenarios = [
  { id: "default", name: { "zh-CN": "默认", en: "Default" } },
  { id: "empty", name: { "zh-CN": "空数据", en: "Empty" } },
  { id: "loading", name: { "zh-CN": "加载中", en: "Loading" } },
  { id: "refresh-error", name: { "zh-CN": "刷新失败", en: "Refresh failed" } },
  { id: "readonly", name: { "zh-CN": "只读", en: "Read only" } },
  { id: "long-content", name: { "zh-CN": "长内容", en: "Long content" } },
] as const
