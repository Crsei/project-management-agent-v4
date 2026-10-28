export type Localized = { "zh-CN": string; en: string }
export type DocumentSection = { title: Localized; paragraphs: Localized[]; keywords: string[] }
export type LibraryDocument = {
  id: string
  title: Localized
  source: Localized
  author: Localized
  month: Localized
  pages: number
  page: number
  minutes: number
  starred: boolean
  description: Localized
  tags: Localized[]
  passage: Localized
  keywords: string[]
  explanation: Localized
  sections: DocumentSection[]
  suggestions: Localized[]
  related: string[]
}

export const libraryDocuments: LibraryDocument[] = [
  {
    id: "refund-policy", title: { "zh-CN": "退款政策", en: "Refund policy" },
    source: { "zh-CN": "支持手册", en: "Support playbook" }, author: { "zh-CN": "M. Okafor · 支持", en: "M. Okafor · Support" }, month: { "zh-CN": "2026 年 6 月", en: "June 2026" },
    pages: 12, page: 9, minutes: 2, starred: true,
    description: { "zh-CN": "当资金退还给客户时，速度与清晰度比流程更重要。本政策规定退款期限、审批人以及应使用的准确措辞。", en: "When money moves back to a customer, speed and clarity matter more than process. This policy sets the window, the approvers, and the exact words to use." },
    tags: [{ "zh-CN": "退款", en: "Refunds" }, { "zh-CN": "支持", en: "Support" }, { "zh-CN": "政策", en: "Policy" }],
    passage: { "zh-CN": "购买后 30 天内、不超过 500 美元的退款自动批准。超出期限或金额的退款需要负责人在工单中签字，并向客户引用说明原因。", en: "Refunds within 30 days of purchase are approved automatically up to $500. Anything older or larger needs a lead's sign-off in the ticket, with the reason quoted back to the customer." },
    keywords: ["refund window", "30", "500", "退款期限", "退款窗口", "解释", "explain"],
    explanation: { "zh-CN": "这段政策设置两个门槛：30 天和 500 美元。同时满足才自动批准；超出任一门槛，由负责人在工单中明确批准。", en: "The policy sets two limits: 30 days and $500. Both must be met for automatic approval; crossing either limit requires a lead's approval in the ticket." },
    sections: [
      { title: { "zh-CN": "1. 30 天期限", en: "1. The 30-day window" }, keywords: ["preorder", "backorder", "gift", "purchase", "delivery", "预购", "预订", "礼品", "日期"], paragraphs: [
        { "zh-CN": "期限从购买时开始，而非交付时。数字商品与实物配送使用同一个起点，这样客服不必在实时工单中计算两套时间线。", en: "The window opens at purchase, not delivery. Digital goods and physical shipments follow the same clock so agents never have to compute two timelines on a live ticket." },
        { "zh-CN": "预购、缺货订单、礼品购买等特殊情况，以收据上的扣款日期为准。收据有歧义时，采用较新的日期。", en: "Edge cases — preorders, backorders, gift purchases — anchor to the charge date on the receipt. When the receipt is ambiguous, the newer date wins." },
      ] },
      { title: { "zh-CN": "2. 审批", en: "2. Approvals" }, keywords: ["repeat", "90", "lead", "approval", "重复", "审批", "负责人"], paragraphs: [
        { "zh-CN": "负责人在工单讨论中批准，不能使用旁路渠道。审批必须引用原因，以便未来审计无需追踪聊天记录即可还原决策。", en: "Leads approve in the ticket thread, never in a side channel. The approval must quote the reason so a future audit can reconstruct the decision without chasing chat logs." },
        { "zh-CN": "同一客户 90 天内重复退款，无论金额多少都提交给负责人。", en: "Repeat refunds to the same customer within 90 days route to a lead regardless of amount." },
      ] },
    ],
    suggestions: [{ "zh-CN": "退款期限？", en: "Refund window?" }, { "zh-CN": "重复退款？", en: "Repeat refunds?" }, { "zh-CN": "预购订单？", en: "Preorders?" }], related: ["pricing-memo", "checkout-outage"],
  },
  {
    id: "onboarding-runbook", title: { "zh-CN": "入职操作手册", en: "Onboarding runbook" }, source: { "zh-CN": "人事运营", en: "People ops" }, author: { "zh-CN": "D. Kim · 人事", en: "D. Kim · People" }, month: { "zh-CN": "2026 年 5 月", en: "May 2026" }, pages: 18, page: 7, minutes: 8, starred: false,
    description: { "zh-CN": "第一周决定新员工多快能成为贡献者。本手册为每项首日任务指定负责人，不让任何工作依赖口口相传的知识。", en: "The first week decides how fast a hire becomes a contributor. This runbook assigns every day-one task an owner so nothing waits on hallway knowledge." },
    tags: [{ "zh-CN": "入职", en: "Onboarding" }, { "zh-CN": "操作手册", en: "Runbook" }, { "zh-CN": "运营", en: "Ops" }],
    passage: { "zh-CN": "每位新员工在第三天前与伙伴结对，将一项成果发布到生产环境。权限、电脑和介绍是前提，不是目标。", en: "Every new hire ships something to production by day three, paired with their buddy. Access, laptop, and introductions are preconditions, never the goal." },
    keywords: ["day-three", "ship", "production", "第三天", "发布", "explain", "解释"], explanation: { "zh-CN": "入职以真实贡献为目标。伙伴负责帮助新人完成一个小而明确的生产发布，而不是只完成账号设置。", en: "Onboarding is measured by a real contribution. The buddy helps the hire ship a small, scoped change, not merely finish account setup." },
    sections: [
      { title: { "zh-CN": "1. 第一天之前", en: "1. Before day one" }, keywords: ["first ticket", "checklist", "laptop", "before", "第一项", "工单", "电脑"], paragraphs: [
        { "zh-CN": "提前一周指定伙伴，由伙伴负责清单：配置电脑、开通账号，并挑选范围足够小的第一个工单。", en: "The buddy is assigned a week early and owns the checklist: laptop imaged, accounts provisioned, first ticket picked and scoped small." },
        { "zh-CN": "用人经理在录用接受的那一周写下第三天的发布目标，此时岗位职责仍然明确。", en: "The hiring manager writes the day-three ship goal in the offer-acceptance week, while the role is still concrete." },
      ] },
      { title: { "zh-CN": "2. 伙伴约定", en: "2. The buddy contract" }, keywords: ["buddy", "pair", "leave", "伙伴", "结对", "休假"], paragraphs: [
        { "zh-CN": "前两周，伙伴每天至少结对两小时。结对是日历上的固定时间，不是空闲时间，发生会议冲突时也要保留。", en: "Buddies pair at least two hours a day for the first two weeks. Pairing time is calendar time, not spare time — it survives meeting conflicts." },
        { "zh-CN": "伙伴休假时，必须在手册讨论中明确转移责任，不存在默认的替补。", en: "If the buddy goes on leave, ownership transfers explicitly in the runbook thread. There is no implicit backup." },
      ] },
    ], suggestions: [{ "zh-CN": "第三天发布？", en: "Day-three ship?" }, { "zh-CN": "伙伴职责？", en: "Buddy duties?" }, { "zh-CN": "第一个工单？", en: "First ticket?" }], related: ["security-checklist", "expense-guidelines"],
  },
  {
    id: "security-checklist", title: { "zh-CN": "安全审查清单", en: "Security review checklist" }, source: { "zh-CN": "工程", en: "Engineering" }, author: { "zh-CN": "S. Rao · 工程", en: "S. Rao · Engineering" }, month: { "zh-CN": "2026 年 7 月", en: "July 2026" }, pages: 9, page: 9, minutes: 0, starred: false,
    description: {"zh-CN":"每次上线都要通过这份清单。它刻意保持简短：从不失败的项目被移除，让真正重要的项目得到关注。","en":"Every launch passes this checklist. It is deliberately short: items that never fail were removed so the ones that matter get attention."},
    tags: [{ "zh-CN": "安全", en: "Security" }, { "zh-CN": "审查", en: "Review" }, { "zh-CN": "工程", en: "Engineering" }],
    passage: {"zh-CN":"密钥存放在保险库中，绝不能出现在代码、配置或聊天里。发布分支的密钥扫描通过之前，上线被阻止。","en":"Secrets live in the vault, never in code, config, or chat. A launch is blocked until the secret scan passes on the release branch."},
    keywords: ["secret","scan","vault","密钥","扫描","保险库","解释","explain"], explanation: {"zh-CN":"密钥只由保险库管理。发布分支必须通过扫描；例外需要安全负责人签署有日期的豁免并关联整改工单。","en":"Secrets belong only in the vault. The release branch must pass its scan; exceptions require a dated security-owner waiver and a linked remediation ticket."},
    sections: [
      {"title":{"zh-CN":"1. 密钥与权限","en":"1. Secrets and access"},"keywords":["third","access","account","第三方","权限","账号"],"paragraphs":[{"zh-CN":"服务账号只获得完成工作所需的最小权限，每季度审查。人员权限默认到期，按申请续期。","en":"Service accounts get the narrowest scope that works, reviewed quarterly. Human access expires by default and is renewed on request."},{"zh-CN":"第三方集成必须登记，并列出数据访问权限。未登记的集成视为安全发现。","en":"Third-party integrations are inventoried with their data access listed. Anything unlisted is treated as a finding."}]},
      {"title":{"zh-CN":"2. 发布门禁","en":"2. Release gates"},"keywords":["exception","waiver","release","例外","豁免","发布"],"paragraphs":[{"zh-CN":"密钥扫描、依赖审计和迁移演练必须在实际发布的准确提交上全部通过——不能用主分支或昨天的结果。","en":"The secret scan, dependency audit, and migration dry-run must all pass on the exact commit being released — not on main, not yesterday."},{"zh-CN":"例外需要安全负责人签署有日期的豁免，并关联整改工单。","en":"Exceptions need a dated waiver from the security owner with a remediation ticket linked."}]},
    ], suggestions: [{"zh-CN":"密钥规则？","en":"Secrets rule?"},{"zh-CN":"例外情况？","en":"Exceptions?"},{"zh-CN":"第三方集成？","en":"Third parties?"}], related: ["onboarding-runbook","checkout-outage"],
  },
  {
    id: "pricing-memo", title: { "zh-CN": "定价备忘录", en: "Pricing memo" }, source: { "zh-CN": "财务", en: "Finance" }, author: { "zh-CN": "L. Chen · 财务", en: "L. Chen · Finance" }, month: { "zh-CN": "2026 年 4 月", en: "April 2026" }, pages: 15, page: 1, minutes: 0, starred: false,
    description: {"zh-CN":"我们如何收费、每个档位为什么存在，以及各角色拥有什么折扣权限。这份备忘录旨在结束销售讨论中的定价争议。","en":"How we charge, why each tier exists, and what discount authority each role holds. Written to end pricing debates in sales threads."},
    tags: [{"zh-CN":"定价","en":"Pricing"},{"zh-CN":"市场运营","en":"GTM"},{"zh-CN":"财务","en":"Finance"}], passage: {"zh-CN":"超过 15% 的折扣需要财务签字。销售让出的任何条件都记录在报价备注中，因为下次续约谈判依据的是这笔交易，而非标价。","en":"Discounts above 15% need finance sign-off. Anything a rep concedes lives in the quote notes, because the next renewal negotiates against this deal, not the list price."},
    keywords: ["discount limits","quote notes","15","折扣限额","报价备注","解释","explain"], explanation: {"zh-CN":"高于 15% 的折扣须经财务批准。报价备注保留让利条件，确保续约时能追溯实际交易基础。","en":"Discounts above 15% require Finance approval. Quote notes preserve the concessions so the next renewal can refer to the actual deal."},
    sections: [
      {"title":{"zh-CN":"1. 档位与锚点","en":"1. Tiers and anchors"},"keywords":["monthly","annual","tier","月付","年付","档位"],"paragraphs":[{"zh-CN":"三个档位，不定制中间档。中档是锚点，应该赢得大多数交易；如果没有，问题在档位而不是销售。","en":"Three tiers, no custom middle. The middle tier is the anchor and should win most deals; if it does not, the tiers are wrong, not the reps."},{"zh-CN":"默认按年付费报价。月付按标价提供，它的存在是为了在比较中优雅地落败。","en":"Annual billing is the default quote. Monthly is available at list and exists to lose comparisons gracefully."}]},
      {"title":{"zh-CN":"2. 折扣权限","en":"2. Discount authority"},"keywords":["manager","authority","trade","经理","权限","交换"],"paragraphs":[{"zh-CN":"销售有 15% 的权限，经理有 25%，更高折扣由财务决定。多年预付经财务批准，可叠加一档优惠。","en":"Reps hold 15%, managers 25%, finance beyond that. Multi-year prepay can stack one extra band with finance approval."},{"zh-CN":"折扣要换取某些条件：合同期限、标识使用权或案例研究。不换取任何条件的折扣，只是披着折扣外衣的降价。","en":"Discounts trade for something: term length, logo rights, or a case study. A discount for nothing is a price cut wearing a costume."}]},
    ], suggestions: [{"zh-CN":"折扣限额？","en":"Discount limits?"},{"zh-CN":"为何记录报价备注？","en":"Why quote notes?"},{"zh-CN":"按月付费？","en":"Monthly billing?"}], related: ["refund-policy","expense-guidelines"],
  },
  {
    id: "checkout-outage", title: { "zh-CN": "结账故障复盘", en: "Checkout outage postmortem" }, source: { "zh-CN": "工程", en: "Engineering" }, author: { "zh-CN": "S. Rao · 工程", en: "S. Rao · Engineering" }, month: { "zh-CN": "2026 年 8 月", en: "August 2026" }, pages: 11, page: 7, minutes: 4, starred: true,
    description: {"zh-CN":"8 月 14 日，结账失败持续了 41 分钟。这里记录故障原因、时间线以及防止再次发生的三项修复。","en":"Forty-one minutes of failed checkouts on August 14. What broke, what the timeline was, and the three fixes that prevent recurrence."},
    tags: [{"zh-CN":"事故","en":"Incident"},{"zh-CN":"复盘","en":"Postmortem"},{"zh-CN":"结账","en":"Checkout"}], passage: {"zh-CN":"导致故障的是重试风暴，而不是部署。带上限和抖动的退避机制本可将故障限制在一个区域，而非级联扩散到全球。","en":"The retry storm, not the deploy, caused the outage. A capped backoff with jitter would have held the failure to one region instead of cascading it globally."},
    keywords: ["root","retry","storm","根因","重试","风暴","解释","explain"], explanation: {"zh-CN":"重试风暴使共享队列饱和并扩散故障。带上限和抖动的指数退避，以及独立的区域熔断和错误预算，可以限制影响。","en":"The retry storm saturated the shared queue and spread the failure. Capped backoff with jitter, regional circuit breakers, and independent error budgets contain the impact."},
    sections: [
      {"title":{"zh-CN":"1. 时间线","en":"1. Timeline"},"keywords":["detect","timeline","14:","发现","时间线"],"paragraphs":[{"zh-CN":"14:02——部署到达第一个区域。四分钟内错误预算开始消耗，但告警阈值假定只有单区域故障。","en":"14:02 — deploy reaches the first region. Error budgets start burning within four minutes, but the alert threshold assumes a single-region fault."},{"zh-CN":"14:19——受影响区域的重试使共享队列饱和，故障扩散到全球。14:43——流量卸载，回滚完成。","en":"14:19 — retries from the affected region saturate the shared queue and the failure goes global. 14:43 — traffic shed, rollback complete."}]},
      {"title":{"zh-CN":"2. 修复","en":"2. Fixes"},"keywords":["fix","backoff","breaker","修复","退避","熔断"],"paragraphs":[{"zh-CN":"所有结账重试都采用带上限和抖动的指数退避，由共享客户端库强制执行，防止服务意外退出。","en":"Capped exponential backoff with jitter on all checkout retries, enforced by the shared client library so services cannot opt out by accident."},{"zh-CN":"各区域采用独立错误预算的熔断器，告警阈值按受影响区域数量而不仅仅是错误率计数。","en":"Per-region circuit breakers with independent error budgets, plus an alert threshold that counts regions, not just error rate."}]},
    ], suggestions: [{"zh-CN":"根本原因？","en":"Root cause?"},{"zh-CN":"修复措施？","en":"The fixes?"},{"zh-CN":"发现缺口？","en":"Detection gap?"}], related: ["security-checklist","refund-policy"],
  },
  {
    id: "expense-guidelines", title: { "zh-CN": "费用报销指南", en: "Expense guidelines" }, source: { "zh-CN": "财务", en: "Finance" }, author: { "zh-CN": "L. Chen · 财务", en: "L. Chen · Finance" }, month: { "zh-CN": "2026 年 3 月", en: "March 2026" }, pages: 7, page: 7, minutes: 0, starred: false,
    description: {"zh-CN":"花钱时像是自己的钱，记录时记得是公司的钱。两页规则，五页示例。","en":"Spend like it is your money, document like it is the company's. Two pages of rules and five of examples."},
    tags: [{"zh-CN":"费用","en":"Expenses"},{"zh-CN":"财务","en":"Finance"},{"zh-CN":"政策","en":"Policy"}], passage: {"zh-CN":"超过 25 美元需要收据。低于此金额，一句话说明即可——财务团队宁愿读一句话，也不愿追着索要一张咖啡收据。","en":"Receipts are required above $25. Below that, a one-line description suffices — the finance team would rather read a sentence than chase a coffee receipt."},
    keywords: ["receipt rule","25","收据规则","解释","explain"], explanation: {"zh-CN":"收据门槛是 25 美元，超过 500 美元须事先批准。说明应明确，团队活动另需人数与人均成本。","en":"The receipt threshold is $25, and spending above $500 needs pre-approval. Descriptions must be clear; team events also record headcount and per-person cost."},
    sections: [
      {"title":{"zh-CN":"1. 金额门槛","en":"1. Thresholds"},"keywords":["pre-approval","500","report","事先","审批","报告"],"paragraphs":[{"zh-CN":"差旅、客户餐饮和设备都遵循相同的 25 美元收据规则。超过 500 美元的费用须在申请讨论中事先批准。","en":"Travel, client meals, and equipment follow the same $25 receipt rule. Anything above $500 needs pre-approval in the request thread."},{"zh-CN":"报销在月末后 30 天截止。逾期报告提交之前，暂停新的事前审批。","en":"Reports close 30 days after month end. Late reports pause new pre-approvals until filed."}]},
      {"title":{"zh-CN":"2. 判断原则","en":"2. Judgment calls"},"keywords":["team","headcount","judgment","团队","人数","判断"],"paragraphs":[{"zh-CN":"不确定时，写下你在审计时希望读到的那句话。含糊的说明会被退回，诚实的说明会通过。","en":"When in doubt, write the sentence you would want to read in an audit. Vague descriptions get the report bounced; honest ones pass."},{"zh-CN":"团队活动必须在备注中记录人数与人均成本。没有例外——这是最常见的退回原因。","en":"Team events need a headcount and a per-person cost in the notes. No exceptions — this is the most common bounce reason."}]},
    ], suggestions: [{"zh-CN":"收据规则？","en":"Receipt rule?"},{"zh-CN":"事前审批？","en":"Pre-approval?"},{"zh-CN":"团队活动？","en":"Team events?"}], related: ["onboarding-runbook","pricing-memo"],
  },
]
