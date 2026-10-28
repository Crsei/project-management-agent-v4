import type { ApCopy, ApScenario } from "../model"

export const pluginCategoryIds = [
  "developer",
  "communication",
  "productivity",
  "design",
  "storage",
] as const
export type PluginCategory = (typeof pluginCategoryIds)[number]
export const pluginCategoryCopy: Record<PluginCategory, ApCopy> = {
  developer: { "zh-CN": "开发者工具", en: "Developer tools" },
  productivity: { "zh-CN": "效率工具", en: "Productivity" },
  communication: { "zh-CN": "沟通协作", en: "Communication" },
  design: { "zh-CN": "设计工具", en: "Design tools" },
  storage: { "zh-CN": "存储", en: "Storage" },
}

export type PluginAction = "connect" | "disable" | "enable" | "save"
export type PluginFixtureOutcome = {
  outcome: "confirmed" | "rejected" | "unknown"
  recorded?: "confirmed" | "rejected"
}

/** GitHub saves remain unknown until checked; Trello writes simulate permission denial. */
const policyRejected: Record<string, true> = {
  "integration-trello": true,
}
export function pluginFixtureOutcome(
  action: PluginAction,
  integrationId: string,
): PluginFixtureOutcome {
  if (policyRejected[integrationId]) return { outcome: "rejected" }
  if (action === "save" && integrationId === "integration-github")
    return { outcome: "unknown", recorded: "confirmed" }
  return { outcome: "confirmed" }
}

/** Invalid-by-default configuration for the fixture configuration-error integration. */
export function pluginConfigDefault(integrationId: string): string {
  return integrationId === "integration-notion"
    ? ""
    : `cfg-${integrationId}-demo`
}

const longDescription: ApCopy = {
  "zh-CN":
    "该长文本场景用于验证卡片两行裁剪、详情面板完整换行与页面横向溢出，切换语言或场景不会丢失已选筛选与草稿。 演示内容刻意冗长以覆盖多语言排版边界。",
  en: "This long-content scene verifies two-line card clamping, full wrapping inside the details panel, and the absence of horizontal page overflow. Switching language or scenario keeps filters and local drafts.",
}
export function pluginDescription(
  description: ApCopy,
  scenario: ApScenario,
): ApCopy {
  if (scenario !== "long-content") return description
  return {
    "zh-CN": `${description["zh-CN"]} ${longDescription["zh-CN"]}`,
    en: `${description.en} ${longDescription.en}`,
  }
}

/**
 * `missing-data` shows a project association that points at an integration the
 * shared catalog no longer carries; the dangling reference stays visible and is
 * never invented into a card.
 */
export const pluginMissingReferenceId = "integration-missing-webhook"
export function pluginProjectIntegrationIds(
  integrationIds: readonly string[],
  scenario: ApScenario,
): string[] {
  return scenario === "missing-data"
    ? [...integrationIds, pluginMissingReferenceId]
    : [...integrationIds]
}

export const pluginOperationDelayMs = 900
export const pluginLoadDelayMs = 700
export const pluginSkeletonDelayMs = 800
export const pluginTestDelayMs = 600

export const pluginGalleryCopy: Readonly<Record<string, ApCopy>> = {
  "integration-github": {
    "zh-CN": "GitHub：搜索代码仓库、查看拉取请求，并将代码上下文带入对话。",
    en: "GitHub: Search repositories, inspect pull requests, and bring code context into conversations.",
  },
  "integration-figma": {
    "zh-CN": "Figma：读取设计文件、检查组件属性，并将产品上下文连接到助手。",
    en: "Figma: Read design files, inspect component properties, and connect product context to your assistant.",
  },
  "integration-notion": {
    "zh-CN": "Notion：搜索团队知识，并从已批准的工作区检索页面。",
    en: "Notion: Search team knowledge and retrieve pages from approved workspaces.",
  },
  "integration-slack": {
    "zh-CN": "Slack：搜索消息、总结频道，并使用团队近期对话为回答提供依据。",
    en: "Slack: Search messages, summarize channels, and ground answers in recent team conversations.",
  },
  "integration-jira": {
    "zh-CN": "Jira：查找问题、查看冲刺进度，并将交付上下文带入项目对话。",
    en: "Jira: Find issues, review sprint progress, and pull delivery context into project conversations.",
  },
  "integration-dropbox": {
    "zh-CN": "Dropbox：无需离开对话即可查找文件和检索已批准的工作区文档。",
    en: "Dropbox: Locate files and retrieve approved workspace documents without leaving the conversation.",
  },
  "integration-gmail": {
    "zh-CN": "Gmail：查找已批准的邮件会话，并在助手回答中使用客户上下文。",
    en: "Gmail: Find approved email threads and use customer context in assistant responses.",
  },
  "integration-trello": {
    "zh-CN": "Trello：读取看板、卡片和清单，让项目回答保持及时且可执行。",
    en: "Trello: Read boards, cards, and checklists to keep project answers current and actionable.",
  },
}

