import type { Copy } from "../views-model"
export type PmScenario =
  | "default"
  | "empty"
  | "loading"
  | "refresh-error"
  | "readonly"
  | "long-content"
export type PmPageProps = { scenario: PmScenario }
export type PmMember = { id: string; name: string; role: Copy }
export type PmMembership = {
  teamId: string
  memberId: string
  role: "maintainer" | "member"
}
export type PmProject = {
  id: string
  identifier: string
  title: Copy
  ownerId: string
  teamId: string
  health: number | null
  dueDate: string | null
}
export const pmFixtureRevision = "pm-fixtures-2026-10-12-v1"
export const pmClock = "2026-01-12T09:00:00Z"
export const pmTimeZone = "UTC"
export const pmScenarios: readonly { id: PmScenario; name: Copy }[] = [
  { id: "default", name: { "zh-CN": "默认", en: "Default" } },
  { id: "empty", name: { "zh-CN": "空集合", en: "Empty" } },
  { id: "loading", name: { "zh-CN": "加载", en: "Loading" } },
  { id: "refresh-error", name: { "zh-CN": "刷新失败", en: "Refresh error" } },
  { id: "readonly", name: { "zh-CN": "只读", en: "Read only" } },
  { id: "long-content", name: { "zh-CN": "长内容", en: "Long content" } },
]
export function isPmScenario(value: string): value is PmScenario {
  return pmScenarios.some((item) => item.id === value)
}
export const pmMembers: readonly PmMember[] = [
  {
    id: "member-alex",
    name: "Alex Morgan",
    role: { "zh-CN": "项目负责人", en: "Project lead" },
  },
  {
    id: "member-sarah",
    name: "Sarah Chen",
    role: { "zh-CN": "设计师", en: "Designer" },
  },
  {
    id: "member-james",
    name: "James Wilson",
    role: { "zh-CN": "工程师", en: "Engineer" },
  },
  {
    id: "member-emily",
    name: "Emily Davis",
    role: { "zh-CN": "产品经理", en: "Product manager" },
  },
  {
    id: "member-michael",
    name: "Michael Brown",
    role: { "zh-CN": "工程师", en: "Engineer" },
  },
  {
    id: "member-lisa",
    name: "Lisa Anderson",
    role: { "zh-CN": "运营", en: "Operations" },
  },
]
