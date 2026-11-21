import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router"
import { ArrowRight, Plug, RefreshCw } from "lucide-react"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { BundledSkillsPanel } from "@/components/bundled-skills-panel"
import { onboardingProviderUrl } from "@/lib/onboarding-navigation"
import { usePmService } from "./pm-service"
import { useText } from "./pm-ui"

const accessSchema = z.object({ authorized: z.boolean() })
const providersSchema = z.object({ providers: z.array(z.object({
  instanceId: z.string(), label: z.string(), enabled: z.boolean(), configured: z.boolean(),
  nativeSessionReady: z.boolean(), authStatus: z.enum(["authenticated", "unauthenticated", "unknown", "not-installed"]),
})) })
type AiStatus = {
  status: "loading" | "access-required" | "unavailable" | "available"
  configured: boolean
  providers: z.infer<typeof providersSchema>["providers"]
}
export type OnboardingAiStatus = AiStatus & { refresh: () => void }
const loading: AiStatus = { status: "loading", configured: false, providers: [] }

/** Reads existing Agent access and provider facts. Never starts auth, a test, or a model call. */
export function useOnboardingAiStatus(enabled = true): OnboardingAiStatus {
  const { actor, actorEpoch } = usePmService()
  const owner = actor ? `${actor.id}:${actorEpoch}` : null
  const [request, setRequest] = useState(0)
  const [snapshot, setSnapshot] = useState<{ owner: string; request: number; value: AiStatus } | null>(null)
  const refresh = useCallback(() => setRequest(value => value + 1), [])
  useEffect(() => {
    if (!owner || !enabled) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    const store = (value: AiStatus) => {
      if (!controller.signal.aborted) setSnapshot({ owner, request, value })
    }
    const read = async () => {
      const access = await fetch("/agent/api/access", { credentials: "same-origin", cache: "no-store", signal })
      if (access.status === 401 || access.status === 403) {
        store({ status: "access-required", configured: false, providers: [] })
        return
      }
      if (!access.ok) throw new Error("Agent access unavailable")
      if (!accessSchema.parse(await access.json()).authorized) {
        store({ status: "access-required", configured: false, providers: [] })
        return
      }
      const response = await fetch("/agent/api/providers", { credentials: "same-origin", cache: "no-store", signal })
      if (response.status === 401 || response.status === 403) {
        store({ status: "access-required", configured: false, providers: [] })
        return
      }
      if (!response.ok) throw new Error("Provider inventory unavailable")
      const { providers } = providersSchema.parse(await response.json())
      store({ status: "available", providers, configured: providers.some(provider => provider.enabled && provider.configured && provider.nativeSessionReady) })
    }
    void read().catch(() => store({ status: "unavailable", configured: false, providers: [] }))
    window.addEventListener("focus", refresh)
    return () => { controller.abort(); window.removeEventListener("focus", refresh) }
  }, [owner, request, enabled, refresh])
  const current = enabled && owner && snapshot?.owner === owner && snapshot.request === request ? snapshot.value : loading
  return { ...current, refresh }
}

export function OnboardingAi({ ai, onContinue, busy, returnTo, onInstallBusyChange }: {
  ai: OnboardingAiStatus
  onContinue: (configured: boolean) => void
  busy: boolean
  returnTo: string
  onInstallBusyChange: (busy: boolean) => void
}) {
  const t = useText()
  const { actor, actorEpoch } = usePmService()
  const available = ai.providers.filter(provider => provider.enabled && provider.configured && provider.nativeSessionReady)
  const [installBusy, setInstallBusy] = useState(false)
  const locked = busy || installBusy
  const reportInstallBusy = useCallback((value: boolean) => {
    setInstallBusy(value)
    onInstallBusyChange(value)
  }, [onInstallBusyChange])
  return <section className="space-y-5" aria-label={t("连接 AI（可选）", "Connect AI (optional)")} data-tour="onboarding-ai">
    <div className="rounded-xl border bg-surface p-5">
      <Plug className="mb-3 size-6 text-primary" aria-hidden="true" />
      <h2 className="text-lg font-semibold">{t("让 AI 成为你的助手", "Bring AI into your workspace")}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("连接已有 Provider，或稍后再配置。项目、任务和文档不依赖 AI；这里不会自动登录供应商、读取凭据或发送消息。", "Connect an existing provider, or set it up later. Projects, tasks and documents do not require AI. This guide does not sign in to providers, import credentials or send messages.")}</p>
      <div className="mt-4 space-y-2 text-sm" aria-live="polite">
        {ai.status === "loading" && <p role="status">{t("正在核对 Agent 访问与 Provider 状态…", "Checking Agent access and provider status…")}</p>}
        {ai.status === "access-required" && <p>{t("Agent 需要独立访问验证。PM 登录不会授予 Agent 权限；可进入设置完成验证，或跳过此步。", "Agent requires separate access verification. PM sign-in does not grant Agent access. Verify access in settings, or skip this step.")}</p>}
        {ai.status === "unavailable" && <p role="alert">{t("暂时无法核对 AI 状态。不会将读取失败当作未配置或已就绪。", "AI status could not be verified. A failed read is neither an empty configuration nor proof of readiness.")}</p>}
        {ai.status === "available" && (ai.configured
          ? <p>{t("已读取到启用且原生就绪的 Provider：", "Enabled providers reporting native readiness: ")}{available.map(provider => provider.label).join("、")}</p>
          : <p>{t("尚未读取到启用且原生就绪的 Provider。", "No enabled provider currently reports native readiness.")}</p>)}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link className={`inline-flex items-center gap-2 rounded-control border px-3 py-2 text-sm font-medium hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring ${locked ? "pointer-events-none opacity-50" : ""}`} aria-disabled={locked || undefined} tabIndex={locked ? -1 : undefined} to={onboardingProviderUrl(returnTo)}>{t("打开 Provider 设置", "Open provider settings")}<ArrowRight className="size-4" aria-hidden="true" /></Link>
        <Button type="button" variant="ghost" size="sm" disabled={locked || ai.status === "loading"} onClick={ai.refresh}><RefreshCw className="size-4" aria-hidden="true" />{t("重新核对", "Check again")}</Button>
      </div>
    </div>
    <BundledSkillsPanel t={t} ownerKey={`${actor?.id ?? "anonymous"}:${actorEpoch}`} disabled={busy || ai.status !== "available"} onBusyChange={reportInstallBusy} />
    <p className="text-xs leading-5 text-muted-foreground">{t("配置状态不是实际模型调用验证。Agent 配置适用于本机服务，不是当前 PM 工作区的私有配置；会话与持久化仍沿用 Agent Chat，统一设计尚未收口。", "Configuration status is not a verified model call. Agent settings apply to the local service, not privately to this PM workspace. Sessions and persistence still use Agent Chat; the unified design is not finalized.")}</p>
    <div className="flex flex-wrap gap-3" data-tour="onboarding-ai-actions">
      {ai.configured && <Button type="button" disabled={locked} onClick={() => onContinue(true)}>{t("继续", "Continue")}<ArrowRight className="size-4" aria-hidden="true" /></Button>}
      <Button type="button" variant="outline" disabled={locked} onClick={() => onContinue(false)}>{t("稍后配置 AI", "Set up AI later")}</Button>
    </div>
  </section>
}
