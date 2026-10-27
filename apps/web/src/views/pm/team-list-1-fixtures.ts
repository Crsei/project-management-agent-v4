import type { Copy } from "../views-model"
import {
  pmClock,
  pmMembers,
  pmTimeZone,
  type PmMembership,
  type PmProject,
  type PmScenario,
} from "./model"

export const teamList1FixtureRevision = "pm-team-list-1-2026-10-12-v1"
export const teamList1Clock = pmClock
export const teamList1TimeZone = pmTimeZone
export const teamFocuses = [
  "delivery",
  "experience",
  "platform",
  "revenue",
] as const
export type TeamFocus = (typeof teamFocuses)[number]
export const focusLabels: Record<TeamFocus, Copy> = {
  delivery: { "zh-CN": "交付", en: "Delivery" },
  experience: { "zh-CN": "体验", en: "Experience" },
  platform: { "zh-CN": "平台", en: "Platform" },
  revenue: { "zh-CN": "营收", en: "Revenue" },
}
export type DirectoryTeam = {
  id: string
  name: Copy
  identifier: string
  focus: TeamFocus
  slaHours: 8 | 24
  description: Copy
  activityAt: string
  openWork: number
  symbol: string
}
export function createTeamList1Fixtures(scenario: PmScenario) {
  const specs = [
    [
      "cx",
      "Customer Experience",
      "客户体验",
      "CX",
      "delivery",
      8,
      13,
      3,
      4,
      "message",
    ],
    [
      "field",
      "Field Services",
      "现场服务",
      "FIELD",
      "delivery",
      8,
      5,
      1,
      3,
      "tool",
    ],
    ["growth", "Growth", "增长", "GROWTH", "experience", 24, 8, 2, 4, "growth"],
    ["mobile", "Mobile", "移动端", "MOBILE", "platform", 24, 4, 1, 3, "mobile"],
    ["ops", "Operations", "运营", "OPS", "revenue", 8, 9, 3, 5, "compass"],
    [
      "partner",
      "Partnerships",
      "合作伙伴",
      "PARTNER",
      "revenue",
      8,
      9,
      2,
      3,
      "partner",
    ],
    [
      "program",
      "Program Office",
      "项目办公室",
      "PROGRAM",
      "platform",
      24,
      13,
      3,
      4,
      "folder",
    ],
    ["talent", "Talent", "人才", "TALENT", "experience", 24, 3, 1, 3, "users"],
  ] as const
  const teams: DirectoryTeam[] = []
  const memberships: PmMembership[] = []
  const projects: PmProject[] = []
  if (scenario !== "empty")
    specs.forEach(
      (
        [
          slug,
          en,
          zh,
          identifier,
          focus,
          slaHours,
          openWork,
          projectCount,
          maintainerCount,
          symbol,
        ],
        index,
      ) => {
        const id = `team-${slug}`
        teams.push({
          id,
          name: { en, "zh-CN": zh },
          identifier,
          focus,
          slaHours,
          openWork,
          symbol,
          description: {
            en: `The ${en.toLowerCase()} team owns ${focus} initiatives and coordinates related projects.`,
            "zh-CN": `${zh}团队负责${focusLabels[focus]["zh-CN"]}工作，并协调关联项目。`,
          },
          activityAt: `2026-01-${String(8 + (index % 5)).padStart(2, "0")}T08:00:00Z`,
        })
        pmMembers.forEach((member, memberIndex) => {
          const position = (memberIndex + index) % pmMembers.length
          if (position <= maintainerCount)
            memberships.push({
              teamId: id,
              memberId: member.id,
              role: position < maintainerCount ? "maintainer" : "member",
            })
        })
        for (let j = 0; j < projectCount; j++)
          projects.push({
            id: `project-${slug}-${j + 1}`,
            identifier: `${identifier}-${j + 1}`,
            title: {
              en: `${en} initiative ${j + 1}`,
              "zh-CN": `${zh}计划 ${j + 1}`,
            },
            ownerId: pmMembers[(index + j) % pmMembers.length].id,
            teamId: id,
            health: j === 2 ? null : 72 + j * 8,
            dueDate: j === 2 ? null : "2026-02-20",
          })
      },
    )
  if (scenario === "long-content") {
    teams[0].name = {
      en: "Customer Experience · Global customer onboarding and service quality coordination",
      "zh-CN": "客户体验 · 全球客户入驻流程与服务质量跨部门协调团队",
    }
    teams[0].description = {
      en: "A distributed team coordinating onboarding, feedback, and service quality across multiple regions. ".repeat(
        8,
      ),
      "zh-CN":
        "跨区域团队协调客户入驻、意见反馈及服务质量，确保关联项目之间的职责清晰。".repeat(
          8,
        ),
    }
    for (let i = 0; i < 24; i++) {
      const source = teams[i % 8]
      const id = `team-regional-${i + 1}`
      teams.push({
        ...source,
        id,
        identifier: `REG-${i + 1}`,
        name: {
          en: `${source.name.en} · Region ${i + 1}`,
          "zh-CN": `${source.name["zh-CN"]} · 区域 ${i + 1}`,
        },
        openWork: 0,
      })
      memberships.push({
        teamId: id,
        memberId: pmMembers[i % pmMembers.length].id,
        role: "maintainer",
      })
    }
  }
  return { teams, memberships, projects }
}
