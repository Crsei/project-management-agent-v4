import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { ArrowUpRight, Building2, CircleHelp, ImagePlus, IdCard, MapPin, RotateCcw, Save, ShieldAlert, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"
import { RadixSelect } from "@/components/ui/radix-select"

type DemoBusiness = { taxId: string; address: string; logo: File | null }
type DemoStatus = "active" | "deactivated" | "deleted"
type DemoAction = "deactivate" | "delete"
type DemoFeedback = "saved" | "discarded" | "reset" | "deactivated" | "deleted" | null
type LogoError = "type" | "size" | "decode" | null

const emptyBusiness: DemoBusiness = { taxId: "", address: "", logo: null }
const logoTypes: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true }
const logoSizeLimit = 2 * 1024 * 1024

function GeneralRow({ id, label, description, children }: {
  id?: string
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="grid min-w-0 gap-4 border-b py-6 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-6">
      <div className="space-y-1">
        {id ? <label htmlFor={id} className="text-sm font-medium">{label}</label> : <p className="text-sm font-medium">{label}</p>}
        <p id={id ? `${id}-description` : undefined} className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  )
}

function AppearancePreferences({ preferencesHref }: { preferencesHref?: string }) {
  const t = useText()
  const id = useId()
  const theme = useWorkspaceStore((state) => state.theme)
  const setTheme = useWorkspaceStore((state) => state.setTheme)
  const locale = useWorkspaceStore((state) => state.locale)
  const setLocale = useWorkspaceStore((state) => state.setLocale)

  return (
    <GeneralRow
      label={t("外观与语言", "Appearance & language")}
      description={t("立即应用并尝试保存在当前浏览器，刷新后保留；不写入账号，也不跨设备同步。", "Applied immediately and saved in this browser when storage is available, including across reloads. Not stored in your account or synced across devices.")}
    >
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label htmlFor={`${id}-theme`} className="grid min-w-0 gap-2 text-sm">
          <span>{t("主题", "Theme")}</span>
          <RadixSelect id={`${id}-theme`} value={theme} onChange={(event) => {
            const value = event.target.value
            if (value === "light" || value === "dark" || value === "system") setTheme(value)
          }}>
            <option value="light">{t("浅色", "Light")}</option>
            <option value="dark">{t("深色", "Dark")}</option>
            <option value="system">{t("跟随系统", "System")}</option>
          </RadixSelect>
        </label>
        <label htmlFor={`${id}-locale`} className="grid min-w-0 gap-2 text-sm">
          <span>{t("界面语言", "Interface language")}</span>
          <RadixSelect id={`${id}-locale`} value={locale} onChange={(event) => {
            const value = event.target.value
            if (value === "zh-CN" || value === "en") setLocale(value)
          }}>
            <option value="zh-CN">{t("中文（简体）", "Chinese (Simplified)")}</option>
            <option value="en">{t("英文", "English")}</option>
          </RadixSelect>
        </label>
      </div>
      {preferencesHref && <Link to={preferencesHref} className="inline-flex items-center gap-1 rounded-control text-sm text-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("完整外观设置", "All appearance settings")}<ArrowUpRight aria-hidden="true" className="size-3.5" />
      </Link>}
    </GeneralRow>
  )
}

function FontPreference() {
  const t = useText()
  const id = useId()
  return (
    <GeneralRow id={id} label={t("系统字体", "System Font")} description={t("设置应用界面使用的字体。", "Choose the font used throughout the application.")}>
      <RadixSelect id={id} disabled defaultValue="system" aria-describedby={`${id}-description ${id}-unavailable`}>
        <option value="inter">Inter</option>
        <option value="manrope">Manrope</option>
        <option value="system">{t("系统默认", "System")}</option>
      </RadixSelect>
      <p id={`${id}-unavailable`} className="text-sm leading-6 text-muted-foreground">{t("暂不可用：应用尚不支持全局字体切换及持久化，当前继续使用系统字体。", "Unavailable: global font switching and persistence are not supported. The current system font remains in use.")}</p>
    </GeneralRow>
  )
}

