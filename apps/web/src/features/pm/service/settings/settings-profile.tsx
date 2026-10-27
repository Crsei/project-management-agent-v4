import { useEffect, useRef, useState, type FormEvent } from "react"
import { ChevronDown } from "lucide-react"
import type { CommandPayloadMap, SelfProfile } from "@contracts"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useI18n } from "@/lib/i18n-provider"
import { usePersonalDashboard, usePmService } from "../pm-service"
import { CommandNotice, useAction, useDraftState, useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

type EditableProfile = { name: string; timeZone: string; jobTitle: string; phone: string; avatarDataUrl: string | null }
type ProfileDraft = EditableProfile & { version: number; pendingCommandId: string | null }
type ProfileValues = EditableProfile & { username: string; email: string; dateOfBirth: string }
type ProfileErrors = { name?: "required" | "length"; timeZone?: "invalid"; jobTitle?: "length"; phone?: "length"; avatarDataUrl?: "invalid"; username?: "required"; dateOfBirth?: "invalid" }
const maxAvatarBytes = 256 * 1024

function profileDraft(profile: SelfProfile): ProfileDraft {
  return { name: profile.name, timeZone: profile.timeZone, jobTitle: profile.jobTitle ?? "", phone: profile.phone ?? "", avatarDataUrl: profile.avatarDataUrl, version: profile.version, pendingCommandId: null }
}

// Match the existing service's MIME, canonical base64, size and image-signature checks.
function isSafeAvatar(value: string): boolean {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2].length % 4 !== 0 || match[2].length > 4 * Math.ceil(maxAvatarBytes / 3)) return false
  try {
    const bytes = atob(match[2])
    if (bytes.length > maxAvatarBytes || btoa(bytes) !== match[2]) return false
    const uint32 = (offset: number, littleEndian = false) => {
      const a = bytes.charCodeAt(offset)
      const b = bytes.charCodeAt(offset + 1)
      const c = bytes.charCodeAt(offset + 2)
      const d = bytes.charCodeAt(offset + 3)
      return littleEndian ? a + b * 256 + c * 65536 + d * 16777216 : a * 16777216 + b * 65536 + c * 256 + d
    }
    if (match[1] === "png") return bytes.length >= 45 && bytes.startsWith("\x89PNG\r\n\x1a\n") && uint32(8) === 13 && bytes.slice(12, 16) === "IHDR" && uint32(16) > 0 && uint32(20) > 0 && bytes.endsWith("\x00\x00\x00\x00IEND\xaeB\x60\x82")
    if (match[1] === "jpeg") return bytes.length >= 4 && bytes.startsWith("\xff\xd8\xff") && bytes.endsWith("\xff\xd9")
    return bytes.length >= 20 && bytes.startsWith("RIFF") && uint32(4, true) === bytes.length - 8 && bytes.slice(8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12, 16))
  } catch {
    return false
  }
}

function validateProfile({ name, timeZone, jobTitle, phone, avatarDataUrl }: EditableProfile): ProfileErrors {
  const errors: ProfileErrors = {}
  if (!name.trim()) errors.name = "required"
  else if (name.trim().length > 200) errors.name = "length"
  try {
    if (!timeZone || timeZone.length > 200 || /^[+-]/.test(timeZone)) throw new RangeError()
    new Intl.DateTimeFormat("en", { timeZone })
  } catch {
    errors.timeZone = "invalid"
  }
  if (jobTitle.trim().length > 200) errors.jobTitle = "length"
  if (phone.trim().length > 80) errors.phone = "length"
  if (avatarDataUrl !== null && !isSafeAvatar(avatarDataUrl)) errors.avatarDataUrl = "invalid"
  return errors
}

