import { apScope, type ApCopy, type ApScenario } from "../model.ts"
import { apModels } from "./models.ts"

export type ApAccountRole = {
  roleId: string
  name: ApCopy
  capabilities: readonly string[]
}
export type ApAccountMember = {
  memberId: string
  name: string
  email: string
  roleId: string
  projectIds: string[]
  groupIds: string[]
  invitationState: "active" | "invited"
  type?: "user" | "service-account"
  invitedExpiresAt?: string | null
}
export type ApAccountGroup = {
  groupId: string
  name: string
  description?: string
  roleId?: string
}
export type ApAccountOrganization = {
  orgId: string
  name: string
  slug: string
  contactEmail: string
  timeZone: string
  defaultModelId: string
  modelTokenLimit: number | null
  monthlyBudgetMicroUsd: number | null
  defaultMemberRoleId?: string
}
export type ApAccountProject = {
  projectId: string
  orgId: string
  name: string
  description: string
  defaultModelId: string | null
  modelTokenLimit: number | null
  monthlyBudgetMicroUsd: number | null
  integrationIds: string[]
  dataRegion?: string
  logRetentionDays?: number
  acceptsNewRequests?: boolean
  modelLimits?: {
    modelId: string
    requestsPerMinute: number
    tokensPerMinute: number
    enabled: boolean
  }[]
}
export type ApAccountIntegration = {
  integrationId: string
  provider: string
  name: ApCopy
  description: ApCopy
  category:
    | "developer"
    | "productivity"
    | "knowledge"
    | "communication"
    | "design"
    | "storage"
  status: "connected" | "not-connected" | "disabled" | "configuration-error"
  configVersion: number
  capabilities: readonly string[]
  disabledReason: ApCopy | null
}
export type ApAccountProfile = {
  memberId: string
  name: string
  email: string
  bio: string
  location: string
  website: string
  handle?: string
  jobTitle?: string
}
export type ApAccountData = {
  organization: ApAccountOrganization
  projects: ApAccountProject[]
  members: ApAccountMember[]
  roles: ApAccountRole[]
  groups: ApAccountGroup[]
  integrations: ApAccountIntegration[]
  profile: ApAccountProfile
}

