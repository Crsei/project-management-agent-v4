import { useId } from "react"
import { Link, useParams } from "react-router"
import { ArrowUpRight, ChevronDown } from "lucide-react"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"
import { UsageNavigationLink } from "../../../agent/src/usage/navigation"

type LocalizedText = readonly [string, string]

const cloudPlans: {
  name: string
  price: LocalizedText
  members: LocalizedText
  seats: LocalizedText
  storage: string
}[] = [
  {
    name: "Free",
    price: ["拟免费", "Planned free"],
    members: ["最多 5 名真人", "Up to 5 people"],
    seats: ["工作区成员上限规划为 5 人", "Planned workspace member cap: 5"],
    storage: "5 GB",
  },
  {
    name: "Team",
    price: ["价格待成本核算", "Price pending cost review"],
    members: ["最多 50 名真人", "Up to 50 people"],
    seats: ["按需购买席位，最多 50 人", "Buy seats as needed, up to 50 people"],
    storage: "100 GB",
  },
  {
    name: "Business",
    price: ["价格待成本核算", "Price pending cost review"],
    members: ["最多 200 名真人", "Up to 200 people"],
    seats: ["按需购买席位，最多 200 人", "Buy seats as needed, up to 200 people"],
    storage: "1 TB",
  },
]

const memberRules: LocalizedText[] = [
  ["按同一工作区内有效、未撤销且未禁用的真人账号去重；管理员也计入，同一人跨多个项目只计一次。", "Count distinct active human accounts with workspace access that is neither revoked nor disabled. Administrators count; the same person counts once across projects in that workspace."],
  ["邀请尚未接受不计费；接受邀请、加入或恢复访问时，应重新核对可用席位和套餐人数上限。", "Unaccepted invitations are not billable. Accepting an invitation, joining, or restoring access must recheck available seats and the plan’s member cap."],
  ["已用席位、已购席位、套餐人数上限是三个不同的数；按席位购买的方案中，已用不能超过已购，已购不能超过套餐上限。撤销访问释放可用席位，不等于自动减少已购席位或退款。", "Seats used, seats purchased, and the plan’s member cap are distinct. For seat-purchase plans, used seats cannot exceed purchased seats, and purchased seats cannot exceed the cap. Revoking access frees a seat; it does not automatically reduce purchased seats or issue a refund."],
  ["Agent 不占真人席位；不承诺免费访客。未来席位规则不改变当前成员角色、项目授权或邀请权限。", "Agents do not consume human seats. Free guests are not promised. Future seat rules do not change current member roles, project access, or invitation permissions."],
]

const storageRules: LocalizedText[] = [
  ["云附件空间拟由同一工作区所有项目共享，而非每成员各有一份；平台托管的附件及保留的历史版本计入。", "Cloud attachment space is planned as one pool shared by all projects in a workspace, not a separate allowance per member. Platform-hosted attachments and retained historical versions count."],
  ["同一存储对象被多处引用拟去重计量；不同保留版本仍计入。仅隐藏附件不释放字节，当前没有自动孤立文件垃圾回收（GC）。", "Multiple references to the same stored object are planned to count once; distinct retained versions still count. Hiding an attachment does not release its bytes. Automatic orphan-file garbage collection (GC) is not available today."],
  ["本地代码、外部 Markdown 目录与自带存储桶，不混入平台云附件额度；自托管使用自己的存储，不赠送平台云空间，也不套用未来云套餐上限。", "Local code, external Markdown directories, and your own storage buckets are not part of platform cloud attachment allowances. Self-hosting uses your own storage, includes no platform cloud space, and is not subject to the planned cloud-tier caps."],
  ["未来上传应先临时预占空间；失败或结果未知时，核对原上传后再释放预占，不能把未确认的字节当作已清理。", "Future uploads should reserve space temporarily. On failure or an unknown outcome, reconcile the original upload before releasing the reservation; unconfirmed bytes must not be treated as cleaned up."],
  ["未来拟在 80% 时提醒，满额时拒绝新增或增加占用的写入，不删除已有数据；降级也不自动删除文件，超额时需先处理容量再恢复增长。", "The proposal is to warn at 80% and reject writes that add or grow stored data at capacity, without deleting existing data. Downgrading must not automatically delete files; resolve excess usage before allowing growth again."],
  ["当前单文件上传上限为 8 MiB（8,388,608 字节），与规划的工作区总空间是独立限制；总空间更大不代表可以上传更大的单文件。", "The current per-file upload limit is 8 MiB (8,388,608 bytes), independent of the planned total workspace allowance. A larger total allowance does not permit larger individual uploads."],
]