function localToday() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function ProfileAvatar({ values, disabled, error, onChange, onBusyChange }: {
  values: EditableProfile
  disabled: boolean
  error?: "invalid"
  onChange: (avatarDataUrl: string | null) => void
  onBusyChange: (busy: boolean) => void
}) {
  const t = useText()
  const reader = useRef<FileReader | null>(null)
  const [busy, setBusy] = useState(false)
  const [imageError, setImageError] = useState<"type" | "size" | "read" | "invalid" | null>(null)
  useEffect(() => () => {
    if (!reader.current) return
    reader.current.onload = null
    reader.current.onerror = null
    reader.current.onabort = null
    if (reader.current.readyState === FileReader.LOADING) reader.current.abort()
  }, [])
  const finish = () => { reader.current = null; setBusy(false); onBusyChange(false) }
  const message = imageError === "type" ? t("只接受 PNG、JPEG 或 WebP；不接受 SVG 或外部图片链接。", "Only PNG, JPEG and WebP are accepted; SVG and external image URLs are not supported.")
    : imageError === "size" ? t("头像必须大于 0 且不超过 256 KiB。", "The avatar must be nonempty and no larger than 256 KiB.")
      : imageError === "read" ? t("无法读取头像，请重新选择文件。", "Could not read the avatar. Choose the file again.")
        : imageError === "invalid" || error ? t("图片内容与 PNG/JPEG/WebP 格式不匹配或已损坏；当前头像未被替换。", "The image content does not match PNG/JPEG/WebP or is damaged; the current avatar was not replaced.") : undefined
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3">
      <Avatar name={values.name} src={values.avatarDataUrl ?? undefined} size={40} />
      <Button type="button" variant="outline" size="sm" disabled={disabled || busy || !values.avatarDataUrl} onClick={() => { setImageError(null); onChange(null) }}>{t("移除头像", "Remove avatar")}</Button>
      <span className="text-xs text-muted-foreground">{t("没有上传图片时使用姓名首字母；头像颜色没有可保存的服务字段。", "Without an uploaded image, name initials are used. The service has no editable avatar-color field.")}</span>
    </div>
    <Field label={t("上传头像", "Upload avatar")} description={t("PNG/JPEG/WebP，最大 256 KiB。先检查文件类型、大小和图片签名；正式模式点击保存后才提交资料服务，Lab 始终仅在内存预览。", "PNG/JPEG/WebP, maximum 256 KiB. File type, size and image signature are checked first. Service mode submits the image only on Save; Lab keeps it in memory only.")} error={message}>
      {control => <Input {...control} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || busy} onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ""
        if (!file || disabled || busy) return
        setImageError(null)
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setImageError("type"); return }
        if (!file.size || file.size > maxAvatarBytes) { setImageError("size"); return }
        const nextReader = new FileReader()
        reader.current = nextReader
        setBusy(true)
        onBusyChange(true)
        nextReader.onerror = () => { setImageError("read"); finish() }
        nextReader.onabort = () => { setImageError("read"); finish() }
        nextReader.onload = () => {
          if (typeof nextReader.result !== "string" || !isSafeAvatar(nextReader.result)) setImageError("invalid")
          else onChange(nextReader.result)
          finish()
        }
        try { nextReader.readAsDataURL(file) } catch { setImageError("read"); finish() }
      }} />}
    </Field>
    {busy && <p role="status" className="text-xs text-muted-foreground">{t("正在读取并验证头像…", "Reading and validating the avatar…")}</p>}
  </div>
}

function LanguageField({ disabled }: { disabled: boolean }) {
  const { locale, setLocale } = useI18n()
  const t = useText()
  return <Field label={t("语言", "Language")} description={t("立即切换界面，并作为当前浏览器的偏好保存；不随资料命令提交，也不代表账号跨设备同步。", "Changes the interface immediately and is saved as a preference in this browser. It is not submitted with the profile or synced across devices.")}>
    {control => <Select value={locale} disabled={disabled} onValueChange={value => { if (value === "zh-CN" || value === "en") setLocale(value) }}>
      <SelectTrigger {...control} className="flex w-full min-w-0 items-center justify-between gap-2 bg-surface"><SelectValue /><ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></SelectTrigger>
      <SelectContent><SelectItem value="zh-CN">{t("中文（简体）", "Chinese (Simplified)")}</SelectItem><SelectItem value="en">English</SelectItem></SelectContent>
    </Select>}
  </Field>
}

