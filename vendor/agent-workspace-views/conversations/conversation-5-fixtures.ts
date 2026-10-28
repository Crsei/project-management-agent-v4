import type { ChangeSet } from "./resource-model"
import type { ComposerDemoSource } from "../demo-source"
import type { ChatEntry } from "../model"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation5Scenarios = commonScenarios
export type Conversation5Scenario = CommonScenario
export interface Conversation5Fixture {
  source: ComposerDemoSource
  changes: ChangeSet
}
const snapshots = [
  {
    id: "page",
    path: "src/app/dashboard/page.tsx",
    old: [
      'import { MetricCard } from "@/components/dashboard/metric-card"',
      'export default function Dashboard() { return <MetricCard label="Revenue" value="$45,231" /> }',
    ],
    code: `import { MetricCard } from "@/components/dashboard/metric-card"
import { RevenueChart } from "@/components/dashboard/revenue-chart"

export default function Dashboard() {
  return (
    <main aria-label="Revenue overview" className="space-y-6">
      <h1>Revenue overview</h1>
      <MetricCard label="Revenue" value="$45,231" trend="+20.1% from last month" />
      <RevenueChart />
    </main>
  )
}`,
  },
  {
    id: "chart",
    path: "src/components/dashboard/revenue-chart.tsx",
    old: ["export const RevenueChart = () => null"],
    code: `"use client"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"

const revenue = [
  { month: "January", revenue: 18600 },
  { month: "February", revenue: 30500 },
  { month: "March", revenue: 23700 },
  { month: "April", revenue: 27300 },
  { month: "May", revenue: 20900 },
  { month: "June", revenue: 31400 },
]
const config = { revenue: { label: "Revenue", color: "var(--chart-1)" } }

export function RevenueChart() {
  return (
    <section aria-label="Six-month revenue">
      <h2>Revenue over time</h2>
      <p>January – June 2026</p>
      <ChartContainer config={config} className="h-64 w-full">
        <AreaChart accessibilityLayer data={revenue}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="month" tickLine={false} axisLine={false}
            tickFormatter={(value) => value.slice(0, 3)} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area dataKey="revenue" type="monotone"
            stroke="var(--color-revenue)" fill="var(--color-revenue)"
            fillOpacity={0.08} strokeWidth={2} />
        </AreaChart>
      </ChartContainer>
      <p>Monthly revenue in US dollars</p>
    </section>
  )
}`,
  },
  {
    id: "metric",
    path: "src/components/dashboard/metric-card.tsx",
    old: [
      "type Props = { label: string; value: string }",
      "export function MetricCard({ label, value }: Props) {",
      "  return <article><h2>{label}</h2><p>{value}</p></article> }",
    ],
    code: `type Props = { label: string; value: string; trend?: string }
export function MetricCard({ label, value, trend }: Props) {
  return <article className="rounded-lg border p-6">
    <h2>{label}</h2>
    <p className="text-2xl font-semibold">{value}</p>
    {trend && <p className="text-sm text-muted-foreground">{trend}</p>}
  </article>
}`,
  },
  {
    id: "format",
    path: "src/lib/format-currency.ts",
    old: [],
    code: `const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})
export const formatCurrency = (value: number): string =>
  dollars.format(value)`,
  },
]
export function createConversation5Fixture(
  scenario: Conversation5Scenario,
): Conversation5Fixture {
  const source = createThreadFixture(
    "conversation-5",
    scenario,
    {
      "zh-CN":
        "按 dashboard brief 实现收入概览：保留 metric cards、增加六个月图表，复用已有 shadcn chart。",
      en: "Build the revenue overview from the dashboard brief. Keep the metric cards, add a six-month chart, and reuse the existing shadcn chart.",
    },
    {
      "zh-CN":
        "我先探索现有路由、卡片、chart wrapper 和 formatter，再做最小修改。\n\n实现计划：页面保留服务端渲染，Recharts 隔离为小型客户端组件。",
      en: "I traced the dashboard route, shared cards, chart wrapper and formatter.\n\nImplementation plan: keep the page server-rendered and isolate Recharts in a small client component.",
    },
  )
  const turns: ChatEntry[] = [
    {
      id: "c5-style",
      role: "user",
      text: {
        "zh-CN": "图表保持安静、克制，不要渐变；卡片加上趋势上下文。",
        en: "Keep the chart quiet and editorial, without gradients. Add trend context to the cards.",
      },
    },
    {
      id: "c5-implemented",
      role: "assistant",
      text: {
        "zh-CN":
          "已整理四文件固定变更：单 area series、浅填充、水平网格与已有主题 token。trend 为可选字段。\n\n这些是本地源码快照；没有修改真实仓库。",
        en: "The four-file snapshot uses one area series, a light fill, horizontal grid and existing tokens. Trend remains optional.\n\nThis is a local source snapshot; the real repository was not changed.",
      },
    },
    {
      id: "c5-why",
      role: "user",
      text: {
        "zh-CN": "为什么扩展既有 metric card，而不是再造 trend card？",
        en: "Why extend the existing metric card instead of creating a separate trend card?",
      },
    },
    {
      id: "c5-compatible",
      role: "assistant",
      text: {
        "zh-CN":
          "新组件会重复 label、value、间距与响应式结构。只加可选 trend，原有十二处调用不需要传新字段。\n\n### 兼容性检查 · 固定审阅记录\n- 12 处既有调用保持原结构\n- trend 可选且以文字表达\n- 未增加页面客户端边界",
        en: "A new component would duplicate label, value, spacing and responsive structure. The optional trend preserves the twelve existing callers.\n\n### Compatibility check · fixture review\n- 12 existing usages keep their structure\n- Optional, text-readable trend\n- No new page client boundary",
      },
    },
    {
      id: "c5-responsive",
      role: "user",
      text: {
        "zh-CN":
          "审阅 phone、tablet、desktop 三个宽度，避免 composer 或图表横向溢出。",
        en: "Review phone, tablet and desktop widths. Avoid composer or chart horizontal overflow.",
      },
    },
    {
      id: "c5-review",
      role: "assistant",
      text: {
        "zh-CN":
          "### 响应审阅 · 3 个原站参考视口\n| 视口 | 固定审阅记录 |\n| --- | --- |\n| 390 px | 单列会话、独立源码视图 |\n| 768 px | 输入控件可达、文件引用换行 |\n| 1440 px | 会话与源码独立滚动 |\n\n这是原站审阅语义的本地记录，不是本应用已执行的测试结果。",
        en: "### Responsive review · 3 reference viewports\n| Width | Fixture review record |\n| --- | --- |\n| 390 px | Single-column thread and separate code surface |\n| 768 px | Reachable composer and wrapping references |\n| 1440 px | Independently scrolling thread and code |\n\nThese are local reference review records, not executed test results for this app.",
      },
    },
    {
      id: "c5-position",
      role: "user",
      text: {
        "zh-CN": "切换文件时不要重置会话或丢失阅读位置。",
        en: "Do not reset the conversation or lose my reading position when switching files.",
      },
    },
    {
      id: "c5-retained",
      role: "assistant",
      text: {
        "zh-CN":
          "会话、草稿和资源工作区独立挂载；切换 Code / Changes、文件或审阅不会替换消息流。",
        en: "The conversation, draft and resource workspace stay mounted independently. Code / Changes and file selection do not replace the thread.",
      },
    },
  ]
  if (scenario !== "empty") source.sessions[0].messages.push(...turns)
  return {
    source,
    changes: {
      repositoryId: "shadcn-analytics",
      scope: "Local demo working tree",
      base: "fixture-base",
      head: "fixture-head",
      revision: "reference-v2",
      files: snapshots.map((snapshot) => ({
        fileId: snapshot.id,
        path: snapshot.path,
        kind: snapshot.old.length ? "modified" : "added",
        baseContent: snapshot.old.join("\n"),
        content: snapshot.code,
        lines: [
          ...snapshot.old.map((text, i) => ({
            id: `${snapshot.id}-old-${i}`,
            kind: "remove" as const,
            text,
            oldLine: i + 1,
          })),
          ...snapshot.code
            .split("\n")
            .map((text, i) => ({
              id: `${snapshot.id}-new-${i}`,
              kind: "add" as const,
              text,
              newLine: i + 1,
            })),
        ],
      })),
    },
  }
}
