import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, RefreshCw } from "lucide-react";
import type { AgentDiagnostics } from "@agent-workspace/contracts/diagnostics";
import { Button } from "@agent/components/ui/button";
import { useI18n } from "@/lib/i18n-provider";
import { useAgentText, type AgentText } from "../i18n";
import { workspaceClient } from "../network";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { useServiceData } from "./use-service-data";
import "./service-data.css";

const statusLabels = (t: AgentText) => ({ ok: t("正常", "OK"), unavailable: t("不可用", "Unavailable"), unknown: t("未知", "Unknown") } as const);
const authenticationLabels = (t: AgentText) => ({ authenticated: t("已验证登录", "Authenticated"), unauthenticated: t("未登录", "Not signed in"), unknown: t("未验证", "Not verified"), "not-installed": t("未安装", "Not installed") } as const);

export default function DiagnosticsPage() {
  const t = useAgentText();
  const { locale } = useI18n();
  const { data, loading, error, refresh } = useServiceData<AgentDiagnostics>("/api/settings/diagnostics");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const download = useRef<AbortController | null>(null);
  useEffect(() => () => download.current?.abort(), []);
  async function downloadReport() {
    if (downloading) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(true); setDownloadError(null);
    try {
      const response = await workspaceClient.request("/api/settings/diagnostics/report", { cache: "no-store", signal: controller.signal });
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "agent-diagnostics.json";
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (!controller.signal.aborted) setDownloadError(t("诊断报告下载失败，请检查服务和登录状态后重试。", "Failed to download the diagnostics report. Check the service and sign-in status, then retry."));
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }
  const status = statusLabels(t);
  const authentication = authenticationLabels(t);
  return <div className="service-data-page">
    <div className="service-data-actions">
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />{t("刷新状态", "Refresh status")}</Button>
      <Button variant="outline" size="sm" disabled={downloading || loading || Boolean(error)} onClick={() => void downloadReport()}><Download aria-hidden="true" />{downloading ? t("正在下载…", "Downloading…") : t("下载安全诊断报告", "Download safety report")}</Button>
    </div>
    {loading && <SettingsNotice kind="loading">{t("正在读取实际服务与持久存储状态，不会发起模型请求或 CLI 登录。", "Loading actual service and durable storage status; no model requests or CLI logins are made.")}</SettingsNotice>}
    {error && <SettingsNotice kind="error" onRetry={() => void refresh()}>{error}</SettingsNotice>}
    {downloadError && <SettingsNotice kind="error">{downloadError}</SettingsNotice>}
    {data && <>
      {error && <SettingsNotice kind="info">{t("以下为上次成功读取的快照，不代表当前健康状态。", "The following is the last successfully loaded snapshot and does not reflect current health.")}</SettingsNotice>}
      <SettingsSection title={t("服务与持久存储", "Service & durable storage")} scope="service">
        <p>{t("读取时间：", "Read at: ")}{new Date(data.generatedAt).toLocaleString(locale)}</p>
        <dl className="service-data-facts">
          <div><dt>{t("HTTP 服务", "HTTP service")}</dt><dd>{t("本次读取可响应", "Responded to this read")}</dd></div>
          <div><dt>{t("持久存储", "Durable storage")}</dt><dd>{status[data.service.durableStore]}</dd></div>
          <div><dt>{t("本进程独占所有权", "Exclusive ownership by this process")}</dt><dd>{data.service.ownsStore ? t("已核对数据库和锁", "Database and lock verified") : t("未证明", "Not proven")}</dd></div>
          <div><dt>{t("SQLite 只读检查", "SQLite read-only check")}</dt><dd>{data.service.integrity === "ok" ? t("通过 quick_check", "Passed quick_check") : data.service.integrity === "failed" ? t("失败", "Failed") : t("未检查", "Not checked")}</dd></div>
          <div><dt>{t("持久会话 / 历史 / 消息", "Durable sessions / histories / messages")}</dt><dd>{data.service.threads ?? t("未知", "Unknown")} / {data.service.histories ?? t("未知", "Unknown")} / {data.service.messages ?? t("未知", "Unknown")}</dd></div>
        </dl>
      </SettingsSection>
      <SettingsSection title={t("版本与运行环境", "Version & runtime")} scope="service">
        <dl className="service-data-facts">
          <div><dt>{t("Agent 服务版本", "Agent service version")}</dt><dd>{data.runtime.applicationVersion ?? t("未知（无可信版本源）", "Unknown (no trusted version source)")}</dd></div>
          <div><dt>{t("版本来源", "Version source")}</dt><dd>{data.runtime.versionSource}</dd></div>
          <div><dt>Node</dt><dd>{data.runtime.nodeVersion}</dd></div>
          <div><dt>{t("平台 / 架构", "Platform / architecture")}</dt><dd>{data.runtime.platform} / {data.runtime.architecture}</dd></div>
        </dl>
      </SettingsSection>
      <SettingsSection title={t("Provider 状态（与服务状态独立）", "Provider status (independent of service status)")} scope="service">
        <p>{t(`配置读取：${status[data.providers.configuration]}；实例 ${data.providers.total} 个（原生 Agent ${data.providers.native} / 历史停用记录 ${data.providers.inactive}）。`, `Configuration read: ${status[data.providers.configuration]}; ${data.providers.total} instance(s) (native Agent ${data.providers.native} / inactive legacy records ${data.providers.inactive}).`)}</p>
        <ul className="service-data-list">{data.providers.observations.map((item) => <li key={item.index}>
          <strong>#{item.index} · {item.driver} · {item.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}</strong>
          <span>{t("认证：", "Auth: ")}{authentication[item.authentication]}{t("；连接：", "; connection: ")}{item.connection === "ok" ? t("最近测试通过", "Last test passed") : item.connection === "failed" ? t("最近测试失败", "Last test failed") : t("未验证", "Not verified")}</span>
          <small>{item.checkedAt ? t(`观察时间：${new Date(item.checkedAt).toLocaleString(locale)}`, `Observed at: ${new Date(item.checkedAt).toLocaleString(locale)}`) : t("无有效观察时间", "No valid observation time")}</small>
        </li>)}</ul>
        <p><Link to="/agent/settings/providers">{t("进入提供商设置查看实例、凭据来源并显式测试", "Open provider settings to inspect instances, credential sources, and run explicit tests")}</Link></p>
      </SettingsSection>
      <SettingsSection title={t("最近持久失败", "Recent durable failures")} scope="service">
        {!data.recentFailures.available ? <p>{t("当前无法读取持久失败记录，不能据此判断没有失败。", "Persistent failure records are currently unavailable; this cannot be taken to mean there were no failures.")}</p>
          : data.recentFailures.items.length === 0 ? <p>{t("当前持久存储没有已记录的失败 / 中断；这不代表 Provider 已通过执行验证。", "Durable storage has no recorded failures or interruptions; this does not mean providers passed execution verification.")}</p>
          : <ul className="service-data-list">{data.recentFailures.items.map((item, index) => <li key={index}>
            <strong>{item.source === "chat" ? t("聊天", "Chat") : t("执行", "Execution")} · {item.status === "failed" ? t("失败", "Failed") : t("已中断", "Interrupted")}</strong>
            <span>{t("错误类别：", "Error class: ")}{item.errorClass}</span>
            <small>{item.endedAt ? new Date(item.endedAt).toLocaleString(locale) : t("无可信记录时间", "No trusted record time")}</small>
          </li>)}</ul>}
      </SettingsSection>
      <SettingsSection title={t("报告隐私边界", "Report privacy boundary")}>
        <ul className="service-data-bullets">{data.privacy.excludes.map((item) => <li key={item}>{item}</li>)}</ul>
      </SettingsSection>
    </>}
  </div>;
}