function ProfileFields({ values, email, errors, disabled, onChange, onAvatarBusyChange, preview }: {
  values: EditableProfile
  email: string
  errors: ProfileErrors
  disabled: boolean
  onChange: (patch: Partial<EditableProfile>) => void
  onAvatarBusyChange: (busy: boolean) => void
  preview?: {
    username: string
    dateOfBirth: string
    onUsernameChange: (username: string) => void
    onEmailChange: (email: string) => void
    onDateOfBirthChange: (date: string) => void
  }
}) {
  const t = useText()
  return <div className="space-y-6">
    <ProfileAvatar values={values} disabled={disabled} error={errors.avatarDataUrl} onChange={avatarDataUrl => onChange({ avatarDataUrl })} onBusyChange={onAvatarBusyChange} />
    <Field label={t("姓名", "Name")} required description={t("用于你的账号和项目协作中的显示名称。", "The display name used for your account and project collaboration.")} error={errors.name === "required" ? t("请输入姓名。", "Enter your name.") : errors.name === "length" ? t("姓名不能超过 200 个字符。", "Your name must be 200 characters or fewer.") : undefined}>
      {control => <Input {...control} autoComplete="name" value={values.name} disabled={disabled} onChange={event => onChange({ name: event.target.value })} />}
    </Field>
    <Field label={t("岗位", "Job title")} description={t("可选，最多 200 个字符；清空并保存会移除岗位信息。", "Optional, up to 200 characters. Clear and save to remove your job title.")} error={errors.jobTitle ? t("岗位不能超过 200 个字符。", "Your job title must be 200 characters or fewer.") : undefined}>
      {control => <Input {...control} autoComplete="organization-title" value={values.jobTitle} disabled={disabled} onChange={event => onChange({ jobTitle: event.target.value })} />}
    </Field>
    <Field label={t("用户名", "Username")} description={preview
      ? t("可在此体验编辑。参考页面的“每 30 天更改一次”规则不在此预览中实施，也不代表真实服务规则。", "Try editing here. The reference page’s 30-day change restriction is not enforced in this preview or claimed as a service rule.")
      : t("当前服务没有用户名字段或更改接口；参考页面的 30 天限制不适用于此服务。", "The service has no username field or update API; the reference page’s 30-day restriction is not a rule of this service.")} error={errors.username ? t("请输入预览用户名。", "Enter a preview username.") : undefined}>
      {control => <Input {...control} autoComplete="off" value={preview?.username ?? ""} placeholder={t("未提供", "Not provided")} disabled={!preview || disabled} onChange={preview ? event => preview.onUsernameChange(event.target.value) : undefined} />}
    </Field>
    <Field label={t("电子邮箱", "Email")} description={preview
      ? t("仅在两个示例地址之间切换，不发送验证邮件或修改真实账号。", "Choose between sample addresses only. No verification email is sent and no real account changes.")
      : t("当前登录账号的真实邮箱，只读。服务不提供邮箱更改或验证状态，不声称已验证。", "Your signed-in account's actual email, read-only. Email changes and verification status are not provided; no verified status is claimed.")}>
      {control => preview ? <Select value={email} disabled={disabled} onValueChange={value => { if (value) preview.onEmailChange(value) }}>
        <SelectTrigger {...control} className="flex w-full min-w-0 items-center justify-between gap-2 bg-surface text-left [&>span:first-child]:truncate"><SelectValue /><ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></SelectTrigger>
        <SelectContent><SelectItem value="alex@example.test">alex@example.test</SelectItem><SelectItem value="alex.work@example.test">alex.work@example.test</SelectItem></SelectContent>
      </Select> : <Input {...control} type="email" value={email} readOnly placeholder={t("未提供", "Not provided")} />}
    </Field>
    <Field label={t("电话", "Phone")} description={t("可选，最多 80 个字符；正式资料仅本人和有权管理员可见。清空并保存会移除电话。", "Optional, up to 80 characters. In the service, only you and authorized administrators can see it. Clear and save to remove it.")} error={errors.phone ? t("电话不能超过 80 个字符。", "Your phone number must be 80 characters or fewer.") : undefined}>
      {control => <Input {...control} type="tel" autoComplete="tel" value={values.phone} disabled={disabled} onChange={event => onChange({ phone: event.target.value })} />}
    </Field>
    <Field label={t("出生日期", "Date of birth")} description={preview
      ? t("可选；使用日历选择日期，仅用于内存预览。", "Optional. Choose a date with the calendar for this in-memory preview only.")
      : t("当前个人资料合同不包含出生日期，服务也没有保存接口。", "The profile contract has no date-of-birth field or save API.")} error={errors.dateOfBirth ? t("请选择有效且不晚于今天的出生日期。", "Choose a valid date of birth that is not in the future.") : undefined}>
      {control => <Input {...control} type="date" value={preview?.dateOfBirth ?? ""} max={preview ? localToday() : undefined} disabled={!preview || disabled} onChange={preview ? event => preview.onDateOfBirthChange(event.target.value) : undefined} className="max-w-xs" />}
    </Field>
    <Field label={t("时区", "Time zone")} required description={t("使用 IANA 时区标识，例如 Asia/Shanghai、Europe/London 或 UTC；用于个人工作台的时间显示和工时统计。", "Use an IANA identifier such as Asia/Shanghai, Europe/London or UTC for personal dashboard times and time totals.")} error={errors.timeZone ? t("请输入有效的 IANA 时区。", "Enter a valid IANA time zone.") : undefined}>
      {control => <Input {...control} autoComplete="off" autoCapitalize="none" spellCheck={false} value={values.timeZone} disabled={disabled} onChange={event => onChange({ timeZone: event.target.value })} placeholder="Asia/Shanghai" />}
    </Field>
    <LanguageField disabled={disabled} />
  </div>
}

