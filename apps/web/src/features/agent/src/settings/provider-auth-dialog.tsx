"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Terminal } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { cn } from "@agent/lib/utils";
import type { ProviderAuthPhase, ProviderAuthStartInput, ProviderAuthState, ProviderInstance, ProviderMaintenanceState } from "@agent-workspace/contracts/provider";
import { field, mono } from "@agent/components/assistant-ui/elements/surfaces";
import { useSettingsGuard } from "./settings-layout";
import { workspaceClient } from "@agent/src/network";
import { useAgentText, type AgentText } from "../i18n";
import { getProviderInstanceDisplayName } from "@agent-workspace/client-runtime/providers";
import { ProviderStatus } from "./provider-card";
import { RadixSelect } from "@/components/ui/radix-select"

const phaseMeta = (t: AgentText): Record<ProviderAuthPhase, { label: string; tone: string }> => ({
  idle: { label: t("准备登录", "Ready to sign in"), tone: "text-muted-foreground" },
  starting: { label: t("正在启动登录流程…", "Starting sign-in…"), tone: "text-muted-foreground" },
  waiting: { label: t("等待完成登录…", "Waiting for sign-in to complete…"), tone: "text-foreground" },
  verifying: { label: t("正在验证登录状态…", "Verifying sign-in status…"), tone: "text-foreground" },
  succeeded: { label: t("认证流程已完成", "Authentication completed"), tone: "text-emerald-700 dark:text-emerald-300" },
  failed: { label: t("登录失败", "Sign-in failed"), tone: "text-destructive" },
  cancelled: { label: t("登录已取消", "Sign-in cancelled"), tone: "text-muted-foreground" },
});