const activationSteps: LocalizedText[] = [
  ["先建立并公布真实云服务、工作区订阅、价格、完整计量和服务端额度校验合同；当前尚未接入，不启用收费或限额。", "First establish and publish real cloud-service, workspace-subscription, pricing, complete-metering, and server-side quota contracts. These are not connected today; charging and plan limits are not enabled."],
  ["未来如开放购买，应先明确工作区、已购席位、价格、账期和变更规则，再由有权操作者确认；本页不发起购买、扣款或权益修改请求。", "If purchasing becomes available, the workspace, purchased seats, price, billing period, and change rules must be explicit before an authorized operator confirms. This page sends no purchase, charge, or entitlement-change requests."],
  ["支付页面返回、浏览器提示或本地选择不等于生效；只有核验后的真实服务端权益才算数。结果未知应核对原操作，不重复付款。", "A payment-page return, browser message, or local selection does not activate a plan. Only verified server-side entitlements do. Reconcile an unknown original outcome rather than paying again."],
]

const questions: { question: LocalizedText; answer: LocalizedText }[] = [
  {
    question: ["没有订阅数据，是否表示我在 Free 或自托管模式？", "Does missing subscription data mean I am on Free or self-hosting?"],
    answer: ["不是。当前缺少订阅与完整计量合同，无法据此判断当前套餐、部署模式、已购席位或剩余额度。未知不能显示为 0、免费或无限，也不能用当前可见成员列表代替全工作区计费人数。", "No. Without subscription and complete-metering contracts, the current plan, hosting mode, purchased seats, and remaining allowance cannot be inferred. Unknown is not zero, free, or unlimited, and the visible member directory is not a workspace-wide billable count."],
  },
  {
    question: ["自托管是否意味着无限空间？", "Does self-hosting mean unlimited storage?"],
    answer: ["不是。自托管不赠送平台云空间，不受未来云套餐上限约束，也不是无限容量承诺。实际可用容量、备份与运维由自己的磁盘或存储服务决定，当前单文件 8 MiB 等已有技术限制仍然适用。", "No. Self-hosting includes no platform cloud space and is not governed by the future cloud-tier caps, but it is not an unlimited-capacity promise. Your disks or storage service determine capacity, backup, and operations; existing technical limits such as 8 MiB per file still apply."],
  },
  {
    question: ["项目和任务会按数量收费吗？", "Will projects and tasks be billed by count?"],
    answer: ["未来云套餐拟不按项目、任务数量收费；这是规划，不是无限性能、无限并发或无限容量承诺。当前能力仍受本机资源与既有技术边界约束。", "The cloud proposal does not bill by project or task count. This is a plan, not a promise of unlimited performance, concurrency, or capacity. Current capabilities remain subject to local resources and existing technical boundaries."],
  },
  {
    question: ["套餐是否包含 AI 额度？", "Do the plans include AI credits?"],
    answer: ["不包含。供应商订阅和 API 费用与工作区云套餐分别核对；本页不承诺供应商的可用额度，也不会用套餐空间或真人席位换算 AI 额度。", "No. Supplier subscriptions and API costs are separate from workspace cloud plans. This page promises no supplier allowance and does not convert storage space or human seats into AI credits."],
  },
  {
    question: ["Business 是否承诺 SAML / SSO、SLA 或生产多租户？", "Does Business promise SAML / SSO, an SLA, or production multitenancy?"],
    answer: ["不承诺。三档都只是云套餐规划，不建立新权限体系，也不改变当前安全边界；套餐名称不能代替 SSO 实现、服务等级协议或生产多租户隔离的独立验收。", "No. All three are cloud-plan proposals, not a new permission system or a change to current security boundaries. A tier name cannot substitute for separately implemented and verified SSO, a service-level agreement, or production multitenant isolation."],
  },
]