function BusinessFields({ value, disabled, onChange, errors }: {
  value: DemoBusiness
  disabled: boolean
  onChange?: (field: "taxId" | "address", value: string) => void
  errors?: { taxId: boolean; address: boolean }
}) {
  const t = useText()
  const id = useId()
  return <>
    <GeneralRow id={`${id}-tax`} label={t("企业税号", "Business Tax ID")} description={onChange
      ? t("仅用于示例的企业税号（必填）。", "Business tax ID for this demo only (required).")
      : t("后端未提供组织税务资料的读取与保存接口。", "The backend does not provide organizational tax information or a save API.")}>
      <InputGroup>
        <InputGroupInput
          id={`${id}-tax`}
          name="taxId"
          value={value.taxId}
          disabled={disabled}
          required={!!onChange}
          maxLength={64}
          autoComplete="off"
          placeholder={onChange ? t("例如：DEMO-TAX-2026", "e.g. DEMO-TAX-2026") : t("暂不可用", "Unavailable")}
          aria-describedby={`${id}-tax-description${errors?.taxId ? ` ${id}-tax-error` : ""}`}
          aria-invalid={errors?.taxId || undefined}
          onChange={onChange ? (event) => onChange("taxId", event.target.value) : undefined}
        />
        <InputGroupAddon aria-hidden="true"><IdCard className="size-4" /></InputGroupAddon>
      </InputGroup>
      {errors?.taxId && <p id={`${id}-tax-error`} role="alert" className="text-sm text-destructive">{t("请输入 1–64 个字符的示例税号。", "Enter a demo tax ID of 1–64 characters.")}</p>}
    </GeneralRow>
    <GeneralRow id={`${id}-address`} label={t("企业地址", "Business Address")} description={onChange
      ? t("仅用于示例的企业地址（必填）。", "Business address for this demo only (required).")
      : t("后端未提供组织地址的读取与保存接口。", "The backend does not provide an organizational address or a save API.")}>
      <InputGroup>
        <InputGroupInput
          id={`${id}-address`}
          name="businessAddress"
          value={value.address}
          disabled={disabled}
          required={!!onChange}
          maxLength={300}
          autoComplete="off"
          placeholder={onChange ? t("例如：示例城市，示例街道 123 号", "e.g. 123 Example Street, Demo City") : t("暂不可用", "Unavailable")}
          aria-describedby={`${id}-address-description${errors?.address ? ` ${id}-address-error` : ""}`}
          aria-invalid={errors?.address || undefined}
          onChange={onChange ? (event) => onChange("address", event.target.value) : undefined}
        />
        <InputGroupAddon aria-hidden="true"><MapPin className="size-4" /></InputGroupAddon>
      </InputGroup>
      {errors?.address && <p id={`${id}-address-error`} role="alert" className="text-sm text-destructive">{t("请输入 1–300 个字符的示例地址。", "Enter a demo address of 1–300 characters.")}</p>}
    </GeneralRow>
  </>
}

function AccountDanger({ disabled, deleted = false, onAction }: {
  disabled: boolean
  deleted?: boolean
  onAction?: (action: DemoAction) => void
}) {
  const t = useText()
  const id = useId()
  return (
    <section aria-labelledby={`${id}-title`} aria-describedby={`${id}-reason`} className="flex min-w-0 flex-col justify-between gap-4 rounded-module border border-destructive/25 bg-surface p-4 lg:flex-row lg:items-center">
      <div className="min-w-0 space-y-1">
        <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-medium"><ShieldAlert aria-hidden="true" className="size-4 text-destructive" />{t("移除账号", "Remove Account")}</h3>
        <p id={`${id}-reason`} className="text-sm leading-6 text-muted-foreground">{onAction
          ? t("以下操作仅修改本页可重置的示例状态，不会停用或删除真实账号。", "These actions only change this page’s resettable demo state. No real account is deactivated or deleted.")
          : t("暂不可用：后端未提供账号停用或删除接口。此处不会改变账号或工作区。", "Unavailable: the backend has no account deactivation or deletion API. These controls cannot change your account or workspace.")}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button variant="outline" disabled={disabled} aria-describedby={`${id}-reason`} className="text-destructive" onClick={() => onAction?.("deactivate")}>{t("停用账号", "Deactivate Account")}</Button>
        <Button variant="destructive" disabled={onAction ? deleted : true} aria-describedby={`${id}-reason`} onClick={() => onAction?.("delete")}><Trash2 aria-hidden="true" className="size-4" />{t("删除账号", "Delete Account")}</Button>
      </div>
    </section>
  )
}