export type ProviderAuthDialogProps = {
  open: boolean;
  provider: ProviderInstance | null;
  authState: ProviderAuthState | null;
  authInstanceId: string | null;
  authError?: string | null;
  initialMethodId?: string;
  autoStart?: boolean;
  loadAuth: (instanceId: string) => Promise<ProviderAuthState>;
  startAuth: (instanceId: string, input?: ProviderAuthStartInput) => Promise<ProviderAuthState>;
  cancelAuth: (instanceId: string, flowId: string) => Promise<void>;
  sendAuthInput: (instanceId: string, flowId: string, input: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
};

export function ProviderAuthDialog({ open, provider, authState, authInstanceId, authError, initialMethodId, autoStart = false, loadAuth, startAuth, cancelAuth, sendAuthInput, onOpenChange }: ProviderAuthDialogProps) {
  const t = useAgentText();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [methodId, setMethodId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [terminalInput, setTerminalInput] = useState("");
  const [manualBrowserUrl, setManualBrowserUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preparation, setPreparation] = useState<ProviderMaintenanceState | null>(null);
  const [cancellingPreparation, setCancellingPreparation] = useState(false);
  const preparationController = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);
  const mounted = useRef(true);
  const { setGuard } = useSettingsGuard();
  const instanceId = provider?.instanceId ?? "";
  const current = authInstanceId === instanceId ? authState : null;
  const phase = current?.phase ?? "idle";
  const active = phase === "starting" || phase === "waiting" || phase === "verifying";
  const methods = current?.methods ?? provider?.authMethods ?? [];
  const selectedMethod = methods.find((method) => method.id === methodId) ?? (methodId ? undefined : methods[0]);
  const interaction = current?.interaction;
  const acpEnvironmentMethod = provider?.driver === "acpRegistry" && (selectedMethod?.type === "credentials" || interaction?.type === "credentials");
  const requiredEnvironmentFields = interaction?.type === "credentials" ? interaction.fields : selectedMethod?.type === "credentials" ? selectedMethod.fields ?? [] : [];
  const credentialFields = acpEnvironmentMethod ? [] : active && interaction?.type === "credentials" ? interaction.fields : selectedMethod?.type === "credentials" && !active ? selectedMethod.fields ?? [] : [];
  const credentialDraftId = `${instanceId}:${selectedMethod?.id ?? ""}:${interaction?.type === "credentials" ? interaction.id : ""}`;
  const dirty = Boolean(terminalInput || Object.values(values).some((value) => value !== ""));
  const managedCodex = provider?.driver === "codex" && provider.config.setupMode === "managed";
  const canStart = Boolean(provider?.enabled && (active || provider.canLogin || managedCodex));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; preparationController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!open || !instanceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMethodId(initialMethodId ?? "");
    setValues({});
    setTerminalInput("");
    setManualBrowserUrl(null);
    autoStarted.current = false;
    setPreparation(null);
    void loadAuth(instanceId).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : t("无法获取登录方式。", "Unable to load sign-in methods."));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, instanceId, initialMethodId, loadAuth]);
  useEffect(() => { setValues({}); }, [credentialDraftId, open]);
  useEffect(() => { setTerminalInput(""); }, [current?.flowId, interaction?.id]);
  useEffect(() => {
    if (!open) { setValues({}); setTerminalInput(""); }
  }, [open]);
  useEffect(() => {
    setGuard(!open ? "clean" : pending ? "busy" : dirty || active ? "dirty" : "clean");
    return () => setGuard("clean");
  }, [open, pending, dirty, active, setGuard]);
  useEffect(() => {
    if (!open || !autoStart || loading || !current || autoStarted.current) return;
    if (active) { autoStarted.current = true; return; }
    if (!selectedMethod || !canStart) return;
    autoStarted.current = true;
    void start();
  }, [open, autoStart, loading, current, active, selectedMethod, canStart]);

  if (!provider) return null;
  const meta = phaseMeta(t)[phase];
  const device = interaction?.type === "browser" || interaction?.type === "device-code" ? interaction : null;
  const deviceUrl = device?.url || current?.authorizationUrl;
  const userCode = device?.userCode || current?.userCode;
  const terminal = interaction?.type === "terminal" ? interaction : null;
  const output = current?.output || terminal?.output;
  const browserConsentRequired = device?.type === "browser" && "requiresConsent" in device && device.requiresConsent === true;
  const browserAcceptsCallback = device?.type === "browser" && "acceptsCallback" in device && device.acceptsCallback === true;
  const credentialsReady = credentialFields.every((entry) => (values[entry.name] ?? "").length > 0);

  async function start(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pending || loading || !canStart || (!selectedMethod && !(active && interaction?.type === "credentials")) || !credentialsReady) return;
    setPending(true);
    setError(null);
    const input: ProviderAuthStartInput = { ...(!active && selectedMethod ? { methodId: selectedMethod.id } : {}), ...(credentialFields.length ? { values } : {}) };
    setValues({});
    let controller: AbortController | null = null;
    try {
      if (managedCodex && provider?.installation?.status !== "installed" && preparation?.status !== "succeeded") {
        if (provider?.revision === undefined) throw new Error(t("未取得服务器配置版本，请刷新后重试。", "No server configuration revision was received. Refresh and try again."));
        controller = new AbortController();
        preparationController.current = controller;
        setPreparing(true);
        const path = `/api/providers/${encodeURIComponent(instanceId)}/maintenance`;
        let state = await workspaceClient.json<ProviderMaintenanceState>(path, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "install", revision: provider.revision }), signal: controller.signal,
        });
        if (mounted.current) setPreparation(state);
        while (state.status === "running") {
          const delay = Promise.withResolvers<void>();
          window.setTimeout(delay.resolve, 1000);
          await delay.promise;
          controller.signal.throwIfAborted();
          state = await workspaceClient.json<ProviderMaintenanceState>(path, { signal: controller.signal });
          if (mounted.current) setPreparation(state);
        }
        controller.signal.throwIfAborted();
        if (state.status !== "succeeded") throw new Error(state.message ?? t("Codex 运行时准备未完成。", "Codex runtime preparation did not complete."));
        if (mounted.current) setPreparing(false);
      }
      if (active && current?.flowId && interaction?.type === "credentials")
        await sendAuthInput(instanceId, current.flowId, JSON.stringify(input.values ?? {}));
      else await startAuth(instanceId, input);
    }
    catch (cause) {
      if (mounted.current) setError(controller?.signal.aborted ? t("运行时准备已取消。", "Runtime preparation was cancelled.") : cause instanceof Error ? cause.message : t("无法启动登录流程。", "Unable to start the sign-in flow."));
    }
    finally {
      preparationController.current = null;
      if (mounted.current) { setPreparing(false); setPending(false); }
    }
  }

  async function cancelPreparation() {
    if (!preparationController.current || cancellingPreparation) return;
    preparationController.current.abort();
    setCancellingPreparation(true);
    try {
      const state = await workspaceClient.json<ProviderMaintenanceState>(`/api/providers/${encodeURIComponent(instanceId)}/maintenance`, { method: "DELETE" });
      if (mounted.current) setPreparation(state);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("取消运行时准备失败。", "Failed to cancel runtime preparation."));
    } finally { if (mounted.current) setCancellingPreparation(false); }
  }

  async function consentToBrowser() {
    if (!current?.flowId || !deviceUrl || !browserConsentRequired || pending) return;
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    setPending(true);
    setError(null);
    try {
      await sendAuthInput(instanceId, current.flowId, "continue");
      if (popup) popup.location.href = deviceUrl;
      else setManualBrowserUrl(deviceUrl);
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : t("无法确认浏览器认证授权。", "Unable to confirm browser authentication consent."));
    } finally { setPending(false); }
  }

  async function cancel(): Promise<boolean> {
    if (!current?.flowId) return !active;
    setPending(true);
    setError(null);
    try { await cancelAuth(instanceId, current.flowId); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法取消登录流程。", "Unable to cancel the sign-in flow.")); return false; }
    finally { setPending(false); }
  }

  async function submitTerminalInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current?.flowId || (!terminal && !browserAcceptsCallback) || pending || (browserAcceptsCallback && !terminalInput.trim())) return;
    setPending(true);
    setError(null);
    const input = terminalInput;
    setTerminalInput("");
    try { await sendAuthInput(instanceId, current.flowId, input); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法发送登录输入。", "Unable to send sign-in input.")); }
    finally { setPending(false); }
  }

  async function changeOpen(next: boolean) {
    if (next || pending || cancellingPreparation) return;
    if ((dirty || active) && !window.confirm(active ? t("关闭将取消当前登录流程，继续？", "Closing will cancel the current sign-in flow. Continue?") : t("放弃尚未发送的登录凭据？", "Discard the sign-in credentials that were not sent?"))) return;
    if (active && !(await cancel())) return;
    setValues({}); setTerminalInput("");
    onOpenChange(false);
  }

  return <Dialog open={open} onOpenChange={(next) => { void changeOpen(next); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-slot="provider-auth-dialog">
    <DialogHeader><DialogTitle>{t(`登录 ${getProviderInstanceDisplayName(provider)}`, `Sign in to ${getProviderInstanceDisplayName(provider)}`)}</DialogTitle></DialogHeader>
    <div className="flex flex-col gap-3">
      <ProviderStatus provider={provider} />
      <div role="status" aria-live="polite" className={cn("flex items-center gap-2 text-sm font-medium", meta.tone)}>
        {(active || loading || pending) && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
        {phase === "succeeded" && <CheckCircle2 aria-hidden="true" className="size-4" />}
        {phase === "failed" && <AlertTriangle aria-hidden="true" className="size-4" />}
        <span>{loading ? t("正在读取认证方式…", "Loading authentication methods…") : preparing ? t("正在准备 Codex 运行时…", "Preparing the Codex runtime…") : meta.label}</span>
        {active && current?.expiresAt && <span className={cn(mono, "text-muted-foreground ms-auto font-normal")}>{t(`截止 ${new Date(current.expiresAt).toLocaleTimeString()}`, `Expires ${new Date(current.expiresAt).toLocaleTimeString()}`)}</span>}
      </div>
      {(preparing || preparation) && <section aria-label={t("Codex 运行时准备", "Codex runtime preparation")} className="provider-feedback"><p>{preparation?.message ?? (preparing ? t("正在准备 Codex 运行时…", "Preparing the Codex runtime…") : preparation?.status)}</p>{preparation?.bytesDownloaded !== undefined && <span>{t(`${preparation.bytesDownloaded}${preparation.bytesTotal !== undefined ? ` / ${preparation.bytesTotal}` : ""} 字节`, `${preparation.bytesDownloaded}${preparation.bytesTotal !== undefined ? ` / ${preparation.bytesTotal}` : ""} bytes`)}</span>}{preparing && <Button type="button" size="sm" variant="outline" disabled={cancellingPreparation} onClick={() => void cancelPreparation()}>{t("取消准备", "Cancel preparation")}</Button>}</section>}
      {current?.message && <p role={phase === "failed" ? "alert" : "status"} className={cn("rounded-lg px-3 py-2 text-xs whitespace-pre-wrap break-words", phase === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{current.message}</p>}
      {phase === "succeeded" && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{t("认证流程已完成。原生会话就绪与账号身份分开展示，以上述当前状态为准；完成认证不等于远端服务或模型已通过验证。", "The authentication flow completed. Native session readiness and account identity are shown separately in the current status above; authentication completion does not verify the remote service or models.")}</p>}
      {phase === "cancelled" && <p className="text-muted-foreground text-xs">{t("认证流程已取消；可选择认证方式后重新启动。", "Authentication was cancelled. Choose a method to start again.")}</p>}
      {!loading && !active && methods.length > 0 && <label className="flex flex-col gap-1.5 text-xs" htmlFor={`${id}-method`}>{t("认证方式", "Authentication method")}<RadixSelect id={`${id}-method`} value={selectedMethod?.id ?? ""} disabled={pending} className="border-input bg-background rounded-md border px-3 py-2 text-sm" onChange={(event) => { setMethodId(event.target.value); setValues({}); setError(null); }}>{methods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</RadixSelect>{selectedMethod?.description && <span className="text-muted-foreground">{selectedMethod.description}</span>}</label>}
      {!loading && !active && methods.length === 0 && <p className="text-muted-foreground text-xs">{t("此 Agent 尚未声明可用的内置认证方式。请检查安装与配置，或按驱动文档完成外部认证；不会伪造登录成功。", "This Agent declares no built-in authentication methods. Check the installation and configuration, or complete external authentication per the driver docs; sign-in success is never faked.")}</p>}
      {!loading && !active && methodId && !selectedMethod && <p role="alert" className="text-destructive text-xs">{t("所选认证方式已不可用，请重新选择；不会改用其他账号。", "The selected authentication method is no longer available. Choose another one; a different account will not be used automatically.")}</p>}
      {acpEnvironmentMethod && <p className="text-muted-foreground text-xs">{t(`请在此实例的环境变量设置中填写 ${requiredEnvironmentFields.map((entry) => entry.name).join("、")}，保存后再开始认证。`, `Set ${requiredEnvironmentFields.map((entry) => entry.name).join(", ")} in this instance's environment variables and save before starting authentication.`)}{active ? t("请先取消当前登录并关闭此窗口。", "Cancel the current sign-in and close this window first.") : ""}</p>}
      {credentialFields.length > 0 && <form autoComplete="off" className="flex flex-col gap-3" onSubmit={(event) => { void start(event); }}>
        {credentialFields.map((entry) => <label key={entry.name} htmlFor={`${id}-credential-${entry.name}`} className="flex flex-col gap-1.5 text-xs">{entry.label}<Input id={`${id}-credential-${entry.name}`} type={entry.secret ? "password" : "text"} autoComplete={entry.secret ? "new-password" : "off"} spellCheck={false} maxLength={8192} value={values[entry.name] ?? ""} disabled={pending || loading} required onChange={(event) => setValues((previous) => ({ ...previous, [entry.name]: event.target.value }))} /></label>)}
        <Button type="submit" disabled={pending || loading || !credentialsReady || !canStart}>{pending && <Loader2 aria-hidden="true" className="animate-spin" />}{active ? t("提交认证凭据", "Submit credentials") : provider.authStatus === "authenticated" ? t("更换账号", "Switch account") : t("使用此方式登录", "Sign in with this method")}</Button>
      </form>}
      {(deviceUrl || userCode) && active && <section aria-label={t("浏览器或设备码登录", "Browser or device code sign-in")} className={cn(field, "flex flex-col gap-2 rounded-xl p-3 text-xs")}>
        <p>{userCode ? t("请打开以下地址并输入设备码：", "Open the address below and enter the device code:") : browserConsentRequired ? t("此 Agent 请求打开以下地址进行认证；仅在你信任此地址时同意。", "This Agent requests opening the address below for authentication; only consent if you trust this address.") : t("请在浏览器中打开以下地址完成认证：", "Open the address below in your browser to complete authentication:")}</p>
        {deviceUrl && (/^https?:\/\//i.test(deviceUrl) && !browserConsentRequired ? <a href={deviceUrl} target="_blank" rel="noreferrer noopener" className="text-primary inline-flex items-center gap-1 break-all hover:text-primary/80">{deviceUrl}<ExternalLink aria-hidden="true" className="size-3 shrink-0" /></a> : <span className="break-all">{deviceUrl}</span>)}
        {browserConsentRequired && deviceUrl && /^https?:\/\//i.test(deviceUrl) && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => { void consentToBrowser(); }}>{t("同意并打开认证页面", "Consent and open the authentication page")}</Button>}
        {userCode && <p>{t("设备码", "Device code")} <code aria-label={t("设备码", "Device code")} className={cn(mono, "bg-background rounded px-2 py-1 text-sm tracking-widest")}>{userCode}</code></p>}
      </section>}
      {manualBrowserUrl && <p className="text-muted-foreground text-xs">{t("浏览器阻止了新窗口。已发送打开此地址的同意；请手动", "The browser blocked the new window. Consent to open this address was sent; please manually")} <a href={manualBrowserUrl} target="_blank" rel="noreferrer noopener" className="hover:text-primary">{t("打开认证页面", "open the authentication page")}</a> {t("完成认证。", "to complete authentication.")}</p>}
      {output && <section aria-label={t("原生认证输出", "Native authentication output")} className="flex flex-col gap-2"><span className="text-muted-foreground flex items-center gap-1.5 text-xs"><Terminal aria-hidden="true" className="size-3.5" />{t("Agent 认证输出", "Agent authentication output")}</span><pre className={cn(mono, "bg-muted max-h-52 overflow-auto rounded-lg p-3 text-xs break-words whitespace-pre-wrap")} aria-live="polite">{output}</pre></section>}
      {terminal && active && <form className="flex flex-col gap-2" onSubmit={(event) => { void submitTerminalInput(event); }}><label htmlFor={`${id}-terminal`} className="text-xs">{t("发送到原生认证进程的输入（留空发送回车）", "Input sent to the native authentication process (leave blank to send Enter)")}</label><Input id={`${id}-terminal`} type="password" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} autoComplete="new-password" disabled={pending} spellCheck={false} /><Button type="submit" variant="outline" size="sm" disabled={pending}>{t("发送输入", "Send input")}</Button></form>}
      {browserAcceptsCallback && active && <form className="flex flex-col gap-2" onSubmit={(event) => { void submitTerminalInput(event); }}>
        <label htmlFor={`${id}-callback`} className="text-xs">{t("如果最后的 localhost 页面无法打开，请粘贴地址栏中的完整回调 URL。", "If the final localhost page does not open, paste the full callback URL from the address bar.")}</label>
        <Input id={`${id}-callback`} type="url" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} autoComplete="off" disabled={pending} spellCheck={false} maxLength={4096} />
        <Button type="submit" variant="outline" size="sm" disabled={pending || !terminalInput.trim()}>{t("提交回调 URL", "Submit callback URL")}</Button>
      </form>}
      {(error || authError) && <p role="alert" className="bg-destructive/10 text-destructive rounded-lg px-3 py-2 text-xs">{error || authError}</p>}
      {provider.docsUrl && <a href={provider.docsUrl} target="_blank" rel="noreferrer noopener" className="text-muted-foreground text-xs hover:text-foreground">{t("原生 Agent 配置与认证文档", "Native Agent configuration and authentication docs")}</a>}
    </div>
    <DialogFooter>{active && current?.flowId && <Button type="button" variant="outline" disabled={pending} onClick={() => { void cancel(); }}>{t("取消登录", "Cancel sign-in")}</Button>}{!active && credentialFields.length === 0 && methods.length > 0 && <Button type="button" disabled={pending || loading || cancellingPreparation || !canStart || !selectedMethod} onClick={() => { void start(); }}>{preparing ? t("准备运行时…", "Preparing runtime…") : provider.authStatus === "authenticated" ? t("更换账号", "Switch account") : phase === "failed" || phase === "cancelled" ? t("重新登录", "Sign in again") : t("开始登录", "Start sign-in")}</Button>}<Button type="button" variant="ghost" disabled={pending || cancellingPreparation} onClick={() => { void changeOpen(false); }}>{t("关闭", "Close")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