/** Invalid demo identities and explicit local configuration, never service authorization. */
export function createApAccountData(scenario: ApScenario): ApAccountData {
  const data: ApAccountData = {
    organization: {
      orgId: apScope.orgId,
      name: "Demo organization",
      slug: "demo-organization",
      contactEmail: "billing@example.invalid",
      timeZone: "UTC",
      defaultModelId: "google/gemini-3.8-flash",
      modelTokenLimit: 128000,
      monthlyBudgetMicroUsd: 100000000,
      defaultMemberRoleId: "role-viewer",
    },
    projects: [
      {
        projectId: apScope.projectId,
        orgId: apScope.orgId,
        name: "API project · Demo",
        description: "Local API Platform showcase fixtures",
        defaultModelId: null,
        modelTokenLimit: null,
        monthlyBudgetMicroUsd: null,
        dataRegion: "us-east",
        logRetentionDays: 30,
        acceptsNewRequests: true,
        modelLimits: apModels
          .filter((model) => model.modality === "text")
          .slice(0, 3)
          .map((model, index) => ({
            modelId: model.modelId,
            requestsPerMinute: [500, 300, 1000][index],
            tokensPerMinute: [150000, 100000, 250000][index],
            enabled: true,
          })),
        integrationIds: ["integration-github", "integration-linear"],
      },
      {
        projectId: "api-project-research",
        orgId: apScope.orgId,
        name: "Research",
        description: "Isolated model comparison fixtures",
        defaultModelId: "anthropic/claude-fable-5.1",
        modelTokenLimit: 64000,
        monthlyBudgetMicroUsd: 0,
        dataRegion: "eu-west",
        logRetentionDays: 7,
        acceptsNewRequests: true,
        modelLimits: [],
        integrationIds: ["integration-github"],
      },
    ],
    roles: [
      {
        roleId: "role-admin",
        name: { "zh-CN": "管理员", en: "Administrator" },
        capabilities: [
          "organization.write",
          "project.write",
          "members.write",
          "keys.write",
          "integrations.write",
          "billing.write",
        ],
      },
      {
        roleId: "role-developer",
        name: { "zh-CN": "开发者", en: "Developer" },
        capabilities: ["project.read", "keys.write", "integrations.read"],
      },
      {
        roleId: "role-viewer",
        name: { "zh-CN": "只读成员", en: "Viewer" },
        capabilities: ["project.read", "keys.read", "integrations.read"],
      },
    ],
    groups: [
      {
        groupId: "group-platform",
        name: "Platform",
        description: "Platform engineering",
        roleId: "role-developer",
      },
      {
        groupId: "group-research",
        name: "Research",
        description: "Model research",
        roleId: "role-viewer",
      },
    ],
    members: [
      {
        memberId: "member-demo",
        name: "Alex Morgan",
        email: "alex@example.invalid",
        roleId: "role-admin",
        projectIds: [apScope.projectId, "api-project-research"],
        groupIds: ["group-platform"],
        invitationState: "active",
        type: "user",
      },
      {
        memberId: "member-lin",
        name: "Lin Chen",
        email: "lin@example.invalid",
        roleId: "role-developer",
        projectIds: [apScope.projectId],
        groupIds: ["group-platform"],
        invitationState: "active",
        type: "user",
      },
      {
        memberId: "member-river",
        name: "River Lee",
        email: "river@example.invalid",
        roleId: "role-viewer",
        projectIds: ["api-project-research"],
        groupIds: ["group-research"],
        invitationState: "active",
        type: "user",
      },
      {
        memberId: "member-invited",
        name: "Sam Rivera",
        email: "sam@example.invalid",
        roleId: "role-viewer",
        projectIds: [apScope.projectId],
        groupIds: [],
        invitationState: "invited",
        type: "user",
        invitedExpiresAt: "2026-10-19T00:00:00Z",
      },
    ],
    integrations: [
      {
        integrationId: "integration-github",
        provider: "GitHub",
        name: { "zh-CN": "GitHub", en: "GitHub" },
        description: {
          "zh-CN": "代码仓库与拉取请求样例。",
          en: "GitHub: Search repositories, inspect pull requests, and bring code context into conversations.",
        },
        category: "developer",
        status: "connected",
        configVersion: 2,
        capabilities: [
          "search_repositories",
          "read_pull_requests",
          "inspect_issues",
        ],
        disabledReason: null,
      },
      {
        integrationId: "integration-linear",
        provider: "Linear",
        name: { "zh-CN": "Linear", en: "Linear" },
        description: {
          "zh-CN": "项目问题与计划样例。",
          en: "Issue and project planning fixtures.",
        },
        category: "productivity",
        status: "connected",
        configVersion: 1,
        capabilities: ["issue.read"],
        disabledReason: null,
      },
      {
        integrationId: "integration-slack",
        provider: "Slack",
        name: { "zh-CN": "Slack", en: "Slack" },
        description: {
          "zh-CN": "频道与消息样例。",
          en: "Slack: Search messages, summarize channels, and ground answers in recent team conversations.",
        },
        category: "communication",
        status: "connected",
        configVersion: 1,
        capabilities: ["search_messages", "read_thread", "list_channels"],
        disabledReason: null,
      },
      {
        integrationId: "integration-drive",
        provider: "Google Drive",
        name: { "zh-CN": "Google Drive", en: "Google Drive" },
        description: {
          "zh-CN": "知识资料目录样例。",
          en: "Knowledge document fixtures.",
        },
        category: "knowledge",
        status: "configuration-error",
        configVersion: 1,
        capabilities: ["document.read"],
        disabledReason: null,
      },
      {
        integrationId: "integration-notion",
        provider: "Notion",
        name: { "zh-CN": "Notion", en: "Notion" },
        description: {
          "zh-CN": "工作区知识库样例。",
          en: "Notion: Search team knowledge and retrieve pages from approved workspaces.",
        },
        category: "productivity",
        status: "configuration-error",
        configVersion: 1,
        capabilities: ["search_pages", "read_page", "list_databases"],
        disabledReason: null,
      },
      {
        integrationId: "integration-figma",
        provider: "Figma",
        name: { "zh-CN": "Figma", en: "Figma" },
        description: {
          "zh-CN": "设计文件与画布样例。",
          en: "Figma: Read design files, inspect component properties, and connect product context to your assistant.",
        },
        category: "design",
        status: "not-connected",
        configVersion: 1,
        capabilities: [
          "read_design_files",
          "inspect_components",
          "export_assets",
        ],
        disabledReason: null,
      },
      {
        integrationId: "integration-jira",
        provider: "Jira",
        name: { "zh-CN": "Jira", en: "Jira" },
        description: {
          "zh-CN": "问题与冲刺计划样例。",
          en: "Jira: Find issues, review sprint progress, and pull delivery context into project conversations.",
        },
        category: "productivity",
        status: "not-connected",
        configVersion: 1,
        capabilities: ["search_issues", "read_sprint", "read_project"],
        disabledReason: null,
      },
      {
        integrationId: "integration-dropbox",
        provider: "Dropbox",
        name: { "zh-CN": "Dropbox", en: "Dropbox" },
        description: {
          "zh-CN": "团队文件与共享目录样例。",
          en: "Dropbox: Locate files and retrieve approved workspace documents without leaving the conversation.",
        },
        category: "storage",
        status: "not-connected",
        configVersion: 1,
        capabilities: ["search_files", "read_file", "list_folders"],
        disabledReason: null,
      },
      {
        integrationId: "integration-gmail",
        provider: "Gmail",
        name: { "zh-CN": "Gmail", en: "Gmail" },
        description: {
          "zh-CN": "邮箱与邮件会话样例。",
          en: "Gmail: Find approved email threads and use customer context in assistant responses.",
        },
        category: "communication",
        status: "not-connected",
        configVersion: 1,
        capabilities: ["search_messages", "read_message", "read_thread"],
        disabledReason: null,
      },
      {
        integrationId: "integration-trello",
        provider: "Trello",
        name: { "zh-CN": "Trello", en: "Trello" },
        description: {
          "zh-CN": "任务卡片与看板样例。",
          en: "Trello: Read boards, cards, and checklists to keep project answers current and actionable.",
        },
        category: "productivity",
        status: "not-connected",
        configVersion: 1,
        capabilities: ["list_boards", "read_cards", "read_checklists"],
        disabledReason: null,
      },
    ],
    profile: {
      memberId: "member-demo",
      name: "Alex Morgan",
      email: "alex@example.invalid",
      bio: "Building source-first agent tools.",
      location: "Shanghai",
      website: "https://example.invalid/alex",
      handle: "alexmorgan",
      jobTitle: "Product engineer",
    },
  }
  if (scenario === "empty") {
    data.members = []
    data.groups = []
    data.integrations = []
  }
  if (scenario === "missing-data") {
    data.organization.modelTokenLimit = null
    data.organization.monthlyBudgetMicroUsd = null
    data.profile.bio = ""
    data.members = data.members.filter(
      (member) => member.invitationState === "active",
    )
  }
  if (scenario === "long-content") {
    data.organization.name =
      "Demonstration organization with an exceptionally long multilingual name · 演示组织与完整配置说明"
    data.projects[0].name =
      "API project with a deliberately long identity · 演示平台项目"
    data.profile.bio =
      "Source-first agent tools · 保留长资料与本地草稿。 ".repeat(12)
  }
  return data
}
