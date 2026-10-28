"use client"
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react"
import {
  ArrowUpRight,
  Building2,
  Check,
  KeyRound,
  Plus,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Switch } from "@easyuse-ui/ui/components/ui/switch"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@easyuse-ui/ui/components/ui/table"
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@easyuse-ui/ui/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSearch, ApSelect } from "../shared"
import { useApState } from "../state"
import { useApAccountState } from "../account-state"
import { apAsOf, apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  applyAccountRequest,
  beginCheck,
  beginRefresh,
  beginSave,
  canWrite,
  createOrgState,
  dialogKey,
  finishOperation,
  formFromAccount,
  formatBudget,
  isBuiltinRole,
  orgAdminScopes,
  orgCapabilities,
  orgOperationDelayMs,
  orgSectionIds,
  orgTimeZones,
  profileDirty,
  profileFromAccount,
  requestCapability,
  settleRefresh,
  validateForm,
  validateProfile,
  writeLocked,
  type OrgDialog,
  type OrgFormDraft,
  type OrgRequest,
  type OrgSectionId,
} from "./controller"
import styles from "./organization-settings.module.css"

export function OrganizationSettingsView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n(),
    en = locale === "en"
  const t = (english: string, chinese: string) => (en ? english : chinese)
  const [account, setAccount] = useApAccountState()
  const [state, setState] = useApState("organization-settings", () =>
    createOrgState(scenario),
  )
  const root = useRef<HTMLDivElement>(null)
  const previousSection = useRef(state.activeSection)
  useLayoutEffect(() => {
    if (previousSection.current === state.activeSection) return
    const scroll = root.current?.closest<HTMLElement>("[data-ap-scroll]")
    if (scroll) scroll.scrollTop = state.sectionScroll[state.activeSection] ?? 0
    previousSection.current = state.activeSection
  }, [state.activeSection, state.sectionScroll])
  const locked = writeLocked(state)
  const orgWrite = canWrite(account, scenario, "organization.write")
  const memberWrite = canWrite(account, scenario, "members.write")
  const projectWrite = canWrite(account, scenario, "project.write")
  const profile = state.profileDraft ?? profileFromAccount(account)
  const profileErrors = validateProfile(profile, account, en)
  const dirty = profileDirty(profile, account)
  const features = state.featureDraft ?? state.features
  const featureDirty = Object.keys(features).some(
    (key) =>
      features[key as keyof typeof features] !==
      state.features[key as keyof typeof features],
  )
  const labels: Record<OrgSectionId, string> = {
    general: t("General", "通用"),
    verification: t("Verification & features", "验证与功能"),
    "admin-keys": t("Admin keys", "管理密钥"),
    members: t("Members", "成员"),
    invitations: t("Invitations", "邀请"),
    groups: t("Groups", "用户组"),
    roles: t("Roles", "角色"),
    projects: t("Projects", "项目"),
  }
  const roleName = (id: string) =>
    account.roles.find((r) => r.roleId === id)?.name[locale] ??
    t("Unknown role", "未知角色")
  const roleOptions = account.roles.map((r) => ({
    value: r.roleId,
    label: r.name[locale],
  }))
  const permissionName = (id: string) =>
    ({
      "project.read": t("Read projects", "查看项目"),
      "organization.write": t("Manage organization", "管理组织"),
      "project.write": t("Manage projects", "管理项目"),
      "keys.write": t("Manage keys", "管理密钥"),
      "members.write": t("Manage members", "管理成员"),
      "billing.write": t("Manage billing", "管理账单"),
      "integrations.read": t("Read integrations", "查看集成"),
      "integrations.write": t("Manage integrations", "管理集成"),
      "organization.read": t("Read organization", "查看组织"),
      "billing.read": t("Read billing", "查看账单"),
    })[id] ?? id
  const members = account.members.filter((m) => m.invitationState === "active")
  const invitations = account.members.filter(
    (m) => m.invitationState === "invited",
  )
  const filtered = members.filter(
    (m) =>
      (state.memberType === "all" || (m.type ?? "user") === state.memberType) &&
      `${m.name} ${m.email}`
        .toLowerCase()
        .includes(state.memberSearch.toLowerCase()),
  )
  const dialog = state.dialog
  const form = dialog
    ? (state.drafts[dialogKey(dialog)] ?? formFromAccount(dialog, account))
    : null
  const formErrors =
    dialog && form ? validateForm(dialog, form, account, en) : {}
  const formatDate = (date: string | null | undefined) =>
    date
      ? new Intl.DateTimeFormat(en ? "en-US" : "zh-CN", {
          timeZone: "UTC",
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(date))
      : t("Unknown", "未知")

  // Depend on the actual immutable operation, rather than a partial list of its properties.
  useEffect(() => {
    const captured = state.save
    if (captured.status !== "pending") return
    const timer = setTimeout(() => {
      let confirmed = false
      setState((current) => {
        const next = finishOperation(current, captured, account, scenario)
        confirmed = next !== current && next.save.status === "confirmed"
        return next
      })
      if (confirmed && captured.request)
        setAccount((current) => applyAccountRequest(current, captured.request!))
    }, orgOperationDelayMs)
    return () => clearTimeout(timer)
  }, [state.save, account, scenario, setState, setAccount])
  useEffect(() => {
    if (state.refresh !== "pending") return
    const timer = setTimeout(() => setState(settleRefresh), orgOperationDelayMs)
    return () => clearTimeout(timer)
  }, [state.refresh, state.refreshIntent, setState])

  function openDialog(next: OrgDialog) {
    setState((current) => ({ ...current, dialog: next }))
  }
  function closeDialog(discard = false) {
    if (locked) return
    setState((current) => {
      const drafts = { ...current.drafts }
      if (discard && current.dialog) delete drafts[dialogKey(current.dialog)]
      return { ...current, drafts, dialog: null }
    })
  }
  function updateForm(patch: Partial<OrgFormDraft>) {
    if (!dialog || !form || locked) return
    setState((current) => ({
      ...current,
      drafts: { ...current.drafts, [dialogKey(dialog)]: { ...form, ...patch } },
    }))
  }
  function submit(request: OrgRequest) {
    setState((current) => beginSave(current, request, account, scenario))
  }
  function receipt(): ReactNode {
    if (state.save.status === "idle") return null
    const status = state.save.status
    return (
      <div
        className={styles.receipt}
        data-ap-receipt
        data-status={status}
        data-ap-operation={state.save.operationId ?? undefined}
      >
        <p role="status">
          {status === "pending"
            ? state.save.intent === "check"
              ? t("Checking recorded result…", "正在查询记录结果…")
              : t("Saving…", "正在保存…")
            : status === "confirmed"
              ? t(
                  "Confirmed in the local fixture.",
                  "已在本地 fixture 中确认。",
                )
              : status === "rejected"
                ? t(
                    `Rejected${state.save.reason ? ` (${state.save.reason})` : ""}; confirmed data and drafts are kept.`,
                    `已拒绝${state.save.reason ? `（${state.save.reason}）` : ""}；已保留确认数据与草稿。`,
                  )
                : t(
                    `Result unknown · ${state.save.operationId}. The original request is retained; it will not be replayed.`,
                    `结果未知 · ${state.save.operationId}。原始请求已保留，不会自动重放。`,
                  )}
        </p>
        {status === "unknown" && (
          <Button
            variant="outline"
            data-ap-check
            onClick={() => setState(beginCheck)}
          >
            {t("Check result", "查询结果")}
          </Button>
        )}
      </div>
    )
  }
  function sectionHeading(
    title: string,
    description: string,
    actions?: ReactNode,
  ) {
    return (
      <div className={styles.sectionHeading}>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    )
  }
  function empty(message: string) {
    return <div className={styles.empty}>{message}</div>
  }
  function table(
    headers: string[],
    rows: ReactNode,
    widths?: string[],
    matrix = false,
  ) {
    return (
      <TableContainer className={styles.tableContainer}>
        <Table
          className={`${styles.table} ${matrix ? styles.matrix : ""}`}
          aria-label={labels[state.activeSection]}
        >
          {widths && (
            <colgroup>
              {widths.map((width, i) => (
                <col key={i} style={{ width }} />
              ))}
            </colgroup>
          )}
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header}>{header}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>{rows}</TableBody>
        </Table>
      </TableContainer>
    )
  }
  function inviteAction() {
    return (
      <Button
        data-ap-invite-open
        disabled={!memberWrite || locked}
        onClick={() => openDialog({ kind: "invite" })}
      >
        <Plus size={16} aria-hidden />
        {t("Invite member", "邀请成员")}
      </Button>
    )
  }
  function renderSection(section: OrgSectionId): ReactNode {
    switch (section) {
      case "general":
        return (
          <section className={styles.general} data-ap-section="general">
            {sectionHeading(
              t("Organization profile", "组织资料"),
              t(
                "Defaults shared by every project in this organization.",
                "本组织所有项目共享的默认配置。",
              ),
            )}
            <div className={styles.identity} data-ap-org-identity>
              <span className={styles.identityIcon}>
                <Building2 size={20} aria-hidden />
              </span>
              <div className={styles.identityText}>
                <p title={account.organization.name} data-ap-org-name>
                  {account.organization.name}
                </p>
                <code data-ap-org-id>{account.organization.orgId}</code>
              </div>
              <Badge className={styles.badge}>
                {t("Team workspace", "团队工作区")}
              </Badge>
            </div>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault()
                if (dirty && !Object.keys(profileErrors).length)
                  submit({ kind: "profile", profile })
              }}
            >
              <div className={styles.fields}>
                <Field
                  className={styles.field}
                  label={t("Organization name", "组织名称")}
                  error={state.profileDraft ? profileErrors.name : undefined}
                >
                  {(props) => (
                    <Input
                      {...props}
                      data-ap-org-name-input
                      value={profile.name}
                      disabled={!orgWrite || locked}
                      onChange={(event) =>
                        setState((current) => ({
                          ...current,
                          profileDraft: {
                            ...profile,
                            name: event.target.value,
                          },
                        }))
                      }
                    />
                  )}
                </Field>
                <Field
                  className={styles.field}
                  label={t("Contact email", "联系邮箱")}
                  description={t(
                    "Shown in demo organization communications.",
                    "显示在演示组织的通信资料中。",
                  )}
                  error={
                    state.profileDraft ? profileErrors.contactEmail : undefined
                  }
                >
                  {(props) => (
                    <Input
                      {...props}
                      type="email"
                      data-ap-org-email-input
                      value={profile.contactEmail}
                      disabled={!orgWrite || locked}
                      onChange={(event) =>
                        setState((current) => ({
                          ...current,
                          profileDraft: {
                            ...profile,
                            contactEmail: event.target.value,
                          },
                        }))
                      }
                    />
                  )}
                </Field>
                <div className={styles.twoColumns}>
                  <Field
                    className={styles.field}
                    label={t("Time zone", "时区")}
                    error={profileErrors.timeZone}
                  >
                    {() => (
                      <ApSelect
                        label={t("Organization time zone", "组织时区")}
                        value={profile.timeZone}
                        options={orgTimeZones.map((value) => ({
                          value,
                          label: value,
                        }))}
                        disabled={!orgWrite || locked}
                        onChange={(timeZone) =>
                          setState((current) => ({
                            ...current,
                            profileDraft: { ...profile, timeZone },
                          }))
                        }
                      />
                    )}
                  </Field>
                  <Field
                    className={styles.field}
                    label={t("Default member role", "默认成员角色")}
                    error={profileErrors.defaultMemberRoleId}
                  >
                    {() => (
                      <ApSelect
                        label={t("Default member role", "默认成员角色")}
                        value={profile.defaultMemberRoleId}
                        options={roleOptions}
                        disabled={!orgWrite || locked}
                        onChange={(defaultMemberRoleId) =>
                          setState((current) => ({
                            ...current,
                            profileDraft: { ...profile, defaultMemberRoleId },
                          }))
                        }
                      />
                    )}
                  </Field>
                </div>
              </div>
              <div className={styles.formFooter}>
                <Button
                  type="button"
                  variant="outline"
                  data-ap-profile-discard
                  disabled={!orgWrite || locked}
                  onClick={() =>
                    setState((current) => ({ ...current, profileDraft: null }))
                  }
                >
                  {t("Discard", "放弃更改")}
                </Button>
                <Button
                  type="submit"
                  data-ap-profile-save
                  disabled={
                    !orgWrite ||
                    locked ||
                    !dirty ||
                    !!Object.keys(profileErrors).length
                  }
                >
                  {t("Save changes", "保存更改")}
                </Button>
              </div>
            </form>
          </section>
        )
      case "verification":
        return (
          <section className={styles.general} data-ap-section="verification">
            {sectionHeading(
              labels.verification,
              t(
                "Review your organization identity and optional capabilities.",
                "查看组织身份与可选功能。",
              ),
            )}
            <div className={styles.verified}>
              <ShieldCheck size={24} aria-hidden />
              <div>
                <h3>{t("Organization verified", "组织已验证")}</h3>
                <p>
                  {account.organization.name} LLC ·{" "}
                  {t(
                    "Demo verification completed Aug 20",
                    "演示验证于8月20日完成",
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => openDialog({ kind: "verification" })}
              >
                {t("View details", "查看详情")}
              </Button>
            </div>
            {(
              [
                [
                  "sharedAccess",
                  t("Shared project access", "共享项目访问"),
                  t(
                    "Allow members to discover projects shared with their groups.",
                    "允许成员发现与所在用户组共享的项目。",
                  ),
                ],
                [
                  "externalPlugins",
                  t("External plugins", "外部插件"),
                  t(
                    "Allow project owners to install plugins from outside the organization.",
                    "允许项目负责人安装来自组织外部的插件。",
                  ),
                ],
                [
                  "evaluationProviders",
                  t("External evaluation providers", "外部评测提供商"),
                  t(
                    "Allow approved providers in evaluation workspaces.",
                    "允许已批准的提供商在评测工作区中使用。",
                  ),
                ],
              ] as const
            ).map(([key, label, description]) => (
              <div className={styles.feature} key={key}>
                <div>
                  <label htmlFor={`ap-org-feature-${key}`}>{label}</label>
                  <p>{description}</p>
                </div>
                <Switch
                  id={`ap-org-feature-${key}`}
                  aria-label={label}
                  checked={features[key]}
                  disabled={!orgWrite || locked}
                  onCheckedChange={(checked) =>
                    setState((current) => ({
                      ...current,
                      featureDraft: { ...features, [key]: checked },
                    }))
                  }
                />
              </div>
            ))}
            <div className={styles.formFooter}>
              {featureDirty && (
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() =>
                    setState((current) => ({ ...current, featureDraft: null }))
                  }
                >
                  {t("Discard", "放弃更改")}
                </Button>
              )}
              <Button
                disabled={!orgWrite || locked || !featureDirty}
                onClick={() =>
                  submit({ kind: "features", preferences: features })
                }
              >
                {t("Save preferences", "保存偏好")}
              </Button>
            </div>
          </section>
        )
      case "admin-keys":
        return (
          <section data-ap-section="admin-keys">
            {sectionHeading(
              labels[section],
              t(
                "Scoped credentials for organization administration.",
                "用于组织管理的范围化凭据。",
              ),
              <Button
                disabled={!orgWrite || locked}
                onClick={() => openDialog({ kind: "admin-key" })}
              >
                <Plus size={16} aria-hidden />
                {t("Create admin key", "创建管理密钥")}
              </Button>,
            )}
            {state.adminKeys.length
              ? table(
                  [
                    t("Name", "名称"),
                    t("Scopes", "范围"),
                    t("Created", "创建日期"),
                    t("Status", "状态"),
                    t("Actions", "操作"),
                  ],
                  state.adminKeys.map((key) => (
                    <TableRow key={key.keyId} data-ap-admin-key={key.keyId}>
                      <TableCell>
                        <span className={styles.memberIdentity}>
                          <KeyRound size={20} aria-hidden />
                          <span>
                            <p>{key.name}</p>
                            <code className={styles.secondary}>
                              {key.masked}
                            </code>
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        {key.scopes.map((scope) => (
                          <p className={styles.secondary} key={scope}>
                            {permissionName(scope)}
                          </p>
                        ))}
                      </TableCell>
                      <TableCell>{formatDate(key.createdAt)}</TableCell>
                      <TableCell>
                        <Badge className={styles.badge}>
                          {key.status === "active"
                            ? t("● Active", "● 有效")
                            : t("Revoked", "已撤销")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          disabled={
                            !orgWrite || locked || key.status === "revoked"
                          }
                          onClick={() =>
                            openDialog({
                              kind: "remove",
                              removeKind: "admin-key",
                              targetId: key.keyId,
                            })
                          }
                        >
                          {t("Revoke", "撤销")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )),
                  ["35%", "20%", "16%", "12%", "17%"],
                )
              : empty(t("No admin keys.", "暂无管理密钥。"))}
            <p className={styles.note}>
              {t(
                "Admin keys do not run models. Manage project API keys in the API Platform section.",
                "管理密钥不能运行模型。项目 API 密钥可在 API Platform 的密钥页面中管理。",
              )}
            </p>
          </section>
        )
      case "members":
        return (
          <section data-ap-section="members">
            {sectionHeading(
              labels.members,
              t(
                "People and service accounts with access to this organization.",
                "可访问本组织的人员与服务账户。",
              ),
              <>
                <Button
                  variant="outline"
                  disabled={!memberWrite || locked}
                  onClick={() => openDialog({ kind: "service" })}
                >
                  <Plus size={16} aria-hidden />
                  {t("Service account", "服务账户")}
                </Button>
                {inviteAction()}
              </>,
            )}
            <div className={styles.filters}>
              <div className={styles.search}>
                <ApSearch
                  label={t("Search members", "搜索成员")}
                  placeholder={t("Search name or email…", "搜索姓名或邮箱…")}
                  value={state.memberSearch}
                  onChange={(memberSearch) =>
                    setState((current) => ({ ...current, memberSearch }))
                  }
                />
              </div>
              <div className={styles.typeFilter}>
                <ApSelect
                  label={t("Member type", "成员类型")}
                  value={state.memberType}
                  options={[
                    { value: "all", label: t("All members", "全部成员") },
                    { value: "user", label: t("Users", "用户") },
                    {
                      value: "service-account",
                      label: t("Service accounts", "服务账户"),
                    },
                  ]}
                  onChange={(value) =>
                    setState((current) => ({
                      ...current,
                      memberType: value as typeof current.memberType,
                    }))
                  }
                />
              </div>
            </div>
            {filtered.length
              ? table(
                  [
                    t("Member", "成员"),
                    t("Type", "类型"),
                    t("Role", "角色"),
                    t("Actions", "操作"),
                  ],
                  filtered.map((member) => (
                    <TableRow
                      key={member.memberId}
                      data-row-id={member.memberId}
                    >
                      <TableCell>
                        <div className={styles.memberIdentity}>
                          <UserRound size={20} aria-hidden />
                          <div>
                            <p title={member.name}>
                              {member.name}
                              {member.memberId === account.profile.memberId
                                ? t(" (you)", "（你）")
                                : ""}
                            </p>
                            <p className={styles.secondary}>{member.email}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {member.type === "service-account"
                          ? t("Service account", "服务账户")
                          : t("User", "用户")}
                      </TableCell>
                      <TableCell>
                        <Badge className={styles.badge}>
                          {roleName(member.roleId)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          data-ap-edit-role={member.memberId}
                          disabled={
                            !memberWrite ||
                            locked ||
                            member.memberId === account.profile.memberId
                          }
                          onClick={() =>
                            openDialog({
                              kind: "member",
                              targetId: member.memberId,
                            })
                          }
                        >
                          {t("Edit role", "编辑角色")}
                        </Button>
                        <Button
                          variant="ghost"
                          data-ap-remove-member={member.memberId}
                          disabled={
                            !memberWrite ||
                            locked ||
                            member.memberId === account.profile.memberId
                          }
                          onClick={() =>
                            openDialog({
                              kind: "remove",
                              removeKind: "member",
                              targetId: member.memberId,
                            })
                          }
                        >
                          {t("Remove", "移除")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )),
                  ["35%", "20%", "20%", "25%"],
                )
              : empty(
                  members.length
                    ? t(
                        "No matching members. Clear the search or member-type filter.",
                        "无匹配成员。请清除搜索或成员类型筛选。",
                      )
                    : t("No members in this fixture.", "此 fixture 暂无成员。"),
                )}
            <p className={styles.note}>
              {members.length} {t("members", "位成员")} · {invitations.length}{" "}
              {t(
                "pending invitations. The workspace owner always retains access.",
                "个待接受邀请。工作区负责人始终保留访问权限。",
              )}
            </p>
          </section>
        )
      case "invitations":
        return (
          <section data-ap-section="invitations">
            {sectionHeading(
              labels.invitations,
              t(
                "Pending access requests for your organization.",
                "等待接受的组织访问邀请。",
              ),
              inviteAction(),
            )}
            {invitations.length
              ? table(
                  [
                    t("Email", "邮箱"),
                    t("Role", "角色"),
                    t("Expires", "到期日"),
                    t("Actions", "操作"),
                  ],
                  invitations.map((member) => (
                    <TableRow
                      key={member.memberId}
                      data-row-id={member.memberId}
                    >
                      <TableCell className="break-all">
                        {member.email}
                      </TableCell>
                      <TableCell>{roleName(member.roleId)}</TableCell>
                      <TableCell>
                        {formatDate(member.invitedExpiresAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          data-ap-resend-invite={member.memberId}
                          disabled={!memberWrite || locked}
                          onClick={() =>
                            submit({
                              kind: "resend",
                              memberId: member.memberId,
                            })
                          }
                        >
                          {t("Resend", "重新发送")}
                        </Button>
                        <Button
                          variant="ghost"
                          data-ap-cancel-invite={member.memberId}
                          disabled={!memberWrite || locked}
                          onClick={() =>
                            openDialog({
                              kind: "remove",
                              removeKind: "invitation",
                              targetId: member.memberId,
                            })
                          }
                        >
                          {t("Cancel invitation", "取消邀请")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )),
                  ["30%", "16%", "20%", "34%"],
                )
              : empty(t("No pending invitations.", "暂无待接受邀请。"))}
          </section>
        )
      case "groups":
        return (
          <section data-ap-section="groups">
            {sectionHeading(
              labels.groups,
              t(
                "Give a team a shared role and manage its membership.",
                "为团队设置共享角色并管理其成员。",
              ),
              <Button
                data-ap-create-group-open
                disabled={!memberWrite || locked}
                onClick={() => openDialog({ kind: "group" })}
              >
                <Plus size={16} aria-hidden />
                {t("Create group", "创建用户组")}
              </Button>,
            )}
            {account.groups.length ? (
              <div className={styles.groupList}>
                {account.groups.map((group) => (
                  <div
                    className={styles.group}
                    data-ap-group={group.groupId}
                    key={group.groupId}
                  >
                    <UsersRound size={20} aria-hidden />
                    <div className={styles.groupText}>
                      <h3>{group.name}</h3>
                      {group.description && <p>{group.description}</p>}
                      <p>
                        {
                          account.members.filter((m) =>
                            m.groupIds.includes(group.groupId),
                          ).length
                        }{" "}
                        {t("members", "位成员")} ·{" "}
                        {group.roleId
                          ? roleName(group.roleId)
                          : t("Unknown role", "未知角色")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      data-ap-manage-group={group.groupId}
                      disabled={!memberWrite || locked}
                      onClick={() =>
                        openDialog({ kind: "group", targetId: group.groupId })
                      }
                    >
                      {t("Manage", "管理")}
                    </Button>
                    <Button
                      variant="ghost"
                      data-ap-delete-group={group.groupId}
                      disabled={!memberWrite || locked}
                      onClick={() =>
                        openDialog({
                          kind: "remove",
                          removeKind: "group",
                          targetId: group.groupId,
                        })
                      }
                    >
                      {t("Delete", "删除")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              empty(t("No groups.", "暂无用户组。"))
            )}
          </section>
        )
      case "roles":
        return (
          <section data-ap-section="roles">
            {sectionHeading(
              t("Roles & permissions", "角色与权限"),
              t(
                "Review the permission matrix or define a custom role.",
                "查看权限矩阵或定义自定义角色。",
              ),
              <Button
                data-ap-create-role-open
                disabled={!memberWrite || locked}
                onClick={() => openDialog({ kind: "role" })}
              >
                <Plus size={16} aria-hidden />
                {t("Create role", "创建角色")}
              </Button>,
            )}
            {table(
              [
                t("Permission", "权限"),
                ...account.roles.map((role) => role.name[locale]),
              ],
              <>
                {[
                  ...new Set([
                    ...orgCapabilities,
                    ...account.roles.flatMap((r) => r.capabilities),
                  ]),
                ].map((capability) => (
                  <TableRow key={capability}>
                    <TableCell>{permissionName(capability)}</TableCell>
                    {account.roles.map((role) => (
                      <TableCell
                        key={role.roleId}
                        data-ap-role-cell={`${role.roleId}:${capability}`}
                      >
                        {role.capabilities.includes(capability) ? (
                          <Check
                            size={16}
                            role="img"
                            aria-label={t("Allowed", "允许")}
                          />
                        ) : (
                          <span
                            aria-label={t("Not allowed", "不允许")}
                            className="text-muted-foreground"
                          >
                            —
                          </span>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell>{t("Manage role", "管理角色")}</TableCell>
                  {account.roles.map((role) => (
                    <TableCell key={role.roleId}>
                      {isBuiltinRole(role.roleId) ? (
                        <span className={styles.secondary}>
                          {t("Built in", "内置")}
                        </span>
                      ) : (
                        <div className="flex justify-center">
                          <Button
                            variant="ghost"
                            disabled={!memberWrite || locked}
                            data-ap-edit-custom-role={role.roleId}
                            onClick={() =>
                              openDialog({
                                kind: "role",
                                targetId: role.roleId,
                              })
                            }
                          >
                            {t("Edit", "编辑")}
                          </Button>
                          <Button
                            variant="ghost"
                            data-ap-delete-role={role.roleId}
                            disabled={!memberWrite || locked}
                            onClick={() =>
                              openDialog({
                                kind: "remove",
                                removeKind: "role",
                                targetId: role.roleId,
                              })
                            }
                          >
                            {t("Delete", "删除")}
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              </>,
              undefined,
              true,
            )}
            <p className={styles.note}>
              {t(
                "Built-in roles cannot be edited. Remove role assignments before deleting a custom role.",
                "内置角色不可编辑。删除自定义角色前请先移除其关联。",
              )}
            </p>
          </section>
        )
      case "projects":
        return (
          <section data-ap-section="projects">
            {sectionHeading(
              labels.projects,
              t(
                "Each project has its own resources, members, and planning budget.",
                "每个项目都有独立的资源、成员和预算。",
              ),
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob(
                      [
                        JSON.stringify(
                          {
                            fixture: true,
                            orgId: account.organization.orgId,
                            projects: account.projects,
                          },
                          null,
                          2,
                        ),
                      ],
                      { type: "application/json" },
                    )
                    const url = URL.createObjectURL(blob)
                    const anchor = document.createElement("a")
                    anchor.href = url
                    anchor.download = "organization-projects.json"
                    anchor.click()
                    URL.revokeObjectURL(url)
                  }}
                >
                  {t("Export", "导出")}
                </Button>
                <Button
                  disabled={!projectWrite || locked}
                  onClick={() => openDialog({ kind: "project" })}
                >
                  <Plus size={16} aria-hidden />
                  {t("Create project", "创建项目")}
                </Button>
              </>,
            )}
            {account.projects.length
              ? table(
                  [
                    t("Project", "项目"),
                    t("Members", "成员"),
                    t("Budget / month", "每月预算"),
                    t("Status", "状态"),
                    t("Actions", "操作"),
                  ],
                  account.projects.map((project) => (
                    <TableRow
                      key={project.projectId}
                      data-row-id={project.projectId}
                    >
                      <TableCell>
                        <p className="font-medium break-words">
                          {project.name}
                        </p>
                        <p className={styles.secondary}>
                          {project.description}
                        </p>
                      </TableCell>
                      <TableCell>
                        {
                          members.filter((m) =>
                            m.projectIds.includes(project.projectId),
                          ).length
                        }
                      </TableCell>
                      <TableCell>
                        {formatBudget(
                          project.monthlyBudgetMicroUsd ??
                            account.organization.monthlyBudgetMicroUsd,
                          en,
                        )}
                        {project.monthlyBudgetMicroUsd === null && (
                          <p className={styles.secondary}>
                            {t("Inherited from organization", "继承自组织")}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={styles.badge}>
                          {t("● Active", "● 有效")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          disabled={!projectWrite || locked}
                          data-ap-manage-project={project.projectId}
                          onClick={() =>
                            openDialog({
                              kind: "project",
                              targetId: project.projectId,
                            })
                          }
                        >
                          {t("Manage", "管理")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )),
                  ["44%", "12%", "18%", "12%", "14%"],
                )
              : empty(t("No projects.", "暂无项目。"))}
          </section>
        )
    }
  }
  function dialogRequest(): OrgRequest | null {
    if (!dialog || !form) return null
    const id = `${account.organization.orgId}-${dialog.kind}-${state.sequence + 1}`
    switch (dialog.kind) {
      case "invite":
        return {
          kind: "invite",
          memberId: id,
          email: form.email.trim(),
          roleId: form.roleId,
        }
      case "service":
        return {
          kind: "service",
          memberId: id,
          name: form.name.trim(),
          roleId: form.roleId,
        }
      case "member":
        return {
          kind: "member-role",
          memberId: dialog.targetId!,
          roleId: form.roleId,
        }
      case "group":
        return {
          kind: "group",
          groupId: dialog.targetId ?? id,
          name: form.name.trim(),
          description: form.description.trim(),
          roleId: form.roleId,
          memberIds: form.memberIds,
        }
      case "role":
        return {
          kind: "role",
          roleId: dialog.targetId ?? id,
          name: form.name.trim(),
          capabilities: form.capabilities,
        }
      case "project":
        return {
          kind: "project",
          projectId: dialog.targetId ?? id,
          name: form.name.trim(),
          description: form.description.trim(),
        }
      case "admin-key":
        return {
          kind: "admin-key",
          key: {
            keyId: id,
            name: form.name.trim(),
            masked: `demo_admin_••••${state.sequence + 1}`,
            scopes: form.scopes,
            createdAt: apAsOf,
            status: "active",
          },
        }
      case "remove":
        switch (dialog.removeKind) {
          case "member":
          case "invitation":
            return { kind: "member-remove", memberId: dialog.targetId! }
          case "group":
            return { kind: "group-delete", groupId: dialog.targetId! }
          case "role":
            return { kind: "role-delete", roleId: dialog.targetId! }
          case "admin-key":
            return { kind: "admin-revoke", keyId: dialog.targetId! }
          default:
            return null
        }
      default:
        return null
    }
  }
  function checkOptions(
    ids: readonly string[],
    selected: string[],
    onChange: (values: string[]) => void,
    label: (id: string) => string,
  ) {
    return (
      <div className={styles.checkOptions}>
        {ids.map((id) => (
          <div className={styles.checkOption} key={id}>
            <Checkbox
              id={`org-option-${id}`}
              aria-label={label(id)}
              checked={selected.includes(id)}
              disabled={
                locked ||
                !(dialog?.kind === "admin-key" ? orgWrite : memberWrite)
              }
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, id]
                    : selected.filter((value) => value !== id),
                )
              }
            />
            <label htmlFor={`org-option-${id}`}>{label(id)}</label>
          </div>
        ))}
      </div>
    )
  }
  function renderDialog() {
    if (!active || !dialog || !form) return null
    const request = dialogRequest()
    const allowed = request
      ? canWrite(account, scenario, requestCapability(request))
      : true
    const targetName =
      dialog.removeKind === "group"
        ? account.groups.find((g) => g.groupId === dialog.targetId)?.name
        : dialog.removeKind === "role"
          ? roleName(dialog.targetId!)
          : dialog.removeKind === "admin-key"
            ? state.adminKeys.find((k) => k.keyId === dialog.targetId)?.name
            : account.members.find((m) => m.memberId === dialog.targetId)?.name
    const title =
      dialog.kind === "verification"
        ? t("Verification details", "验证详情")
        : dialog.kind === "invite"
          ? t("Invite member", "邀请成员")
          : dialog.kind === "service"
            ? t("Create service account", "创建服务账户")
            : dialog.kind === "member"
              ? `${t("Edit", "编辑")} ${account.members.find((m) => m.memberId === dialog.targetId)?.name ?? ""}`
              : dialog.kind === "group"
                ? dialog.targetId
                  ? t("Manage group", "管理用户组")
                  : t("Create group", "创建用户组")
                : dialog.kind === "role"
                  ? dialog.targetId
                    ? t("Edit role", "编辑角色")
                    : t("Create role", "创建角色")
                  : dialog.kind === "project"
                    ? dialog.targetId
                      ? t("Manage project", "管理项目")
                      : t("Create project", "创建项目")
                    : dialog.kind === "admin-key"
                      ? t("Create admin key", "创建管理密钥")
                      : `${dialog.removeKind === "admin-key" ? t("Revoke", "撤销") : t("Remove", "移除")} ${targetName ?? t("item", "项目")}?`
    const description =
      dialog.kind === "verification"
        ? t(
            "Illustrative organization verification record.",
            "演示组织验证记录。",
          )
        : dialog.kind === "invite"
          ? t(
              "This showcase records the invitation locally; no email is sent.",
              "此展示仅在本地记录邀请，不会发送邮件。",
            )
          : dialog.kind === "remove"
            ? dialog.removeKind === "admin-key"
              ? t(
                  "The key will be marked revoked in this demo.",
                  "密钥将仅在本地演示中标记为已撤销。",
                )
              : dialog.removeKind === "member"
                ? t(
                    "Their group memberships will also be removed from this demo.",
                    "同时移除此成员在演示中的用户组关系。",
                  )
                : t(
                    "This removes the selected item from the demo workspace.",
                    "仅从演示工作区移除所选项目。",
                  )
            : ["project", "admin-key"].includes(dialog.kind)
              ? t(
                  "Changes are saved only in this demo session.",
                  "更改仅保存在本次演示会话中。",
                )
              : t(
                  "Update access within this demo organization.",
                  "更新此演示组织中的访问权限。",
                )
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
      >
        <DialogContent className={styles.dialog} data-ap-dialog={dialog.kind}>
          <DialogTitle className={styles.dialogTitle}>{title}</DialogTitle>
          <DialogDescription className={styles.dialogDescription}>
            {description}
          </DialogDescription>
          {dialog.kind === "verification" ? (
            <dl className={styles.detailsGrid}>
              {[
                [
                  t("Legal name", "法定名称"),
                  `${account.organization.name} LLC`,
                ],
                [t("Country", "国家"), t("United States", "美国")],
                [t("Status", "状态"), t("Verified (demo)", "已验证（演示）")],
                [
                  t("Review date", "审核日期"),
                  formatDate("2026-08-20T00:00:00Z"),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (request && allowed && !Object.keys(formErrors).length)
                  submit(request)
              }}
            >
              {dialog.kind !== "remove" && (
                <div className={styles.dialogFields}>
                  {[
                    "service",
                    "group",
                    "role",
                    "project",
                    "admin-key",
                  ].includes(dialog.kind) && (
                    <Field
                      className={styles.dialogField}
                      label={t("Name", "名称")}
                      error={
                        state.drafts[dialogKey(dialog)]
                          ? formErrors.name
                          : undefined
                      }
                    >
                      {(props) => (
                        <Input
                          {...props}
                          data-ap-form-name
                          value={form.name}
                          disabled={!allowed || locked}
                          onChange={(event) =>
                            updateForm({ name: event.target.value })
                          }
                        />
                      )}
                    </Field>
                  )}
                  {dialog.kind === "invite" && (
                    <Field
                      className={styles.dialogField}
                      label={t("Email address", "邮箱地址")}
                      error={
                        state.drafts[dialogKey(dialog)]
                          ? formErrors.email
                          : undefined
                      }
                    >
                      {(props) => (
                        <Input
                          {...props}
                          type="email"
                          placeholder="teammate@example.invalid"
                          data-ap-invite-email
                          value={form.email}
                          disabled={!allowed || locked}
                          onChange={(event) =>
                            updateForm({ email: event.target.value })
                          }
                        />
                      )}
                    </Field>
                  )}
                  {["service", "group", "member", "invite"].includes(
                    dialog.kind,
                  ) && (
                    <Field
                      className={styles.dialogField}
                      label={t("Role", "角色")}
                      error={formErrors.roleId}
                    >
                      {() => (
                        <ApSelect
                          label={t("Access role", "访问角色")}
                          value={form.roleId}
                          options={roleOptions}
                          disabled={!allowed || locked}
                          onChange={(roleId) => updateForm({ roleId })}
                        />
                      )}
                    </Field>
                  )}
                  {["project", "group"].includes(dialog.kind) && (
                    <Field
                      className={styles.dialogField}
                      label={t("Description", "描述")}
                    >
                      {(props) => (
                        <Textarea
                          {...props}
                          rows={2}
                          value={form.description}
                          disabled={!allowed || locked}
                          onChange={(event) =>
                            updateForm({ description: event.target.value })
                          }
                        />
                      )}
                    </Field>
                  )}
                  {dialog.kind === "group" && (
                    <div>
                      <p>{t("Group members", "用户组成员")}</p>
                      <p className="text-sm text-muted-foreground">
                        {t(
                          "Choose people or service accounts already in this organization.",
                          "选择已加入本组织的人员或服务账户。",
                        )}
                      </p>
                      {checkOptions(
                        members.map((m) => m.memberId),
                        form.memberIds,
                        (memberIds) => updateForm({ memberIds }),
                        (id) => members.find((m) => m.memberId === id)!.name,
                      )}
                    </div>
                  )}
                  {dialog.kind === "role" && (
                    <div>
                      <p>{t("Permissions", "权限")}</p>
                      {checkOptions(
                        orgCapabilities,
                        form.capabilities,
                        (capabilities) => updateForm({ capabilities }),
                        permissionName,
                      )}
                    </div>
                  )}
                  {dialog.kind === "admin-key" && (
                    <div>
                      <p>{t("Scopes", "范围")}</p>
                      {checkOptions(
                        orgAdminScopes,
                        form.scopes,
                        (scopes) => updateForm({ scopes }),
                        permissionName,
                      )}
                      {formErrors.scopes && (
                        <p role="alert" className="text-sm text-destructive">
                          {formErrors.scopes}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {state.save.status !== "idle" &&
                state.save.section === state.activeSection &&
                receipt()}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked}
                  onClick={() => closeDialog(true)}
                >
                  {dialog.kind === "remove"
                    ? dialog.removeKind === "admin-key"
                      ? t("Keep key", "保留密钥")
                      : t("Keep", "保留")
                    : t("Cancel", "取消")}
                </Button>
                <Button
                  type="submit"
                  variant={dialog.kind === "remove" ? "destructive" : "default"}
                  disabled={
                    !allowed || locked || !!Object.keys(formErrors).length
                  }
                >
                  {dialog.kind === "remove"
                    ? dialog.removeKind === "admin-key"
                      ? t("Revoke key", "撤销密钥")
                      : t("Remove", "移除")
                    : dialog.kind === "invite"
                      ? t("Add demo invitation", "添加演示邀请")
                      : dialog.kind === "admin-key" ||
                          (dialog.kind === "project" && !dialog.targetId)
                        ? t("Create", "创建")
                        : t("Save", "保存")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <ApPage
      variant="reference"
      pageId="organization-settings"
      title={t("Organization settings", "组织设置")}
      description={`${account.organization.name} · ${t("Organization-wide identity, access, and projects.", "组织级身份、访问与项目配置。")}`}
      actions={
        <a
          href="/showcase/billing"
          className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm"
        >
          {t("Billing", "账单")}
          <ArrowUpRight size={14} aria-hidden />
        </a>
      }
    >
      <div ref={root} className={styles.root}>
        {!orgWrite && (
          <p
            data-ap-readonly-note
            className="mb-4 text-sm text-muted-foreground"
          >
            {scenario === "readonly"
              ? t(
                  "Read-only scene: organization writes are disabled.",
                  "只读场景：组织写入已禁用。",
                )
              : t(
                  "Your acting role is missing or lacks organization-write permission.",
                  "当前角色缺失或无组织写入权限。",
                )}
          </p>
        )}
        <DataRegion
          state={
            !state.loaded
              ? "loading"
              : state.refresh === "error"
                ? "error"
                : scenario === "missing-data"
                  ? "partial"
                  : "success"
          }
          hasContent={state.loaded}
          refreshing={state.refresh === "pending"}
          updatedAt={apAsOf}
          error={{
            category: "network",
            message: t(
              "The organization refresh failed.",
              "组织数据刷新失败。",
            ),
            reason: t(
              "Previous organization values and drafts are retained.",
              "已保留上一次的组织数据与草稿。",
            ),
          }}
          onRetry={
            state.refresh === "error"
              ? () => setState((current) => beginRefresh(current, "retry"))
              : undefined
          }
          partialDescription={t(
            "Some referenced account values are missing; unknown is not zero.",
            "部分关联账户信息缺失；未知不代表零。",
          )}
        >
          {state.loaded && (
            <Tabs
              value={state.activeSection}
              orientation="vertical"
              onValueChange={(value) => {
                const scrollTop =
                  root.current?.closest<HTMLElement>("[data-ap-scroll]")
                    ?.scrollTop ?? 0
                setState((current) => ({
                  ...current,
                  activeSection: value as OrgSectionId,
                  sectionScroll: {
                    ...current.sectionScroll,
                    [current.activeSection]: scrollTop,
                  },
                }))
              }}
            >
              <div className={styles.settings}>
                <TabsList
                  aria-label={t("Settings sections", "设置分区")}
                  className={styles.rail}
                >
                  {orgSectionIds.map((section) => (
                    <TabsTab
                      className={styles.tab}
                      value={section}
                      key={section}
                      data-ap-section-tab={section}
                    >
                      {labels[section]}
                    </TabsTab>
                  ))}
                </TabsList>
                <div className="min-w-0">
                  {orgSectionIds.map((section) => (
                    <TabsPanel
                      keepMounted
                      className={styles.panel}
                      value={section}
                      key={section}
                      aria-label={labels[section]}
                    >
                      {renderSection(section)}
                    </TabsPanel>
                  ))}
                </div>
              </div>
            </Tabs>
          )}
        </DataRegion>
        {!state.loaded && (
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => setState((current) => ({ ...current, loaded: true }))}
          >
            {t("Complete simulated load", "完成模拟加载")}
          </Button>
        )}
        {!dialog && receipt()}
        {state.notice === "refreshed" && (
          <p role="status" data-ap-refresh-notice className={styles.note}>
            {t(
              "Organization fixture revalidated; drafts kept.",
              "已重新校验组织 fixture，草稿保持不变。",
            )}
          </p>
        )}
        <details className={styles.fixture}>
          <summary>{t("Local fixture controls", "本地 fixture 控件")}</summary>
          <p>
            {t(
              "No email, real credentials, model execution, or service writes. Admin keys are masked invalid metadata only.",
              "不会发送邮件、生成真实凭据、执行模型或写入服务。管理密钥仅为无效掩码元数据。",
            )}
          </p>
          <div className={styles.fixtureControls}>
            <Field label={t("Next write result", "下次写入结果")}>
              {() => (
                <ApSelect
                  label={t("Next write result", "下次写入结果")}
                  value={state.outcome}
                  disabled={locked}
                  options={[
                    { value: "confirmed", label: t("Confirmed", "确认") },
                    { value: "rejected", label: t("Rejected", "拒绝") },
                    { value: "unknown", label: t("Unknown", "未知") },
                  ]}
                  onChange={(outcome) =>
                    setState((current) => ({
                      ...current,
                      outcome: outcome as typeof current.outcome,
                    }))
                  }
                />
              )}
            </Field>
            <Field label={t("Recorded unknown result", "未知结果记录")}>
              {() => (
                <ApSelect
                  label={t("Recorded unknown result", "未知结果记录")}
                  value={state.unknownReceipt}
                  disabled={locked}
                  options={[
                    { value: "confirmed", label: t("Confirmed", "确认") },
                    { value: "rejected", label: t("Rejected", "拒绝") },
                  ]}
                  onChange={(unknownReceipt) =>
                    setState((current) => ({
                      ...current,
                      unknownReceipt:
                        unknownReceipt as typeof current.unknownReceipt,
                    }))
                  }
                />
              )}
            </Field>
            <Button
              variant="outline"
              data-ap-refresh
              disabled={state.refresh === "pending" || !state.loaded}
              onClick={() =>
                setState((current) => beginRefresh(current, "refresh"))
              }
            >
              {t("Refresh organization", "刷新组织")}
            </Button>
          </div>
        </details>
      </div>
      {renderDialog()}
    </ApPage>
  )
}

export const pageScenarios = apScenarios

/** The Showcase host owns the per-scenario AP page and account caches. */
export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  return <OrganizationSettingsView scenario={scenario as ApScenario} active={active} />
}
