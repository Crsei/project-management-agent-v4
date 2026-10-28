"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Terminal } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ProviderAuthPhase, ProviderAuthStartInput, ProviderAuthState, ProviderInstance } from "@agent-workspace/contracts/provider";
import { field, mono } from "@/components/assistant-ui/elements/surfaces";
import { useSettingsGuard } from "./settings-layout";

const PHASE_META: Record<ProviderAuthPhase, { label: string; tone: string }> = {
  idle: { label: "准备登录", tone: "text-muted-foreground" },
  starting: { label: "正在启动登录流程…", tone: "text-muted-foreground" },
  waiting: { label: "等待完成登录…", tone: "text-foreground" },
  verifying: { label: "正在验证登录状态…", tone: "text-foreground" },
  succeeded: { label: "认证流程已完成", tone: "text-emerald-700 dark:text-emerald-300" },
  failed: { label: "登录失败", tone: "text-destructive" },
  cancelled: { label: "登录已取消", tone: "text-muted-foreground" },
};

export type ProviderAuthDialogProps = {
  open: boolean;
  provider: ProviderInstance | null;
  authState: ProviderAuthState | null;
  authInstanceId: string | null;
  authError?: string | null;
  loadAuth: (instanceId: string) => Promise<ProviderAuthState>;
  startAuth: (instanceId: string, input?: ProviderAuthStartInput) => Promise<ProviderAuthState>;
  cancelAuth: (instanceId: string, flowId: string) => Promise<void>;
  sendAuthInput: (instanceId: string, flowId: string, input: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
};

export function ProviderAuthDialog({ open, provider, authState, authInstanceId, authError, loadAuth, startAuth, cancelAuth, sendAuthInput, onOpenChange }: ProviderAuthDialogProps) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [methodId, setMethodId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [terminalInput, setTerminalInput] = useState("");
  const [manualBrowserUrl, setManualBrowserUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const { setGuard } = useSettingsGuard();
  const instanceId = provider?.instanceId ?? "";
  const current = authInstanceId === instanceId ? authState : null;
  const phase = current?.phase ?? "idle";
  const active = phase === "starting" || phase === "waiting" || phase === "verifying";
  const methods = current?.methods ?? provider?.authMethods ?? [];
  const selectedMethod = methods.find((method) => method.id === methodId) ?? methods[0];
  const interaction = current?.interaction;
  const credentialFields = active && interaction?.type === "credentials" ? interaction.fields : selectedMethod?.type === "credentials" && !active ? selectedMethod.fields ?? [] : [];
  const credentialDraftId = `${instanceId}:${selectedMethod?.id ?? ""}:${interaction?.type === "credentials" ? interaction.id : ""}`;
  const dirty = Boolean(terminalInput || Object.values(values).some((value) => value !== ""));

  useEffect(() => {
    if (!open || !instanceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMethodId("");
    setValues({});
    setTerminalInput("");
    setManualBrowserUrl(null);
    void loadAuth(instanceId).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "无法获取登录方式。");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, instanceId, loadAuth]);
  useEffect(() => { setValues({}); }, [credentialDraftId, open]);
  useEffect(() => { setTerminalInput(""); }, [current?.flowId, interaction?.id]);
  useEffect(() => {
    if (!open) { setValues({}); setTerminalInput(""); }
  }, [open]);
  useEffect(() => {
    setGuard(!open ? "clean" : pending ? "busy" : dirty || active ? "dirty" : "clean");
    return () => setGuard("clean");
  }, [open, pending, dirty, active, setGuard]);

  if (!provider) return null;
  const meta = PHASE_META[phase];
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
    if (pending || loading || (!selectedMethod && !(active && interaction?.type === "credentials")) || !credentialsReady) return;
    setPending(true);
    setError(null);
    const input: ProviderAuthStartInput = { ...(!active && selectedMethod ? { methodId: selectedMethod.id } : {}), ...(credentialFields.length ? { values } : {}) };
    setValues({});
    try {
      if (active && current?.flowId && interaction?.type === "credentials")
        await sendAuthInput(instanceId, current.flowId, JSON.stringify(input.values ?? {}));
      else await startAuth(instanceId, input);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法启动登录流程。"); }
    finally { setPending(false); }
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
      setError(cause instanceof Error ? cause.message : "无法确认浏览器认证授权。");
    } finally { setPending(false); }
  }

  async function cancel(): Promise<boolean> {
    if (!current?.flowId) return !active;
    setPending(true);
    setError(null);
    try { await cancelAuth(instanceId, current.flowId); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法取消登录流程。"); return false; }
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
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法发送登录输入。"); }
    finally { setPending(false); }
  }

  async function changeOpen(next: boolean) {
    if (next || pending) return;
    if ((dirty || active) && !window.confirm(active ? "关闭将取消当前登录流程，继续？" : "放弃尚未发送的登录凭据？")) return;
    if (active && !(await cancel())) return;
    setValues({}); setTerminalInput("");
    onOpenChange(false);
  }

  return <Dialog open={open} onOpenChange={(next) => { void changeOpen(next); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-slot="provider-auth-dialog">
    <DialogHeader><DialogTitle>登录 {provider.label}</DialogTitle><DialogDescription>认证由此原生 Agent 在实例独立环境中完成，不导入全局账号。凭据只发送到服务端，不写入浏览器存储；状态来自实际认证流程。</DialogDescription></DialogHeader>
    <div className="flex flex-col gap-3">
      <div role="status" aria-live="polite" className={cn("flex items-center gap-2 text-sm font-medium", meta.tone)}>
        {(active || loading || pending) && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
        {phase === "succeeded" && <CheckCircle2 aria-hidden="true" className="size-4" />}
        {phase === "failed" && <AlertTriangle aria-hidden="true" className="size-4" />}
        <span>{loading ? "正在读取认证方式…" : meta.label}</span>
        {active && current?.expiresAt && <span className={cn(mono, "text-muted-foreground ms-auto font-normal")}>截止 {new Date(current.expiresAt).toLocaleTimeString()}</span>}
      </div>
      {current?.message && <p role={phase === "failed" ? "alert" : "status"} className={cn("rounded-lg px-3 py-2 text-xs whitespace-pre-wrap break-words", phase === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{current.message}</p>}
      {phase === "succeeded" && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">原生认证流程已完成，提供商状态已刷新；是否已确认登录以上述原生状态为准。</p>}
      {phase === "cancelled" && <p className="text-muted-foreground text-xs">认证流程已取消；可选择认证方式后重新启动。</p>}
      {!loading && !active && methods.length > 0 && <label className="flex flex-col gap-1.5 text-xs" htmlFor={`${id}-method`}>认证方式<select id={`${id}-method`} value={selectedMethod?.id ?? ""} disabled={pending} className="border-input bg-background rounded-md border px-3 py-2 text-sm" onChange={(event) => { setMethodId(event.target.value); setValues({}); setError(null); }}>{methods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select>{selectedMethod?.description && <span className="text-muted-foreground">{selectedMethod.description}</span>}</label>}
      {!loading && !active && methods.length === 0 && <p className="text-muted-foreground text-xs">此 Agent 尚未声明可用的内置认证方式。请检查安装与配置，或按驱动文档完成外部认证；不会伪造登录成功。</p>}
      {credentialFields.length > 0 && <form autoComplete="off" className="flex flex-col gap-3" onSubmit={(event) => { void start(event); }}>
        {credentialFields.map((entry) => <label key={entry.name} htmlFor={`${id}-credential-${entry.name}`} className="flex flex-col gap-1.5 text-xs">{entry.label}<Input id={`${id}-credential-${entry.name}`} type={entry.secret ? "password" : "text"} autoComplete={entry.secret ? "new-password" : "off"} spellCheck={false} maxLength={8192} value={values[entry.name] ?? ""} disabled={pending || loading} required onChange={(event) => setValues((previous) => ({ ...previous, [entry.name]: event.target.value }))} /></label>)}
        <Button type="submit" disabled={pending || loading || !credentialsReady || !provider.enabled || (!active && !provider.canLogin)}>{pending && <Loader2 aria-hidden="true" className="animate-spin" />}{active ? "提交认证凭据" : provider.authStatus === "authenticated" ? "更换账号" : "使用此方式登录"}</Button>
      </form>}
      {(deviceUrl || userCode) && active && <section aria-label="浏览器或设备码登录" className={cn(field, "flex flex-col gap-2 rounded-xl p-3 text-xs")}>
        <p>{userCode ? "请打开以下地址并输入设备码：" : browserConsentRequired ? "此 Agent 请求打开以下地址进行认证；仅在你信任此地址时同意。" : "请在浏览器中打开以下地址完成认证："}</p>
        {deviceUrl && (/^https?:\/\//i.test(deviceUrl) && !browserConsentRequired ? <a href={deviceUrl} target="_blank" rel="noreferrer noopener" className="text-primary inline-flex items-center gap-1 break-all underline underline-offset-2">{deviceUrl}<ExternalLink aria-hidden="true" className="size-3 shrink-0" /></a> : <span className="break-all">{deviceUrl}</span>)}
        {browserConsentRequired && deviceUrl && /^https?:\/\//i.test(deviceUrl) && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => { void consentToBrowser(); }}>同意并打开认证页面</Button>}
        {userCode && <p>设备码 <code aria-label="设备码" className={cn(mono, "bg-background rounded px-2 py-1 text-sm tracking-widest")}>{userCode}</code></p>}
      </section>}
      {manualBrowserUrl && <p className="text-muted-foreground text-xs">浏览器阻止了新窗口。已发送打开此地址的同意；请手动 <a href={manualBrowserUrl} target="_blank" rel="noreferrer noopener" className="underline">打开认证页面</a> 完成认证。</p>}
      {output && <section aria-label="原生认证输出" className="flex flex-col gap-2"><span className="text-muted-foreground flex items-center gap-1.5 text-xs"><Terminal aria-hidden="true" className="size-3.5" />Agent 认证输出</span><pre className={cn(mono, "bg-muted max-h-52 overflow-auto rounded-lg p-3 text-xs break-words whitespace-pre-wrap")} aria-live="polite">{output}</pre></section>}
      {terminal && active && <form className="flex flex-col gap-2" onSubmit={(event) => { void submitTerminalInput(event); }}><label htmlFor={`${id}-terminal`} className="text-xs">发送到原生认证进程的输入（留空发送回车）</label><Input id={`${id}-terminal`} type="password" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} autoComplete="new-password" disabled={pending} spellCheck={false} /><Button type="submit" variant="outline" size="sm" disabled={pending}>发送输入</Button></form>}
      {browserAcceptsCallback && active && <form className="flex flex-col gap-2" onSubmit={(event) => { void submitTerminalInput(event); }}>
        <label htmlFor={`${id}-callback`} className="text-xs">如果最后的 localhost 页面无法打开，请粘贴地址栏中的完整回调 URL。</label>
        <Input id={`${id}-callback`} type="url" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} autoComplete="off" disabled={pending} spellCheck={false} maxLength={4096} />
        <Button type="submit" variant="outline" size="sm" disabled={pending || !terminalInput.trim()}>提交回调 URL</Button>
      </form>}
      {(error || authError) && <p role="alert" className="bg-destructive/10 text-destructive rounded-lg px-3 py-2 text-xs">{error || authError}</p>}
      {provider.docsUrl && <a href={provider.docsUrl} target="_blank" rel="noreferrer noopener" className="text-muted-foreground text-xs underline underline-offset-2">原生 Agent 配置与认证文档</a>}
    </div>
    <DialogFooter>{active && current?.flowId && <Button type="button" variant="outline" disabled={pending} onClick={() => { void cancel(); }}>取消登录</Button>}{!active && credentialFields.length === 0 && methods.length > 0 && <Button type="button" disabled={pending || loading || !provider.enabled || !provider.canLogin} onClick={() => { void start(); }}>{provider.authStatus === "authenticated" ? "更换账号" : phase === "failed" || phase === "cancelled" ? "重新登录" : "开始登录"}</Button>}<Button type="button" variant="ghost" disabled={pending} onClick={() => { void changeOpen(false); }}>关闭</Button></DialogFooter>
  </DialogContent></Dialog>;
}
