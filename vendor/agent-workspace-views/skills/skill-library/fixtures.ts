import referenceSkills from "./reference-skills.json" with { type: "json" }

export type Localized = { "zh-CN": string; en: string }
export type SkillSnapshot = {
  name: string
  description: Localized
  instructions: string
}
export type SkillVersion = SkillSnapshot & { version: number; reason: "repository" | "metadata" | "instructions" | "upload" | "restore" | "created" }
export type Skill = SkillSnapshot & {
  slug: string
  version: number
  source: "repository" | "local" | "upload"
  upstream?: string
  history: SkillVersion[]
  repository?: SkillSnapshot
}

const descriptions = [
  "使用 agents 包构建、调试或审查 Cloudflare Agents SDK 应用。",
  "为应用、API、AI Agent、存储、网络与安全发现并选择 Cloudflare 产品，包括架构和产品选型。",
  "实现或排查 Cloudflare 邮件发送、邮件路由集成与投递配置。",
  "设计、配置、排查或审查 Cloudflare One 零信任与 SASE 部署。迁移规划请使用 cloudflare-one-migrations。",
  "评估现有 VPN、SWG 或 SASE 平台迁移到 Cloudflare One 的方案，包括策略映射、功能差距和上线计划。",
  "构建、调试或审查用于持久状态和协作的 Cloudflare Durable Objects 代码。",
  "使用 vinext 在 Cloudflare Workers 上构建、迁移和部署 Next.js 应用，包括项目初始化、框架选择和配置。",
  "使用稳定的 @cloudflare/sandbox 包构建和维护 Cloudflare Sandbox 应用。",
  "为现有前后端实现、修复或迁移 Cloudflare Turnstile 人机验证，包括服务端 Siteverify。",
  "审查、诊断和优化网站加载与交互性能、Core Web Vitals 和 Lighthouse 得分。",
  "编写、审查或配置生产环境 Cloudflare Workers 的最佳实践。",
  "运行或排查 Wrangler CLI 命令，并配置 Worker 项目的本地开发、部署和资源管理。",
]

/** Cloudflare skills, Apache-2.0. See LICENSE.cloudflare. Public skill text
 * collected from the reference's read-only instruction editor; translated
 * descriptions are local adaptations. No external code is executed. */
export function createSkills(): Skill[] {
  return referenceSkills.skills.map((entry, index) => {
    const snapshot: SkillSnapshot = {
      name: entry.slug,
      description: { "zh-CN": descriptions[index], en: entry.description },
      instructions: entry.body,
    }
    return {
      ...snapshot,
      slug: entry.slug,
      version: 1,
      source: "repository",
      upstream: `https://github.com/cloudflare/skills/blob/d924cd8f59e75e08fd3dd52843bb2776de35c77e/skills/${entry.slug}/SKILL.md`,
      history: [],
      repository: snapshot,
    }
  })
}
