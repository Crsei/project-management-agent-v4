"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Bot, Code2, LogIn, LogOut, RefreshCw, Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProviderAuthStatus, ProviderDriver, ProviderDriverDefinition, ProviderInstance, ProviderTestResult } from "@agent-workspace/contracts/provider";
import { useSettingsGuard } from "./settings-layout";

const STATUS_LABEL: Record<ProviderAuthStatus, string> = {
  authenticated: "身份已确认",
  unauthenticated: "未认证",
  unknown: "身份未知",
  "not-installed": "Agent 未安装",
};
const DRIVER_ICON = { codex: Code2, claude: Terminal, cursor: Code2, grok: Bot, opencode: Code2, antigravity: Sparkles, muse: Sparkles, pi: Terminal, acpRegistry: Bot };

export function ProviderGlyph({ driver, accentColor }: { driver: ProviderDriver; accentColor?: string }) {
  const Icon = DRIVER_ICON[driver];
  return <span className="provider-glyph" data-driver={driver} style={accentColor ? { color: accentColor } : undefined}><Icon aria-hidden="true" /></span>;
}

export function ProviderStatus({ provider }: { provider: ProviderInstance }) {
  return <span className="provider-status" data-status={provider.authStatus}><span aria-hidden="true" />{STATUS_LABEL[provider.authStatus]}</span>;
}

type ProviderCardProps = {
  provider: ProviderInstance;
  definition?: ProviderDriverDefinition;
  onAuth: (provider: ProviderInstance) => void;
  onTest: (instanceId: string) => Promise<ProviderTestResult>;
  onLogout: (provider: ProviderInstance) => Promise<void>;
  children: ReactNode;
};

