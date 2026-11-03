export interface Capability {
  index: string;
  title: string;
  summary: string;
  points: string[];
  evidence: string;
}

/**
 * Only capabilities backed by the v4 repository are listed here.
 * Keep the evidence string tied to a real route, package, or README section.
 */
export const capabilities: Capability[] = [
  {
    index: "01",
    title: "PM 原生项目与任务",
    summary:
      "工作区、项目、任务、里程碑、依赖、评论、审核、审计、成员与通知共用同一套 PM 外壳。",
    points: [
      "项目、任务、里程碑与依赖",
      "评论、审核、审计与命令收据",
      "成员、团队、邀请与通知",
      "Dashboard、个人白板与项目动态",
    ],
    evidence: "apps/web/src/routes.tsx；README「当前状态」",
  },
  {
    index: "02",
    title: "统一 Agent Chat",
    summary:
      "PM 详情侧栏与 /agent/workspace 共用 Session、Composer、Provider 和运行时，不再运行第二个 PM 模型助手。",
    points: [
      "Session 侧栏、搜索与作用域筛选",
      "Files / Git / Terminal / Browser 右侧面板",
      "项目与任务上下文随会话保留",
      "窄屏抽屉与键盘快捷键",
    ],
    evidence: "README「Agent Chat」",
  },
  {
    index: "03",
    title: "自带 Provider",
    summary:
      "按 t3code 原生驱动规则接入 Provider；凭据留在服务端，会话按线程选择实例与模型。",
    points: [
      "Codex、Claude、Cursor、Grok、FX、OpenCode、Antigravity、Muse Code、Pi、OMP、ACP Registry",
      "复用现有 CLI 配置或受管账号",
      "原生模型目录与显式登记的自定义模型",
      "按线程保存选择，不改写历史会话",
    ],
    evidence: "README「配置并使用 Provider」",
  },
  {
    index: "04",
    title: "可恢复的执行记录",
    summary:
      "服务端持久化已接受的执行、事件和结果；刷新或关闭标签页只停止订阅，不取消已接受的工作。",
    points: [
      "SQLite 保存执行、事件与结果",
      "重连后读取已保存状态",
      "服务重启把未完成执行标记为 interrupted",
      "继续执行是新 Run，不静默重放",
    ],
    evidence: "README「当前状态」；Agent durable 运行时",
  },
  {
    index: "05",
    title: "分支与上下文回传",
    summary:
      "从已记录的边界 fork 会话，预览并确认把上下文传回父线程；对话分支不是 Git 分支。",
    points: [
      "保留父线程与原始 Run",
      "原生 Provider 支持时使用原生 fork",
      "回传是显式确认的上下文转移",
      "分支默认共享工作目录，不自动创建 worktree",
    ],
    evidence: "README「Agent Chat」；安全与边界说明",
  },
  {
    index: "06",
    title: "自动化与触发",
    summary:
      "用定时、额度恢复或 PR 监听触发同一套持久执行队列；派发成功不等于完成。",
    points: [
      "Schedule 使用服务器时区",
      "额度恢复需要显式授权与有效重置时间",
      "PR Watch 建立基线、去重并排队",
      "服务器停止时不会继续执行",
    ],
    evidence: "README「自动化」；自动化 Studio / OMP",
  },
  {
    index: "07",
    title: "任务工作流与代码交付",
    summary:
      "任务详情提供节点画布、草稿/发布版本和受限连线；代码交付走独立分支、显式提交和 Draft PR。",
    points: [
      "三套预制工作流模板",
      "项目级草稿 / 发布版本与受限节点连线",
      "一次明确授权后的后台交付",
      "开发前进入进行中，CI 后确认待审核，不自动完成",
      "Draft PR、手动刷新 CI 与评审",
    ],
    evidence: "README「任务工作流」「任务代码交付」",
  },
  {
    index: "08",
    title: "产品规划与场景预览",
    summary:
      "从轻量 PRD 生成可编辑的多任务 Roadmap，绑定真实任务与依赖；场景提交后可显式启动隔离预览。",
    points: [
      "轻量 PRD 与可编辑多任务 Roadmap",
      "不可变发布版本",
      "真实任务、依赖与前置代码基线校验",
      "IdeaBoard App 场景与隔离预览",
      "不自动合并、部署或完成任务",
    ],
    evidence: "README「产品规划」「IdeaBoard 场景」",
  },
];

export interface PlatformItem {
  title: string;
  detail: string;
}

export const platformItems: PlatformItem[] = [
  {
    title: "本地项目存储",
    detail: "新项目写入所选目录的 .pm/core/ 与 .pm/attachments/；目录迁移、找回与完整备份有独立台账。",
  },
  {
    title: "Web + Desktop",
    detail: "同一套 Web 产物；Electron 可选择本机托管服务或显式连接远程服务。",
  },
  {
    title: "同源服务组",
    detail: "PM API、Agent API、Worker 与公共网关由 services:* 管理启停，流与 WebSocket 保留同源检查。",
  },
  {
    title: "单用户信任边界",
    detail: "allowedRoots、HttpOnly Cookie、能力端点与真实目录校验；不是多租户隔离或文件沙箱。",
  },
];