// Presentation-only brand artwork observed from the reference DOM; account identity,
// state, capabilities and project associations remain in the shared account fixture.
export const pluginBrandSources: Readonly<Record<string, string>> = {
  "integration-github":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22%23171717%22%20fill%3D%22%23171717%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-foreground%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M12%20.297c-6.63%200-12%205.373-12%2012%200%205.303%203.438%209.8%208.205%2011.385.6.113.82-.258.82-.577%200-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422%2018.07%203.633%2017.7%203.633%2017.7c-1.087-.744.084-.729.084-.729%201.205.084%201.838%201.236%201.838%201.236%201.07%201.835%202.809%201.305%203.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93%200-1.31.465-2.38%201.235-3.22-.135-.303-.54-1.523.105-3.176%200%200%201.005-.322%203.3%201.23.96-.267%201.98-.399%203-.405%201.02.006%202.04.138%203%20.405%202.28-1.552%203.285-1.23%203.285-1.23.645%201.653.24%202.873.12%203.176.765.84%201.23%201.91%201.23%203.22%200%204.61-2.805%205.625-5.475%205.92.42.36.81%201.096.81%202.22%200%201.606-.015%202.896-.015%203.286%200%20.315.21.69.825.57C20.565%2022.092%2024%2017.592%2024%2012.297c0-6.627-5.373-12-12-12%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
  "integration-figma":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22rgb(242%2C%2078%2C%2030)%22%20fill%3D%22rgb(242%2C%2078%2C%2030)%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-%5B%23f24e1e%5D%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M15.852%208.981h-4.588V0h4.588c2.476%200%204.49%202.014%204.49%204.49s-2.014%204.491-4.49%204.491zM12.735%207.51h3.117c1.665%200%203.019-1.355%203.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0%201.471H8.148c-2.476%200-4.49-2.014-4.49-4.49S5.672%200%208.148%200h4.588v8.981zm-4.587-7.51c-1.665%200-3.019%201.355-3.019%203.019s1.354%203.02%203.019%203.02h3.117V1.471H8.148zm4.587%2015.019H8.148c-2.476%200-4.49-2.014-4.49-4.49s2.014-4.49%204.49-4.49h4.588v8.98zM8.148%208.981c-1.665%200-3.019%201.355-3.019%203.019s1.355%203.019%203.019%203.019h3.117V8.981H8.148zM8.172%2024c-2.489%200-4.515-2.014-4.515-4.49s2.014-4.49%204.49-4.49h4.588v4.441c0%202.503-2.047%204.539-4.563%204.539zm-.024-7.51a3.023%203.023%200%200%200-3.019%203.019c0%201.665%201.365%203.019%203.044%203.019%201.705%200%203.093-1.376%203.093-3.068v-2.97H8.148zm7.704%200h-.098c-2.476%200-4.49-2.014-4.49-4.49s2.014-4.49%204.49-4.49h.098c2.476%200%204.49%202.014%204.49%204.49s-2.014%204.49-4.49%204.49zm-.097-7.509c-1.665%200-3.019%201.355-3.019%203.019s1.355%203.019%203.019%203.019h.098c1.665%200%203.019-1.355%203.019-3.019s-1.355-3.019-3.019-3.019h-.098z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
  "integration-notion":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22%23171717%22%20fill%3D%22%23171717%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-foreground%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M4.459%204.208c.746.606%201.026.56%202.428.466l13.215-.793c.28%200%20.047-.28-.046-.326L17.86%201.968c-.42-.326-.981-.7-2.055-.607L3.01%202.295c-.466.046-.56.28-.374.466zm.793%203.08v13.904c0%20.747.373%201.027%201.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42%200%20.84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748%200-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21%2019s0%20.84-1.168.84l-3.222.186c-.093-.186%200-.653.327-.746l.84-.233V9.854L7.822%209.76c-.094-.42.14-1.026.793-1.073l3.456-.233%204.764%207.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936%201.035l13.31-.98c1.634-.14%202.055-.047%203.082.7l4.249%202.986c.7.513.934.653.934%201.213v16.378c0%201.026-.373%201.634-1.68%201.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54%201.447-1.632z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
  "integration-slack":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22rgb(224%2C%2030%2C%2090)%22%20fill%3D%22rgb(224%2C%2030%2C%2090)%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-%5B%23e01e5a%5D%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M5.042%2015.165a2.528%202.528%200%200%201-2.52%202.523A2.528%202.528%200%200%201%200%2015.165a2.527%202.527%200%200%201%202.522-2.52h2.52v2.52zM6.313%2015.165a2.527%202.527%200%200%201%202.521-2.52%202.527%202.527%200%200%201%202.521%202.52v6.313A2.528%202.528%200%200%201%208.834%2024a2.528%202.528%200%200%201-2.521-2.522v-6.313zM8.834%205.042a2.528%202.528%200%200%201-2.521-2.52A2.528%202.528%200%200%201%208.834%200a2.528%202.528%200%200%201%202.521%202.522v2.52H8.834zM8.834%206.313a2.528%202.528%200%200%201%202.521%202.521%202.528%202.528%200%200%201-2.521%202.521H2.522A2.528%202.528%200%200%201%200%208.834a2.528%202.528%200%200%201%202.522-2.521h6.312zM18.956%208.834a2.528%202.528%200%200%201%202.522-2.521A2.528%202.528%200%200%201%2024%208.834a2.528%202.528%200%200%201-2.522%202.521h-2.522V8.834zM17.688%208.834a2.528%202.528%200%200%201-2.523%202.521%202.527%202.527%200%200%201-2.52-2.521V2.522A2.527%202.527%200%200%201%2015.165%200a2.528%202.528%200%200%201%202.523%202.522v6.312zM15.165%2018.956a2.528%202.528%200%200%201%202.523%202.522A2.528%202.528%200%200%201%2015.165%2024a2.527%202.527%200%200%201-2.52-2.522v-2.522h2.52zM15.165%2017.688a2.527%202.527%200%200%201-2.52-2.523%202.526%202.526%200%200%201%202.52-2.52h6.313A2.527%202.527%200%200%201%2024%2015.165a2.528%202.528%200%200%201-2.522%202.523h-6.313z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
  "integration-jira":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22rgb(24%2C%20104%2C%20219)%22%20fill%3D%22rgb(24%2C%20104%2C%20219)%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-%5B%231868db%5D%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M11.571%2011.513H0a5.218%205.218%200%200%200%205.232%205.215h2.13v2.057A5.215%205.215%200%200%200%2012.575%2024V12.518a1.005%201.005%200%200%200-1.005-1.005zm5.723-5.756H5.736a5.215%205.215%200%200%200%205.215%205.214h2.129v2.058a5.218%205.218%200%200%200%205.215%205.214V6.758a1.001%201.001%200%200%200-1.001-1.001zM23.013%200H11.455a5.215%205.215%200%200%200%205.215%205.215h2.129v2.057A5.215%205.215%200%200%200%2024%2012.483V1.005A1.001%201.001%200%200%200%2023.013%200Z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
  "integration-dropbox":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22rgb(0%2C%2097%2C%20255)%22%20fill%3D%22rgb(0%2C%2097%2C%20255)%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-%5B%230061ff%5D%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M6%201.807L0%205.629l6%203.822%206.001-3.822L6%201.807zM18%201.807l-6%203.822%206%203.822%206-3.822-6-3.822zM0%2013.274l6%203.822%206.001-3.822L6%209.452l-6%203.822zM18%209.452l-6%203.822%206%203.822%206-3.822-6-3.822zM6%2018.371l6.001%203.822%206-3.822-6-3.822L6%2018.371z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
  "integration-gmail":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22rgb(234%2C%2067%2C%2053)%22%20fill%3D%22rgb(234%2C%2067%2C%2053)%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-%5B%23ea4335%5D%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M24%205.457v13.909c0%20.904-.732%201.636-1.636%201.636h-3.819V11.73L12%2016.64l-6.545-4.91v9.273H1.636A1.636%201.636%200%200%201%200%2019.366V5.457c0-2.023%202.309-3.178%203.927-1.964L5.455%204.64%2012%209.548l6.545-4.91%201.528-1.145C21.69%202.28%2024%203.434%2024%205.457z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
  "integration-trello":
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2244%22%20height%3D%2244%22%20viewBox%3D%220%200%2044%2044%22%3E%3Csvg%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2224%22%20height%3D%2224%22%20stroke%3D%22rgb(12%2C%20102%2C%20228)%22%20fill%3D%22rgb(12%2C%20102%2C%20228)%22%20stroke-width%3D%220%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20class%3D%22size-6%20text-%5B%230c66e4%5D%22%20%20%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M21.147%200H2.853A2.86%202.86%200%20000%202.853v18.294A2.86%202.86%200%20002.853%2024h18.294A2.86%202.86%200%200024%2021.147V2.853A2.86%202.86%200%200021.147%200zM10.34%2017.287a.953.953%200%2001-.953.953h-4a.954.954%200%2001-.954-.953V5.38a.953.953%200%2001.954-.953h4a.954.954%200%2001.953.953zm9.233-5.467a.944.944%200%2001-.953.947h-4a.947.947%200%2001-.953-.947V5.38a.953.953%200%2001.953-.953h4a.954.954%200%2001.953.953z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E%3C%2Fsvg%3E",
}

