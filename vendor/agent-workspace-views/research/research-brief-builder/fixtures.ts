import type { Copy } from "../../model"
export type DraftText = string | Copy
export const text = (value: DraftText, locale: string) =>
  typeof value === "string" ? value : value[locale === "en" ? "en" : "zh-CN"]
const copy = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })
export const sourceTypes = [
  { id: "documentation", label: copy("官方文档", "Official documentation") },
  { id: "research", label: copy("独立研究", "Independent research") },
  { id: "interviews", label: copy("客户访谈", "Customer interviews") },
] as const
export const regions = [
  { id: "north-america", label: copy("北美", "North America") },
  { id: "europe", label: copy("欧洲", "Europe") },
  { id: "asia-pacific", label: copy("亚太地区", "Asia Pacific") },
  { id: "global", label: copy("全球", "Global") },
] as const
export const windows = [
  { id: "3-months", label: copy("过去 3 个月", "Past 3 months") },
  { id: "12-months", label: copy("过去 12 个月", "Past 12 months") },
  { id: "3-years", label: copy("过去 3 年", "Past 3 years") },
  { id: "any", label: copy("不限时间", "Any time") },
] as const
export function createBrief() {
  return {
    goal: copy(
      "什么条件能让自助式入门试点值得扩大？",
      "What would make a self-serve onboarding pilot worth expanding?",
    ),
    audience: copy("产品和客户成功团队", "Product and customer success teams"),
    questions: [
      {
        id: "question-1",
        value: copy(
          "新团队在哪些环节失去动力，未能获得首次价值？",
          "Where do new teams lose momentum before reaching first value?",
        ),
      },
      {
        id: "question-2",
        value: copy(
          "哪些入门干预措施有证据表明能改善激活率？",
          "Which onboarding interventions have evidence of improving activation?",
        ),
      },
      {
        id: "question-3",
        value: copy(
          "扩大 20 个工作区的试点前，我们应该衡量什么？",
          "What should we measure before expanding a 20-workspace pilot?",
        ),
      },
    ],
    steps: [
      {
        id: "step-1",
        value: copy(
          "为每个研究问题寻找相关来源。",
          "Find relevant sources for each research question.",
        ),
      },
      {
        id: "step-2",
        value: copy(
          "比较证据、发布日期和相互冲突的发现。",
          "Compare evidence, publication dates, and conflicting findings.",
        ),
      },
      {
        id: "step-3",
        value: copy(
          "撰写包含引用和未解问题的决策简报。",
          "Draft a decision brief with citations and open questions.",
        ),
      },
    ],
    region: "north-america",
    window: "12-months",
    sources: ["documentation", "research"],
    exclusions: copy(
      "排除供应商赞助的排名和匿名说法。",
      "Exclude vendor-sponsored rankings and anonymous claims.",
    ),
  }
}