export function SettingsProfile({ mode }: SettingsPageProps) {
  const t = useText()
  return <SettingsSection title={t("个人资料", "Profile")} description={t("管理本人姓名、岗位、电话、头像和时区；界面语言单独保存在当前浏览器。", "Manage your name, job title, phone, avatar and time zone. Interface language is stored separately in this browser.")}>
    {mode === "service" ? <ServiceProfile /> : <LabProfile />}
  </SettingsSection>
}

function ServiceProfile() {
  const query = usePersonalDashboard()
  const { actor, refresh, error } = usePmService()
  const t = useText()
  const profile = query.data?.profile
  const refreshedName = useRef<string | null>(null)
  // Receipt reconciliation and changes in another tab also need the account header refreshed.
  useEffect(() => {
    if (!profile || profile.name === actor?.name || refreshedName.current === profile.name) return
    refreshedName.current = profile.name
    void refresh().catch(() => { refreshedName.current = null })
  }, [actor?.name, profile?.name, refresh])
  return <div className="space-y-6">
    <div className="space-y-2 text-sm" aria-live="polite">
      {query.isPending && <p role="status" className="text-muted-foreground">{t("正在读取个人资料…", "Loading your profile…")}</p>}
      {query.isFetching && !!query.data && <p role="status" className="text-muted-foreground">{t("正在刷新；未保存的草稿会保留。", "Refreshing; unsaved drafts are retained.")}</p>}
      {query.error && <div role="alert" className="space-y-2"><p className="break-words text-destructive">{query.data ? t("刷新失败，上次快照可能已过期：", "Refresh failed; the previous snapshot may be stale: ") : ""}{query.error.message}</p><Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => { void query.refetch() }}>{t("重试读取", "Retry read")}</Button></div>}
      {error && <div role="alert" className="space-y-2"><p className="break-words text-destructive">{t("账号信息刷新失败：", "Account refresh failed: ")}{error.message}</p><Button variant="outline" size="sm" onClick={() => { void refresh().catch(() => undefined) }}>{t("重试账号刷新", "Retry account refresh")}</Button></div>}
    </div>
    {profile ? <ServiceProfileEditor profile={profile} email={actor?.email ?? ""} readBlocked={!!query.error || query.isFetching} refreshAccount={refresh} /> : !query.isPending && !query.error && <SettingsNotice>{t("没有可用的个人资料；不会使用示例账号代替。", "No profile is available. No sample account is substituted.")}</SettingsNotice>}
  </div>
}

