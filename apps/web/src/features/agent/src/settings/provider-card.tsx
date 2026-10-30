"use client";

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import type { ProviderAuthStatus, ProviderDriver, ProviderDriverDefinition, ProviderInstance, ProviderTestResult } from "@agent-workspace/contracts/provider";
import { useSettingsGuard } from "./settings-layout";
import { formatProviderUpdateRequiredNotice, getProviderClient, getProviderInstanceDisplayName, normalizeProviderAccentColor, providerAccentForegroundColor, providerInstanceInitials, type ProviderIcon } from "@agent-workspace/client-runtime/providers";
import { ANTIGRAVITY_ICON_DATA_URL } from "./provider-brand-assets";
import { useAgentText, type AgentText } from "../i18n";
import "../../styles/providers.css";

const statusLabel = (t: AgentText): Record<ProviderAuthStatus, string> => ({
  authenticated: t("身份已确认", "Identity verified"),
  unauthenticated: t("未认证", "Not authenticated"),
  unknown: t("身份未知", "Identity unknown"),
  "not-installed": t("Agent 未安装", "Agent not installed"),
});

// Upstream builtin branding; package-defined families use their original client icons.
function BrandIcon({ driver }: { driver: ProviderDriver }) {
  switch (driver) {
    case "claude": return <svg viewBox="0 0 256 257" fill="currentColor" aria-hidden="true"><path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" /></svg>;
    case "codex": return <svg viewBox="100 100 411 411" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z" /></svg>;
    case "antigravity": return <svg viewBox="0 0 128 128" aria-hidden="true"><image href={ANTIGRAVITY_ICON_DATA_URL} width="128" height="128" /></svg>;
  }
}