export const pluginGalleryIds = [
  "integration-github",
  "integration-figma",
  "integration-notion",
  "integration-slack",
  "integration-jira",
  "integration-dropbox",
  "integration-gmail",
  "integration-trello",
] as const

export const pluginPresentation: Readonly<
  Record<
    string,
    { vendor: string; steps: number; permissions: ApCopy[]; isNew?: boolean }
  >
> = {
  "integration-github": {
    vendor: "GitHub, Inc.",
    steps: 2,
    permissions: [
      { "zh-CN": "读取代码仓库元数据", en: "Read repository metadata" },
      { "zh-CN": "读取问题与拉取请求", en: "Read issues and pull requests" },
    ],
  },
  "integration-figma": {
    vendor: "Figma, Inc.",
    steps: 4,
    isNew: true,
    permissions: [
      { "zh-CN": "读取所选设计文件", en: "Read selected design files" },
      { "zh-CN": "导出预览素材", en: "Export preview assets" },
    ],
  },
  "integration-notion": {
    vendor: "Notion Labs, Inc.",
    steps: 4,
    permissions: [
      { "zh-CN": "读取共享页面", en: "Read shared pages" },
      { "zh-CN": "搜索共享数据库", en: "Search shared databases" },
    ],
  },
  "integration-slack": {
    vendor: "Slack Technologies",
    steps: 4,
    permissions: [
      { "zh-CN": "读取已批准的频道", en: "Read approved channels" },
      { "zh-CN": "搜索消息历史", en: "Search message history" },
    ],
  },
  "integration-jira": {
    vendor: "Atlassian",
    steps: 3,
    permissions: [
      { "zh-CN": "读取问题详情", en: "Read issue details" },
      {
        "zh-CN": "读取项目与冲刺元数据",
        en: "Read project and sprint metadata",
      },
    ],
  },
  "integration-dropbox": {
    vendor: "Dropbox, Inc.",
    steps: 2,
    permissions: [
      { "zh-CN": "读取所选文件夹", en: "Read selected folders" },
      { "zh-CN": "搜索文件元数据", en: "Search file metadata" },
    ],
  },
  "integration-gmail": {
    vendor: "Google",
    steps: 3,
    permissions: [
      { "zh-CN": "读取已批准的邮箱", en: "Read approved mailboxes" },
      { "zh-CN": "搜索邮件元数据", en: "Search email metadata" },
    ],
  },
  "integration-trello": {
    vendor: "Atlassian",
    steps: 3,
    permissions: [
      { "zh-CN": "读取所选看板", en: "Read selected boards" },
      { "zh-CN": "读取卡片与清单", en: "Read cards and checklists" },
    ],
  },
}