const navigationClass = "flex min-w-0 items-start justify-between gap-3 rounded-module border bg-surface p-4 text-sm font-medium hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
const ruleLinkClass = "rounded-control text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function SettingsPlans({ mode }: SettingsPageProps) {
  const t = useText()
  const id = useId()
  const { workspaceSlug = "" } = useParams()
  const root = `/pm/${encodeURIComponent(workspaceSlug)}`
  return <SettingsSection title={t("套餐与用量", "Plans & usage")} description={t("了解当前服务边界、尚未接入的用量数据，以及未来按工作区订阅的云套餐规划。", "Understand today’s service boundaries, unavailable usage data, and future workspace-based cloud-plan proposals.")}>
    {mode === "lab" && <SettingsNotice><p className="font-medium text-foreground">{t("Lab · 套餐与用量说明预览", "Lab · Plans & usage information preview")}</p><p>{t("与正式页使用同一份说明；不读取真实订阅或用量，不生成样例计费数据，也不模拟购买或权益生效。", "This uses the same guidance as the service page. It reads no real subscriptions or usage, invents no sample billing data, and simulates neither purchases nor entitlement activation.")}</p></SettingsNotice>}
    <section aria-labelledby={`${id}-current`} className="min-w-0 space-y-4 rounded-module border bg-surface p-4 sm:p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-current`} className="font-semibold">{t("当前状态", "Current status")}</h3>
        <span className="rounded-pill border bg-surface-raised px-2 py-1 text-xs">{t("订阅与全量计量未接入", "Subscriptions & complete metering not connected")}</span>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{t("现在交付的是说明页，不是订阅服务。当前套餐、已购席位及云附件已用空间均未知；不启用下方规划的收费或限额，也不从缺失数据推断 Free、自托管或无限用量。", "This is an information page, not a subscription service. The current plan, purchased seats, and cloud attachment usage are unknown. The planned charges and caps below are not enabled, and missing data is not interpreted as Free, self-hosted, or unlimited usage.")}</p>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-3">
        {[
          [t("工作区套餐", "Workspace plan"), t("未知 · 订阅服务未接入", "Unknown · Subscription service not connected")],
          [t("真人席位用量", "Human seat usage"), t("未知 · 无完整计费用量", "Unknown · No complete billing usage")],
          [t("云附件已用空间", "Cloud attachment space used"), t("未知 · 无完整存储计量", "Unknown · No complete storage metering")],
        ].map(([label, value]) => <div key={label} className="min-w-0 space-y-2 rounded-control bg-surface-raised p-3"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="text-sm leading-6">{value}</dd></div>)}
      </dl>
      <p className="text-xs leading-5 text-muted-foreground">{t("不读取受限成员统计，也不把可见项目或成员数当作全量计费数据；未提供的计量不画成 0% 进度条。", "Restricted member statistics are not read, visible project or member counts are not substituted for complete billing data, and missing measurements are not shown as 0% progress.")}</p>
    </section>

    <nav aria-label={t("现有管理入口与说明", "Existing settings and guidance")} className="min-w-0 space-y-3">
      {mode === "service" ? <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Link to={`${root}/members?tab=members`} className={navigationClass}><span>{t("成员与团队", "Members & teams")}</span><ArrowUpRight aria-hidden="true" className="size-4 shrink-0" /></Link>
        <Link to={`${root}/settings?section=local-storage`} className={navigationClass}><span>{t("本地项目存储设置", "Local project storage settings")}</span><ArrowUpRight aria-hidden="true" className="size-4 shrink-0" /></Link>
        <Link to="/agent/settings/providers" className={navigationClass}><span>{t("自带 AI Provider", "Your AI Providers")}</span><ArrowUpRight aria-hidden="true" className="size-4 shrink-0" /></Link>
      </div> : <p className="text-sm leading-6 text-muted-foreground">{t("Lab 不管理真实成员或存储。", "Lab does not manage real members or storage.")} <Link to="/pm" className={ruleLinkClass}>{t("打开真实工作区", "Open a real workspace")}</Link></p>}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm"><a href={`#${id}-rules`} className={ruleLinkClass}>{t("查看计量规则", "Read metering rules")}</a><a href={`#${id}-activation`} className={ruleLinkClass}>{t("如何生效", "How activation would work")}</a><a href={`#${id}-faq`} className={ruleLinkClass}>{t("常见问题", "FAQ")}</a></div>
      {mode === "service" && <p className="text-xs leading-5 text-muted-foreground">{t("以上入口沿用现有授权；本地存储设置不是云空间购买或完整用量统计。", "These destinations retain existing authorization. Local storage settings are neither a cloud-space purchase flow nor complete usage statistics.")}</p>}
    </nav>
    <section className="min-w-0 space-y-3 rounded-module border bg-surface p-4 sm:p-5">
      <h3 className="font-semibold">{t("Agent 用量 · 与订阅账单分开", "Agent usage · Separate from subscription billing")}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{t("现有 Agent Usage 可查看本机已记录的模型调用、Token 与来源覆盖；它不是供应商实时余额、工作区订阅、真人席位或云附件计量。记录缺失、价格缺失或覆盖不完整时仍为未知，不记成零，也不推断完整费用。", "Existing Agent Usage shows locally recorded model calls, tokens, and source coverage. It is not a live supplier balance or workspace subscription, human-seat, or cloud-attachment meter. Missing records, prices, or incomplete coverage remain unknown, not zero or a complete cost total.")}</p>
      {mode === "service" ? <UsageNavigationLink className={navigationClass}><span>{t("打开 Agent Usage", "Open Agent Usage")}</span><ArrowUpRight aria-hidden="true" className="size-4 shrink-0" /></UsageNavigationLink> : <p className="text-xs leading-5 text-muted-foreground">{t("Lab 不读取 Agent 用量；真实入口使用独立 Agent 访问验证。", "Lab does not read Agent usage. The live destination uses separate Agent access verification.")}</p>}
      <p className="text-xs leading-5 text-muted-foreground">{t("导航不调用付费模型、不查询供应商余额，也不改变订阅或执行权限。Agent 数据仍属于可信本机单操作者范围，不按 PM 成员隔离。", "Navigation does not call paid models, query supplier balances, or change subscriptions or execution permissions. Agent data remains scoped to one trusted local operator, not isolated per PM member.")}</p>
    </section>

    <section aria-labelledby={`${id}-cloud`} className="min-w-0 space-y-4">
      <div className="space-y-2"><h3 id={`${id}-cloud`} className="font-semibold">{t("未来云套餐规划", "Future cloud-plan proposals")}</h3><p className="text-sm leading-6 text-muted-foreground">{t("全部规划中、未生效、不可购买。订阅单位是工作区；空间为同一工作区共享，不是每人额度。以下上限不适用于当前自托管安装。", "All tiers are planned, inactive, and unavailable for purchase. Subscriptions are per workspace; storage is shared within that workspace, not allocated per person. These caps do not apply to current self-hosted installations.")}</p></div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-3">
        {cloudPlans.map(plan => <article key={plan.name} className="min-w-0 space-y-5 rounded-module border bg-surface p-4 sm:p-5">
          <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-lg font-semibold">{plan.name}</h4><span className="rounded-pill border bg-surface-raised px-2 py-0.5 text-xs">{t("规划中 · 未生效", "Planned · Inactive")}</span></div><p className="text-sm font-medium">{t(...plan.price)}</p></div>
          <dl className="space-y-4 text-sm">
            <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t("真人成员上限", "Human member cap")}</dt><dd className="font-medium">{t(...plan.members)}</dd><dd className="leading-6 text-muted-foreground">{t(...plan.seats)}</dd></div>
            <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t("云附件空间", "Cloud attachment space")}</dt><dd className="text-xl font-semibold tabular-nums">{plan.storage}</dd><dd className="leading-6 text-muted-foreground">{t("每工作区共享 · 含保留版本", "Shared per workspace · Includes retained versions")}</dd></div>
          </dl>
          <p className="border-t pt-3 text-xs leading-5 text-muted-foreground">{t("仅为规划说明，不授予权益或改变现有权限。", "A proposal only; no entitlements are granted or current permissions changed.")}</p>
        </article>)}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("容量使用十进制：1 GB = 1,000,000,000 字节，1 TB = 1,000,000,000,000 字节。Team / Business 的价格与正式条款须经成本核算后另行公布；没有已发布的月付、年付或终身报价。", "Capacity is decimal: 1 GB = 1,000,000,000 bytes; 1 TB = 1,000,000,000,000 bytes. Team / Business prices and final terms require cost review and separate publication. No monthly, annual, or lifetime offers are published.")}</p>
    </section>

    <section id={`${id}-rules`} aria-labelledby={`${id}-rules-title`} className="min-w-0 scroll-mt-5 space-y-4 border-t pt-6">
      <h3 id={`${id}-rules-title`} className="font-semibold">{t("计量规则 · 未来建议，尚未启用", "Metering rules · Proposed, not enabled")}</h3>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {[
          { title: t("真人成员与席位", "Human members & seats"), rules: memberRules },
          { title: t("云附件空间与版本", "Cloud attachment space & versions"), rules: storageRules },
        ].map(group => <section key={group.title} className="min-w-0 space-y-3 rounded-module border bg-surface p-4 sm:p-5"><h4 className="text-sm font-semibold">{group.title}</h4><ul className="list-disc space-y-3 pl-4 text-sm leading-6 text-muted-foreground">{group.rules.map(rule => <li key={rule[1]}>{t(...rule)}</li>)}</ul></section>)}
      </div>
    </section>

    <section id={`${id}-activation`} aria-labelledby={`${id}-activation-title`} className="min-w-0 scroll-mt-5 space-y-3 border-t pt-6">
      <h3 id={`${id}-activation-title`} className="font-semibold">{t("未来如何生效", "How future activation would work")}</h3>
      <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">{activationSteps.map(step => <li key={step[1]}>{t(...step)}</li>)}</ol>
    </section>

    <SettingsNotice>
      <h3 className="font-semibold text-foreground">{t("当前 AI 与安全边界", "Current AI & security boundaries")}</h3>
      <p className="mt-2">{t("AI 使用自带 Provider，由供应商按你的账号与合同计费；不赠送或虚构 AI 额度。配置 Provider 不代表模型访问、余额或真实调用已验收。", "AI uses your own Provider, billed by that supplier under your account and contract. No AI credits are granted or invented. Configuring a Provider does not prove model access, available balance, or successful real calls.")}</p>
      <p className="mt-2">{t("Agent 仅面向可信本机单操作者；PM 成员授权不等于 Agent 会话所有权隔离。文件区域和 cwd 不是文件系统沙箱，Terminal 使用服务进程的本机权限，不要直接开放到公网。会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。", "Agent is for one trusted local operator. PM membership is not Agent session-ownership isolation. File areas and cwd are not filesystem sandboxes, and Terminal uses the service process’s local permissions; do not expose it directly to the public internet. Sessions and persistence still follow Agent Chat; the unified design is not finalized.")}</p>
    </SettingsNotice>

    <section id={`${id}-faq`} aria-labelledby={`${id}-faq-title`} className="min-w-0 scroll-mt-5 space-y-3 border-t pt-6">
      <h3 id={`${id}-faq-title`} className="font-semibold">{t("常见问题", "Frequently asked questions")}</h3>
      <div className="min-w-0 divide-y rounded-module border bg-surface px-4 sm:px-5">{questions.map(item => <details key={item.question[1]} className="group min-w-0 py-4">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-control text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><span className="min-w-0">{t(...item.question)}</span><ChevronDown aria-hidden="true" className="mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" /></summary>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{t(...item.answer)}</p>
      </details>)}</div>
    </section>
  </SettingsSection>
}
