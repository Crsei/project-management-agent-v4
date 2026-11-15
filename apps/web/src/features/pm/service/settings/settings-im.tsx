import { useEffect, useState } from "react"
import type { ImBinding, ImBot, ImSettings } from "@contracts"
import { Check, Clock3, Copy, ExternalLink, MessageCircle, Send } from "lucide-react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n-provider"
import { usePmService, usePrivateQuery, pmErrorMessage } from "../pm-service"
import { pmKeys } from "../pm-data"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

function formatTime(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale === "en" ? "en" : "zh-CN")
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function botFor(settings: ImSettings | undefined, platform: string): ImBot | undefined {
  return settings?.connectivity.bots.find(bot => bot.platform === platform)
}

function ServiceImSettings() {
  const t = useText()
  const { locale } = useI18n()
  const service = usePmService()
  const query = usePrivateQuery(
    [...pmKeys.workspace(window.location.origin, service.actor?.id ?? "anonymous", service.workspace?.id ?? "none"), "im"],
    "domain.read",
    undefined,
    (client, workspaceId, signal) => client.getImSettings(workspaceId, { signal }),
  )
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null)
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [codeNow, setCodeNow] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  const [refreshResult, setRefreshResult] = useState<string | null>(null)

  useEffect(() => {
    if (!dialogOpen) return
    const timer = window.setInterval(() => setCodeNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [dialogOpen])

  if (service.loading) return <p role="status">{t("正在读取当前会话…", "Loading current session…")}</p>
  if (service.error || !service.workspace) return <div role="alert" className="space-y-3"><p>{t("会话或工作区不可用；不读取 IM 配置。", "Session or workspace unavailable; IM configuration is not queried.")}</p><Button variant="outline" onClick={() => { void service.refresh().catch(() => {}) }}>{t("重新读取会话", "Reload session")}</Button></div>

  const data = !query.error ? query.data : undefined
  const configured = data?.configuration === "configured"
  const satoriReady = data?.connectivity.satori.state === "ready"
  const telegramBot = botFor(data, "telegram")
  const canConnectTelegram = configured && satoriReady && telegramBot?.status === "online"
  const telegramBinding = data?.bindings.find(binding => binding.platform === "telegram")
  const canManage = service.workspace.capabilities.includes("access.manage")
  const satori = data?.connectivity.satori

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try { await action() }
    catch (failure) { setActionError(pmErrorMessage(failure, locale === "en" ? "en" : "zh")) }
    finally { setBusy(false) }
  }
  const generateCode = async () => {
    if (!service.workspace) return
    if (!canConnectTelegram) {
      setDialogOpen(true)
      setCodeError(t("机器人当前不在线，暂时不能生成链接码。", "The bot is currently offline, so a link code cannot be generated."))
      return
    }
    setDialogOpen(true)
    setCodeBusy(true)
    setCodeError(null)
    setRefreshResult(null)
    try {
      setCode(await service.client.createImLinkCode(service.workspace.id))
      setCodeNow(Date.now())
      setDialogOpen(true)
    } catch (failure) {
      setCodeError(pmErrorMessage(failure, locale === "en" ? "en" : "zh"))
      setDialogOpen(true)
    } finally { setCodeBusy(false) }
  }
  const refreshBindings = async () => {
    setBusy(true)
    setActionError(null)
    try {
      const result = await query.refetch()
      const found = result.data?.bindings.some(binding => binding.platform === "telegram")
      setRefreshResult(found ? t("已检测到 Telegram 绑定。", "Telegram binding detected.") : t("尚未检测到绑定；请确认已在机器人私聊发送命令。", "No binding detected yet; confirm the command was sent in the bot private chat."))
      if (found) setDialogOpen(false)
    } catch (failure) {
      const message = pmErrorMessage(failure, locale === "en" ? "en" : "zh")
      setActionError(message)
      setCodeError(message)
    }
    finally { setBusy(false) }
  }
  const toggleNotify = (binding: ImBinding) => run(async () => {
    if (!service.workspace) return
    await service.client.setImBindingNotify(service.workspace.id, binding.id, { notifyEnabled: !binding.notifyEnabled })
    await query.refetch()
  })
  const revoke = (binding: ImBinding) => {
    if (!window.confirm(t("撤销后该平台账号将立即停止收发，但历史记录保留。继续？", "Revoking immediately stops sending and receiving for this platform account; history is retained. Continue?"))) return
    void run(async () => {
      if (!service.workspace) return
      await service.client.revokeImBinding(service.workspace.id, binding.id)
      await query.refetch()
    })
  }
  const copyCode = async () => {
    if (!code) return
    try { await navigator.clipboard?.writeText(`/link ${code.code}`); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
    catch { setActionError(t("无法复制，请手动选择命令。", "Could not copy; select the command manually.")) }
  }
  const codeRemaining = code ? Date.parse(code.expiresAt) - codeNow : 0
  const connectionLabel = !configured
    ? t("尚未配置", "Not configured")
    : satori?.state === "ready"
      ? t("已连接 Satori", "Satori connected")
      : satori?.state === "connecting" ? t("正在连接 Satori…", "Connecting to Satori…")
        : satori?.state === "auth_failed" ? t("Satori 鉴权失败", "Satori authentication failed")
          : t("未连接 Satori", "Satori disconnected")
  const botLabel = telegramBot
    ? telegramBot.status === "online" ? t("在线", "Online")
      : telegramBot.status === "offline" ? t("离线", "Offline")
        : telegramBot.status === "connecting" ? t("连接中", "Connecting") : t("状态未知", "Unknown")
    : t("未读取到机器人", "Bot not reported")

  return <div className="min-w-0 space-y-6 text-sm">
    <SettingsNotice>{t("IM 网关只负责平台连接；身份、权限、任务和通知仍由 Dovspace 处理。首期仅支持私聊文字命令，不开放群聊、文件、按钮、任意命令转发或 Agent/终端能力。", "The IM gateway only handles platform connectivity. Identity, permissions, tasks and notifications remain in Dovspace. This first release supports private-chat text commands only; groups, files, buttons, arbitrary command forwarding and Agent/terminal capabilities are unavailable.")}</SettingsNotice>
    {actionError && <p role="alert" className="text-destructive">{actionError}</p>}

    <section className="space-y-3 rounded-module border p-4">
      <h3 className="font-medium">{t("服务状态", "Service status")}</h3>
      {!data && (query.isPending || query.isFetching) && <p role="status">{t("正在读取配置、Satori 连接和机器人状态…", "Reading configuration, Satori connection and bot state…")}</p>}
      {query.error && <p role="alert">{t("暂时无法读取服务状态；这不代表没有历史绑定。", "Service state is temporarily unavailable; this does not mean there are no historical bindings.")} {pmErrorMessage(query.error, locale === "en" ? "en" : "zh")}</p>}
      {query.isPaused && <p role="status">{t("离线；读取暂停。", "Offline; reads paused.")}</p>}
      {data && <>
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t("配置", "Configuration")}</dt><dd className="font-medium">{configured ? t("已配置", "Configured") : t("尚未配置 IM 网关", "IM gateway not configured")}</dd></div>
          <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t("Satori 连接", "Satori connection")}</dt><dd className="font-medium">{connectionLabel}</dd></div>
          <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t("Telegram 机器人", "Telegram bot")}</dt><dd className="font-medium">{telegramBot ? `${telegramBot.name ?? telegramBot.selfId} · ${botLabel}` : botLabel}</dd></div>
        </dl>
        <p className="text-xs leading-5 text-muted-foreground">{t("Satori 已连接不等于 Telegram Bot 在线；网关离线不会删除历史绑定。绑定数据读取失败也不会被显示为“没有绑定”。", "Satori connected does not mean the Telegram bot is online; an offline gateway does not delete historical bindings. A binding read failure is not displayed as “no bindings”.")}</p>
        {satori?.lastErrorCode && <p className="break-all text-xs text-muted-foreground">{t("最近安全错误码：", "Latest safe error code: ")}{satori.lastErrorCode}</p>}
        {!configured && <SettingsNotice>{canManage
          ? <details className="space-y-2"><summary className="cursor-pointer font-medium">{t("部署管理员配置", "Deployment administrator configuration")}</summary><p className="pt-2">{t("此实例尚未配置 IM 网关。请由部署管理员按部署手册启动独立 Koishi、配置 Satori 地址与私有 token，然后重启 PM API/Worker。普通成员无需操作，已有绑定不会被删除。", "This instance has no IM gateway configured. A deployment administrator should start an independent Koishi runtime, configure the Satori address and private token, then restart PM API/Worker. Members need no action, and existing bindings are not deleted.")}</p><p className="text-xs text-muted-foreground">{t("完整步骤见 deploy/koishi/README.md；本页不收集 token 或平台凭据。", "Full steps are in deploy/koishi/README.md; this page collects no token or platform credentials.")}</p></details>
          : t("此实例尚未配置即时通讯。请联系实例管理员；已有绑定不会被删除。", "This instance has no messaging configured. Contact the instance administrator; existing bindings are not deleted.")}</SettingsNotice>}
      </>}
    </section>

    <section className="space-y-3 rounded-module border p-4">
      <h3 className="font-medium">{t("连接账号", "Connect an account")}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3 rounded-control border p-3">
          <div className="flex items-center gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-surface-raised"><Send aria-hidden="true" className="size-5" /></span><div className="min-w-0"><h4 className="font-medium">Telegram</h4><p className="text-xs text-muted-foreground">{t("通过机器人私聊进行身份绑定", "Identity binding through the bot private chat")}</p></div></div>
          <p className="min-w-0 break-all text-xs text-muted-foreground">{telegramBot ? `${telegramBot.name ?? telegramBot.selfId}${telegramBot.username ? ` · @${telegramBot.username}` : ""} · ${botLabel}` : t("尚未读取到 Telegram 机器人", "Telegram bot not reported yet")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || codeBusy || !canConnectTelegram} onClick={() => { void generateCode() }}>{telegramBinding ? t("重新连接", "Reconnect") : t("连接", "Connect")}</Button>
            {!data ? <span className="self-center text-xs text-muted-foreground">{t("状态不可用，暂不能连接", "Status unavailable; connection is disabled")}</span>
              : !configured ? <span className="self-center text-xs text-muted-foreground">{t("网关未配置", "Gateway not configured")}</span>
                : !satoriReady ? <span className="self-center text-xs text-muted-foreground">{t("等待 Satori 连接", "Waiting for Satori")}</span>
                  : telegramBot?.status !== "online" ? <span className="self-center text-xs text-muted-foreground">{t("等待机器人上线", "Waiting for the bot")}</span> : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3 rounded-control border p-3 opacity-70">
          <div className="flex items-center gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-surface-raised"><MessageCircle aria-hidden="true" className="size-5" /></span><div className="min-w-0"><h4 className="font-medium">飞书</h4><p className="text-xs text-muted-foreground">{t("等待平台配置", "Waiting for platform configuration")}</p></div></div>
          <p className="text-xs text-muted-foreground">{t("后续通过 Koishi 适配器接入；当前不提供连接或凭据表单。", "Planned through a Koishi adapter; no connection or credential form is available now.")}</p>
          <Button size="sm" variant="outline" disabled>{t("暂不可用", "Unavailable")}</Button>
        </div>
      </div>
    </section>

    <section className="space-y-3 rounded-module border p-4">
      <h3 className="font-medium">{t("我的绑定", "My bindings")}</h3>
      {!data && (query.isPending || query.isFetching) && <p role="status">{t("正在读取绑定…", "Loading bindings…")}</p>}
      {query.error && <p role="alert">{t("暂时无法读取绑定；这不表示没有绑定。", "Bindings are temporarily unavailable; this does not mean there are none.")}</p>}
      {data && !data.bindings.length && <p className="text-muted-foreground">{t("尚无已确认的账号绑定。", "No confirmed account bindings.")}</p>}
      <ul className="space-y-3">{data?.bindings.map(binding => <li key={binding.id} className="space-y-3 rounded-control border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0"><p className="font-medium break-all">{binding.accountLabel}</p><p className="text-xs text-muted-foreground">{t("平台：", "Platform: ")}{binding.platform} · {t("绑定时间：", "Linked: ")}{formatTime(binding.verifiedAt, locale)}</p></div>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => { void toggleNotify(binding) }}>{binding.notifyEnabled ? t("关闭通知", "Disable notifications") : t("开启通知", "Enable notifications")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => revoke(binding)}>{t("解绑", "Unbind")}</Button></div>
        </div>
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <p>{t("默认项目：", "Default project: ")}{binding.defaultProjectId ? <Link className="text-primary hover:text-foreground" to={`/pm/${encodeURIComponent(service.workspace!.id)}/projects/${encodeURIComponent(binding.defaultProjectId)}`}>{binding.defaultProjectId}</Link> : t("尚未选择", "Not selected")}</p>
          <p>{t("最近活动：", "Last seen: ")}{formatTime(binding.lastSeenAt, locale)}</p>
          <p>{t("通知：", "Notifications: ")}{binding.notifyEnabled ? t("已开启", "Enabled") : t("已关闭", "Disabled")}</p>
        </div>
      </li>)}</ul>
    </section>

    <details className="rounded-module border p-4 text-sm">
      <summary className="cursor-pointer font-medium">{t("支持的命令与边界", "Supported commands and boundaries")}</summary>
      <div className="space-y-3 pt-3 text-muted-foreground">
        <p>{t("仅私聊；命令由固定白名单解析，未知命令不会转发给 Agent 或终端。", "Private chat only; commands are parsed from a fixed allowlist and are never forwarded to Agent or a terminal.")}</p>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="font-mono text-xs text-foreground">/link &lt;码&gt;</dt><dd>{t("绑定当前平台账号", "Bind the current platform account")}</dd></div>
          <div><dt className="font-mono text-xs text-foreground">/projects · /use &lt;项目ID&gt;</dt><dd>{t("查看并选择默认项目", "List and select the default project")}</dd></div>
          <div><dt className="font-mono text-xs text-foreground">/task [项目ID] &lt;标题&gt;</dt><dd>{t("创建任务", "Create a work item")}</dd></div>
          <div><dt className="font-mono text-xs text-foreground">/tasks · /mine · /show &lt;任务ID&gt;</dt><dd>{t("查看可读任务", "Read authorized tasks")}</dd></div>
          <div><dt className="font-mono text-xs text-foreground">/comment &lt;任务ID&gt; &lt;文本&gt;</dt><dd>{t("创建评论；需现有评论能力", "Create a comment; existing capability required")}</dd></div>
          <div><dt className="font-mono text-xs text-foreground">/watch · /unwatch &lt;任务ID&gt;</dt><dd>{t("关注或取消关注", "Watch or unwatch a task")}</dd></div>
          <div><dt className="font-mono text-xs text-foreground">/start · /done · /cancel</dt><dd>{t("按现有工作流转换状态", "Transition through the existing workflow")}</dd></div>
          <div><dt className="font-mono text-xs text-foreground">/notify on|off · /unlink · /help</dt><dd>{t("通知、解绑与帮助", "Notifications, unbinding and help")}</dd></div>
        </dl>
        <p>{t("绑定、通知和解绑由 Dovspace 保存；Koishi 离线时仍可读取和解绑。聊天成功、HTTP 2xx 或 Satori accepted 都不等于任务完成。", "Bindings, notifications and unbinding are stored by Dovspace and remain readable and revocable while Koishi is offline. Chat success, HTTP 2xx or Satori acceptance never completes a task.")}</p>
      </div>
    </details>

    <Dialog open={dialogOpen} onOpenChange={open => { setDialogOpen(open); if (!open) { setCode(null); setCodeError(null); setRefreshResult(null) } }}>
      <DialogContent className="max-w-xl">
        <DialogTitle>{t("连接 Telegram", "Connect Telegram")}</DialogTitle>
        <DialogDescription>{t("在机器人私聊中发送一次性命令。不要在群聊中使用链接码，也不要转发给其他人。", "Send a one-time command in the bot private chat. Do not use the code in a group or forward it.")}</DialogDescription>
        <DialogBody className="space-y-4">
          <div className="space-y-1 rounded-control border bg-surface-raised p-3">
            <p className="font-medium">{telegramBot?.name ?? "Telegram"}{telegramBot?.username ? ` · @${telegramBot.username}` : ""}</p>
            <p className="text-xs text-muted-foreground">{t("平台：Telegram · 机器人状态：", "Platform: Telegram · Bot status: ")}{botLabel}</p>
            {telegramBot?.url
              ? <Button size="sm" variant="outline" render={<a href={telegramBot.url} target="_blank" rel="noreferrer" />}>{t("打开 Telegram", "Open Telegram")}<ExternalLink aria-hidden="true" className="size-4" /></Button>
              : <p className="text-xs text-muted-foreground">{t("未配置机器人链接；请在 Telegram 中搜索机器人名称。", "No bot link is configured; search for the bot name in Telegram.")}</p>}
          </div>
          {codeError && <p role="alert" className="text-destructive">{codeError}</p>}
          {codeError && !code && !codeBusy && <Button size="sm" onClick={() => { void generateCode() }}>{t("重试生成", "Try again")}</Button>}
          {codeBusy && <p role="status">{t("正在生成链接码…", "Generating link code…")}</p>}
          {code && <>
            <div className="rounded-control border p-3">
              <p className="break-all font-mono text-base">/link {code.code}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => { void copyCode() }}>{copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}{copied ? t("已复制", "Copied") : t("复制命令", "Copy command")}</Button>
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 aria-hidden="true" className="size-4" />{codeRemaining > 0 ? t(`剩余 ${formatRemaining(codeRemaining)}`, `${formatRemaining(codeRemaining)} remaining`) : t("链接码已过期，请重新生成。", "The code expired; generate a new one.")}</p>
            {codeRemaining <= 0 && <Button size="sm" variant="outline" disabled={codeBusy} onClick={() => { void generateCode() }}>{t("重新生成", "Generate again")}</Button>}
          </>}
          {refreshResult && <p role="status" className="text-xs text-muted-foreground">{refreshResult}</p>}
          {!code && !codeBusy && !codeError && <Button size="sm" onClick={() => { void generateCode() }}>{t("生成链接码", "Generate link code")}</Button>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { void refreshBindings() }}>{t("已发送，刷新状态", "Sent; refresh status")}</Button>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>{t("取消", "Cancel")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

export function SettingsIm({ mode }: SettingsPageProps) {
  const t = useText()
  return <SettingsSection title={t("即时通讯", "Instant messaging")} description={t("将你的聊天账号连接到 Dovspace，接收项目通知并使用支持的命令。", "Connect your chat account to Dovspace to receive project notifications and use supported commands.")}>
    {mode === "service" ? <ServiceImSettings /> : <SettingsNotice>{t("Lab · 静态说明，不读取真实连接、绑定或机器人状态，不生成链接码。", "Lab · Static information only; no real connection, bindings or bot state are read, and no link code is generated.")}</SettingsNotice>}
  </SettingsSection>
}
