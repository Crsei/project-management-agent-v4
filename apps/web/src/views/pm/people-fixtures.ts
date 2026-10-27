import type { Copy } from "../views-model"
import { type PmScenario } from "./model"

export const peopleFixtureRevision = "pm-people-2026-10-12-v1"

export type Availability = "available" | "away" | "offline"
export type Engagement = "active" | "part-time" | "remote"
export type AccessRole = "admin" | "member" | "guest"
export type PersonContact = { email: string; phone: string }

export type PersonFixture = {
  memberId: string
  /** Scenario-owned display label; identity and membership remain stable IDs. */
  displayName?: string
  availability: Availability
  engagement: Engagement
  accessRole: AccessRole
  ownership: Copy
  joinedAt: string
  contact: PersonContact | null
  capacityPoints: number | null
  twoFactor: boolean
}

export const availabilityLabels: Record<Availability, Copy> = {
  available: { en: "Available", "zh-CN": "在线" },
  away: { en: "Away", "zh-CN": "离开" },
  offline: { en: "Offline", "zh-CN": "离线" },
}
export const engagementLabels: Record<Engagement, Copy> = {
  active: { en: "Active", "zh-CN": "全职" },
  "part-time": { en: "Part-time", "zh-CN": "兼职" },
  remote: { en: "Remote", "zh-CN": "远程" },
}
export const accessRoleLabels: Record<AccessRole, Copy> = {
  admin: { en: "Admin", "zh-CN": "管理员" },
  member: { en: "Member", "zh-CN": "成员" },
  guest: { en: "Guest", "zh-CN": "访客" },
}

const fixtures: readonly PersonFixture[] = [
  {
    memberId: "member-alex",
    availability: "available",
    engagement: "active",
    accessRole: "admin",
    ownership: { en: "Delivery owner", "zh-CN": "交付负责人" },
    joinedAt: "2023-08-14T00:00:00Z",
    contact: {
      email: "alex.morgan@example.com",
      phone: "+1 (555) 010-0101",
    },
    capacityPoints: 8,
    twoFactor: true,
  },
  {
    memberId: "member-sarah",
    availability: "away",
    engagement: "remote",
    accessRole: "member",
    ownership: { en: "Experience owner", "zh-CN": "体验负责人" },
    joinedAt: "2024-01-22T00:00:00Z",
    contact: {
      email: "sarah.chen@example.com",
      phone: "+1 (555) 010-0102",
    },
    capacityPoints: 6,
    twoFactor: true,
  },
  {
    memberId: "member-james",
    availability: "available",
    engagement: "active",
    accessRole: "member",
    ownership: { en: "No team ownership", "zh-CN": "暂无方向归属" },
    joinedAt: "2024-03-11T00:00:00Z",
    contact: {
      email: "james.wilson@example.com",
      phone: "+1 (555) 010-0103",
    },
    capacityPoints: 8,
    twoFactor: true,
  },
  {
    memberId: "member-emily",
    availability: "available",
    engagement: "part-time",
    accessRole: "admin",
    ownership: { en: "Platform owner", "zh-CN": "平台负责人" },
    joinedAt: "2023-11-06T00:00:00Z",
    contact: {
      email: "emily.davis@example.com",
      phone: "+1 (555) 010-0104",
    },
    capacityPoints: 10,
    twoFactor: false,
  },
  {
    memberId: "member-michael",
    availability: "offline",
    engagement: "active",
    accessRole: "member",
    ownership: { en: "No team ownership", "zh-CN": "暂无方向归属" },
    joinedAt: "2024-06-18T00:00:00Z",
    contact: {
      email: "michael.brown@example.com",
      phone: "+1 (555) 010-0105",
    },
    capacityPoints: 6,
    twoFactor: true,
  },
  {
    memberId: "member-lisa",
    availability: "offline",
    engagement: "part-time",
    accessRole: "guest",
    ownership: { en: "Revenue owner", "zh-CN": "营收负责人" },
    joinedAt: "2023-09-25T00:00:00Z",
    contact: null,
    capacityPoints: null,
    twoFactor: false,
  },
]

export function createPeopleFixtures(scenario: PmScenario): PersonFixture[] {
  if (scenario === "empty") return []
  return fixtures.map((fixture) => {
    if (scenario !== "long-content") return { ...fixture }
    if (fixture.memberId === "member-james")
      return { ...fixture, displayName: "Alex Morgan" }
    if (fixture.memberId !== "member-lisa") return { ...fixture }
    return {
      ...fixture,
      displayName: "Lisa Anderson — Regional Enterprise Revenue Programmes and Partner Renewal Forecasting",
      ownership: {
        en: `${fixture.ownership.en} — recurring programme ownership across revenue operations, partner reporting and renewal forecasting for the whole organisation`,
        "zh-CN": `${fixture.ownership["zh-CN"]}——负责营收运营、合作伙伴汇报与续约预测的跨组织常设工作`,
      },
    }
  })
}
