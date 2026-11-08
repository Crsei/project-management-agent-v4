import { useId, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { ArrowUpRight, RefreshCw } from "lucide-react"
import type { MemberDirectoryMember } from "@contracts"
import { MEMBER_ROLE_PRESETS } from "../../../../../../../packages/domain/src/members"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { DisplayPreferences } from "@/features/workspace/store"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useMemberDirectory, useMemberInvitations } from "../pm-member-hooks"
import { usePmEntities, usePmService } from "../pm-service"
import { useTeamDirectory } from "../pm-team-hooks"
import { allowed, string, useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"
import { ServiceWorkspaceIdentity } from "./settings-workspace-identity"
import { WorkspaceIdentityBadge } from "../pm-workspace-identity-badge"
import { RadixSelect } from "@/components/ui/radix-select"

type ProjectPreferences = Pick<DisplayPreferences, "projectTab" | "showCompletedTasks">
const linkClass = "inline-flex max-w-full items-center gap-1 rounded-control text-sm text-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function SettingRow({ label, description, children, id }: { label: string; description: string; children: ReactNode; id?: string }) {
  return <div className="grid min-w-0 gap-3 border-b pb-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-6">
    <div className="space-y-1">{id ? <label htmlFor={id} className="text-sm font-medium">{label}</label> : <h3 className="text-sm font-medium">{label}</h3>}<p id={id ? `${id}-description` : undefined} className="text-sm leading-6 text-muted-foreground">{description}</p></div>
    <div className="min-w-0 space-y-2">{children}</div>
  </div>
}

function ManagementLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className={linkClass}>{children}<ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" /></Link>
}

function ReadState({ pending, fetching, error, present, onRetry }: { pending: boolean; fetching: boolean; error: Error | null; present: boolean; onRetry: () => unknown }) {
  const t = useText()
  return <div className="space-y-2 text-sm" aria-live="polite">
    {pending && !present && <p role="status">{t("正在读取真实服务…", "Reading the real service…")}</p>}
    {fetching && present && !error && <p role="status">{t("正在刷新服务快照…", "Refreshing the service snapshot…")}</p>}
    {error && <div role="alert" className="space-y-2 rounded-module border border-destructive/30 p-3"><p>{error.message}</p><p className="text-muted-foreground">{t("本区域数据暂不可用；不会用样例替代失败的读取。", "This data is unavailable; failed reads are never replaced with samples.")}</p><Button variant="outline" disabled={fetching} onClick={() => { void onRetry() }}>{t("重试读取", "Retry read")}</Button></div>}
  </div>
}

/** Mount service-dependent hooks only after the authenticated workspace is available. */
function ServiceWorkspaceGate({ children }: { children: ReactNode }) {
  const service = usePmService()
  const t = useText()
  const [retryError, setRetryError] = useState<string | null>(null)
  if (service.loading) return <p role="status">{t("正在读取会话与工作区…", "Loading session and workspace…")}</p>
  if (service.error || !service.actor || !service.workspace) return <div role="alert" className="space-y-3 text-sm">
    <p>{service.error?.message ?? t("请先登录并选择有权访问的工作区。", "Sign in and choose an authorized workspace first.")}</p>
    <div className="flex flex-wrap gap-3"><ManagementLink to="/pm?pick=1">{t("登录 / 选择工作区", "Sign in / choose workspace")}</ManagementLink><Button variant="outline" onClick={() => { setRetryError(null); void service.refresh().catch((error: unknown) => setRetryError(error instanceof Error ? error.message : String(error))) }}><RefreshCw aria-hidden="true" className="size-4" />{t("重新读取会话", "Reload session")}</Button></div>
    {retryError && <p>{retryError}</p>}
  </div>
  return children
}

function LabNotice() {
  const t = useText()
  return <SettingsNotice>{t("Lab · 以下身份、成员、团队和项目均为明确标记的展示样例，不读取正式工作区、不调用管理服务。预览偏好只在本页内存中生效，离页或刷新重置；禁用的操作不会写入任何数据。", "Lab · Identities, members, teams and projects below are labeled presentation samples. No formal workspace or management service is accessed. Preview preferences live only in page memory and reset on navigation or reload; disabled actions write nothing.")}</SettingsNotice>
}

function LabWorkspaceIdentity() {
  const t = useText()
  return <div className="space-y-5">
    <WorkspaceIdentityBadge icon="building" color="#2F2E2A" className="size-12 [&>svg]:size-6" />
    <SettingRow label={t("工作区名称", "Workspace name")} description={t("Lab 只读样例，不是服务数据；正式工作区在对应设置页保存。", "Read-only Lab sample, not service data. Formal workspaces save through their settings page.")}><Input value={t("示例工作区 · Lab", "Example workspace · Lab")} disabled /></SettingRow>
    <SettingRow label={t("工作区 ID / URL", "Workspace ID / URL")} description={t("示例稳定身份；Lab 不修改真实工作区或导航地址。", "Sample stable identity; Lab never changes a real workspace or its address.")}><Input value="lab-workspace-sample" readOnly /><Input value="https://example.invalid/lab/workspace" readOnly /></SettingRow>
    <Button disabled>{t("保存工作区资料", "Save workspace identity")}</Button>
    <SettingsNotice>{t("自定义 URL、停用及删除仍需单独讨论；Lab 不执行这些操作。", "Custom URLs, deactivation and deletion require separate decisions; Lab performs none of these actions.")}</SettingsNotice>
  </div>
}

