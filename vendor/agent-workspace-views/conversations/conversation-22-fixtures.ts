import type { ComposerDemoSource } from "../demo-source.ts"
import type { Copy } from "../model.ts"
import type { CitationSource } from "./citation-model.ts"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"

export const conversation22Scenarios = [
  ...commonScenarios,
  { id: "missing-source", name: { "zh-CN": "来源失效", en: "Missing source" } },
  {
    id: "refresh-error",
    name: { "zh-CN": "来源刷新失败", en: "Source refresh error" },
  },
] as const
export type Conversation22Scenario =
  CommonScenario | "missing-source" | "refresh-error"
export interface ResearchParagraph {
  text: Copy
  sourceId: string
}
export interface ResearchSection {
  id: string
  title: Copy
  items: { title?: Copy; paragraph: ResearchParagraph }[]
}
export interface ResearchFollowUp {
  id: string
  question: Copy
  sourceIds: string[]
  keywords: string[]
}
export interface Conversation22Fixture {
  source: ComposerDemoSource
  sources: CitationSource[]
  question: Copy
  summary: ResearchParagraph
  sections: ResearchSection[]
  followUps: ResearchFollowUp[]
  researchSteps: Copy[]
  savedDate: string
}

export function createConversation22Fixture(
  scenario: Conversation22Scenario,
): Conversation22Fixture {
  const question: Copy = {
    "zh-CN": "用 Shadcnblocks 可以构建什么？",
    en: "What can you build with Shadcnblocks?",
  }
  const sources: CitationSource[] = [
    {
      id: "overview",
      title: { "zh-CN": "Shadcnblocks 概览", en: "Shadcnblocks overview" },
      url: "https://www.shadcnblocks.com/",
      excerpt: {
        "zh-CN":
          "公开目录包含 React、shadcn/ui 与 Tailwind 的区块、组件和网站模板；预览和授权条件由各产品页面说明。",
        en: "The public catalog contains React, shadcn/ui and Tailwind blocks, components and website templates. Product pages describe previews and access conditions.",
      },
      available: scenario !== "missing-source",
    },
    {
      id: "blocks",
      title: {
        "zh-CN": "浏览区块与使用入门",
        en: "Browse blocks and get started",
      },
      url: "https://www.shadcnblocks.com/docs/blocks/getting-started",
      excerpt: {
        "zh-CN":
          "区块入门文档说明如何在 React 与 Tailwind 项目中初始化 shadcn/ui 并安装区块源码。选择目标区块后仍需核对具体组件和依赖。",
        en: "The blocks guide explains initializing shadcn/ui in a React and Tailwind project and installing block source. Check the chosen block's components and dependencies.",
      },
      available: true,
    },
    {
      id: "templates",
      title: { "zh-CN": "网站模板", en: "Website templates" },
      url: "https://www.shadcnblocks.com/docs/templates/adding-blocks",
      excerpt: {
        "zh-CN":
          "模板已组合好网站结构，也可继续加入区块并修改其源码。目录提供 Next.js 与 Astro 设计；以所选模板列出的技术栈为准。",
        en: "Templates compose website structure and can accept additional blocks and source modifications. The catalog offers Next.js and Astro designs; follow the selected template's listed stack.",
      },
      available: true,
    },
    {
      id: "installation",
      title: { "zh-CN": "shadcn CLI 安装指南", en: "shadcn CLI installation" },
      url: "https://www.shadcnblocks.com/docs/shadcn-cli/overview",
      excerpt: {
        "zh-CN":
          "CLI 使用命名空间 Registry 安装源码及依赖。私有 Registry 的付费资源需符合授权与认证要求；公开预览不等于再分发许可。",
        en: "The CLI installs source and dependencies from namespaced registries. Premium private-registry resources require appropriate access and authentication; public previews are not redistribution licenses.",
      },
      available: true,
    },
    {
      id: "admin",
      title: { "zh-CN": "Shadcn Admin Kit", en: "Shadcn Admin Kit" },
      url: "https://www.shadcnblocks.com/template/admin",
      excerpt: {
        "zh-CN":
          "Admin Kit 将电商、项目管理、支付、AI 对话、任务和开发者页面放入共享 Next.js 应用。购买模板不会自动提供业务后端。",
        en: "Admin Kit combines ecommerce, project management, payments, AI chat, tasks and developer pages in a shared Next.js application. Purchasing a template does not automatically provide a business backend.",
      },
      available: true,
    },
  ]
  const summary: ResearchParagraph = {
    text: {
      "zh-CN":
        "Shadcnblocks 提供可直接改造的界面区块、组件和网站模板，面向 React、shadcn/ui 和 Tailwind CSS。先选择完整设计，再根据你的产品修改其源码。",
      en: "Shadcnblocks provides adaptable interface blocks, components and website templates for React, shadcn/ui and Tailwind CSS. Start with a complete design, then tailor its source to your product.",
    },
    sourceId: "overview",
  }
  const sections: ResearchSection[] = [
    {
      id: "application",
      title: {
        "zh-CN": "从着陆页到应用",
        en: "From a landing page to an application",
      },
      items: [
        {
          title: {
            "zh-CN": "1. 组合一个产品网站",
            en: "1. Assemble a product website",
          },
          paragraph: {
            text: {
              "zh-CN":
                "把 hero、功能区、用户评价和定价组合成着陆页。按用途浏览所需的区块，安装源码后统一内容与样式，而不是把预览当成已完成的业务产品。",
              en: "Compose a landing page from a hero, features, testimonials and pricing. Browse by purpose, install the source, then align content and styling; a preview is not a finished business product.",
            },
            sourceId: "blocks",
          },
        },
        {
          title: {
            "zh-CN": "2. 从完整模板开始",
            en: "2. Start from a complete template",
          },
          paragraph: {
            text: {
              "zh-CN":
                "需要协调一致的网站时，可从已经编排好各章节的模板开始。核对所选设计使用 Next.js 还是 Astro，再按它的安装说明加入新的区块。",
              en: "For a coordinated website, start with a template whose sections are already composed. Check whether the chosen design uses Next.js or Astro, then follow its guide when adding blocks.",
            },
            sourceId: "templates",
          },
        },
        {
          title: {
            "zh-CN": "3. 构建产品背后的工作区",
            en: "3. Build the workspace behind the product",
          },
          paragraph: {
            text: {
              "zh-CN":
                "Admin Kit 在一个共享 Next.js 应用中提供电商、项目管理、支付、任务和开发者界面。导航与主题可作为应用外框；执行、权限、持久化和真实服务仍由接入方实现。",
              en: "Admin Kit provides ecommerce, project management, payments, tasks and developer interfaces in one Next.js application. Navigation and themes form an application frame; execution, permissions, persistence and real services remain integration responsibilities.",
            },
            sourceId: "admin",
          },
        },
      ],
    },
    {
      id: "installation",
      title: {
        "zh-CN": "如何引入你的项目？",
        en: "How do you bring it into your project?",
      },
      items: [
        {
          paragraph: {
            text: {
              "zh-CN":
                "选择区块并遵循它的安装指南。shadcn CLI 会加入源码并处理所需组件与依赖；命名空间 Registry 与付费资源的认证方式见官方指南。先核对许可证，不直接复制付费模板源码或资产。",
              en: "Choose a block and follow its installation guide. The shadcn CLI adds source and required components and dependencies; official guides cover namespaced registries and premium authentication. Verify licenses rather than copying paid template source or assets.",
            },
            sourceId: "installation",
          },
        },
      ],
    },
  ]
  const followUps: ResearchFollowUp[] = [
    {
      id: "landing",
      question: {
        "zh-CN": "着陆页可以选哪些区块？",
        en: "Which blocks can I use for a landing page?",
      },
      sourceIds: ["blocks", "overview"],
      keywords: ["着陆", "landing", "hero", "pricing", "定价"],
    },
    {
      id: "install",
      question: {
        "zh-CN": "如何安装一个区块？",
        en: "How do I install a block?",
      },
      sourceIds: ["installation", "blocks"],
      keywords: ["安装", "install", "registry", "cli"],
    },
    {
      id: "admin",
      question: {
        "zh-CN": "Admin Kit 包含什么？",
        en: "What is included in the Admin Kit?",
      },
      sourceIds: ["admin", "templates"],
      keywords: ["admin", "工作区", "workspace", "模板", "template"],
    },
  ]
  const answer: Copy = { "zh-CN": "", en: "" }
  for (const locale of ["zh-CN", "en"] as const) {
    const citation = (sourceId: string) =>
      `[${sources.findIndex((item) => item.id === sourceId) + 1}]`
    answer[locale] =
      `# ${question[locale]}\n\n${summary.text[locale]} ${citation(summary.sourceId)}\n\n${sections.map((section) => `## ${section.title[locale]}\n\n${section.items.map((item) => `${item.title ? `### ${item.title[locale]}\n\n` : ""}${item.paragraph.text[locale]} ${citation(item.paragraph.sourceId)}`).join("\n\n")}`).join("\n\n")}`
  }
  return {
    source: createThreadFixture("web-answer", scenario, question, answer),
    sources,
    question,
    summary,
    sections,
    followUps,
    savedDate: "2026-09-07",
    researchSteps: [
      { "zh-CN": "整理五份保存的来源", en: "Collect five saved sources" },
      { "zh-CN": "核对区块库说明", en: "Review the block library" },
      { "zh-CN": "比较网站模板", en: "Compare website templates" },
      {
        "zh-CN": "核对 CLI 与授权边界",
        en: "Check CLI and licensing boundaries",
      },
      { "zh-CN": "形成带句内引用的答复", en: "Compose a cited answer" },
    ],
  }
}
