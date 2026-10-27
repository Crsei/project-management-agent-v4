import { useId, useRef, useState, type FormEvent } from "react"
import { Link } from "react-router"
import { CreditCard, ShieldCheck, Smartphone, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { RadioGroup, useRadioGroupItem } from "@/components/ui/radio-group"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

type PaymentMethod = "card" | "paypal" | "apple"
const paymentMethods: PaymentMethod[] = ["card", "paypal", "apple"]
const methodIcons = { card: CreditCard, paypal: Wallet, apple: Smartphone }
const testCard = { number: "•••• •••• •••• 4242", month: "12", year: "2030", cvc: "—" }

function methodLabel(method: PaymentMethod, t: ReturnType<typeof useText>) {
  return method === "card" ? t("银行卡", "Card") : method === "paypal" ? "PayPal" : "Apple Pay"
}

function PaymentMethodCard({ method }: { method: PaymentMethod }) {
  const t = useText()
  const state = useRadioGroupItem(method)
  const Icon = methodIcons[method]
  return <button
    type="button"
    role="radio"
    aria-checked={state.checked}
    disabled={state.disabled}
    tabIndex={state.tabIndex}
    data-value={method}
    onClick={state.select}
    className={`flex min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border px-3 py-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 ${state.checked ? "border-foreground bg-muted ring-1 ring-foreground" : "border-border bg-surface hover:bg-surface-hover"}`}
  >
    <Icon aria-hidden="true" className="size-6" strokeWidth={1.75} />
    <span>{methodLabel(method, t)}</span>
  </button>
}

function PaymentMethods({ value, onChange, disabled = false, descriptionId }: {
  value: PaymentMethod | null
  onChange?: (method: PaymentMethod) => void
  disabled?: boolean
  descriptionId: string
}) {
  const t = useText()
  const labelId = useId()
  return <div className="space-y-3">
    <p id={labelId} className="text-sm font-medium">{t("付款方式", "Payment method")}</p>
    <RadioGroup<PaymentMethod> value={value} onValueChange={onChange} disabled={disabled} aria-labelledby={labelId} aria-describedby={descriptionId} className="grid-cols-1 gap-3 sm:grid-cols-3">
      {paymentMethods.map(method => <PaymentMethodCard key={method} method={method} />)}
    </RadioGroup>
  </div>
}

function LockedCardFields({ preview = false }: { preview?: boolean }) {
  const t = useText()
  const id = useId()
  return <div className="space-y-4">
    <label className="grid min-w-0 gap-2 text-sm" htmlFor={`${id}-number`}>
      <span className="font-medium">{t("卡号", "Card number")}</span>
      <Input id={`${id}-number`} disabled autoComplete="off" value={preview ? testCard.number : ""} placeholder={t("付款服务不可用", "Payments unavailable")} aria-describedby={`${id}-notice`} />
    </label>
    <div className="grid min-w-0 grid-cols-3 gap-3">
      <label className="grid min-w-0 gap-2 text-sm" htmlFor={`${id}-month`}>
        <span className="font-medium">{t("月份", "Month")}</span>
        <Input id={`${id}-month`} disabled autoComplete="off" value={preview ? testCard.month : ""} placeholder="—" aria-describedby={`${id}-notice`} />
      </label>
      <label className="grid min-w-0 gap-2 text-sm" htmlFor={`${id}-year`}>
        <span className="font-medium">{t("年份", "Year")}</span>
        <Input id={`${id}-year`} disabled autoComplete="off" value={preview ? testCard.year : ""} placeholder="—" aria-describedby={`${id}-notice`} />
      </label>
      <label className="grid min-w-0 gap-2 text-sm" htmlFor={`${id}-cvc`}>
        <span className="font-medium">{t("安全码 CVC", "CVC")}</span>
        <Input id={`${id}-cvc`} disabled autoComplete="off" value={preview ? testCard.cvc : ""} placeholder="—" aria-describedby={`${id}-notice`} />
      </label>
    </div>
    <p id={`${id}-notice`} className="text-xs leading-5 text-muted-foreground">
      {preview
        ? t("以上仅为固定的测试卡展示。卡号已遮罩，月份和年份不可编辑；不收集安全码，请勿输入真实银行卡信息。", "Fixed test card only. The number is masked and the month and year cannot be edited. No CVC is collected; do not enter real card details.")
        : t("当前后端未提供付款服务，无法添加付款方式或输入银行卡信息。", "This backend has no payment service. Payment methods cannot be added and card details cannot be entered.")}
    </p>
  </div>
}

function DefaultPaymentMethod({ preview = false, onPreview }: { preview?: boolean; onPreview?: () => void }) {
  const t = useText()
  const id = useId()
  return <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-lg border bg-surface p-4">
    <h3 id={`${id}-title`} className="text-sm font-semibold">{t("已绑定的默认付款方式", "Saved default payment method")}</h3>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <CreditCard aria-hidden="true" className="mt-1 size-5 shrink-0" />
        <div className="min-w-0 space-y-2 text-sm">
          <p className="font-medium">{preview ? t("Visa 尾号 4242 · 固定虚构样例", "Visa ending in 4242 · Fixed fictional example") : t("绑定状态未知", "Saved-method status unknown")}</p>
          <p className="leading-6 text-muted-foreground">{preview ? t("有效期 12/2030 · 默认（仅示例）", "Expires 12/2030 · Default (example only)") : t("未接入付款方式查询；不能据此判断未绑定银行卡。", "No saved-payment-method API is connected. This does not mean that no card is saved.")}</p>
        </div>
      </div>
      <Button variant="outline" disabled={!preview} aria-describedby={`${id}-reason`} onClick={onPreview}>{preview ? t("预览更新方式", "Preview method update") : t("更新付款方式", "Update payment method")}</Button>
    </div>
    <p id={`${id}-reason`} className="text-xs leading-5 text-muted-foreground">{preview
      ? t("此卡不是从账号读取的已绑卡。下方新增表单只预览流程，不会替换此样例、绑定真实方式或收集卡号/CVC。", "This card was not read from an account. The new-method form below only previews the flow; it does not replace this example, save a real method, or collect card numbers or CVCs.")
      : t("查询、添加、替换和删除付款方式均未提供服务合同，所有正式支付操作禁用。", "There is no service contract to read, add, replace, or remove payment methods. All real payment actions are disabled.")}</p>
  </section>
}

function BillingDetails({ preview = false }: { preview?: boolean }) {
  const t = useText()
  const id = useId()
  const fields = [
    { key: "name", label: t("账单名称 / 公司", "Billing name / company"), value: "Example Studio" },
    { key: "email", label: t("账单邮箱", "Billing email"), value: "billing@example.test" },
    { key: "country", label: t("国家或税务地区", "Country or tax region"), value: t("虚构示例地区", "Fictional example region") },
    { key: "address", label: t("街道地址", "Street address"), value: "2150 Demo Street" },
    { key: "city", label: t("城市 / 省州", "City / state"), value: t("示例城市", "Demo City") },
    { key: "postal", label: t("邮政编码", "Postal code"), value: "DEMO-1000" },
    { key: "tax", label: t("税号（VAT / GST / EIN 等）", "Tax ID (VAT / GST / EIN, etc.)"), value: "DEMO-TAX-0001" },
  ]
  return <section aria-labelledby={`${id}-title`} className="space-y-4">
    <h3 id={`${id}-title`} className="text-sm font-semibold">{preview ? t("账单资料 · 固定 Lab 样例", "Billing details · Fixed Lab example") : t("账单资料", "Billing details")}</h3>
    <p id={`${id}-reason`} className="text-sm leading-6 text-muted-foreground">{preview
      ? t("仅展示虚构资料的位置和格式，不是实际收票地址或有效税号。没有账单资料写入接口，因此不提供可保存的编辑表单，也不收集真实税务信息。", "Fictional examples show the layout only, not an actual invoice destination or valid tax ID. There is no billing-details write API, so this is not a savable edit form and no real tax information is collected.")
      : t("账单邮箱、地址和税务资料未接入读写 API，当前值未知；个人资料邮箱不会自动当作账单邮箱，也不推测税务地区。", "Billing email, address, and tax details have no read/write API, so their values are unknown. Your profile email is not assumed to be your billing email, and no tax region is inferred.")}</p>
    <fieldset disabled aria-describedby={`${id}-reason`} className="min-w-0 space-y-4 rounded-lg border bg-surface p-4">
      <legend className="sr-only">{t("账单邮箱、地址和税号（不可编辑）", "Billing email, address, and tax ID (not editable)")}</legend>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        {fields.map(field => <label key={field.key} htmlFor={`${id}-${field.key}`} className={`grid min-w-0 gap-2 text-sm ${field.key === "address" || field.key === "tax" ? "sm:col-span-2" : ""}`}>
          <span className="font-medium">{field.label}</span>
          <Input id={`${id}-${field.key}`} type={field.key === "email" ? "email" : "text"} disabled autoComplete="off" value={preview ? field.value : ""} placeholder={t("未知 · 服务未接入", "Unknown · Service not connected")} aria-describedby={`${id}-reason`} />
        </label>)}
      </div>
      <Button variant="outline" disabled aria-describedby={`${id}-reason`}>{t("保存账单资料", "Save billing details")}</Button>
    </fieldset>
  </section>
}

function ServiceBilling() {
  const t = useText()
  const id = useId()
  return <SettingsSection title={t("账单", "Billing")}>
    <SettingsNotice>
      <p id={`${id}-unavailable`} className="font-medium text-foreground">{t("账单与付款服务未接入", "Billing and payments are not connected")}</p>
      <p>{t("当前服务没有账单或支付接口，状态未知而非未绑卡。所有财务控件均禁用，不会收集、保存或发送银行卡资料，不会发起扣款。", "This service has no billing or payment API. The state is unknown, not an empty saved-card list. All financial controls are disabled; card details are not collected, saved, or sent, and no charge can be made.")}</p>
    </SettingsNotice>
    <DefaultPaymentMethod />
    <BillingDetails />
    <section aria-labelledby={`${id}-new-title`} className="space-y-4 border-t pt-5">
      <h3 id={`${id}-new-title`} className="text-sm font-semibold">{t("添加新的付款方式", "Add a new payment method")}</h3>
      <fieldset disabled aria-describedby={`${id}-unavailable`} className="min-w-0 space-y-6">
        <legend className="sr-only">{t("新增付款方式（不可用）", "New payment method (unavailable)")}</legend>
        <PaymentMethods value={null} disabled descriptionId={`${id}-unavailable`} />
        <LockedCardFields />
        <Button disabled className="w-full" aria-describedby={`${id}-unavailable`}>{t("继续", "Continue")}</Button>
      </fieldset>
    </section>
    <Button variant="outline" render={<Link to="../invoices" relative="path" />}>{t("查看发票与服务支持情况", "View invoices and availability")}</Button>
  </SettingsSection>
}

function PaymentPreviewDetails({ method }: { method: PaymentMethod }) {
  const t = useText()
  if (method === "card") return <div className="space-y-4">
    <p className="inline-flex items-center gap-2 rounded-md border bg-muted px-2 py-1 text-xs font-medium">
      <ShieldCheck aria-hidden="true" className="size-4" />{t("测试卡 · 非真实银行卡", "TEST CARD · Not a real card")}
    </p>
    <LockedCardFields preview />
  </div>
  if (method === "paypal") return <div className="space-y-3 rounded-lg border bg-surface p-4 text-sm">
    <p className="flex items-center gap-2 font-medium"><Wallet aria-hidden="true" className="size-5" />{t("PayPal 演示账户", "PayPal demo account")}</p>
    <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">buyer@example.test</p>
    <p className="leading-6 text-muted-foreground">{t("仅展示固定的虚构账户，不要求登录，不跳转至 PayPal，不连接或授权真实账户。", "This is a fixed fictional account. No sign-in, PayPal redirect, real account connection, or authorization takes place.")}</p>
  </div>
  return <div className="space-y-3 rounded-lg border bg-surface p-4 text-sm">
    <p className="flex items-center gap-2 font-medium"><Smartphone aria-hidden="true" className="size-5" />{t("Apple Pay 演示钱包", "Apple Pay demo wallet")}</p>
    <div className="space-y-1 rounded-md bg-muted p-3">
      <p className="text-xs font-medium">{t("测试卡 · 非真实银行卡", "TEST CARD · Not a real card")}</p>
      <p className="font-mono">{testCard.number}</p>
    </div>
    <p className="leading-6 text-muted-foreground">{t("仅预览固定的演示钱包，不会打开设备钱包、请求生物识别验证或生成付款令牌。", "Only a fixed demo wallet is previewed. Your device wallet will not open, and no biometric approval or payment token is requested.")}</p>
  </div>
}

function LabBilling() {
  const t = useText()
  const id = useId()
  const [username, setUsername] = useState("")
  const [city, setCity] = useState("")
  const [method, setMethod] = useState<PaymentMethod>("card")
  const [attempted, setAttempted] = useState(false)
  const [stage, setStage] = useState<"review" | "result" | null>(null)
  const [previewed, setPreviewed] = useState<PaymentMethod | null>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const cityRef = useRef<HTMLInputElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  const validUsername = username.trim().length >= 2 && username.trim().length <= 48 && /\p{L}/u.test(username)
  const validCity = city.trim().length >= 2 && city.trim().length <= 80 && /\p{L}/u.test(city)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (!validUsername || !validCity) {
      if (!validUsername) usernameRef.current?.focus()
      else cityRef.current?.focus()
      return
    }
    setStage("review")
  }

  return <SettingsSection title={t("账单", "Billing")} description={t("预览付款表单并检查演示信息；不会产生真实账单或扣款。", "Preview the payment form and review demo details. No real billing or charges take place.")}>
    <SettingsNotice>
      <p id={`${id}-preview`} className="font-medium text-foreground">{t("仅付款预览 · 不会扣款", "Payment preview only · No charge")}</p>
      <p>{t("请仅填写虚构的用户名和城市。付款资料固定且不可编辑；所有演示信息仅保留在当前页面内存中，离开页面或刷新后重置。", "Use a fictional username and city only. Payment details are fixed and cannot be edited. Demo details stay in this page's memory and reset when you leave or refresh.")}</p>
    </SettingsNotice>
    <DefaultPaymentMethod preview onPreview={() => usernameRef.current?.focus()} />
    <BillingDetails preview />
    <h3 className="border-t pt-5 text-sm font-semibold">{t("新增付款方式 · 安全 Lab 预览", "New payment method · Safe Lab preview")}</h3>
    <form noValidate autoComplete="off" onSubmit={submit} className="min-w-0 space-y-6" aria-describedby={`${id}-preview`}>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <label htmlFor={`${id}-username`} className="text-sm font-medium">{t("用户名", "Username")}</label>
          <Input id={`${id}-username`} ref={usernameRef} value={username} required maxLength={48} autoComplete="off" placeholder="demo-user" aria-invalid={attempted && !validUsername} aria-describedby={`${id}-username-help${attempted && !validUsername ? ` ${id}-username-error` : ""}`} onChange={event => { setUsername(event.target.value); setPreviewed(null) }} />
          <p id={`${id}-username-help`} className="text-xs leading-5 text-muted-foreground">{t("虚构用户名，2–48 个字符，至少包含一个字母或汉字。", "Fictional username, 2–48 characters, including at least one letter.")}</p>
          {attempted && !validUsername && <p id={`${id}-username-error`} role="alert" className="text-xs text-destructive">{t("请输入有效的演示用户名（2–48 个字符，至少包含一个字母或汉字）。", "Enter a demo username with 2–48 characters and at least one letter.")}</p>}
        </div>
        <div className="min-w-0 space-y-2">
          <label htmlFor={`${id}-city`} className="text-sm font-medium">{t("城市", "City")}</label>
          <Input id={`${id}-city`} ref={cityRef} value={city} required maxLength={80} autoComplete="off" placeholder={t("示例城市", "Demo City")} aria-invalid={attempted && !validCity} aria-describedby={`${id}-city-help${attempted && !validCity ? ` ${id}-city-error` : ""}`} onChange={event => { setCity(event.target.value); setPreviewed(null) }} />
          <p id={`${id}-city-help`} className="text-xs leading-5 text-muted-foreground">{t("虚构城市，2–80 个字符，至少包含一个字母或汉字。", "Fictional city, 2–80 characters, including at least one letter.")}</p>
          {attempted && !validCity && <p id={`${id}-city-error`} role="alert" className="text-xs text-destructive">{t("请输入有效的演示城市（2–80 个字符，至少包含一个字母或汉字）。", "Enter a demo city with 2–80 characters and at least one letter.")}</p>}
        </div>
      </div>
      <PaymentMethods value={method} onChange={next => { setMethod(next); setPreviewed(null) }} descriptionId={`${id}-method-help`} />
      <p id={`${id}-method-help`} className="text-xs leading-5 text-muted-foreground">{t("使用方向键选择方式。每种方式均为独立的本地预览，不会连接支付平台。", "Use arrow keys to choose a method. Each is a separate local preview; no payment provider is contacted.")}</p>
      <PaymentPreviewDetails method={method} />
      <Button ref={continueRef} type="submit" className="w-full" disabled={stage !== null}>{t("继续", "Continue")}</Button>
      {previewed && <p role="status" className="rounded-lg border bg-muted p-3 text-sm leading-6">
        {t("已完成本地预览：", "Local preview completed: ")}{methodLabel(previewed, t)}{t("。未保存付款方式，未连接支付平台，未产生扣款。", ". No payment method was saved, no provider was contacted, and no charge was made.")}
      </p>}
    </form>
    <Button variant="outline" render={<Link to="../invoices" relative="path" />}>{t("查看 Lab 发票样例", "View Lab invoice examples")}</Button>
    <Dialog open={stage !== null} onOpenChange={open => { if (!open) setStage(null) }}>
      <DialogContent className="max-w-lg" finalFocus={continueRef}>
        <DialogTitle>{stage === "result" ? t("预览完成 · 未扣款", "Preview complete · No charge") : t("检查演示付款信息", "Review demo payment details")}</DialogTitle>
        <DialogDescription>
          {stage === "result"
            ? t("仅完成当前页面的本地演示。未保存付款方式、未联系支付平台，也未进行授权或扣款。", "Only this page's local demonstration is complete. No payment method was saved, no payment provider was contacted, and no authorization or charge occurred.")
            : t("这是预览，不是付款确认。以下只显示演示资料；测试卡固定且已遮罩，绝不收集真实卡号或安全码。", "This is a preview, not a payment confirmation. Only demo details appear below. The test card is fixed and masked; real card numbers and CVCs are never collected.")}
        </DialogDescription>
        <DialogBody className="space-y-5">
          {stage === "result" ? <div role="status" className="flex items-start gap-3 rounded-lg border bg-muted p-4 text-sm leading-6">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <p>{methodLabel(method, t)}{t(" 预览已完成。可以返回修改演示信息或体验其他付款方式。", " preview completed. Go back to edit demo details or try another payment method.")}</p>
          </div> : <>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted-foreground">{t("演示用户名", "Demo username")}</dt><dd className="break-words">{username.trim()}</dd>
              <dt className="text-muted-foreground">{t("演示城市", "Demo city")}</dt><dd className="break-words">{city.trim()}</dd>
              <dt className="text-muted-foreground">{t("付款方式", "Payment method")}</dt><dd>{methodLabel(method, t)}</dd>
            </dl>
            <PaymentPreviewDetails method={method} />
          </>}
        </DialogBody>
        <DialogFooter className="flex-col-reverse sm:flex-row">
          <Button variant="outline" onClick={() => setStage(null)}>{t("返回编辑", "Back to edit")}</Button>
          {stage === "review" && <Button onClick={() => { setPreviewed(method); setStage("result") }}>{t("完成预览（不扣款）", "Finish preview (no charge)")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsSection>
}

export function SettingsBilling({ mode }: SettingsPageProps) {
  return mode === "service" ? <ServiceBilling /> : <LabBilling />
}
