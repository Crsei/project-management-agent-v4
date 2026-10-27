import { useId, useState } from "react"
import { Link } from "react-router"
import { Check, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

type LocalizedText = readonly [string, string]
type PlanPeriod = "monthly" | "annual" | "lifetime"

const periods: PlanPeriod[] = ["monthly", "annual", "lifetime"]
const periodLabels: Record<PlanPeriod, LocalizedText> = {
  monthly: ["月付", "Monthly"],
  annual: ["年付", "Annual"],
  lifetime: ["终身", "Lifetime"],
}

const exampleAmounts = { monthly: 4999, annual: 49999, lifetime: 89999 }
const annualMonthlyEquivalent = exampleAmounts.annual / 12
const annualSavings = exampleAmounts.monthly * 12 - exampleAmounts.annual
const annualDiscount = (annualSavings / (exampleAmounts.monthly * 12) * 100).toFixed(2)
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

const monthlyFeatures: LocalizedText[] = [
  ["专属客户经理", "Dedicated Account Manager"],
  ["社区访问与论坛参与", "Community Access & Forum Participation"],
  ["自定义设置与偏好", "Customizable Settings & Preferences"],
  ["定期绩效报告", "Regular Performance Reports"],
]
const monthlyResources: LocalizedText[] = [
  ["导师计划", "Mentorship Program"],
  ["社区教程", "Community Tutorials"],
  ["知识库访问", "Access to Knowledge Base"],
]

const exampleOfferings: Record<PlanPeriod, {
  description: LocalizedText
  features: LocalizedText[]
  resources: LocalizedText[]
  featureDetails: LocalizedText
  resourceDetails: LocalizedText
}> = {
  monthly: {
    description: [
      "此示例月付方案以灵活的月度周期提供核心功能、持续支持与常用工具，适合先体验再决定长期使用的展示场景。",
      "This example monthly offering combines core features, ongoing support and everyday tools with the flexibility of a monthly billing period.",
    ],
    features: monthlyFeatures,
    resources: monthlyResources,
    featureDetails: [
      "示例内容包含客户经理协助、社区交流、个性化偏好与定期绩效报告。这些条目仅用于比较方案，不代表本项目已提供相应服务或已授予任何权限。",
      "The example bundles account-manager guidance, community participation, personal preferences and periodic performance reports. These comparison items are not implemented service capabilities or granted entitlements.",
    ],
    resourceDetails: [
      "导师计划、教程和知识库均为示例资源名称。本预览不分配导师，也不开放外部资源或真实订阅内容。",
      "Mentorship, tutorials and the knowledge base are example resource names. This preview does not assign a mentor or unlock external resources or paid content.",
    ],
  },
  annual: {
    description: [
      "此示例年付方案包含月付方案的全部内容，并增加全天候支持与专属工作坊。与连续支付 12 个月的示例月费相比，年付总价更低。",
      "This example annual offering includes everything in Monthly, plus round-the-clock support and exclusive workshops. Its yearly total is lower than twelve example monthly payments.",
    ],
    features: [...monthlyFeatures, ["全天候服务与支持", "24/7 Availability & Support"]],
    resources: [...monthlyResources, ["专属工作坊", "Exclusive Workshops"]],
    featureDetails: [
      "此示例在月付方案的四项功能上增加全天候支持。支持时段和客户经理均为展示内容，当前服务没有实际支持协议或订阅权益。",
      "This example adds 24/7 support to the four Monthly features. Support coverage and account management are illustrative; the current service provides no subscription entitlements or support agreement.",
    ],
    resourceDetails: [
      "此示例在导师计划、社区教程和知识库之外增加专属工作坊。本预览不会安排活动、发送邀请或预订席位。",
      "This example adds exclusive workshops to mentorship, community tutorials and the knowledge base. The preview does not schedule events, send invitations or reserve a place.",
    ],
  },
  lifetime: {
    description: [
      "此示例终身方案以一次性金额展示长期访问、进阶进度跟踪、优先支持与专属更新，无周期性续费。它不代表真实的终身服务承诺。",
      "This example lifetime offering illustrates long-term access, advanced progress tracking, priority support and exclusive updates for a one-time amount, without recurring billing. It is not a real lifetime-service commitment.",
    ],
    features: [
      ["全部功能路径的无限访问", "Unlimited Access to All Routes"],
      ["进阶进度跟踪", "Advanced Progress Tracking"],
      ["新功能抢先体验", "Early Access to New Features"],
      ["反馈驱动的产品路线图", "Feedback-Driven Roadmap"],
      ["增强分析与洞察", "Enhanced Analytics & Insights"],
      ["优先问题修复与支持", "Priority Bug Fixes & Support"],
    ],
    resources: [...monthlyResources, ["终身专属网络研讨会", "Lifetime Exclusive Webinars"]],
    featureDetails: [
      "无限访问、进度跟踪、抢先体验、路线图参与、分析与优先修复均为示例权益。当前项目不会因此开放功能、改变访问权限或作出长期服务承诺。",
      "Unlimited access, progress tracking, early access, roadmap participation, analytics and priority fixes are example benefits. No functionality is unlocked, permissions changed or long-term service commitment made by this project.",
    ],
    resourceDetails: [
      "此示例增加终身专属网络研讨会，保留导师计划、社区教程和知识库。本预览不会报名活动，也不授予任何真实资源的长期访问权。",
      "This example adds lifetime-exclusive webinars alongside mentorship, community tutorials and the knowledge base. No event registration or lifetime access to real resources is provided.",
    ],
  },
}

function ExamplePrice({ period }: { period: PlanPeriod }) {
  const t = useText()
  return <div className="space-y-1 border-t px-4 py-3">
    <p className="font-medium tabular-nums">
      {usd(period === "annual" ? annualMonthlyEquivalent : exampleAmounts[period])}
      {period !== "lifetime" && <span className="text-sm font-normal">{t(" / 月", " / month")}</span>}
    </p>
    <p className="text-xs leading-5 text-muted-foreground">
      {period === "monthly" ? t("示例价格 · 按月计费（美元）", "Example price · billed monthly (USD)") : period === "annual"
        ? t(`${usd(exampleAmounts.annual)} / 年 · 示例价格（美元）`, `${usd(exampleAmounts.annual)} yearly · example price (USD)`)
        : t("示例价格 · 一次性计费（美元）", "Example price · one-time billing (USD)")}
    </p>
  </div>
}

function PlanCards({ selected, onSelect, disabled = false }: {
  selected: PlanPeriod | null
  onSelect?: (period: PlanPeriod) => void
  disabled?: boolean
}) {
  const t = useText()
  const id = useId()
  return <fieldset aria-describedby={disabled ? `${id}-unavailable` : `${id}-example`}>
    <legend className="sr-only">{t("选择计费周期", "Choose a billing period")}</legend>
    <div className="grid min-w-0 gap-4 md:grid-cols-3">
      {periods.map(period => <label key={period} className={`min-w-0 overflow-hidden rounded-lg border bg-surface ${disabled ? "cursor-not-allowed" : "cursor-pointer"} ${selected === period ? "border-foreground ring-1 ring-foreground" : "border-border"}`}>
        <span className="flex min-h-12 flex-wrap items-center gap-2 px-4 py-3">
          <input type="radio" name={`${id}-period`} value={period} checked={selected === period} onChange={() => onSelect?.(period)} disabled={disabled} className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" />
          <span className="text-sm font-medium">{t(...periodLabels[period])}</span>
          {!disabled && period === "annual" && <span className="ml-auto rounded border px-1.5 py-0.5 text-xs tabular-nums">{t(`省 ${annualDiscount}%`, `Save ${annualDiscount}%`)}</span>}
        </span>
        {disabled ? <div className="space-y-1 border-t px-4 py-3 text-sm text-muted-foreground">
          <p>{t("价格不可用", "Pricing unavailable")}</p>
          <p className="text-xs">{t("当前服务不提供订阅", "Subscriptions are not supported")}</p>
        </div> : <ExamplePrice period={period} />}
      </label>)}
    </div>
    <p id={disabled ? `${id}-unavailable` : `${id}-example`} className="mt-3 text-xs leading-5 text-muted-foreground">
      {disabled ? t("当前服务没有发布计费周期或价格，因此无法选择方案。", "The current service publishes no billing periods or prices, so plan selection is unavailable.")
        : t("所有金额与权益均为展示示例，不是真实报价。年付月均金额四舍五入至美分；折扣按未舍入的年度总价计算。终身方案无固定月数，因此不计算月均金额或折扣。", "All amounts and benefits are illustrative examples, not a real quote. The annual monthly equivalent is rounded to cents; the discount uses unrounded yearly totals. Lifetime has no fixed number of months, so no monthly equivalent or discount is stated.")}
    </p>
  </fieldset>
}

function BenefitGroup({ title, items, details }: { title: string; items: LocalizedText[]; details: string }) {
  const t = useText()
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const unavailable = items.length === 0
  return <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id={`${id}-title`} className="text-sm font-semibold">{title}</h3>
      <Button variant="ghost" size="sm" disabled={unavailable} aria-label={t(`${expanded ? "收起" : "了解更多"}：${title}`, `${expanded ? "Show less" : "Learn more"}: ${title}`)} aria-expanded={expanded} aria-controls={`${id}-details`} aria-describedby={unavailable ? `${id}-details` : undefined} onClick={() => setExpanded(previous => !previous)}>
        {expanded ? t("收起", "Show Less") : t("了解更多", "Learn More")}
        <ChevronDown aria-hidden="true" size={14} className={`transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
      </Button>
    </div>
    <div className="rounded-lg border bg-surface p-4">
      {unavailable ? <p id={`${id}-details`} className="text-sm leading-6 text-muted-foreground">{details}</p> : <>
        <ul className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {items.map(item => <li key={item[1]} className="flex min-w-0 items-start gap-2 text-sm leading-6"><Check aria-hidden="true" size={16} className="mt-1 shrink-0" /><span>{t(...item)}</span></li>)}
        </ul>
        <p id={`${id}-details`} hidden={!expanded} className="mt-4 border-t pt-4 text-sm leading-6 text-muted-foreground">{details}</p>
      </>}
    </div>
  </section>
}

function SubscriptionOverview({ preview = false }: { preview?: boolean }) {
  const t = useText()
  const id = useId()
  const usage = [
    { label: t("成员", "Members"), used: 8, limit: 50, unit: "" },
    { label: t("存储空间", "Storage"), used: 12.4, limit: 100, unit: " GB" },
    { label: t("项目", "Projects"), used: 6, limit: 50, unit: "" },
  ]
  return <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-lg border bg-surface p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold">{preview ? t("当前订阅 · Lab 样例", "Current subscription · Lab example") : t("当前订阅", "Current subscription")}</h3>
        <p className="text-xl font-semibold">{preview ? t("Team（示例）", "Team (example)") : t("状态未知", "Status unknown")}</p>
        <p className="text-sm leading-6 text-muted-foreground">{preview
          ? t("固定示例快照，不对应当前账号或工作区。", "A fixed example snapshot, unrelated to your account or workspace.")
          : t("没有订阅数据不代表免费方案、未订阅或零用量。", "Missing subscription data does not mean Free, unsubscribed, or zero usage.")}</p>
      </div>
      <Button variant="outline" render={<Link to="../invoices" relative="path" />}>{t("查看发票", "View invoices")}</Button>
    </div>
    <dl className="grid gap-4 border-y py-4 text-sm sm:grid-cols-2">
      <div className="space-y-1"><dt className="font-medium">{t("每成员价格", "Price per member")}</dt><dd className="text-muted-foreground">{preview ? t("$12.00 USD / 成员 / 月（示例）", "$12.00 USD / member / month (example)") : t("未知 · 未接入价格目录", "Unknown · No price catalog")}</dd></div>
      <div className="space-y-1"><dt className="font-medium">{t("计费周期", "Billing cycle")}</dt><dd className="text-muted-foreground">{preview ? t("月付 · 8 个示例席位合计 $96.00 USD / 月", "Monthly · 8 example seats total $96.00 USD / month") : t("未知 · 未接入订阅查询", "Unknown · No subscription API")}</dd></div>
      <div className="space-y-1"><dt className="font-medium">{t("下次续费", "Next renewal")}</dt><dd className="text-muted-foreground">{preview ? t("2026 年 11 月 1 日（固定示例，非续费安排）", "November 1, 2026 (fixed example, not scheduled)") : t("未知 · 不推测续费日期或金额", "Unknown · No date or amount inferred")}</dd></div>
      <div className="space-y-1"><dt className="font-medium">{t("试用状态", "Trial status")}</dt><dd className="text-muted-foreground">{preview ? t("示例中无进行中的试用", "No active trial in this example") : t("未知 · 未提供试用数据", "Unknown · No trial data")}</dd></div>
    </dl>
    <div className="grid gap-5 lg:grid-cols-3">
      {usage.map(item => <div key={item.label} className="min-w-0 space-y-2">
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">{item.label}</span>
          <span className="text-muted-foreground tabular-nums">{preview ? `${item.used}${item.unit} / ${item.limit}${item.unit}` : t("用量 / 配额未知", "Usage / limit unknown")}</span>
        </div>
        {preview ? <progress className="block h-2 w-full overflow-hidden rounded-full accent-primary [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary" value={item.used} max={item.limit} aria-label={t(`${item.label}示例用量`, `Example ${item.label.toLowerCase()} usage`)} /> : <div aria-hidden="true" className="h-2 rounded-full border border-dashed bg-surface-raised" />}
      </div>)}
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{preview
      ? t("用量与配额均为静态样例，不限制正式工作区，也不代表本项目提供存储套餐。", "Usage and limits are static examples. They do not limit the real workspace or represent available storage plans.")
      : t("服务没有提供计费用成员数、存储计量、项目总量或额度合同；此处不使用当前可见项目/成员冒充完整计费用量。", "The service provides no billable-member count, storage metering, total-project count, or quota contract. Visible members and projects are not substituted for complete billing usage.")}</p>
  </section>
}

const exampleTiers = [
  { name: "Free", cents: 0, benefits: [["最多 3 名成员", "Up to 3 members"], ["不限任务数量", "Unlimited tasks"], ["5 GB 存储空间", "5 GB storage"]] },
  { name: "Team", cents: 1200, benefits: [["最多 50 名成员", "Up to 50 members"], ["时间线与自定义视图", "Timelines & custom views"], ["100 GB 存储空间", "100 GB storage"], ["访客访问", "Guest access"]] },
  { name: "Business", cents: 2400, benefits: [["不限成员数量", "Unlimited members"], ["高级权限", "Advanced permissions"], ["SAML SSO", "SAML SSO"], ["1 TB 存储空间", "1 TB storage"]] },
] satisfies { name: string; cents: number; benefits: LocalizedText[] }[]

function ExampleTierComparison() {
  const t = useText()
  const id = useId()
  const [target, setTarget] = useState<(typeof exampleTiers)[number] | null>(null)
  const [previewed, setPreviewed] = useState<string | null>(null)
  return <section aria-labelledby={`${id}-title`} className="space-y-4">
    <h3 id={`${id}-title`} className="text-sm font-semibold">{t("分级权益比较 · Lab 样例", "Tier comparison · Lab example")}</h3>
    <p className="text-sm leading-6 text-muted-foreground">{t("下列 Free / Team / Business 来自参考设计，仅展示月付分级，不是真实产品目录。访客访问、SAML SSO、套餐配额等不代表已实现；购买或预览均不会授予权限。", "The reference Free / Team / Business tiers illustrate monthly tier comparisons only, not a real product catalog. Guest access, SAML SSO and plan quotas are not promised capabilities. No access is granted by a purchase or preview.")}</p>
    <div className="grid min-w-0 gap-4 xl:grid-cols-3">
      {exampleTiers.map(tier => <div key={tier.name} className={`flex min-w-0 flex-col gap-4 rounded-lg border bg-surface p-4 ${tier.name === "Team" ? "border-foreground" : ""}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold">{tier.name}</h4>
          {tier.name === "Team" && <span className="rounded border px-2 py-0.5 text-xs">{t("当前示例", "Current example")}</span>}
        </div>
        <p className="text-lg font-semibold tabular-nums">{usd(tier.cents)} <span className="text-xs font-normal text-muted-foreground">{t("USD / 成员 / 月 · 示例", "USD / member / month · example")}</span></p>
        <ul className="flex-1 space-y-3">
          {tier.benefits.map(benefit => <li key={benefit[1]} className="flex items-start gap-2 text-sm leading-6"><Check aria-hidden="true" className="mt-1 size-4 shrink-0" /><span>{t(...benefit)}</span></li>)}
        </ul>
        <Button variant="outline" disabled={tier.name === "Team"} onClick={() => { setTarget(tier); setPreviewed(null) }}>{tier.name === "Team" ? t("当前示例方案", "Current example tier") : tier.name === "Free" ? t("预览降级", "Preview downgrade") : t("预览升级", "Preview upgrade")}</Button>
      </div>)}
    </div>
    <Dialog open={target !== null} onOpenChange={open => { if (!open) setTarget(null) }}>
      <DialogContent>
        <DialogTitle>{t("查看分级变更示例", "Review example tier change")}</DialogTitle>
        <DialogDescription>{t("这是本地比较，不会更改示例当前方案或正式订阅，不会扣款、退款或删除超额数据。", "A local comparison only. It does not change the current example tier or a real subscription, charge, refund, or delete over-limit data.")}</DialogDescription>
        {target && <div className="my-5 space-y-3 text-sm leading-6">
          <p className="font-medium">Team → {target.name} · {usd(target.cents)} {t("USD / 成员 / 月（示例）", "USD / member / month (example)")}</p>
          <p className="text-muted-foreground">{target.name === "Free"
            ? t("此静态样例有 8 名成员及 12.4 GB 存储，超过 Free 样例的 3 人和 5 GB 配额。这里只展示差异，未实现真实降级校验、按比例结算或超额处理策略。", "The static example has 8 members and 12.4 GB of storage, above the example Free limits of 3 members and 5 GB. This only shows the differences; no real downgrade validation, proration, or overage policy is implemented.")
            : t("示例业务版为每成员每月 $24.00 USD；按 8 个示例席位计算为 $192.00 USD / 月。并无实际报价、账期调整或 SSO 开通。", "The example Business tier is $24.00 USD per member per month: $192.00 USD per month for 8 example seats. This is not a real quote, billing adjustment, or SSO activation.")}</p>
        </div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose render={<Button variant="outline" />}>{t("返回比较", "Back to comparison")}</DialogClose>
          <Button onClick={() => { if (target) setPreviewed(target.name); setTarget(null) }}>{t("完成比较（不变更订阅）", "Finish comparison (no change)")}</Button>
        </div>
      </DialogContent>
    </Dialog>
    {previewed && <p role="status" className="rounded-lg border bg-surface-raised p-3 text-sm leading-6">{t(`已查看 Team → ${previewed} 的样例比较。当前样例仍为 Team；没有更改订阅、权限或配额。`, `Reviewed the Team → ${previewed} example. The current example remains Team; no subscription, access, or quota was changed.`)}</p>}
  </section>
}

function ServicePlans() {
  const t = useText()
  const reasonId = useId()
  return <SettingsSection wide title={t("订阅方案", "Plans")} description={t("查看订阅方案与计费信息；当前服务尚未提供订阅能力。", "Review subscription options and billing information. Subscriptions are not available in the current service.")}>
    <SettingsNotice>{t("当前后端不提供价格目录、当前方案、试用状态或订阅接口。此页不推测账户权益，也不显示示例价格。", "The current backend provides no price catalog, current plan, trial status or subscription API. This page does not infer account entitlements or display example prices.")}</SettingsNotice>
    <SubscriptionOverview />
    <PlanCards selected={null} disabled />
    <BenefitGroup title={t("功能", "Features")} items={[]} details={t("当前服务未发布付费功能或方案权益，无法查看功能明细。", "The current service publishes no paid features or plan entitlements. Feature details are unavailable.")} />
    <BenefitGroup title={t("附加资源", "Additional Resources")} items={[]} details={t("当前服务未发布订阅资源，无法查看资源明细。", "The current service publishes no subscription resources. Resource details are unavailable.")} />
    <div className="space-y-2 border-t pt-5">
      <div className="flex flex-wrap gap-2">
        <Button disabled aria-describedby={reasonId}>{t("开始订阅", "Start subscription")}</Button>
        <Button variant="outline" disabled aria-describedby={reasonId}>{t("升级方案", "Upgrade plan")}</Button>
        <Button variant="outline" disabled aria-describedby={reasonId}>{t("降级方案", "Downgrade plan")}</Button>
      </div>
      <p id={reasonId} className="text-sm text-muted-foreground">{t("订阅不可用：尚未接入真实订阅与支付服务。", "Subscriptions are unavailable: no real subscription or payment service is connected.")}</p>
    </div>
  </SettingsSection>
}

function LabPlans() {
  const t = useText()
  const [period, setPeriod] = useState<PlanPeriod>("monthly")
  const [reviewOpen, setReviewOpen] = useState(false)
  const [previewed, setPreviewed] = useState<PlanPeriod | null>(null)
  const offering = exampleOfferings[period]
  const cadence = (value: PlanPeriod) => value === "monthly" ? t("每月", "Monthly") : value === "annual" ? t("每年", "Yearly") : t("一次性", "One-time")
  return <SettingsSection wide title={t("订阅方案", "Plans")} description={t("参考方案包含 14 天免费试用示例。这里只能比较与预览，不会启动真实试用或订阅。", "The reference offering includes an example 14-day free trial. Compare and preview only; no real trial or subscription will start.")}>
    <SettingsNotice>{t("Lab 计费示例：当前订阅、用量、分级权益和下方历史周期套餐均为虚构演示。它们不代表正式账号状态，不触发网络请求，离开页面后交互重置。", "Lab billing examples: subscription, usage, tier benefits, and the separate legacy cycle offerings below are fictional demonstrations. They do not describe a real account or send network requests. Interactions reset when you leave.")}</SettingsNotice>
    <SubscriptionOverview preview />
    <ExampleTierComparison />
    <div className="space-y-2 border-t pt-5">
      <h3 className="text-sm font-semibold">{t("独立周期套餐 · 原有 Lab 流程", "Separate cycle offerings · Original Lab flow")}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{t("以下保留原有月付 / 年付 / 终身套餐及详情预览。它们是另一组历史展示数据，不是上方 Free / Team / Business 的计费周期或每成员价格，不可混合计算。", "The original Monthly / Annual / Lifetime offerings and detail preview remain below. These are a separate legacy demonstration, not billing cycles or per-member prices for Free / Team / Business above. Their amounts must not be combined.")}</p>
    </div>
    <PlanCards selected={period} onSelect={value => { setPeriod(value); setPreviewed(null) }} />
    <section aria-labelledby="example-plan-overview" className="space-y-3" aria-live="polite" aria-atomic="true">
      <h3 id="example-plan-overview" className="text-sm font-semibold">{t("概览", "Overview")}</h3>
      <p className="text-sm font-medium">{t(...periodLabels[period])}{t(" · 示例方案", " · Example offering")}</p>
      <p className="text-sm leading-6 text-muted-foreground">{t(...offering.description)}</p>
      {period === "annual" && <p className="text-sm leading-6 text-muted-foreground">{t(
        `12 次示例月费合计 ${usd(exampleAmounts.monthly * 12)}；示例年费 ${usd(exampleAmounts.annual)}，每年节省 ${usd(annualSavings)}（${annualDiscount}%）。月均约 ${usd(annualMonthlyEquivalent)}，并非按月收费。`,
        `Twelve example monthly payments total ${usd(exampleAmounts.monthly * 12)}. The example annual amount of ${usd(exampleAmounts.annual)} saves ${usd(annualSavings)} per year (${annualDiscount}%). The approximate ${usd(annualMonthlyEquivalent)} monthly equivalent is not a monthly charge.`,
      )}</p>}
    </section>
    <BenefitGroup title={t("功能", "Features")} items={offering.features} details={t(...offering.featureDetails)} />
    <BenefitGroup title={t("附加资源", "Additional Resources")} items={offering.resources} details={t(...offering.resourceDetails)} />
    <div className="space-y-3 border-t pt-5">
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogTrigger render={<Button className="bg-foreground text-background hover:bg-foreground/90" />}>{t("开始订阅", "Start Subscribe")}</DialogTrigger>
        <DialogContent>
          <DialogTitle>{t("查看示例订阅", "Review example subscription")}</DialogTitle>
          <DialogDescription>{t("请核对所选周期和示例金额。这不是结账流程，不会收款或创建真实订阅。", "Review the selected period and example amount. This is not checkout; no payment will be taken and no real subscription will be created.")}</DialogDescription>
          <dl className="my-5 space-y-3 rounded-lg border bg-surface p-4 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">{t("示例方案", "Example offering")}</dt><dd className="font-medium">{t(...periodLabels[period])}</dd></div>
            <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">{t("计费周期", "Billing period")}</dt><dd>{cadence(period)}</dd></div>
            <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">{t("示例金额", "Example amount")}</dt><dd className="font-medium tabular-nums">{usd(exampleAmounts[period])} USD</dd></div>
          </dl>
          <p className="text-sm leading-6 text-muted-foreground">{t("14 天免费试用仅为参考文案。确认只会显示本地预览反馈；不会开始试用、保存支付信息或改变账户权限。", "The 14-day free trial is reference copy only. Confirming displays local preview feedback; it does not start a trial, store payment information or change account access.")}</p>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose render={<Button variant="outline" />}>{t("取消", "Cancel")}</DialogClose>
            <Button className="bg-foreground text-background hover:bg-foreground/90" onClick={() => { setPreviewed(period); setReviewOpen(false) }}>{t("确认预览（不付款）", "Confirm preview (no payment)")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <p className="text-xs leading-5 text-muted-foreground">{t("仅预览所选示例方案，不会进入真实支付流程。", "Preview the selected example offering only. No real payment flow is opened.")}</p>
      <div role="status" aria-live="polite" aria-atomic="true">
        {previewed && <p className="rounded-lg border bg-surface-raised p-4 text-sm leading-6">{t(
          `预览已完成：${t(...periodLabels[previewed])}，${usd(exampleAmounts[previewed])} USD，${cadence(previewed)}。没有创建订阅、启动试用或发生付款。`,
          `Preview complete: ${t(...periodLabels[previewed])}, ${usd(exampleAmounts[previewed])} USD, ${cadence(previewed)}. No subscription was created, no trial was started and no payment was taken.`,
        )}</p>}
      </div>
    </div>
  </SettingsSection>
}

export function SettingsPlans({ mode }: SettingsPageProps) {
  return mode === "lab" ? <LabPlans /> : <ServicePlans />
}