function ServiceGeneral() {
  const t = useText()
  const id = useId()
  const { workspaceSlug } = useParams()
  const root = `/pm/${encodeURIComponent(workspaceSlug ?? "")}/settings`
  return (
    <SettingsSection wide title={t("常规", "General")}>
      <div className="flex min-w-0 flex-col gap-4 rounded-module border bg-surface p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <CircleHelp aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("方案状态暂不可用", "Plan status unavailable")}</p>
            <p className="text-sm leading-6 text-muted-foreground">{t("当前服务未提供订阅或计费数据；不会推定为免费方案。", "This service does not expose subscription or billing data. No free plan is assumed.")}</p>
          </div>
        </div>
        <Button variant="outline" render={<Link to={`${root}/plans`} />}>{t("查看方案支持情况", "View plan availability")}<ArrowUpRight aria-hidden="true" className="size-4" /></Button>
      </div>
      <GeneralRow label={t("工作区资料", "Workspace identity")} description={t("名称、应用内安全图标和颜色使用正式工作区服务保存；不会改动 URL、核心目录或组织税务资料。", "Name, safe built-in icon and color save through the real workspace service. URLs, core directories and organization tax details are unchanged.")}><Link to={`${root}/workspace`} className="inline-flex items-center gap-1 text-sm text-primary hover:text-foreground">{t("管理工作区名称、图标与颜色", "Manage workspace name, icon and color")}<ArrowUpRight aria-hidden="true" className="size-3.5" /></Link></GeneralRow>
      <SettingsNotice>{t("组织资料暂不可编辑：后端尚无公司标志、税号或企业地址的服务契约。下方停用和删除操作同样不可用。外观与语言可使用现有应用偏好进行调整。", "Organization details cannot be edited: the backend has no company logo, tax ID, or business address contract. Deactivation and deletion are also unavailable. Appearance and language use the existing application preferences.")}</SettingsNotice>
      <div>
        <GeneralRow id={`${id}-logo`} label={t("公司标志", "Company Logo")} description={t("更新公司标志。当前服务不支持组织标志上传。", "Update your company logo. Organizational logo uploads are not supported by this service.")}>
          <div className="flex min-w-0 items-center gap-3">
            <div aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-module border border-dashed bg-surface-raised"><Building2 className="size-5 text-muted-foreground" /></div>
            <Input id={`${id}-logo`} type="file" accept="image/png,image/jpeg,image/webp" disabled aria-describedby={`${id}-logo-description`} className="h-auto min-h-9 min-w-0 py-1.5 text-xs" />
          </div>
        </GeneralRow>
        <FontPreference />
        <AppearancePreferences preferencesHref={`${root}/appearance`} />
        <BusinessFields value={emptyBusiness} disabled />
        <div className="space-y-2 pt-5">
          <Button disabled aria-describedby={`${id}-save-reason`}>{t("保存更改", "Save Changes")}</Button>
          <p id={`${id}-save-reason`} className="text-sm text-muted-foreground">{t("组织资料保存不可用。上方主题与语言在选择后立即生效。", "Organization saves are unavailable. Theme and language changes above apply immediately.")}</p>
        </div>
      </div>
      <div className="pt-6"><AccountDanger disabled /></div>
    </SettingsSection>
  )
}

