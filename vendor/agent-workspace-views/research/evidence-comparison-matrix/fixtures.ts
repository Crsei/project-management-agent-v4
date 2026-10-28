import type { Copy } from "../../model"

export type Assessment = "conflict" | "agreement" | "qualified" | "gap"
export type Relation = "supports" | "conflicts" | "qualifies" | "none"
export type Evidence = { relation: Relation; quote?: Copy; interpretation: Copy }
export type Claim = { id: string; title: Copy; assessment: Assessment; evidence: Record<string, Evidence> }
export const text = (value: Copy, locale: string) => value[locale === "en" ? "en" : "zh-CN"]
const c = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })

export const sources = [
  { id: "interviews", title: c("客户访谈", "Customer interviews"), provenance: c("观察来源 01", "OBSERVED SOURCE 01"), kind: "observed" },
  { id: "support", title: c("支持记录审阅", "Support review"), provenance: c("观察来源 02", "OBSERVED SOURCE 02"), kind: "observed" },
  { id: "proposal", title: c("设计提案", "Design proposal"), provenance: c("提案 · 非独立证据", "PROPOSAL · NOT INDEPENDENT EVIDENCE"), kind: "hypothesis" },
] as const
export const assessments: Record<Assessment, Copy> = {
  conflict: c("冲突", "Conflict"), agreement: c("一致", "Agreement"), qualified: c("有条件", "Qualified"), gap: c("证据缺口", "Evidence gap"),
}
export const relations: Record<Relation, Copy> = {
  supports: c("支持", "Supports"), conflicts: c("冲突", "Conflicts"), qualifies: c("限定条件", "Qualifies"), none: c("无证据", "No evidence"),
}
export const filters = ["all", "conflict", "agreement", "qualified", "gap"] as const
export type Filter = (typeof filters)[number]

export const claims: Claim[] = [
  {
    id: "document-first", title: c("先导入文档，再介绍协作", "Import a document before introducing collaboration"), assessment: "qualified",
    evidence: {
      interviews: { relation: "supports", quote: c("参与者希望先有值得分享的内容，再邀请同事。", "Participants wanted something worth sharing before they invited a colleague."), interpretation: c("访谈样本倾向于先准备内容，再发出邀请。", "The interview sample favors content before invitations.") },
      support: { relation: "qualifies", quote: c("加入现有团队的人，已有共享内容等待他们。", "People joining an established team already had shared content waiting for them."), interpretation: c("建议的顺序可能只适用于创建新工作区的人。", "The proposed sequence may only fit people creating a new workspace.") },
      proposal: { relation: "supports", quote: c("从文档开始，再把分享作为下一步有用的操作。", "Begin with a document, then offer sharing as the next useful action."), interpretation: c("提案采用相同顺序；这是一个假设，而非独立验证。", "The proposal follows the same sequence; it is a hypothesis, not independent validation.") },
    },
  },
  {
    id: "required-invitation", title: c("要求邀请团队成员才能完成设置", "Require a team invitation to finish setup"), assessment: "conflict",
    evidence: {
      interviews: { relation: "conflicts", quote: c("独立使用的参与者希望先探索，再决定邀请谁加入。", "Solo participants wanted to explore before deciding who else should join."), interpretation: c("强制邀请会阻止这些参与者完成设置。", "A required invitation prevents these participants from completing setup.") },
      support: { relation: "conflicts", quote: c("个人账户用户询问如何跳过团队邀请步骤。", "Individual accounts asked how to skip the team invitation step."), interpretation: c("支持记录揭示了强制邀请带来的阻力。", "Support notes identify friction with mandatory invitations.") },
      proposal: { relation: "supports", quote: c("最初的构想将邀请一位团队成员设为设置的最后一个必需步骤。", "The initial concept makes one teammate invitation the last required setup step."), interpretation: c("这份较早的设计构想与观察到的需求冲突。实施前应先解决。", "This earlier design concept conflicts with the observed needs. Resolve before implementation.") },
    },
  },
  {
    id: "visibility", title: c("发送邀请前展示文档可见范围", "Show document visibility before sending invitations"), assessment: "agreement",
    evidence: {
      interviews: { relation: "supports", quote: c("分享前，参与者会确认其他人是否能看到整个工作区。", "Before sharing, participants checked whether others could see the whole workspace."), interpretation: c("在做出分享决策时，受众范围存在不确定性。", "Audience uncertainty appears at the sharing decision.") },
      support: { relation: "supports", quote: c("邀请请求中反复出现有关私人文件与共享文件的问题。", "Questions about private versus shared files recur in invitation requests."), interpretation: c("支持记录的主题进一步表明，需要明确的权限说明。", "Support themes reinforce the need for explicit permission language.") },
      proposal: { relation: "supports", quote: c("在邀请操作旁展示受众预览。", "Show an audience preview alongside the invitation action."), interpretation: c("提案回应了相同的可见性问题。", "The proposal addresses the same visibility concern.") },
    },
  },
  {
    id: "guided-tour", title: c("引导教程能提升首周留存率", "A guided tour improves first-week retention"), assessment: "gap",
    evidence: {
      interviews: { relation: "none", interpretation: c("访谈未衡量首周留存率，也未比较引导教程。", "Interviews did not measure first-week retention or compare guided tours.") },
      support: { relation: "none", interpretation: c("支持记录的主题不包含留存率测量。", "Support themes contain no retention measurements.") },
      proposal: { relation: "qualifies", quote: c("简短的教程或许能帮助不熟悉的用户；应将其与在实际工作中学习的方式进行比较测试。", "A short tour might help unfamiliar users; test it against learning through real work."), interpretation: c("这是一个可测试的假设，不能据此认定它有助于留存。", "This is a testable hypothesis. It does not establish a retention benefit.") },
    },
  },
]

/** Long-content adds context, never additional observations or independent support. */
export function fixtureClaims(scenario: string): Claim[] {
  if (scenario === "empty") return []
  if (scenario !== "long-content") return claims
  const context = c(" 本地演示的来源上下文：这些片段来自同一入门研究样本，不包含因果对照、统计显著性或真实留存率指标。审阅只表示已经阅读该单元格；它不会改变证据的性质，也不会解决研究冲突。设计提案仍是假设，后续决策需要单独收集独立证据。", " Demo source context: these excerpts belong to the same onboarding sample and contain no causal control, statistical significance, or measured retention outcome. Review means the cell was read; it does not change the nature of the evidence or resolve a research conflict. The design proposal remains a hypothesis, and a later decision requires separately collected independent evidence.")
  return claims.map(claim => ({ ...claim, evidence: Object.fromEntries(Object.entries(claim.evidence).map(([id, evidence]) => [id, { ...evidence, interpretation: { "zh-CN": evidence.interpretation["zh-CN"] + context["zh-CN"], en: evidence.interpretation.en + context.en } }])) }))
}
