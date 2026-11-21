// Local Agent access replaces the visible OAuth code/PKCE ceremony for loopback deployments.
// The PM login that enables the binding remains the only identity authority.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePmService } from "@/features/pm/service/pm-service";
import { PmLoginPage } from "@/features/pm/service/pm-auth-page";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { mcpBrowserJson, type LocalMcpAccessState } from "../mcp/browser-api";
import { workspaceClient } from "../network";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";

export default function McpExternalAccess() {
  const t = useAgentText();
  const service = usePmService();
  const { setGuard } = useSettingsGuard();
  const [result, setResult] = useState<{ key: string; value: LocalMcpAccessState }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<"enable" | "disable">();
  const [copied, setCopied] = useState<"endpoint" | "snippet">();
  const [copyError, setCopyError] = useState<string>();
  const actorKey = `${service.actor?.id}:${service.actorEpoch}`;
  const liveKey = useRef(actorKey);
  liveKey.current = actorKey;
  const inFlight = useRef(false);
  const data = result?.key === actorKey ? result.value : undefined;
  const load = useCallback(async () => {
    if (!service.actor) return;
    const captured = actorKey;
    setLoading(true); setError(undefined);
    try {
      const value = await mcpBrowserJson<LocalMcpAccessState>(workspaceClient.url("/api/mcp/local-access"));
      if (liveKey.current === captured) setResult({ key: captured, value });
    } catch (cause) {
      if (liveKey.current === captured) { setResult(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
    } finally {
      if (liveKey.current === captured) setLoading(false);
    }
  }, [actorKey, service.actor?.id]);
  useEffect(() => { setPending(undefined); setCopied(undefined); setCopyError(undefined); void load(); }, [load]);
  useEffect(() => { setGuard(pending ? "busy" : "clean"); }, [pending, setGuard]);
  const mutate = async (action: "enable" | "disable") => {
    if (!data || pending || inFlight.current) return;
    if (action === "disable" && !window.confirm(t("停用后本机 Agent 立即失去 MCP 访问；已提交的业务动作不会回滚。", "Disabling removes local Agent MCP access immediately; already submitted actions are not rolled back."))) return;
    const captured = actorKey;
    inFlight.current = true; setPending(action); setError(undefined); setCopied(undefined);
    try {
      const value = await mcpBrowserJson<LocalMcpAccessState>(workspaceClient.url(action === "enable" ? "/api/mcp/local-access" : "/api/mcp/local-access/disable"), { method: "POST", body: JSON.stringify({ csrfToken: data.csrfToken }) });
      if (liveKey.current === captured) setResult({ key: captured, value });
    } catch (cause) {
      if (liveKey.current === captured) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      if (liveKey.current === captured) setPending(undefined);
    }
  };
  const endpoint = data?.endpoint;
  const snippet = endpoint ? JSON.stringify({ mcpServers: { "dovspace-pm": { type: "http", url: endpoint } } }, null, 2) : "";
  const copy = async (kind: "endpoint" | "snippet", value: string) => {
    try {
      if (!navigator.clipboard) throw new Error(t("浏览器未提供剪贴板权限。请手动复制。", "Clipboard access is unavailable. Copy manually."));
      await navigator.clipboard.writeText(value);
      setCopied(kind); setCopyError(undefined);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <div className="settings-mcp-external-access">
    <SettingsSection title={t("本机 Agent 直连", "Local Agent access")} scope="service">
      <p>{t("此部署把 MCP 常驻发布在固定地址。登录 PM 后可查看地址、启用本机直连并复制配置。", "This deployment publishes a resident MCP endpoint at a fixed address. Sign in to PM to view the address, enable local access, and copy the configuration.")}</p>
      {endpoint ? <div className="agent-preference-row"><code style={{ overflowWrap: "anywhere" }}>{endpoint}</code><Button variant="outline" size="sm" onClick={() => void copy("endpoint", endpoint)}>{copied === "endpoint" ? t("已复制地址", "Address copied") : t("复制 MCP 地址", "Copy MCP address")}</Button></div> : !data && loading && <SettingsNotice kind="loading">{t("正在读取本机连接状态…", "Reading local connection state…")}</SettingsNotice>}
      {data && !data.available && <SettingsNotice kind="error">{t("本机直连仅在 MCP_PUBLIC_ORIGIN 为回环 HTTP 地址（localhost / 127.0.0.1 / ::1）时可用；当前部署未满足此条件。", "Local access is available only when MCP_PUBLIC_ORIGIN is a loopback HTTP origin (localhost / 127.0.0.1 / ::1). This deployment does not meet that condition.")}</SettingsNotice>}
      {copyError && <SettingsNotice kind="error">{copyError}</SettingsNotice>}
      <SettingsNotice kind="info">{t("启用后，当前 PM 账号实时有权访问的全部工作区与项目对本机 MCP 客户端可见，写入按完整访问处理。每次工具调用仍由 PM 复核成员、项目能力和审批；撤销 PM 权限会立即生效。", "When enabled, every workspace and project the current PM account can access becomes visible to local MCP clients with full-access writes. Each tool call is still rechecked by PM for membership, project capability and approvals; revoked PM access takes effect immediately.")}</SettingsNotice>
      <SettingsNotice kind="info">{t("本机边界：该地址不做逐客户端认证，任何能访问本机回环端口的进程都可以使用。不要把它暴露到公网或不可信网络。", "Local boundary: the endpoint does not authenticate individual clients; any process that can reach the loopback port can use it. Do not expose it to the public internet or an untrusted network.")}</SettingsNotice>
    </SettingsSection>
    <SettingsSection title={t("当前绑定", "Current binding")} scope="workspace">
      {!service.actor ? <PmLoginPage /> : <>
        <div className="agent-preference-row"><p>{t("当前 PM 身份：", "Current PM identity: ")}{service.actor.name}</p><Button size="sm" variant="outline" disabled={loading || !!pending} onClick={() => void load()}>{t("重新读取状态", "Reload state")}</Button></div>
        {loading && !data && <SettingsNotice kind="loading">{t("正在读取当前绑定…", "Reading the current binding…")}</SettingsNotice>}
        {error && <SettingsNotice kind="error" onRetry={() => void load()}>{error}</SettingsNotice>}
        {data && data.occupied && <SettingsNotice kind="error">{t("本机直连已由另一个 PM 账号启用。请用该账号停用，或在该账号下更新授权范围。", "Local access is enabled for another PM account. Sign in as that account to disable it or refresh its scope.")}</SettingsNotice>}
        {data && !data.enabled && !data.occupied && <SettingsNotice kind="info">{t("尚未启用本机直连。启用会把当前账号的全部已授权工作区/项目同步为 MCP 范围。", "Local access is not enabled. Enabling synchronizes all currently authorized workspaces/projects for this account into the MCP scope.")}</SettingsNotice>}
        {data && data.enabled && data.owner && <>
          <p>{t("已为 ", "Enabled for ")}<strong>{data.actor?.name}</strong>{t(" 启用：", ": ")}{data.workspaceCount ?? 0}{t(" 个工作区 / ", " workspaces / ")}{data.projectCount ?? 0}{t(" 个项目。", " projects.")}</p>
          <div className="agent-preference-row">
            <Button size="sm" disabled={!!pending} onClick={() => void mutate("enable")}>{pending === "enable" ? t("正在同步…", "Synchronizing…") : t("更新授权范围", "Refresh scope")}</Button>
            <Button size="sm" variant="outline" disabled={!!pending} onClick={() => void mutate("disable")}>{pending === "disable" ? t("正在停用…", "Disabling…") : t("停用本机直连", "Disable local access")}</Button>
          </div>
          {data.updatedAt && <p><small>{t("最近同步：", "Last synchronized: ")}{data.updatedAt}</small></p>}
          {data.endpoint && <>
            <p>{t("复制下面的通用 MCP 配置到本机 Agent（HTTP / Streamable HTTP）。", "Copy this generic MCP configuration into a local Agent (HTTP / Streamable HTTP).")}</p>
            <pre style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{snippet}</pre>
            <Button size="sm" variant="outline" onClick={() => void copy("snippet", snippet)}>{copied === "snippet" ? t("已复制配置", "Configuration copied") : t("复制配置片段", "Copy configuration")}</Button>
          </>}
        </>}
        {data && data.available && !data.enabled && !data.occupied && <Button size="sm" disabled={!!pending} onClick={() => void mutate("enable")}>{pending === "enable" ? t("正在启用…", "Enabling…") : t("启用本机直连", "Enable local access")}</Button>}
      </>}
    </SettingsSection>
  </div>;
}