export function ProviderCard({ provider, definition, onAuth, onTest, onLogout, children }: ProviderCardProps) {
  const [testing, setTesting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { setGuard } = useSettingsGuard();
  useEffect(() => { setGuard(testing || loggingOut ? "busy" : "clean"); return () => setGuard("clean"); }, [testing, loggingOut, setGuard]);
  const connection = testResult?.instanceRevision === provider.revision ? testResult : provider.lastConnectionTest;
  const staleConnection = Boolean(connection && connection.instanceRevision !== provider.revision);

  async function runTest() {
    setTesting(true); setActionError(null); setTestResult(null);
    try { setTestResult(await onTest(provider.instanceId)); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "检查请求失败。"); }
    finally { setTesting(false); }
  }
  async function runLogout() {
    if (!window.confirm(`退出“${provider.label}”的原生账号？历史记录会保留。`)) return;
    setLoggingOut(true); setActionError(null); setTestResult(null);
    try { await onLogout(provider); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "退出登录失败。"); }
    finally { setLoggingOut(false); }
  }

  return <article className="provider-detail" aria-labelledby="provider-detail-title">
    <header className="provider-detail-heading"><ProviderGlyph driver={provider.driver} accentColor={provider.accentColor} /><h2 id="provider-detail-title">{provider.label}</h2><span>{definition?.label ?? provider.driver}{!provider.enabled ? " · 已停用" : ""}</span></header>
    <section className="provider-settings-section" aria-label="身份与连接">
      <div className="provider-settings-group provider-auth-group">
        <div className="provider-auth-summary"><ProviderStatus provider={provider} /><p>{provider.email || provider.authLabel || (provider.credentialSource === "provider" ? "原生 Agent 管理的认证" : "尚未确认此实例的身份")}</p>{provider.email && provider.authLabel && <p>{provider.authLabel}</p>}</div>
        <div className="provider-auth-actions">
          <Button size="sm" variant="outline" disabled={!provider.enabled || !provider.canLogin || provider.authStatus === "not-installed" || testing || loggingOut} title={provider.authStatus === "not-installed" ? "请先配置并安装此 Agent。" : !provider.canLogin ? "驱动未声明内置登录，请查看配置文档。" : undefined} onClick={() => onAuth(provider)}><LogIn aria-hidden="true" />{provider.authStatus === "authenticated" ? "更换账号" : "登录"}</Button>
          <Button size="sm" variant="ghost" disabled={!provider.enabled || testing || loggingOut} onClick={() => void runTest()}><RefreshCw aria-hidden="true" className={testing ? "animate-spin" : undefined} />{testing ? "检查中…" : "检查 Agent"}</Button>
          <Button size="icon-sm" variant="ghost" aria-label="退出登录" disabled={!provider.canLogout || loggingOut || testing} title={provider.canLogout ? "退出此实例" : "此 Agent 未提供可用的退出方式。"} onClick={() => void runLogout()}><LogOut aria-hidden="true" /></Button>
        </div>
      </div>
      {provider.message && <p className="provider-section-note">{provider.message}</p>}
      <p className="provider-section-note">实例：{provider.enabled ? "已启用" : "已停用"} · 配置：{provider.configured ? "已就绪" : "未就绪"} · 认证：{STATUS_LABEL[provider.authStatus]}{provider.authCheckedAt ? ` · 身份检查 ${new Date(provider.authCheckedAt).toLocaleString()}` : ""}</p>
      {connection ? <p role={staleConnection || connection.ok ? "status" : "alert"} className={`provider-feedback${!staleConnection && !connection.ok ? " provider-feedback-error" : ""}`}>
        {staleConnection && <strong>上次旧配置检查（已失效，需重新检查）</strong>}
        原生 Agent 状态检查：{connection.ok ? `完成 · ${connection.latencyMs} ms` : `失败：${connection.error ?? "未知错误"}`}{connection.authentication && <span>身份：{STATUS_LABEL[connection.authentication]}</span>}{connection.checkedAt && <span>{new Date(connection.checkedAt).toLocaleString()}</span>}
      </p> : <p className="provider-section-note">当前配置尚无手动检查结果。</p>}
      <p className="provider-section-note">状态检查只观察实际安装、认证和可用模型，不执行计费推理。身份未知不等于认证成功；模型目录也不保证每个模型均可调用。</p>
      <dl className="provider-probe-details"><dt>安装状态</dt><dd>{provider.installation?.status === "installed" ? "已检测到" : provider.installation?.status === "not-installed" ? "未检测到" : provider.installation?.status === "not-applicable" ? "无需本机可执行文件" : "尚未确认"}</dd><dt>版本</dt><dd>{provider.installation?.version ?? "未知（未取得版本）"}</dd><dt>实际可执行路径</dt><dd><code>{provider.installation?.executablePath ?? "尚未检测"}</code></dd>{provider.installation?.checkedAt && <><dt>安装检查时间</dt><dd>{new Date(provider.installation.checkedAt).toLocaleString()}</dd></>}{provider.installation?.error && <><dt>安装检查说明</dt><dd>{provider.installation.error}</dd></>}</dl>
      {actionError && <p role="alert" className="provider-feedback provider-feedback-error">{actionError}</p>}
    </section>
    {children}
    <section className="provider-settings-section" aria-labelledby="provider-models-title"><div className="provider-section-heading"><h3 id="provider-models-title">可选择的模型</h3><span>{provider.models.length} 个 · 按来源标识</span></div><div className="provider-settings-group provider-models">{provider.models.length ? provider.models.map((model) => <div className="provider-model-row" key={model.id}><div><span>{model.label}</span><code>{model.id}</code></div><span className="provider-model-capability">{model.source === "custom" ? "自定义登记" : model.source === "discovered" ? "实际发现" : "内置"}</span>{model.reasoning && <span className="provider-model-capability">推理模型</span>}</div>) : <p className="provider-section-note">没有可展示的模型。请先配置并检查 Agent。</p>}</div></section>
    <details className="provider-technical-details"><summary>实例详情</summary><dl><dt>实例 ID</dt><dd><code>{provider.instanceId}</code></dd><dt>驱动</dt><dd>{provider.driver}</dd>{definition?.source && <><dt>配置来源</dt><dd>{definition.source}</dd></>}{provider.capabilities && <><dt>原生恢复 / Fork / 精确边界</dt><dd>{provider.capabilities.nativeResume ? "支持" : "不支持"} / {provider.capabilities.nativeFork ? "支持" : "不支持"} / {provider.capabilities.boundedFork ? "支持" : "不支持（需可移植接续）"}</dd></>}</dl></details>
  </article>;
}
