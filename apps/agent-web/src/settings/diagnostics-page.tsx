import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, RefreshCw } from "lucide-react";
import type { AgentDiagnostics } from "@agent-workspace/contracts/diagnostics";
import { Button } from "@/components/ui/button";
import { workspaceClient } from "../network";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { useServiceData } from "./use-service-data";
import "./service-data.css";

const status = { ok: "正常", unavailable: "不可用", unknown: "未知" } as const;
const authentication = { authenticated: "已验证登录", unauthenticated: "未登录", unknown: "未验证", "not-installed": "未安装" } as const;

export default function DiagnosticsPage() {
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
      if (!controller.signal.aborted) setDownloadError("诊断报告下载失败，请检查服务和登录状态后重试。");
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }
  return <div className="service-data-page">
    <div className="service-data-actions">
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />刷新状态</Button>
      <Button variant="outline" size="sm" disabled={downloading || loading || Boolean(error)} onClick={() => void downloadReport()}><Download aria-hidden="true" />{downloading ? "正在下载…" : "下载安全诊断报告"}</Button>
    </div>
    {loading && <SettingsNotice kind="loading">正在读取实际服务与持久存储状态，不会发起模型请求或 CLI 登录。</SettingsNotice>}
    {error && <SettingsNotice kind="error" onRetry={() => void refresh()}>{error}</SettingsNotice>}
    {downloadError && <SettingsNotice kind="error">{downloadError}</SettingsNotice>}
    {data && <>
      {error && <SettingsNotice kind="info">以下为上次成功读取的快照，不代表当前健康状态。</SettingsNotice>}
      <SettingsSection title="服务与持久存储" scope="service" description={`读取时间：${new Date(data.generatedAt).toLocaleString()}。HTTP 可响应与 Provider 可执行是两回事。`}>
        <dl className="service-data-facts">
          <div><dt>HTTP 服务</dt><dd>本次读取可响应</dd></div>
          <div><dt>持久存储</dt><dd>{status[data.service.durableStore]}</dd></div>
          <div><dt>本进程独占所有权</dt><dd>{data.service.ownsStore ? "已核对数据库和锁" : "未证明"}</dd></div>
          <div><dt>SQLite 只读检查</dt><dd>{data.service.integrity === "ok" ? "通过 quick_check" : data.service.integrity === "failed" ? "失败" : "未检查"}</dd></div>
          <div><dt>持久会话 / 历史 / 消息</dt><dd>{data.service.threads ?? "未知"} / {data.service.histories ?? "未知"} / {data.service.messages ?? "未知"}</dd></div>
        </dl>
      </SettingsSection>
      <SettingsSection title="版本与运行环境" scope="service" description="仅使用已知 package.json 版本和当前 Node 运行时，不读取进程环境变量、命令行或原始日志。">
        <dl className="service-data-facts">
          <div><dt>Agent 服务版本</dt><dd>{data.runtime.applicationVersion ?? "未知（无可信版本源）"}</dd></div>
          <div><dt>版本来源</dt><dd>{data.runtime.versionSource}</dd></div>
          <div><dt>Node</dt><dd>{data.runtime.nodeVersion}</dd></div>
          <div><dt>平台 / 架构</dt><dd>{data.runtime.platform} / {data.runtime.architecture}</dd></div>
        </dl>
      </SettingsSection>
      <SettingsSection title="Provider 状态（与服务状态独立）" scope="service" description="这里只展示当前配置 revision 对应的最近连接测试观察，不执行新探测、不代表真实付费模型调用成功。认证状态未独立验证时始终显示未验证。">
        <p>配置读取：{status[data.providers.configuration]}；实例 {data.providers.total} 个（原生 Agent {data.providers.native} / 历史停用记录 {data.providers.inactive}）。</p>
        <ul className="service-data-list">{data.providers.observations.map((item) => <li key={item.index}>
          <strong>#{item.index} · {item.driver} · {item.enabled ? "已启用" : "已停用"}</strong>
          <span>认证：{authentication[item.authentication]}；连接：{item.connection === "ok" ? "最近测试通过" : item.connection === "failed" ? "最近测试失败" : "未验证"}</span>
          <small>{item.checkedAt ? `观察时间：${new Date(item.checkedAt).toLocaleString()}` : "无有效观察时间"}</small>
        </li>)}</ul>
        <p><Link to="/settings/providers">进入提供商设置查看实例、凭据来源并显式测试</Link></p>
      </SettingsSection>
      <SettingsSection title="最近持久失败" scope="service" description="最多显示最近 10 条已保存的聊天 / 执行失败或中断，只含来源、状态、错误类别和时间；不会读取或下载原始日志、错误正文或消息。">
        {!data.recentFailures.available ? <p>当前无法读取持久失败记录，不能据此判断没有失败。</p>
          : data.recentFailures.items.length === 0 ? <p>当前持久存储没有已记录的失败 / 中断；这不代表 Provider 已通过执行验证。</p>
          : <ul className="service-data-list">{data.recentFailures.items.map((item, index) => <li key={index}>
            <strong>{item.source === "chat" ? "聊天" : "执行"} · {item.status === "failed" ? "失败" : "已中断"}</strong>
            <span>错误类别：{item.errorClass}</span>
            <small>{item.endedAt ? new Date(item.endedAt).toLocaleString() : "无可信记录时间"}</small>
          </li>)}</ul>}
      </SettingsSection>
      <SettingsSection title="报告隐私边界" description="报告只含上方白名单状态和计数，不是备份；下载不会导出数据库、Provider 配置或登录文件。">
        <ul className="service-data-bullets">{data.privacy.excludes.map((item) => <li key={item}>{item}</li>)}</ul>
      </SettingsSection>
    </>}
  </div>;
}
