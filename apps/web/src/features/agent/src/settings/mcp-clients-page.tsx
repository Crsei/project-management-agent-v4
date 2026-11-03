// Adapted from t3code d53873b6 ConnectionsSettings authorized-client management.
// PM authority replaces upstream environment sessions. MIT; LICENSE.t3code.
import { useCallback, useEffect, useRef, useState } from "react";
import { PmServiceProvider, usePmService } from "@/features/pm/service/pm-service";
import { PmLoginPage } from "@/features/pm/service/pm-auth-page";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { mcpBrowserJson, type McpClients } from "../mcp/browser-api";
import { workspaceClient } from "../network";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";

function Clients() {
  const t = useAgentText();
  const service = usePmService();
  const { setGuard } = useSettingsGuard();
  const [result, setResult] = useState<{ actor: string; data: McpClients }>();
  const [endpoint, setEndpoint] = useState<string>();
  const [metadataError, setMetadataError] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string>();
  const [copied, setCopied] = useState(false);
  const actorKey = `${service.actor?.id}:${service.actorEpoch}`;
  const liveActor = useRef(actorKey); liveActor.current = actorKey;
  const inFlight = useRef(false);
  const data = result?.actor === actorKey ? result.data : undefined;
  const load = useCallback(async () => {
    if (!service.actor) return;
    const captured = actorKey;
    setLoading(true); setError(undefined);
    try {
      const value = await mcpBrowserJson<McpClients>(workspaceClient.url("/api/mcp/clients"));
      if (liveActor.current === captured) setResult({ actor: captured, data: value });
    } catch (cause) { if (liveActor.current === captured) { setResult(undefined); setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (liveActor.current === captured) setLoading(false); }
  }, [actorKey, service.actor?.id]);
  useEffect(() => { setPending(undefined); void load(); }, [load]);
  useEffect(() => {
    const abort = new AbortController();
    void mcpBrowserJson<{ resource: string }>("/.well-known/oauth-protected-resource", { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) { setEndpoint(value.resource); setMetadataError(undefined); }
    }).catch(cause => { if (!abort.signal.aborted) setMetadataError(cause instanceof Error ? cause.message : String(cause)); });
    return () => abort.abort();
  }, []);
  useEffect(() => { setGuard(pending ? "busy" : "clean"); }, [pending, setGuard]);
  const revoke = async (id: string, name: string) => {
    if (!data || pending || inFlight.current || !window.confirm(t(`撤销 ${name} 的授权？现有 token 将立即失效；已经提交的业务动作不会回滚。`, `Revoke ${name}? Existing tokens are invalidated immediately; already submitted actions are not rolled back.`))) return;
    const captured = actorKey; inFlight.current = true; setPending(id); setError(undefined);
    try {
      await mcpBrowserJson(workspaceClient.url(`/api/mcp/clients/${encodeURIComponent(id)}/revoke`), { method: "POST", body: JSON.stringify({ csrfToken: data.csrfToken }) });
      if (liveActor.current === captured) await load();
    } catch (cause) {
      if (liveActor.current === captured) setError(`${cause instanceof Error ? cause.message : String(cause)} ${t("请重新读取客户端列表核对当前授权状态；不会自动重放。", "Reload the client list to check the current grant; this request is not replayed automatically.")}`);
    } finally { inFlight.current = false; if (liveActor.current === captured) setPending(undefined); }
  };
  const copyEndpoint = async () => {
    if (!endpoint) return;
    try {
      if (!navigator.clipboard) throw new Error(t("浏览器未提供剪贴板权限。请手动复制地址。", "Clipboard access is unavailable. Copy the address manually."));
      await navigator.clipboard.writeText(endpoint); setCopied(true); setMetadataError(undefined);
    } catch (cause) { setMetadataError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <>
    <SettingsSection title={t("连接外部 MCP 客户端", "Connect external MCP clients")} scope="service">
      <p>{t("将此部署公开的 MCP 地址提供给支持 HTTP MCP + OAuth 授权码 / S256 的客户端。公网访问、TLS 与固定 issuer 由部署环境提供。", "Give this deployment's MCP address to a client supporting HTTP MCP and OAuth authorization-code / S256. Public reachability, TLS and the fixed issuer are deployment responsibilities.")}</p>
      {endpoint ? <div className="agent-preference-row"><code style={{ overflowWrap: "anywhere" }}>{endpoint}</code><Button variant="outline" size="sm" onClick={() => void copyEndpoint()}>{copied ? t("已复制地址", "Address copied") : t("复制 MCP 地址", "Copy MCP address")}</Button></div> : !metadataError && <SettingsNotice kind="loading">{t("正在读取部署的 MCP 元数据…", "Reading deployment MCP metadata…")}</SettingsNotice>}
      {metadataError && <SettingsNotice kind="error">{metadataError}</SettingsNotice>}
      <SettingsNotice kind="info">{t("授权默认只读，必须通过真实 PM 登录明确选择工作区 / 项目及线程。完整访问可启动付费模型及业务写操作，但不绕过受保护动作审批。此页不展示或保存 token、授权码、密码或 Provider 凭据。", "Grants default to read-only and require a real PM login plus explicit workspace / project and thread selection. Full access may start paid model turns and business writes, but never bypasses protected-action approvals. This page never displays or stores tokens, authorization codes, passwords or provider credentials.")}</SettingsNotice>
    </SettingsSection>
    <SettingsSection title={t("我的已授权客户端", "My authorized clients")} scope="workspace">
      {!service.actor ? <PmLoginPage /> : <>
        <div className="agent-preference-row"><p>{t("当前 PM 身份：", "Current PM identity: ")}{service.actor.name}</p><Button size="sm" variant="outline" disabled={loading || !!pending} onClick={() => void load()}>{t("重新读取授权", "Reload grants")}</Button></div>
        {loading && <SettingsNotice kind="loading">{t("正在读取当前身份的授权…", "Reading the current actor's grants…")}</SettingsNotice>}
        {error && <SettingsNotice kind="error" onRetry={() => void load()}>{error}</SettingsNotice>}
        {data && !data.items.length && <p>{t("此 PM 身份尚未授权任何客户端。", "This PM identity has no authorized clients.")}</p>}
        {data?.items.map(item => <article className="settings-section" key={item.id}>
          <div className="agent-preference-row"><strong>{item.clientName}</strong><Button size="sm" variant="outline" disabled={!!item.revokedAt || !!pending} onClick={() => void revoke(item.id, item.clientName)}>{pending === item.id ? t("正在撤销…", "Revoking…") : item.revokedAt ? t("已撤销", "Revoked") : t("撤销授权", "Revoke grant")}</Button></div>
          <dl><dt>{t("状态 / 权限", "Status / access")}</dt><dd>{item.revokedAt ? t("已撤销", "Revoked") : Date.parse(item.expiresAt) <= Date.now() ? t("已过期", "Expired") : t("有效", "Active")} · {item.access === "read-only" ? t("只读", "Read-only") : t("完整访问", "Full access")}</dd><dt>{t("精确作用域", "Exact scope")}</dt><dd><code>{item.scope.workspaceId} / {item.scope.projectId ?? t("仅工作区", "Workspace only")}</code></dd><dt>{t("明确允许的线程", "Explicit allowed threads")}</dt><dd>{item.threadIds.length ? <ul>{item.threadIds.map(id => <li key={id}><code>{id}</code></li>)}</ul> : t("无现有线程", "No existing threads")}</dd><dt>{t("创建 / 到期", "Created / expires")}</dt><dd><time>{item.createdAt}</time> / <time>{item.expiresAt}</time></dd></dl>
        </article>)}
      </>}
    </SettingsSection>
  </>;
}
export default function McpClientsPage() { return <PmServiceProvider><Clients /></PmServiceProvider>; }