function ServiceWorkspace() {
  const t = useText()
  return <SettingsSection title={t("工作区", "Workspace")} description={t("保存真实工作区名称、安全图标与颜色；稳定 ID 和地址不变。", "Save your real workspace name, safe icon and color. The stable ID and address remain unchanged.")}><ServiceWorkspaceIdentity /></SettingsSection>
}

export function SettingsWorkspace({ mode }: SettingsPageProps) {
  const t = useText()
  return mode === "service" ? <ServiceWorkspaceGate><ServiceWorkspace /></ServiceWorkspaceGate> : <SettingsSection title={t("工作区", "Workspace")} description={t("Lab 工作区身份与危险区域样例。", "Lab workspace identity and danger-zone sample.")}><LabNotice /><LabWorkspaceIdentity /></SettingsSection>
}

function MemberScope({ member }: { member: MemberDirectoryMember }) {
  const t = useText()
  if (!member.access) return <span>{t("授权明细已脱敏", "Access details redacted")}</span>
  return <span>{member.access.revokedAt ? t("已撤销", "Revoked") : member.access.projectIds === null ? t("整个工作区", "Whole workspace") : member.access.projectIds.length ? member.access.projectIds.join(", ") : t("未授权项目", "No projects granted")}</span>
}

function MemberDirectoryOverview({ root }: { root: string }) {
  const t = useText()
  const query = useMemberDirectory()
  const data = query.error ? undefined : query.data
  return <div className="space-y-4">
    <ReadState pending={query.isPending} fetching={query.isFetching} error={query.error} present={!!query.data} onRetry={query.refetch} />
    {data && <>
      <p className="text-sm">{t(`当前可见 ${data.members.length} 位成员。`, `${data.members.length} members visible to you.`)} {data.capabilities.canManageMembers ? t("具有工作区成员管理权限。", "Workspace member management is available.") : t("这是按共同项目裁剪的目录，不是工作区成员总量。", "This directory is limited to shared projects, not the workspace total.")}</p>
      {data.members.length === 0 ? <SettingsNotice>{t("当前授权目录没有可见成员。", "No members are visible in your authorized directory.")}</SettingsNotice> : <div className="overflow-x-auto rounded-module border"><table className="w-full min-w-[34rem] text-left text-sm"><caption className="sr-only">{t("真实成员与授权范围概览", "Actual members and access scope overview")}</caption><thead className="bg-surface-raised"><tr>{[t("成员", "Member"), t("角色模板", "Role template"), t("团队", "Teams"), t("访问范围", "Access scope")].map(label => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{data.members.map(member => <tr key={member.userId} className="border-t"><th scope="row" className="max-w-60 break-words px-4 py-3 font-normal"><p className="font-medium">{member.name}</p>{member.email && <p className="break-all text-xs text-muted-foreground">{member.email}</p>}</th><td className="px-4 py-3">{member.role === "unknown" ? t("未提供", "Unavailable") : member.role === "custom" ? "Custom" : member.role === "admin" ? "Admin" : member.role === "member" ? "Member" : "Guest"}</td><td className="max-w-56 break-words px-4 py-3">{member.teams.map(team => team.name).join(" · ") || t("无可见团队", "No visible teams")}</td><td className="max-w-56 break-words px-4 py-3"><MemberScope member={member} /></td></tr>)}</tbody></table></div>}
      <ManagementLink to={`${root}/members?tab=members`}>{t("打开成员目录与角色操作", "Open directory and role actions")}</ManagementLink>
    </>}
  </div>
}

function InvitationOverview({ root }: { root: string }) {
  const query = useMemberInvitations()
  const t = useText()
  const data = query.error ? undefined : query.data
  return <section className="space-y-3" aria-label={t("邀请服务状态", "Invitation service status")}>
    <h3 className="text-sm font-medium">{t("邀请与投递", "Invitations and delivery")}</h3>
    <ReadState pending={query.isPending} fetching={query.isFetching} error={query.error} present={!!query.data} onRetry={query.refetch} />
    {data && <><SettingsNotice>{data.enabled ? t("邀请服务已启用。SMTP 接受不代表收件箱送达；结果未知时需在原邀请记录中显式核对或重发。", "The invitation service is enabled. SMTP acceptance is not inbox delivery; unknown outcomes require checking the original record or explicit resending.") : t("SMTP / 邀请部署配置不可用：不能新建或重发邮件邀请。已有邀请状态与撤销仍可管理；授权已有账号不发送邮件，不依赖 SMTP。", "SMTP / invitation deployment configuration is unavailable: creating and resending email invitations are disabled. Existing invitation status and revocation remain manageable; granting an existing account sends no email and does not require SMTP.")}</SettingsNotice><p className="text-sm">{t(`真实邀请记录 ${data.items.length} 条，其中待接受 ${data.items.filter(item => item.status === "pending").length} 条。`, `${data.items.length} actual invitation records; ${data.items.filter(item => item.status === "pending").length} pending acceptance.`)}</p></>}
    <ManagementLink to={`${root}/members?tab=members&panel=invitations`}>{t("打开邮箱邀请、记录与撤销 / 重发", "Open email invitations, records and revoke / resend")}</ManagementLink>
  </section>
}

function ServiceMembers() {
  const { workspace } = usePmService()
  const t = useText()
  if (!workspace) return null
  const root = `/pm/${encodeURIComponent(workspace.id)}`
  const canManage = allowed(workspace, "access.manage")
  const canRead = canManage || workspace.capabilities.includes("directory.read")
  return <SettingsSection wide title={t("成员", "Members")} description={t("管理入口复用真实成员目录、角色模板、独立能力和邮件邀请；设置页不建立第二套成员存储。", "Management uses the existing member directory, role templates, explicit capabilities and email invitations; settings never creates another member store.")}>
    <SettingsNotice>{t("仅无限制工作区 access.manage 可修改角色、授权范围、撤销成员或管理邀请。Admin / Member / Guest 是显式能力模板；Custom 不会被自动替换。普通目录隐藏无权读取的联系方式和授权明细；2FA 没有可信来源，不由管理员随意设置。", "Only unrestricted workspace access.manage can change roles, scopes, revoke access or manage invitations. Admin / Member / Guest are explicit capability templates; Custom is never replaced automatically. Ordinary readers see redacted contact and access details. No trusted 2FA source is available, and administrators cannot set it arbitrarily.")}</SettingsNotice>
    {canRead ? <MemberDirectoryOverview root={root} /> : <SettingsNotice>{t("当前缺少 directory.read 或工作区 access.manage，不能读取成员目录。请由现有管理员在成员管理中显式授权；本页不会扩大权限。", "directory.read or workspace access.manage is required to read the member directory. Ask an existing administrator for an explicit grant; this page never expands access.")}</SettingsNotice>}
    {canManage ? <InvitationOverview root={root} /> : <SettingsNotice>{t("邀请列表与 SMTP 可用性只对工作区管理员开放，当前账号无法读取。邀请 Guest 也需要 access.manage，不因 Member 模板或加入团队而开放。", "Invitation records and SMTP availability are only exposed to workspace administrators and cannot be read by this account. Inviting a Guest still requires access.manage; the Member template or team membership does not enable it.")}</SettingsNotice>}
    <section className="space-y-3 rounded-module border p-4"><h3 className="text-sm font-medium">{t("具体管理操作", "Management actions")}</h3><p className="text-sm leading-6 text-muted-foreground">{t("在成员目录使用成员菜单“更改角色”，或“管理访问 → 编辑独立能力”修改能力、整个工作区 / 项目 ID 范围并撤销访问；“授权已有账号”仅接受已存在的账号 UUID。沿用版本检查、未知命令收据恢复及最后管理员保护，不会移除账号本身。", "Use a member’s “Change role” menu, or “Manage Access → Edit capabilities” to change grants, workspace / project-ID scope or revoke access. “Grant existing account” requires an existing account UUID. Version checks, unknown-command receipt recovery and final-administrator protection are retained; revoking membership does not delete the account.")}</p><div className="flex flex-wrap gap-4"><ManagementLink to={`${root}/members?tab=members&panel=invitations`}>{t("成员授权与邀请管理", "Member access and invitations")}</ManagementLink><ManagementLink to={`${root}/settings/permissions`}>{t("查看真实能力矩阵", "View the actual capability matrix")}</ManagementLink></div></section>
  </SettingsSection>
}

export function SettingsMembers({ mode }: SettingsPageProps) {
  const t = useText()
  return mode === "service" ? <ServiceWorkspaceGate><ServiceMembers /></ServiceWorkspaceGate> : <SettingsSection title={t("成员", "Members")} description={t("Lab 成员与授权管理概览样例。", "Lab member and access management overview.")}><LabNotice /><div className="rounded-module border p-4 text-sm"><p className="font-medium">{t("示例成员 · Lab", "Example member · Lab")}</p><p className="text-muted-foreground">sample@example.invalid · Member</p><p className="mt-2">{t("示例范围：项目 LAB-1。角色不是等级授权，团队不增加能力。", "Sample scope: project LAB-1. Roles are not permission ranks; teams grant no capabilities.")}</p></div><Button disabled>{t("邀请成员", "Invite member")}</Button><SettingsNotice>{t("正式页面复用原成员目录中的角色、能力、项目范围、撤销和邀请记录。邮件创建 / 重发受工作区 access.manage 与 SMTP 配置约束；Lab 不发送邮件、不授予权限。", "Formal pages reuse roles, capabilities, project scopes, revocation and invitation records in the existing member directory. Creating / resending email requires workspace access.manage and SMTP configuration; Lab sends no mail and grants no access.")}</SettingsNotice></SettingsSection>
}

function TeamsOverview({ root }: { root: string }) {
  const query = useTeamDirectory()
  const t = useText()
  const data = query.error ? undefined : query.data
  return <div className="space-y-4">
    <ReadState pending={query.isPending} fetching={query.isFetching} error={query.error} present={!!query.data} onRetry={query.refetch} />
    {data && <><p className="text-sm">{t(`当前可见团队 ${data.teams.filter(team => !team.data.archivedAt).length} 个；归档记录 ${data.teams.filter(team => !!team.data.archivedAt).length} 个。`, `${data.teams.filter(team => !team.data.archivedAt).length} active teams and ${data.teams.filter(team => !!team.data.archivedAt).length} archived records visible.`)} {data.canManage ? t("团队维护权限可用。", "Team management is available.") : t("仅显示当前授权范围；不代表全工作区总量。", "Only your authorized scope is shown; these are not workspace totals.")}</p>
      {data.teams.length === 0 ? <SettingsNotice>{t("当前没有可见团队。具有工作区管理权限的成员可在团队页面创建。", "No teams are currently visible. Workspace administrators can create one on the teams page.")}</SettingsNotice> : <ul className="space-y-3">{data.teams.map(team => <li key={team.id} className="space-y-2 rounded-module border p-4 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{team.data.name}</h3><span className="text-muted-foreground">{team.data.archivedAt ? t("已归档", "Archived") : team.data.identifier || t("无团队标识", "No team identifier")}</span></div>{team.data.description && <p className="break-words text-muted-foreground">{team.data.description}</p>}<dl className="grid gap-2 sm:grid-cols-2"><div><dt className="text-muted-foreground">{t("可见成员 / 维护者", "Visible members / maintainers")}</dt><dd>{team.data.memberIds.length} / {team.data.maintainerIds.length}</dd></div><div><dt className="text-muted-foreground">{t("关联项目", "Assigned projects")}</dt><dd className="break-words">{team.projectIds.map(id => data.projects.find(project => project.id === id)?.name ?? id).join(" · ") || t("无可见关联", "No visible assignments")}</dd></div><div><dt className="text-muted-foreground">{t("工作方向 / 响应目标", "Focus / response target")}</dt><dd>{team.data.focus ?? t("未设置", "Not set")} · {team.data.responseTargetHours === null ? t("未设置响应目标", "No response target") : t(`${team.data.responseTargetHours} 小时`, `${team.data.responseTargetHours} hours`)}</dd></div><div><dt className="text-muted-foreground">{t("当前可见未完成工作", "Visible open work")}</dt><dd>{team.openWorkCount ?? t("未知", "Unknown")}{!team.scopeComplete && ` · ${t("范围不完整", "Partial scope")}`}</dd></div></dl></li>)}</ul>}
      <ManagementLink to={`${root}/members?tab=teams`}>{t("打开团队目录与维护操作", "Open teams and management actions")}</ManagementLink>
    </>}
  </div>
}

function TeamManagementGuide({ root }: { root?: string }) {
  const t = useText()
  return <section className="space-y-4 rounded-module border p-4"><h3 className="text-sm font-medium">{t("管理入口与限制", "Management entrypoints and limits")}</h3><ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground"><li>{t("团队页面的创建、编辑、成员 / 维护者及归档菜单复用无限制工作区 access.manage。维护者只是团队标签，不会自动获得管理权限；归档不是删除团队或成员。", "Create, edit, members / maintainers and archive actions on the teams page require unrestricted workspace access.manage. Maintainer is a team label, not a permission grant; archiving does not delete the team or its members.")}</li><li>{t("团队中的关联项目操作还要求该项目 domain.read 与可写状态；关联不会创建工作区成员、发送邀请或授予项目权限。仅有管理能力也不能读取业务项目。", "Assigning projects also requires that project’s domain.read and writable state. Assignments do not create workspace membership, send invitations or grant project access. Management permission alone cannot read business projects.")}</li><li>{t("工作方向与响应目标是已有团队字段，响应目标不是 SLA 达标引擎。容量为并行未完成工作的估算点，不是周工时；部分范围与缺失估算不能推定全局未超载。", "Focus and response target are existing team fields, not an SLA enforcement engine. Capacity uses estimate points for concurrent unfinished work, not weekly hours; partial scope and missing estimates cannot establish global spare capacity.")}</li><li>{t("邀请仍复用成员服务：创建 / 重发需要管理员与已配置 SMTP，SMTP 接受不是最终送达；团队本身不绕过这些限制。", "Invitations use the member service: create / resend requires an administrator and configured SMTP. SMTP acceptance is not delivery, and teams cannot bypass these limits.")}</li></ul>{root && <div className="flex flex-wrap gap-4"><ManagementLink to={`${root}/members?tab=teams`}>{t("团队、成员与归档", "Teams, members and archiving")}</ManagementLink><ManagementLink to={`${root}/members?tab=members`}>{t("成员目录与资料", "Member directory and profiles")}</ManagementLink><ManagementLink to={`${root}/members?tab=workload`}>{t("容量与工作量", "Capacity and workload")}</ManagementLink><ManagementLink to={`${root}/members?tab=members&panel=invitations`}>{t("邀请与授权", "Invitations and access")}</ManagementLink></div>}</section>
}

function ServiceTeams() {
  const { workspace } = usePmService()
  const t = useText()
  if (!workspace) return null
  const root = `/pm/${encodeURIComponent(workspace.id)}`
  const canRead = allowed(workspace, "access.manage") || workspace.capabilities.includes("domain.read")
  return <SettingsSection wide title={t("团队", "Teams")} description={t("真实团队、成员 / 维护者与项目关联的管理概览；团队组织关系不构成授权。", "An overview of actual teams, members / maintainers and project assignments; organizational relationships never grant access.")}><SettingsNotice>{t("以下信息使用既有团队目录服务，按当前权限裁剪；不会推定被隐藏的成员、项目或工作量不存在。", "The existing team directory is filtered to your current authority. Hidden members, projects or workloads are never assumed absent.")}</SettingsNotice>{canRead ? <TeamsOverview root={root} /> : <SettingsNotice>{t("当前缺少 domain.read 或工作区 access.manage，团队目录不可读取。", "domain.read or workspace access.manage is required to read the team directory.")}</SettingsNotice>}<TeamManagementGuide root={root} /></SettingsSection>
}

export function SettingsTeams({ mode }: SettingsPageProps) {
  const t = useText()
  return mode === "service" ? <ServiceWorkspaceGate><ServiceTeams /></ServiceWorkspaceGate> : <SettingsSection title={t("团队", "Teams")} description={t("Lab 团队组织样例。", "Lab team organization sample.")}><LabNotice /><div className="space-y-2 rounded-module border p-4 text-sm"><h3 className="font-medium">{t("示例团队 · Lab", "Example team · Lab")}</h3><p>{t("示例成员 2 位 · 维护者 1 位 · 关联项目 LAB-1", "2 sample members · 1 maintainer · assigned project LAB-1")}</p><Button variant="outline" disabled>{t("管理团队 / 归档", "Manage / archive team")}</Button></div><TeamManagementGuide /></SettingsSection>
}

function ProjectPreferenceControls({ value, onChange }: { value: ProjectPreferences; onChange: (patch: Partial<ProjectPreferences>) => void }) {
  const id = useId()
  const t = useText()
  return <>
    <SettingRow id={`${id}-tab`} label={t("默认项目视图", "Default project view")} description={t("打开项目时的首选任务布局；URL 明确指定的布局优先。不会更改项目状态或工作区共享配置。", "Preferred task layout when opening a project; explicit URL layouts take precedence. This never changes project state or shared workspace configuration.")}><RadixSelect id={`${id}-tab`} value={value.projectTab} aria-describedby={`${id}-tab-description`} onChange={event => { const tab = event.target.value; if (tab === "list" || tab === "board" || tab === "table" || tab === "timeline") onChange({ projectTab: tab }) }}><option value="list">{t("列表", "List")}</option><option value="board">{t("看板", "Board")}</option><option value="table">{t("表格", "Table")}</option><option value="timeline">{t("时间线", "Timeline")}</option></RadixSelect></SettingRow>
    <SettingRow id={`${id}-completed`} label={t("在看板中显示已完成任务", "Show completed tasks on boards")} description={t("仅改变显示筛选，不删除或归档任务，也不改变任务工作流状态。", "Only changes display filtering: tasks are not deleted, archived or moved to another workflow state.")}><Switch id={`${id}-completed`} checked={value.showCompletedTasks} onCheckedChange={checked => onChange({ showCompletedTasks: checked })} aria-describedby={`${id}-completed-description`} /></SettingRow>
  </>
}

function ServiceProjectPreferences() {
  const projectTab = useWorkspaceStore(state => state.projectTab)
  const showCompletedTasks = useWorkspaceStore(state => state.showCompletedTasks)
  const setPreferences = useWorkspaceStore(state => state.setPreferences)
  const storage = useWorkspaceStore(state => state.preferenceStorage)
  const t = useText()
  return <><SettingsNotice>{storage === "unavailable" ? t("浏览器存储不可用：下方偏好仅在当前会话生效，刷新后可能丢失。没有写入账号或项目服务。", "Browser storage is unavailable: preferences apply only to this session and may be lost on reload. Nothing is saved to your account or project service.") : t("下方显示偏好在选择后立即应用，保存在当前浏览器，不是账号跨设备同步或所有成员的项目默认值。", "Display preferences apply immediately and are saved in this browser, not synchronized across devices or imposed on other workspace members.")}</SettingsNotice><ProjectPreferenceControls value={{ projectTab, showCompletedTasks }} onChange={setPreferences} /></>
}

function ProjectEditingGuide() {
  const t = useText()
  return <section className="space-y-4 rounded-module border p-4"><h3 className="text-sm font-medium">{t("项目设置与字段边界", "Project settings and field boundaries")}</h3><ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
    <li>{t("侧栏或项目页的“…” → “重命名与编辑”可保存名称、Markdown 描述、负责人、目标日期、安全图标和颜色。所有字段使用真实项目修订与命令收据；冲突保留草稿，结果未知时先核对原请求。", "Use the sidebar or project page … menu → Rename & edit to save the name, Markdown description, owner, target date, safe icon and color. Fields use the real project revision and command receipt; conflicts retain drafts and unknown outcomes require checking the original request.")}</li>
    <li>{t("团队：项目设置中的团队关联独立保存，也可使用下方“团队与封面设置”。需要工作区 access.manage、该项目 domain.read 与可写状态；团队归属不授予项目权限。", "Team assignments save separately in project settings or through Team and cover settings below. They require workspace access.manage, project domain.read and a writable project; team membership does not grant project access.")}</li>
    <li>{t("负责人使用真实授权身份，保留不可用的历史负责人供核对；实际写入资格仍由原服务校验。完整对象入口继续编辑源码、工作流及其他原生属性。", "Owners use real authorized identities, retaining unavailable historical owners for reconciliation. The existing service validates assignments. The full entity editor remains available for source, workflow and other native properties.")}</li>
    <li>{t("图标仅渲染应用内置图形，颜色使用安全十六进制值；封面仍只引用本项目已登记的不可变栅格图片版本。归档项目从活动侧栏隐藏，可在已归档列表恢复；永久删除必须先归档且没有入站引用，不删除用户代码目录，也没有撤销。", "Icons render only bundled shapes and colors use safe hex values. Covers still reference registered immutable raster-image versions from this project. Archived projects leave the active sidebar and can be restored from Archived. Permanent deletion requires archive-first and no inbound references; user code directories remain and there is no undo.")}</li>
  </ul></section>
}

function ProjectManagementOverview({ root }: { root: string }) {
  const query = usePmEntities("project")
  const { workspace } = usePmService()
  const [selectedId, setSelectedId] = useState("")
  const t = useText()
  const id = useId()
  const data = query.error ? undefined : query.data
  const selected = data?.find(project => project.id === selectedId) ?? data?.[0]
  const archived = data?.filter(project => !!project.data.archivedAt || project.data.archived === true)
  const entityHref = (projectId: string) => `${root}/entities/${encodeURIComponent(projectId)}?${new URLSearchParams({ returnTo: `${root}/settings/projects` })}`
  const lifecycleAllowed = (projectId: string) => allowed(workspace, "planning.lifecycle", projectId)
  return <section className="space-y-4" aria-label={t("项目设置与归档管理", "Project settings and archive management")}>
    <ReadState pending={query.isPending} fetching={query.isFetching} error={query.error} present={!!query.data} onRetry={query.refetch} />
    {data && <>
      <p className="text-sm">{t(`当前可读取 ${data.length} 个项目，含 ${archived?.length ?? 0} 个归档项目；不是无权访问项目的总量。`, `${data.length} readable projects, including ${archived?.length ?? 0} archived; projects outside your access are not counted.`)}</p>
      {selected ? <div className="space-y-4 rounded-module border p-4"><label htmlFor={`${id}-project`} className="grid gap-2 text-sm"><span className="font-medium">{t("选择需要管理的项目", "Choose a project to manage")}</span><RadixSelect id={`${id}-project`} value={selected.id} onChange={event => setSelectedId(event.target.value)}>{data.map(project => <option key={project.id} value={project.id}>{project.id} · {string(project.data.name) || project.id}{project.data.archivedAt || project.data.archived === true ? ` · ${t("已归档", "Archived")}` : ""}</option>)}</RadixSelect></label><div className="flex flex-wrap gap-4"><ManagementLink to={entityHref(selected.id)}>{t("完整对象 / 字段与生命周期", "Full entity / fields and lifecycle")}</ManagementLink><ManagementLink to={`${root}/projects/${encodeURIComponent(selected.id)}?view=detail2&tab=overview`}>{t("团队与封面设置", "Team and cover settings")}</ManagementLink></div><p className="text-sm text-muted-foreground">{t("完整对象中切换“属性”可找到归档、恢复与永久删除；业务标签保留项目状态操作。编辑需要相应项目的 planning.edit；生命周期需要 planning.lifecycle，并继续检查当前版本、草稿与领域守卫。", "Choose “Properties” in the full entity for archive, restore and permanent deletion; the Business tab retains project state actions. Editing requires project planning.edit; lifecycle requires planning.lifecycle and still checks versions, drafts and domain guards.")}</p>{!(selected.data.archivedAt || selected.data.archived === true) && <Button variant="outline" disabled={!lifecycleAllowed(selected.id)} render={lifecycleAllowed(selected.id) ? <Link to={entityHref(selected.id)} /> : undefined}>{t("打开归档入口", "Open archive action")}</Button>}{!lifecycleAllowed(selected.id) && <p className="text-xs text-muted-foreground">{t("当前项目未授予 planning.lifecycle；只能查看，不可归档、恢复或删除。", "planning.lifecycle is not granted for this project; archive, restore and deletion are unavailable.")}</p>}</div> : <SettingsNotice>{t("当前没有可读取项目；不会显示示例项目或把读取失败当作空归档。", "No readable projects; samples are never substituted and failed reads are not treated as an empty archive.")}</SettingsNotice>}
      <div className="space-y-3"><h3 className="text-sm font-medium">{t("归档项目", "Archived projects")}</h3>{archived?.length ? <ul className="space-y-3">{archived.map(project => <li key={project.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-module border p-4"><div className="min-w-0 text-sm"><p className="break-words font-medium">{string(project.data.name) || project.id}</p><p className="font-mono text-xs text-muted-foreground">{project.id}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!lifecycleAllowed(project.id)} render={lifecycleAllowed(project.id) ? <Link to={entityHref(project.id)} /> : undefined}>{t("恢复入口", "Restore action")}</Button><Button variant="outline" className="text-destructive" disabled={!lifecycleAllowed(project.id)} render={lifecycleAllowed(project.id) ? <Link to={entityHref(project.id)} /> : undefined}>{t("安全删除入口", "Safe deletion action")}</Button></div></li>)}</ul> : <p className="text-sm text-muted-foreground">{t("当前可见范围内没有归档项目。归档保留任务与引用，不等同于永久删除。", "No archived projects in your visible scope. Archiving preserves tasks and references; it is not permanent deletion.")}</p>}</div>
    </>}
    <SettingsNotice>{t("安全删除沿用原完整对象确认：对象须先归档、无入站引用；不可读取 / 不可解析的来源会阻止删除，必须输入对象 ID 确认。不会级联删除其他文件或复用已删除 ID。本设置页只导航，不直接执行归档、恢复或删除。", "Safe deletion uses the existing full-entity confirmation: the object must be archived and have no incoming references; unreadable / unparseable sources prevent deletion, and its ID must be typed to confirm. Other files are not cascaded and deleted IDs are not reused. This settings page only navigates; it never directly archives, restores or deletes.")}</SettingsNotice>
    <ManagementLink to={`${root}/projects`}>{t("打开正式项目目录（使用归档筛选）", "Open project directory (use the archive filter)")}</ManagementLink>
  </section>
}

function ServiceProjects() {
  const { workspace } = usePmService()
  const t = useText()
  if (!workspace) return null
  const root = `/pm/${encodeURIComponent(workspace.id)}`
  return <SettingsSection wide title={t("项目", "Projects")} description={t("设置浏览器项目显示偏好，进入真实项目字段、团队、封面与受保护生命周期管理。", "Set browser display preferences and access actual project fields, teams, covers and protected lifecycle management.")}><ServiceProjectPreferences /><ProjectEditingGuide />{workspace.capabilities.includes("domain.read") ? <ProjectManagementOverview root={root} /> : <SettingsNotice>{t("当前没有 domain.read，不能读取项目或归档目录。工作区成员管理权限不隐含项目业务读取权限。", "Without domain.read, projects and archives cannot be read. Workspace access management does not imply business read access.")}</SettingsNotice>}</SettingsSection>
}

function LabProjects() {
  const t = useText()
  const [preferences, setPreferences] = useState<ProjectPreferences>({ projectTab: "board", showCompletedTasks: true })
  return <SettingsSection title={t("项目", "Projects")} description={t("Lab 默认项目视图与归档管理样例。", "Lab project defaults and archive management sample.")}><LabNotice /><ProjectPreferenceControls value={preferences} onChange={patch => setPreferences(previous => ({ ...previous, ...patch }))} /><Button variant="outline" onClick={() => setPreferences({ projectTab: "board", showCompletedTasks: true })}>{t("重置本页预览", "Reset page preview")}</Button><ProjectEditingGuide /><section className="space-y-3 rounded-module border p-4"><h3 className="text-sm font-medium">{t("归档项目 · Lab 样例", "Archived project · Lab sample")}</h3><p className="text-sm">LAB-1 · {t("示例归档项目", "Example archived project")}</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled>{t("恢复", "Restore")}</Button><Button variant="outline" disabled>{t("安全删除", "Safe deletion")}</Button></div><p className="text-sm text-muted-foreground">{t("仅展示控件；正式操作回到原完整对象，保留归档、入站引用、版本与输入 ID 确认保护。", "Presentation only. Formal actions return to the full entity with archive, incoming-reference, version and typed-ID protections.")}</p></section></SettingsSection>
}

export function SettingsProjects({ mode }: SettingsPageProps) {
  return mode === "service" ? <ServiceWorkspaceGate><ServiceProjects /></ServiceWorkspaceGate> : <LabProjects />
}

const permissionRows = [
  { capability: "domain.read", zh: "读取获授权项目", en: "Read authorized projects" },
  { capability: "directory.read", zh: "读取脱敏成员目录", en: "Read redacted member directory" },
  { capability: "intent.propose", zh: "提出意图", en: "Propose intents" },
  { capability: "planning.edit", zh: "规划编辑 / 创建项目¹", en: "Planning edits / create projects¹" },
  { capability: "delivery.write", zh: "登记成果与证据", en: "Register artifacts and evidence" },
  { capability: "delivery.submit", zh: "提交交付", en: "Submit delivery" },
  { capability: "access.manage", zh: "成员、邀请与团队管理²", en: "Manage access, invitations and teams²" },
  { capability: "audit.read", zh: "读取业务审计", en: "Read business audit" },
  { capability: "intent.decide", zh: "正式决策", en: "Decide intents" },
  { capability: "planning.lifecycle", zh: "项目生命周期 / 归档", en: "Project lifecycle / archive" },
  { capability: "workitem.cancel_reopen", zh: "取消 / 重开工作项", en: "Cancel / reopen work items" },
  { capability: "delivery.review", zh: "审核成果", en: "Review delivery" },
  { capability: "workitem.complete", zh: "确认完成工作项", en: "Confirm work-item completion" },
]

function RoleMatrix() {
  const t = useText()
  const roles = ["admin", "member", "guest"] as const
  return <section className="space-y-4"><h3 className="text-sm font-medium">{t("真实角色能力模板", "Actual role capability templates")}</h3><div className="overflow-x-auto rounded-module border"><table className="w-full min-w-[35rem] text-left text-sm"><caption className="sr-only">{t("服务端 Admin、Member、Guest 模板；不是等级继承关系", "Server Admin, Member and Guest templates; roles do not inherit by rank")}</caption><thead className="bg-surface-raised"><tr><th scope="col" className="px-4 py-3">{t("能力", "Capability")}</th>{roles.map(role => <th key={role} scope="col" className="px-4 py-3 text-center">{role === "admin" ? "Admin" : role === "member" ? "Member" : "Guest"}</th>)}</tr></thead><tbody>{permissionRows.map(row => <tr key={row.capability} className="border-t"><th scope="row" className="px-4 py-3 font-normal"><p>{t(row.zh, row.en)}</p><code className="text-xs text-muted-foreground">{row.capability}</code></th>{roles.map(role => { const grants: readonly string[] = MEMBER_ROLE_PRESETS[role]; return <td key={role} className="px-4 py-3 text-center">{grants.includes(row.capability) ? t("已含", "Included") : t("需独立授权", "Explicit grant required")}</td> })}</tr>)}</tbody></table></div><p className="text-sm leading-6 text-muted-foreground">{t("矩阵直接复用服务端 MEMBER_ROLE_PRESETS。Custom 为非模板能力组合，保持原样，只有显式应用模板才替换。Admin 不继承 Member 的规划 / 交付能力，也不自动拥有审核、生命周期、审计或完成权。工作区 owner 身份不替代当前能力检查。", "This matrix reuses the server’s MEMBER_ROLE_PRESETS. Custom combinations remain unchanged unless a template is explicitly applied. Admin does not inherit Member’s planning / delivery grants or automatically receive review, lifecycle, audit or completion rights. Workspace ownership does not replace current capability checks.")}</p><p className="text-sm leading-6 text-muted-foreground">{t("¹ 创建项目需要工作区范围 planning.edit；仅限已有项目的 planning.edit 不允许新建工作区项目。² access.manage 必须是无限制工作区范围，邀请邮件另需 SMTP。所有动作仍受当前授权项目、撤销状态、版本及领域守卫约束。", "¹ Creating projects requires workspace-scoped planning.edit; a grant limited to existing projects cannot create workspace projects. ² access.manage must be unrestricted workspace scope, and email invitations also require SMTP. Every action remains subject to current project scope, revocation, versions and domain guards.")}</p></section>
}

function PermissionPolicyControls({ canCreate, canManage, root, lab = false }: { canCreate: boolean; canManage: boolean; root?: string; lab?: boolean }) {
  const t = useText()
  const id = useId()
  return <>
    <SettingsNotice>{lab ? t("参考的三个全局开关在这里仅作能力映射说明，不模拟全工作区策略保存。", "The three reference switches only explain capability mappings; no workspace policy save is simulated.") : t("正式服务不存在“所有 Member 一键开关”的策略合同。以下禁用开关只反映当前账号与真实能力映射，不代表全工作区策略，也不会改变其他成员权限。", "The service has no global policy switches for all Members. These disabled switches only reflect this account’s actual capability mapping, not workspace policy, and cannot change anyone’s access.")}</SettingsNotice>
    <SettingRow id={`${id}-create`} label={t("成员可创建项目", "Members can create projects")} description={t("映射到每位成员的 planning.edit 与作用域；当前开关显示本账号是否持有工作区范围授权。请在原成员授权页面管理，不新增全局策略。", "Maps to each member’s planning.edit and scope. This switch reflects whether this account has workspace-scoped access. Manage grants through the existing member page, not a new global policy.")}><Switch id={`${id}-create`} checked={canCreate} disabled aria-describedby={`${id}-create-description`} /><p className="text-sm text-muted-foreground">{lab ? t("Lab 样例状态", "Lab sample state") : canCreate ? t("当前账号已获工作区范围 planning.edit。", "This account has workspace-scoped planning.edit.") : t("当前账号没有工作区范围 planning.edit。", "This account does not have workspace-scoped planning.edit.")}</p></SettingRow>
    <SettingRow id={`${id}-invite`} label={t("成员可邀请访客", "Members can invite guests")} description={t("映射到无限制工作区 access.manage；Member 模板默认没有该能力。访客范围由邀请 / 成员 projectIds 明确限制；邮件创建与重发另受 SMTP 配置约束。", "Requires unrestricted workspace access.manage, absent from the Member template. Guest scope is explicitly set by invitation / member projectIds; creating and resending mail also depends on SMTP configuration.")}><Switch id={`${id}-invite`} checked={canManage} disabled aria-describedby={`${id}-invite-description`} /><p className="text-sm text-muted-foreground">{lab ? t("Lab 样例状态，不代表 SMTP 可用", "Lab sample state; not SMTP availability") : canManage ? t("当前账号有授权管理能力；邮件可用性以成员页真实读取为准。", "This account can manage access; actual mail availability is read on the members page.") : t("当前账号不能管理邀请与授权。", "This account cannot manage invitations or grants.")}</p></SettingRow>
    <SettingRow id={`${id}-public`} label={t("允许公开分享链接", "Allow public share links")} description={t("未实现匿名 / 公开项目分享。应用 URL 仍要求登录、有效成员资格和当前项目 domain.read；复制链接不能绕过授权。", "Anonymous / public project sharing is unsupported. App URLs still require authentication, active membership and current project domain.read; copying a link never bypasses access checks.")}><Switch id={`${id}-public`} checked={false} disabled aria-describedby={`${id}-public-description`} /><p className="text-sm text-muted-foreground">{t("始终禁用；没有公开分享写入接口。", "Always disabled; no public-sharing write API exists.")}</p></SettingRow>
    {root && <div className="space-y-2"><ManagementLink to={`${root}/members?tab=members`}>{t("打开成员角色 / 独立能力 / 范围管理", "Open member roles / capabilities / scope management")}</ManagementLink><p className="text-sm text-muted-foreground">{t("在“管理访问”中显式配置能力与项目范围；撤销仍受最后管理员、版本与未知收据保护。没有管理能力的账号只能查看已获授权的信息。", "Explicitly configure capabilities and project scope in “Manage Access”. Revocation retains final-administrator, version and unknown-receipt protections. Accounts without management access can only read authorized information.")}</p></div>}
  </>
}

function ServicePermissions() {
  const { workspace } = usePmService()
  const t = useText()
  if (!workspace) return null
  return <SettingsSection wide title={t("权限", "Permissions")} description={t("依据真实服务的能力模板解释角色、当前授权和作用域；不创建可绕过服务端的全局权限开关。", "Understand actual capability templates, your grants and scopes; no global switches can bypass server authorization.")}><PermissionPolicyControls canCreate={allowed(workspace, "planning.edit")} canManage={allowed(workspace, "access.manage")} root={`/pm/${encodeURIComponent(workspace.id)}`} /><section className="space-y-2 rounded-module border p-4 text-sm"><h3 className="font-medium">{t("当前账号的真实授权", "This account’s actual grants")}</h3><p className="break-words font-mono text-xs">{workspace.capabilities.join(" · ") || t("没有授予能力", "No capabilities granted")}</p><p className="break-words text-muted-foreground">{t("范围：", "Scope: ")}{workspace.projectIds === null ? t("整个工作区", "Whole workspace") : workspace.projectIds.length ? workspace.projectIds.join(", ") : t("未授权项目", "No projects granted")}</p><p className="text-muted-foreground">{t("团队与维护者身份不增加任何能力；审核、任务完成和项目生命周期独立授权。", "Team membership and maintainer labels grant no capabilities; review, task completion and project lifecycle are independent grants.")}</p></section><RoleMatrix /></SettingsSection>
}

export function SettingsPermissions({ mode }: SettingsPageProps) {
  const t = useText()
  return mode === "service" ? <ServiceWorkspaceGate><ServicePermissions /></ServiceWorkspaceGate> : <SettingsSection wide title={t("权限", "Permissions")} description={t("Lab 角色矩阵与参考策略开关说明。", "Lab role matrix and reference policy-switch explanation.")}><LabNotice /><PermissionPolicyControls lab canCreate canManage={false} /><RoleMatrix /></SettingsSection>
}