// Render only the browser-local registry's structured SVG metadata, never remote SVG markup.
function PackageIcon({ icon }: { icon: ProviderIcon }) {
  const id = useId();
  return <svg viewBox={icon.viewBox} className="provider-package-icon" aria-hidden="true" style={{ "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties}>
    {icon.paths.some((path) => path.gradient) && <defs>{icon.paths.map((path, index) => path.gradient && <linearGradient key={index} id={`${id}-${index}`} x1={path.gradient.x1} y1={path.gradient.y1} x2={path.gradient.x2} y2={path.gradient.y2} gradientUnits="userSpaceOnUse">{path.gradient.stops.map((stop) => <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />)}</linearGradient>)}</defs>}
    {icon.paths.map((path, index) => <path key={index} d={path.d} fillRule={path.fillRule} fill={path.gradient ? `url(#${id}-${index})` : undefined} className={path.fill ? "provider-package-icon-detail" : undefined} style={path.fill ? { "--path-light": path.fill.light, "--path-dark": path.fill.dark } as CSSProperties : undefined} />)}
  </svg>;
}

export function ProviderGlyph({ driver, accentColor, iconUrl, displayName, showInstanceBadge = false }: { driver: ProviderDriver; accentColor?: string; iconUrl?: string; displayName?: string; showInstanceBadge?: boolean }) {
  const icon = getProviderClient(driver)?.icon;
  const color = normalizeProviderAccentColor(accentColor);
  const safeUrl = driver === "acpRegistry" && iconUrl?.startsWith("https://") ? iconUrl : undefined;
  return <span className="provider-glyph" data-driver={driver} style={color ? { color } : undefined}>
    {safeUrl ? <img src={safeUrl} alt="" referrerPolicy="no-referrer" /> : icon ? <PackageIcon icon={icon} /> : <BrandIcon driver={driver} />}
    {showInstanceBadge && <span className="provider-instance-badge" aria-hidden="true" style={color ? { backgroundColor: color, color: providerAccentForegroundColor(color) } : undefined}>{providerInstanceInitials(displayName ?? getProviderClient(driver)?.label ?? driver)}</span>}
  </span>;
}

export function ProviderStatus({ provider }: { provider: ProviderInstance }) {
  const t = useAgentText();
  const ready = provider.enabled && provider.nativeSessionReady;
  return <span className="provider-status" data-status={!provider.enabled ? "disabled" : ready ? "native-ready" : "not-ready"}>
    <span>{!provider.enabled ? t("已停用", "Disabled") : ready ? t("原生会话就绪", "Native session ready") : t("原生会话未就绪", "Native session not ready")}</span>
    <span className="provider-identity-status" data-status={provider.authStatus}>{statusLabel(t)[provider.authStatus]}{provider.authStatus === "authenticated" && provider.authLabel ? ` · ${provider.authLabel}` : ""}</span>
  </span>;
}

type ProviderCardProps = {
  provider: ProviderInstance;
  definition?: ProviderDriverDefinition;
  onAuth: (provider: ProviderInstance) => void;
  onTest: (instanceId: string) => Promise<ProviderTestResult>;
  onLogout: (provider: ProviderInstance) => Promise<void>;
  onBeforeAction?: () => boolean;
  onBusyChange?: (busy: boolean) => void;
  children: (setup: ReactNode) => ReactNode;
};

export function ProviderCard({ provider, definition, onAuth, onTest, onLogout, onBeforeAction, onBusyChange, children }: ProviderCardProps) {
  const t = useAgentText();
  const [testing, setTesting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { setGuard } = useSettingsGuard();
  useEffect(() => { setGuard(testing || loggingOut ? "busy" : "clean"); onBusyChange?.(testing || loggingOut); return () => { setGuard("clean"); onBusyChange?.(false); }; }, [testing, loggingOut, setGuard, onBusyChange]);
  useEffect(() => { setTestResult(null); }, [provider.instanceId, provider.revision, provider.nativeSessionReady, provider.authCheckedAt]);
  const connection = testResult?.instanceRevision === provider.revision ? testResult : provider.lastConnectionTest;
  const staleConnection = Boolean(connection && connection.instanceRevision !== provider.revision);
  const connectionFailed = connection?.ok === false;
  const connectionUnverified = Boolean(connection?.ok && connection.nativeSessionReady !== true);
  const connectionLabel = !connection ? "" : [
    connectionFailed ? t(`失败：${connection.error ?? "未知错误"}`, `Failed: ${connection.error ?? "unknown error"}`) : t("检查完成", "Check completed"),
    connection.nativeSessionReady === true ? t("本次检查：原生会话就绪", "This check: native session ready") : t("本次检查：原生会话未确认就绪", "This check: native session readiness not confirmed"),
    connection.authentication ? statusLabel(t)[connection.authentication] : t("身份未检查", "Identity not checked"),
    `${connection.latencyMs} ms`,
  ].join(" · ");
  const displayName = getProviderInstanceDisplayName(provider);
  const updateNotice = formatProviderUpdateRequiredNotice(provider);

  async function runTest() {
    if (onBeforeAction && !onBeforeAction()) return;
    setTesting(true); setActionError(null); setTestResult(null);
    try { setTestResult(await onTest(provider.instanceId)); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : t("检查请求失败。", "The check request failed.")); }
    finally { setTesting(false); }
  }
  async function runLogout() {
    if (!window.confirm(t(`退出“${provider.label}”的原生账号？历史记录会保留。`, `Sign out of the native account for "${provider.label}"? History is preserved.`))) return;
    if (onBeforeAction && !onBeforeAction()) return;
    setLoggingOut(true); setActionError(null); setTestResult(null);
    try { await onLogout(provider); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : t("退出登录失败。", "Failed to sign out.")); }
    finally { setLoggingOut(false); }
  }

  const hasAccountSetup = provider.driver !== "codex" && (provider.canLogin || provider.canLogout);
  const setup = hasAccountSetup ? <div className="provider-settings-group provider-auth-group">
      <div className="provider-auth-summary">{provider.enabled && provider.authStatus === "authenticated" && (provider.email || provider.authLabel) && <p>{provider.email}{provider.email && provider.authLabel ? " · " : ""}{provider.authLabel}</p>}</div>
      <div className="provider-auth-actions">
        {provider.canLogin && <Button type="button" size="sm" variant="outline" disabled={!provider.enabled || provider.authStatus === "not-installed" || testing || loggingOut} title={provider.authStatus === "not-installed" ? t("请先配置并安装此 Agent。", "Configure and install this Agent first.") : undefined} onClick={() => onAuth(provider)}><LogIn aria-hidden="true" />{provider.authStatus === "authenticated" ? t("更换账号", "Switch account") : t("登录", "Sign in")}</Button>}
        {provider.canLogout && <Button type="button" size="icon-sm" variant="ghost" aria-label={t("退出登录", "Sign out")} disabled={loggingOut || testing} title={t("退出原生账号", "Sign out of the native account")} onClick={() => void runLogout()}><LogOut aria-hidden="true" /></Button>}
      </div>
  </div> : null;
  return <article className="provider-detail" aria-labelledby="provider-detail-title">
    <header className="provider-detail-heading"><ProviderGlyph driver={provider.driver} accentColor={provider.accentColor} iconUrl={provider.registryIconUrl} displayName={displayName} showInstanceBadge={Boolean(normalizeProviderAccentColor(provider.accentColor))} /><h2 id="provider-detail-title">{displayName}</h2>{provider.installation?.version && <code>{provider.installation.version}</code>}<Button type="button" size="sm" variant="ghost" disabled={!provider.enabled || testing || loggingOut} onClick={() => void runTest()}><RefreshCw aria-hidden="true" className={testing ? "animate-spin" : undefined} />{testing ? t("检查中…", "Checking…") : t("检查 Agent", "Check Agent")}</Button></header>
    {updateNotice && <p role="status" className="provider-feedback">{updateNotice}</p>}
    {actionError && <p role="alert" className="provider-feedback provider-feedback-error">{actionError}</p>}
    {connection && <p role={!staleConnection && connectionFailed ? "alert" : "status"} className={`provider-feedback${staleConnection ? "" : connectionFailed ? " provider-feedback-error" : connectionUnverified ? " provider-feedback-warning" : ""}`}>{staleConnection && <strong>{t("上次旧配置检查（已失效，需重新检查）", "Previous check used an older configuration (stale, re-check needed)")}</strong>}{t("原生 Agent 状态检查：", "Native Agent status check: ")}{connectionLabel}</p>}
    {children(setup)}
    <details className="provider-technical-details">
      <summary>{t("状态与实例详情", "Status & instance details")}</summary>
      {provider.message && <p>{provider.message}</p>}
      <dl>
        <dt>{t("实例 ID", "Instance ID")}</dt><dd><code>{provider.instanceId}</code></dd>
        <dt>{t("驱动", "Driver")}</dt><dd>{provider.driver}</dd>
        {definition?.source && <><dt>{t("配置来源", "Config source")}</dt><dd>{definition.source}</dd></>}
        <dt>{t("原生会话", "Native session")}</dt><dd>{provider.enabled && provider.nativeSessionReady ? t("就绪", "Ready") : t("未就绪", "Not ready")}</dd>
        <dt>{t("账号身份", "Account identity")}</dt><dd>{statusLabel(t)[provider.authStatus]}</dd>
        <dt>{t("配置", "Configuration")}</dt><dd>{provider.configured ? t("已配置", "Configured") : t("未配置", "Not configured")}</dd>
        <dt>{t("安装状态", "Install status")}</dt><dd>{provider.installation?.status === "installed" ? t("已检测到", "Detected") : provider.installation?.status === "not-installed" ? t("未检测到", "Not detected") : provider.installation?.status === "not-applicable" ? t("无需本机可执行文件", "No local executable needed") : t("尚未确认", "Not confirmed")}</dd>
        <dt>{t("实际可执行路径", "Actual executable path")}</dt><dd><code>{provider.installation?.executablePath ?? t("尚未检测", "Not detected yet")}</code></dd>
        {provider.installation?.error && <><dt>{t("安装检查说明", "Install check note")}</dt><dd>{provider.installation.error}</dd></>}
        {provider.authCheckedAt && <><dt>{t("身份检查时间", "Identity checked at")}</dt><dd>{new Date(provider.authCheckedAt).toLocaleString()}</dd></>}
        {provider.installation?.checkedAt && <><dt>{t("安装检查时间", "Install checked at")}</dt><dd>{new Date(provider.installation.checkedAt).toLocaleString()}</dd></>}
        {provider.capabilities && <><dt>{t("原生恢复 / Fork / 精确边界", "Native resume / fork / bounded fork")}</dt><dd>{provider.capabilities.nativeResume ? t("支持", "Supported") : t("不支持", "Not supported")} / {provider.capabilities.nativeFork ? t("支持", "Supported") : t("不支持", "Not supported")} / {provider.capabilities.boundedFork ? t("支持", "Supported") : t("不支持（需可移植接续）", "Not supported (portable resume required)")}</dd></>}
      </dl>
      <p>{t("原生会话就绪与账号身份相互独立。状态检查不执行计费推理，也不证明远端服务、凭据或每个模型可用。", "Native session readiness and account identity are independent. Status checks never run billable inference and do not prove remote service, credential, or individual model availability.")}</p>
    </details>
  </article>;
}