function ServiceProfileEditor({ profile, email, readBlocked, refreshAccount }: { profile: SelfProfile; email: string; readBlocked: boolean; refreshAccount: () => Promise<void> }) {
  const t = useText()
  const action = useAction()
  const original = action.unknownCommand?.commandType === "UpdateSelfProfile" && action.unknownCommand.targetId === profile.userId ? action.unknownCommand : null
  // The older dashboard draft has only two fields. Keep a complete, isolated draft here.
  const [draft, setDraft] = useDraftState<ProfileDraft>("settings-self-profile", "draft", () => {
    const initial = profileDraft(profile)
    if (!original) return initial
    const payload = original.payload
    return {
      ...initial,
      name: payload.name ?? initial.name,
      timeZone: payload.timeZone ?? initial.timeZone,
      jobTitle: payload.jobTitle === undefined ? initial.jobTitle : payload.jobTitle ?? "",
      phone: payload.phone === undefined ? initial.phone : payload.phone ?? "",
      avatarDataUrl: payload.avatarDataUrl === undefined ? initial.avatarDataUrl : payload.avatarDataUrl,
      version: original.expectedVersions?.[profile.userId] ?? initial.version,
      pendingCommandId: original.commandId,
    }
  })
  const [errors, setErrors] = useState<ProfileErrors>({})
  const [saved, setSaved] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const conflict = profile.version > draft.version
  const awaitingSnapshot = profile.version < draft.version
  const dirty = draft.name !== profile.name || draft.timeZone !== profile.timeZone || draft.jobTitle !== (profile.jobTitle ?? "") || draft.phone !== (profile.phone ?? "") || draft.avatarDataUrl !== profile.avatarDataUrl
  const locked = action.locked || submitting || !!draft.pendingCommandId && action.receipt?.commandId === draft.pendingCommandId
  useEffect(() => {
    const receipt = action.receipt
    if (!draft.pendingCommandId || receipt?.commandId !== draft.pendingCommandId || action.unknownCommand?.commandId === draft.pendingCommandId) return
    if (receipt.status === "committed") {
      setDraft(profileDraft(receipt.result as SelfProfile))
      setErrors({})
      setSaved(true)
      // A confirmed write remains confirmed if this subsequent account read fails.
      void refreshAccount().catch(() => undefined)
    } else {
      setDraft(previous => ({ ...previous, pendingCommandId: null }))
      setSaved(false)
    }
  }, [action.receipt, action.unknownCommand, draft.pendingCommandId, refreshAccount, setDraft])
  const change = (patch: Partial<ProfileDraft>) => {
    setDraft(previous => ({ ...previous, ...patch }))
    setErrors({})
    setSaved(false)
    action.setError(null)
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (locked || imageBusy || readBlocked || conflict || awaitingSnapshot || !dirty) return
    const validation = validateProfile(draft)
    setErrors(validation)
    if (Object.keys(validation).length) return
    const payload: CommandPayloadMap["UpdateSelfProfile"] = { name: draft.name.trim(), timeZone: draft.timeZone, jobTitle: draft.jobTitle.trim() || null, phone: draft.phone.trim() || null, avatarDataUrl: draft.avatarDataUrl }
    const commandId = crypto.randomUUID()
    setDraft(previous => ({ ...previous, pendingCommandId: commandId }))
    setSaved(false)
    setSubmitting(true)
    try {
      await action.run(() => action.execute({ commandId, commandType: "UpdateSelfProfile", targetId: profile.userId, expectedVersions: { [profile.userId]: draft.version }, payload }))
    } finally {
      setSubmitting(false)
    }
  }
  return <div className="space-y-5">
    <SettingsNotice>{t("姓名、岗位、电话、头像和时区通过同一真实资料服务与版本保存。未保存草稿在当前应用会话内按账号和工作区保留；刷新页面后普通草稿不保留，结果未知的原命令由收据恢复日志保留。用户名、邮箱更改、出生日期和头像颜色不受支持。", "Name, job title, phone, avatar and time zone share the real profile service and version. Unsaved drafts are retained per account and workspace during this app session, not across reloads. Unknown commands remain in the receipt-recovery journal. Username, email changes, date of birth and avatar colors are not supported.")}</SettingsNotice>
    <CommandNotice />
    {conflict && <div role="status" className="space-y-3 rounded-lg border bg-surface p-4 text-sm">
      <p>{t("服务端个人资料已更新，完整草稿及原版本仍保留。比较下列服务值与表单草稿后明确选择；“保留草稿”会在下一次保存时提交草稿中的全部五项资料，不会自动合并或重试。", "Your server profile changed; the complete draft and original version are retained. Compare the saved values below with your form before choosing. Keeping the draft submits all five profile fields on your next save; nothing is merged or retried automatically.")}</p>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">{t("服务端姓名", "Saved name")}</dt><dd className="break-words">{profile.name}</dd>
        <dt className="text-muted-foreground">{t("服务端岗位", "Saved job title")}</dt><dd className="break-words">{profile.jobTitle ?? t("未设置", "Not set")}</dd>
        <dt className="text-muted-foreground">{t("服务端电话", "Saved phone")}</dt><dd className="break-words">{profile.phone ?? t("未设置", "Not set")}</dd>
        <dt className="text-muted-foreground">{t("服务端头像", "Saved avatar")}</dt><dd className="flex flex-wrap items-center gap-2"><Avatar name={profile.name} src={profile.avatarDataUrl ?? undefined} size={32} /><span>{profile.avatarDataUrl ? t("已上传图片", "Uploaded image") : t("姓名首字母", "Name initials")}</span></dd>
        <dt className="text-muted-foreground">{t("服务端时区", "Saved time zone")}</dt><dd className="break-words">{profile.timeZone}</dd>
        <dt className="text-muted-foreground">{t("草稿 / 最新版本", "Draft / latest version")}</dt><dd>{draft.version} / {profile.version}</dd>
      </dl>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked || imageBusy || readBlocked} onClick={() => change({ version: profile.version, pendingCommandId: null })}>{t("保留完整草稿，采用最新版本", "Keep complete draft, use latest version")}</Button><Button size="sm" variant="ghost" disabled={locked || imageBusy || readBlocked} onClick={() => change(profileDraft(profile))}>{t("放弃草稿，读取全部服务值", "Discard draft, load all saved values")}</Button></div>
    </div>}
    {awaitingSnapshot && <p role="status" className="text-sm text-muted-foreground">{t("草稿版本比当前快照新，正在等待服务端快照刷新；在版本一致前不会再次提交。", "The draft version is newer than the current snapshot. Waiting for a refreshed snapshot; no further submission is allowed until the versions agree.")}</p>}
    <form noValidate className="space-y-6" onSubmit={event => { void submit(event) }}>
      <ProfileFields values={draft} email={email} errors={errors} disabled={locked} onChange={change} onAvatarBusyChange={setImageBusy} />
      <div className="space-y-2" aria-live="polite">
        {Object.keys(errors).length > 0 && <p role="alert" className="text-sm text-destructive">{t("请检查上方标出的字段。", "Check the highlighted fields above.")}</p>}
        {action.localError && !action.error && <p role="alert" className="break-words text-sm text-destructive">{action.localError}</p>}
        {saved && <p role="status" className="text-sm">{t("个人资料已通过服务端命令收据确认保存。", "Your profile save is confirmed by the server command receipt.")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={submitting || action.pending} disabled={locked || imageBusy || readBlocked || conflict || awaitingSnapshot || !dirty}>{t("保存个人资料", "Save profile")}</Button>
        {dirty && !conflict && <Button type="button" variant="ghost" disabled={locked || imageBusy || readBlocked || awaitingSnapshot} onClick={() => change(profileDraft(profile))}>{t("放弃全部草稿", "Discard complete draft")}</Button>}
      </div>
    </form>
  </div>
}

function LabProfile() {
  const t = useText()
  const [values, setValues] = useState<ProfileValues>({ name: "Alex Morgan", username: "alexmorgan", email: "alex@example.test", dateOfBirth: "1994-05-17", timeZone: "Asia/Shanghai", jobTitle: "Product designer", phone: "", avatarDataUrl: null })
  const [errors, setErrors] = useState<ProfileErrors>({})
  const [saved, setSaved] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const change = (patch: Partial<ProfileValues>) => {
    setValues(previous => ({ ...previous, ...patch }))
    setErrors({})
    setSaved(false)
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (imageBusy) return
    const validation = validateProfile(values)
    if (!values.username.trim()) validation.username = "required"
    if (values.dateOfBirth && (!/^\d{4}-\d{2}-\d{2}$/.test(values.dateOfBirth) || !Number.isFinite(Date.parse(`${values.dateOfBirth}T00:00:00Z`)) || new Date(`${values.dateOfBirth}T00:00:00Z`).toISOString().slice(0, 10) !== values.dateOfBirth || values.dateOfBirth > localToday())) validation.dateOfBirth = "invalid"
    setErrors(validation)
    if (Object.keys(validation).length) return
    setValues(previous => ({ ...previous, name: previous.name.trim(), username: previous.username.trim(), jobTitle: previous.jobTitle.trim(), phone: previous.phone.trim() }))
    setSaved(true)
  }
  return <div className="space-y-5">
    <SettingsNotice>{t("Lab 示例账号的全部资料（含图片）仅在本页内存中预览；离开页面即重置，不发送资料命令，也不更改真实账号。语言选项是例外：它切换应用界面并保存在当前浏览器，不属于示例资料。", "All sample-account profile fields, including images, are an in-memory Lab preview that resets when you leave. No profile commands are sent and no real account changes. Language is separate: it changes the app interface and is stored in this browser, not in the sample profile.")}</SettingsNotice>
    <form noValidate className="space-y-6" onSubmit={submit}>
      <ProfileFields values={values} email={values.email} errors={errors} disabled={false} onChange={change} onAvatarBusyChange={setImageBusy} preview={{ username: values.username, dateOfBirth: values.dateOfBirth, onUsernameChange: username => change({ username }), onEmailChange: email => change({ email }), onDateOfBirthChange: dateOfBirth => change({ dateOfBirth }) }} />
      <div className="space-y-2" aria-live="polite">
        {Object.keys(errors).length > 0 && <p role="alert" className="text-sm text-destructive">{t("请检查上方标出的字段。", "Check the highlighted fields above.")}</p>}
        {saved && <p role="status" className="text-sm">{t("预览资料已在本页内存中更新，没有修改任何真实账号或服务端数据。", "The profile preview is updated in page memory. No real account or server data changed.")}</p>}
      </div>
      <Button type="submit" disabled={imageBusy}>{t("更新资料（内存预览）", "Update profile (in-memory preview)")}</Button>
    </form>
  </div>
}