function LabGeneral() {
  const t = useText()
  const id = useId()
  const { workspaceSlug } = useParams()
  const [draft, setDraft] = useState<DemoBusiness>(emptyBusiness)
  const [saved, setSaved] = useState<DemoBusiness>(emptyBusiness)
  const [status, setStatus] = useState<DemoStatus>("active")
  const [pendingAction, setPendingAction] = useState<DemoAction | null>(null)
  const [feedback, setFeedback] = useState<DemoFeedback>(null)
  const [errors, setErrors] = useState({ taxId: false, address: false })
  const [logoError, setLogoError] = useState<LogoError>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [logoReady, setLogoReady] = useState(true)
  const currentUrl = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const active = status === "active"
  const dirty = draft.taxId !== saved.taxId || draft.address !== saved.address || draft.logo !== saved.logo

  useEffect(() => () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
  }, [])

  const replacePreview = (file: File | null) => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    const next = file ? URL.createObjectURL(file) : null
    currentUrl.current = next
    setPreview(next)
    setLogoReady(!file)
    setLogoError(null)
    if (fileInput.current) fileInput.current.value = ""
  }

  const resetDemo = () => {
    replacePreview(null)
    setDraft(emptyBusiness)
    setSaved(emptyBusiness)
    setErrors({ taxId: false, address: false })
    setStatus("active")
    setPendingAction(null)
    setFeedback("reset")
  }

  const saveDemo = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!active || !logoReady) return
    const taxId = draft.taxId.trim()
    const address = draft.address.trim()
    const nextErrors = { taxId: !taxId || taxId.length > 64, address: !address || address.length > 300 }
    setErrors(nextErrors)
    setFeedback(null)
    if (nextErrors.taxId || nextErrors.address) return
    const next = { ...draft, taxId, address }
    setDraft(next)
    setSaved(next)
    setFeedback("saved")
  }

  const confirmAction = () => {
    if (!pendingAction) return
    if (pendingAction === "deactivate") {
      setStatus("deactivated")
      setFeedback("deactivated")
    } else {
      replacePreview(null)
      setDraft(emptyBusiness)
      setSaved(emptyBusiness)
      setErrors({ taxId: false, address: false })
      setStatus("deleted")
      setFeedback("deleted")
    }
    setPendingAction(null)
  }

  return (
    <SettingsSection wide title={t("常规", "General")} description={t("管理应用选项，并体验仅限本页的组织资料示例。", "Manage application options and try this page’s isolated organization demo.")}>
      <div className="flex min-w-0 flex-col gap-4 rounded-module border bg-surface p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <Building2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{t("示例账号", "Demo account")}<span className="rounded-pill border bg-surface-raised px-2 py-0.5 text-xs">{status === "active" ? t("启用中", "Active") : status === "deactivated" ? t("已停用（示例）", "Deactivated (demo)") : t("已删除（示例）", "Deleted (demo)")}</span></p>
            <p className="text-sm leading-6 text-muted-foreground">{t("仅为本地交互示例，无订阅或付费方案。", "A local interaction demo, with no subscription or paid plan.")}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" render={<Link to={`/lab/pm/${encodeURIComponent(workspaceSlug ?? "")}/settings/plans`} />}>{t("查看方案示例", "Explore demo plans")}</Button>
          <Button variant="outline" onClick={resetDemo}><RotateCcw aria-hidden="true" className="size-4" />{t("重置示例", "Reset demo")}</Button>
        </div>
      </div>
      <SettingsNotice>{t("请仅输入示例资料。保存只更新当前页面内存中的示例快照；标志不会上传。离开页面或刷新后会重置，也可随时点击“重置示例”。主题与语言是独立的浏览器偏好，不受示例重置影响。", "Use sample information only. Save updates a demo snapshot in this page’s memory; your logo is never uploaded. Leaving the page or reloading resets the demo, and Reset demo is always available. Theme and language are separate browser preferences and are not affected by a demo reset.")}</SettingsNotice>
      <form noValidate onSubmit={saveDemo}>
        <GeneralRow id={`${id}-logo`} label={t("公司标志", "Company Logo")} description={t("预览公司标志；支持 PNG、JPEG 或 WebP，最大 2 MiB。", "Preview a company logo. PNG, JPEG, or WebP, up to 2 MiB.")}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-module border bg-surface-raised">
              {preview ? <img
                src={preview}
                alt={t("公司标志示例预览", "Demo company logo preview")}
                className="size-full object-contain"
                onLoad={() => { if (currentUrl.current === preview) setLogoReady(true) }}
                onError={() => {
                  if (currentUrl.current !== preview) return
                  replacePreview(null)
                  setDraft((previous) => ({ ...previous, logo: null }))
                  setLogoError("decode")
                  setFeedback(null)
                }}
              /> : <ImagePlus aria-hidden="true" className="size-5 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <Input
                ref={fileInput}
                id={`${id}-logo`}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!active}
                aria-describedby={`${id}-logo-description${logoError ? ` ${id}-logo-error` : ""}`}
                aria-invalid={!!logoError || undefined}
                className="h-auto min-h-9 min-w-0 py-1.5 text-xs"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ""
                  if (!file) return
                  setFeedback(null)
                  if (!Object.hasOwn(logoTypes, file.type)) { setLogoError("type"); return }
                  if (file.size === 0 || file.size > logoSizeLimit) { setLogoError("size"); return }
                  replacePreview(file)
                  setDraft((previous) => ({ ...previous, logo: file }))
                }}
              />
              {draft.logo && <p className="break-all text-xs text-muted-foreground">{draft.logo.name}</p>}
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={!active || !draft.logo} onClick={() => {
            replacePreview(null)
            setDraft((previous) => ({ ...previous, logo: null }))
            setFeedback(null)
          }}>{t("移除标志", "Remove logo")}</Button>
          {preview && !logoReady && <p role="status" className="text-sm text-muted-foreground">{t("正在读取预览…", "Reading preview…")}</p>}
          {logoError && <p id={`${id}-logo-error`} role="alert" className="text-sm text-destructive">{logoError === "type"
            ? t("未选择此文件。请选择 PNG、JPEG 或 WebP 图片。", "This file was not selected. Choose a PNG, JPEG, or WebP image.")
            : logoError === "size"
              ? t("未选择此文件。图片不能为空，且不能超过 2 MiB。", "This file was not selected. The image must be non-empty and no larger than 2 MiB.")
              : t("无法解码此图片，已移除预览。请选择有效的图片文件。", "This image could not be decoded, so its preview was removed. Choose a valid image file.")}</p>}
        </GeneralRow>
        <FontPreference />
        <AppearancePreferences preferencesHref={`/lab/pm/${encodeURIComponent(workspaceSlug ?? "")}/settings/appearance`} />
        <BusinessFields value={draft} disabled={!active} errors={errors} onChange={(field, value) => {
          setDraft((previous) => ({ ...previous, [field]: value }))
          setErrors((previous) => ({ ...previous, [field]: false }))
          setFeedback(null)
        }} />
        <div className="flex flex-wrap gap-2 pt-5">
          <Button type="submit" disabled={!active || !logoReady}><Save aria-hidden="true" className="size-4" />{t("保存更改", "Save Changes")}</Button>
          <Button variant="outline" disabled={!active || !dirty} onClick={() => {
            replacePreview(saved.logo)
            setDraft(saved)
            setErrors({ taxId: false, address: false })
            setFeedback("discarded")
          }}>{t("撤销未保存的更改", "Discard unsaved changes")}</Button>
        </div>
        {!active && <p className="mt-3 text-sm text-muted-foreground">{t("示例编辑已暂停。点击“重置示例”即可恢复，不影响真实账号。", "Demo editing is paused. Use Reset demo to restore it; your real account is unaffected.")}</p>}
        <div aria-live="polite" className="mt-3 text-sm leading-6 text-muted-foreground">
          {feedback === "saved" && <p>{t("更改已保存到本页的示例快照，未发送至服务器。离开页面后会重置。", "Changes saved to this page’s demo snapshot, not to a server. Leaving this page resets them.")}</p>}
          {feedback === "discarded" && <p>{t("已恢复本页最后保存的示例快照。", "The last saved demo snapshot on this page has been restored.")}</p>}
          {feedback === "reset" && <p>{t("本页示例状态已重置，示例账号已恢复启用。", "This page’s demo state was reset and its demo account is active again.")}</p>}
          {feedback === "deactivated" && <p>{t("仅本页示例账号已停用。真实登录、账号和工作区均未更改。", "Only this page’s demo account was deactivated. Your real session, account, and workspace are unchanged.")}</p>}
          {feedback === "deleted" && <p>{t("仅本页示例资料已清除，示例账号标记为已删除。可随时重置；未删除任何真实数据。", "Only this page’s demo details were cleared and its demo account marked deleted. Reset is always available; no real data was deleted.")}</p>}
        </div>
      </form>
      <div className="pt-6"><AccountDanger disabled={!active} deleted={status === "deleted"} onAction={setPendingAction} /></div>
      <AlertDialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null) }}>
        <AlertDialogContent>
          <AlertDialogTitle className="text-base font-semibold">{pendingAction === "delete" ? t("删除本页的示例账号？", "Delete this page’s demo account?") : t("停用本页的示例账号？", "Deactivate this page’s demo account?")}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm leading-6 text-muted-foreground">{pendingAction === "delete"
            ? t("这只会清除本页的示例标志、税号、地址和保存快照，并标记示例账号为已删除。不会调用服务或删除真实账号；点击“重置示例”可重新开始。", "This only clears this page’s demo logo, tax ID, address, and saved snapshot, then marks the demo account as deleted. No service is called and no real account is deleted. Reset demo lets you start again.")
            : t("这只会暂停本页示例资料的编辑，保留示例内容。不会退出登录或停用真实账号；点击“重置示例”可恢复。", "This only pauses editing of this page’s demo details and retains their contents. It does not sign you out or deactivate a real account. Reset demo restores editing.")}</AlertDialogDescription>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <AlertDialogCancel asChild><Button variant="outline">{t("取消", "Cancel")}</Button></AlertDialogCancel>
            <Button variant={pendingAction === "delete" ? "destructive" : "primary"} onClick={confirmAction}>{pendingAction === "delete" ? t("仅删除示例", "Delete demo only") : t("仅停用示例", "Deactivate demo only")}</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}

export function SettingsGeneral({ mode }: SettingsPageProps) {
  return mode === "service" ? <ServiceGeneral /> : <LabGeneral />
}
