export const settingsGroups = [
  { id: "general", zh: "常规", en: "General" },
  { id: "workspace", zh: "工作区", en: "Workspace" },
  { id: "notifications", zh: "通知", en: "Notifications" },
  { id: "personal", zh: "个人", en: "Personal" },
  { id: "security", zh: "安全", en: "Security" },
  { id: "billing", zh: "计费", en: "Billing" },
  { id: "integrations", zh: "集成", en: "Integrations" },
  { id: "agent-extensions", zh: "Agent 扩展", en: "Agent extensions" },
] as const

export const settingsPages = [
  { slug: "general", group: "general", zh: "设置概览", en: "Overview" },
  { slug: "workspace", group: "general", zh: "工作区资料", en: "Workspace identity" },
  { slug: "appearance", group: "general", zh: "外观", en: "Appearance" },
  { slug: "design-system", group: "general", zh: "设计系统", en: "Design System" },
  { slug: "language", group: "general", zh: "语言与拼写", en: "Language & spelling" },
  { slug: "datetime", group: "general", zh: "日期与时间", en: "Date & time" },
  { slug: "members", group: "workspace", zh: "成员", en: "Members" },
  { slug: "teams", group: "workspace", zh: "团队", en: "Teams" },
  { slug: "projects", group: "workspace", zh: "项目", en: "Projects" },
  { slug: "permissions", group: "workspace", zh: "权限", en: "Permissions" },
  { slug: "notifications", group: "notifications", zh: "通知概览", en: "Notification overview" },
  { slug: "notif-email", group: "notifications", zh: "邮件通知", en: "Email notifications" },
  { slug: "notif-push", group: "notifications", zh: "推送", en: "Push" },
  { slug: "notif-mentions", group: "notifications", zh: "提及", en: "Mentions" },
  { slug: "notif-assign", group: "notifications", zh: "任务分配", en: "Task assignments" },
  { slug: "profile", group: "personal", zh: "个人资料", en: "Profile" },
  { slug: "preferences", group: "personal", zh: "操作偏好", en: "Preferences" },
  { slug: "shortcuts", group: "personal", zh: "键盘快捷键", en: "Keyboard shortcuts" },
  { slug: "password", group: "security", zh: "密码", en: "Password" },
  { slug: "sessions", group: "security", zh: "登录会话", en: "Sessions" },
  { slug: "two-factor", group: "security", zh: "双因素认证", en: "Two-factor authentication" },
  { slug: "plans", group: "billing", zh: "套餐与用量", en: "Plans & usage" },
  { slug: "billing", group: "billing", zh: "账单服务", en: "Billing service" },
  { slug: "invoices", group: "billing", zh: "发票", en: "Invoices" },
  { slug: "plugins", group: "integrations", zh: "集成目录", en: "Integration catalog" },
  { slug: "integration-email", group: "integrations", zh: "邮件", en: "Email" },
  { slug: "integration-webhook", group: "integrations", zh: "Webhook", en: "Webhook" },
  { slug: "im", group: "integrations", zh: "即时通讯", en: "Instant messaging" },
  { slug: "agent", group: "agent-extensions", zh: "Agent 扩展", en: "Agent extensions" },
] as const

export type SettingsPageSlug = (typeof settingsPages)[number]["slug"]

// These are existing service editors, not duplicate settings implementations.
export const workspaceSettingsPages = [
  { section: "preferences", zh: "页面布局", en: "Page layouts" },
  { section: "configuration", zh: "工作流与字段", en: "Workflows & fields" },
  { section: "local-storage", zh: "本地项目存储", en: "Local project storage" },
  { section: "migrations", zh: "协议迁移", en: "Protocol migrations" },
  { section: "diagnostics", zh: "诊断", en: "Diagnostics" },
] as const