export interface EvidenceItem {
  date: string;
  title: string;
  detail: string;
  scope: string;
}

export const evidenceItems: EvidenceItem[] = [
  {
    date: "2026-10-31",
    title: "任务代码交付第一版",
    detail:
      "隔离仓库中真实 Codex 开发 → 10 项测试 → Draft PR → 同版本 CI 回到任务；暂无人工评审。",
    scope: "隔离仓库",
  },
  {
    date: "2026-11-01",
    title: "工作流 v3",
    detail:
      "公共入口真实 Codex 开发 → 测试 → Draft PR #2 → 同 SHA 必需 CI → 人工确认待审核。",
    scope: "本机验收",
  },
  {
    date: "2026-11-02",
    title: "产品规划增量交付",
    detail:
      "五个真实任务增量交付同一客户反馈 App → Draft PR #4–#8、同版本 CI；浏览器跨功能与重启持久化已核对。",
    scope: "隔离仓库",
  },
  {
    date: "2026-11-02",
    title: "统一 Web 与服务组",
    detail:
      "Web lint、TypeScript、Vite 构建通过；四角色服务组重启后项目与验证会话仍可读；390px 窄屏实测。",
    scope: "本机",
  },
];

export type BoundaryStatus = "未实现" | "未验收" | "明确不存在" | "部分验收" | "不支持" | "未收口";

export interface BoundaryItem {
  status: BoundaryStatus;
  title: string;
  detail: string;
}

export const boundaries: BoundaryItem[] = [
  {
    status: "未实现",
    title: "多用户与 RBAC",
    detail:
      "当前只面向本机单操作者；Agent 会话尚未按 PM 成员建立所有权隔离，不要把目录绑定当作多用户授权或文件沙箱。",
  },
  {
    status: "未实现",
    title: "云端同步 / 多实例",
    detail:
      "未实现云端同步、多实例或接管来源服务；本机服务组是当前入口，不自动导入其他副本的数据。",
  },
  {
    status: "明确不存在",
    title: "自动完成任务",
    detail:
      "Chat 或 Run 成功都不会改写 WorkItem；工作流只在 CI 后确认待审核，没有自动完成规则。",
  },
  {
    status: "未验收",
    title: "生产级 Runner 与全仓回归",
    detail:
      "本页只引用本机与隔离仓库记录；完整 Runner、生产发布、全仓回归和所有平台验收尚未通过。",
  },
  {
    status: "未验收",
    title: "安装包、签名、公证、自动更新",
    detail:
      "桌面可从源码构建；尚无已验收的安装包、签名、公证或自动更新服务。",
  },
  {
    status: "未收口",
    title: "会话与持久化统一设计",
    detail:
      "当前暂沿用 Agent Chat 的保存方式；统一会话与持久化设计尚未收口。",
  },
  {
    status: "部分验收",
    title: "Provider 真实账号",
    detail:
      "Provider 集合已接入，但只有部分真实账号或模型通过验证；状态检查不能证明远端接口、密钥或模型可用。",
  },
  {
    status: "不支持",
    title: "外部邮箱、Push、SSO、协作白板",
    detail:
      "README「未支持」列出：外部邮箱同步、邮件/Push 通知、MFA/SSO、自动 GC 与协作白板。个人本地 SVG 白板不等同协作白板。",
  },
];

export interface PlaceholderItem {
  label: string;
  detail: string;
  meta: string;
}

/**
 * Deliberately empty marketing slots. Do not replace these with invented
 * screenshots, quotes, prices, badges, or usage numbers.
 */
export const placeholders: PlaceholderItem[] = [
  {
    label: "产品截图",
    detail: "Hero 已预留真实界面截图位置；当前只展示架构示意，不伪造产品画面。",
    meta: "建议 1600 × 1000",
  },
  {
    label: "客户评价",
    detail: "没有可引用的真实用户评价或 Logo 授权，位置留空。",
    meta: "待授权",
  },
  {
    label: "价格与套餐",
    detail: "仓库没有公开定价信息，不展示虚构价格或免费额度。",
    meta: "待补充",
  },
  {
    label: "公开下载",
    detail: "没有已验收的桌面安装包；当前只提供源码构建与本机启动步骤。",
    meta: "源码构建",
  },
  {
    label: "公开指标",
    detail: "没有可引用的用户数、星标、SLA 或可用性数据。",
    meta: "待补充",
  },
  {
    label: "安全 / 合规认证",
    detail: "未提供认证材料，不展示未经证实的合规徽章。",
    meta: "待补充",
  },
];

export const verificationNumbers = [
  { value: "440", label: "Agent server 测试" },
  { value: "11", label: "client runtime 测试" },
  { value: "5", label: "desktop 测试" },
  { value: "4", label: "网关与 Worker 隔离测试" },
];
