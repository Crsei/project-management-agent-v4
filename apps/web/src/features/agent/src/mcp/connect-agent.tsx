// Adapted from t3code d53873b6 ConnectAgentSurface.tsx; PM owns login and scope authority.
// No upstream pairing/account system is imported. MIT; LICENSE.t3code.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { PmServiceProvider, usePmService } from "@/features/pm/service/pm-service";
import { PmAuthPageShell, PmLoginPage } from "@/features/pm/service/pm-auth-page";
import { useText } from "@/features/pm/service/pm-ui";
import { Button } from "@/components/ui/button";
import { RadixSelect } from "@/components/ui/radix-select";
import { McpBrowserError, mcpBrowserJson, type McpApproval } from "./browser-api";
import "./connect-agent.css";

function Consent() {
  const t = useText();
  const service = usePmService();
  const location = useLocation();
  const authorization = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const values: Record<string, string> = {};
    for (const [name, value] of params) {
      if (Object.hasOwn(values, name)) return null;
      values[name] = value;
    }
    return values;
  }, [location.search]);
  const [loaded, setLoaded] = useState<{ key: string; details: McpApproval }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [threadIds, setThreadIds] = useState<string[]>([]);
  const [access, setAccess] = useState<"read-only" | "full">("read-only");
  const [fullWarningAccepted, setFullWarningAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const inFlight = useRef(false);
  const key = JSON.stringify([service.actor?.id, service.actorEpoch, location.search]);
  const currentKey = useRef(key); currentKey.current = key;
  const details = loaded?.key === key ? loaded.details : undefined;
  const load = useCallback(async () => {
    if (!service.actor || !authorization) return;
    const captured = key;
    setLoading(true); setError(undefined); setLoaded(undefined);
    setWorkspaceId(""); setProjectId(""); setThreadIds([]); setAccess("read-only"); setFullWarningAccepted(false); setUnknown(false);
    try {
      const value = await mcpBrowserJson<McpApproval>("/oauth/mcp/approval", { method: "POST", body: JSON.stringify(authorization) });
      if (currentKey.current === captured) setLoaded({ key: captured, details: value });
    } catch (cause) { if (currentKey.current === captured) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentKey.current === captured) setLoading(false); }
  }, [key, service.actor?.id, authorization]);
  useEffect(() => { setPending(false); void load(); }, [load]);
  const workspace = details?.catalog.workspaces.find(item => item.id === workspaceId);
  const selectedProject = projectId === "workspace" ? null : projectId;
  const scopeValid = !!workspace && (projectId === "workspace" ? workspace.workspaceAllowed : !!workspace.projects.find(project => project.id === projectId));
  const threads = details?.threads.filter(thread => thread.scope.workspaceId === workspaceId && thread.scope.projectId === selectedProject) ?? [];
  const decide = async (approve: boolean) => {
    if (!details || pending || unknown || inFlight.current || approve && (!scopeValid || access === "full" && !fullWarningAccepted)) return;
    const captured = key; inFlight.current = true; setPending(true); setError(undefined);
    try {
      const result = await mcpBrowserJson<{ redirectTo: string }>("/oauth/mcp/decision", { method: "POST", body: JSON.stringify({ authorization: details.authorization, decision: approve ? { _tag: "approve", csrfToken: details.csrfToken, scope: { workspaceId, projectId: selectedProject }, threadIds: threadIds.filter(id => threads.some(thread => thread.id === id)), access } : { _tag: "deny", csrfToken: details.csrfToken } }) });
      if (currentKey.current !== captured) return;
      // The authority validated the registered redirect. Never display/store its one-time code.
      window.location.replace(result.redirectTo);
    } catch (cause) {
      if (currentKey.current !== captured) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (!(cause instanceof McpBrowserError) || cause.status >= 500) setUnknown(true);
    } finally { inFlight.current = false; if (currentKey.current === captured) setPending(false); }
  };
  if (!service.actor) return <PmLoginPage />;
  return <section className="mcp-consent" aria-labelledby="mcp-consent-title">
    <p>{t("外部 Agent 连接授权", "External Agent authorization")}</p>
    <h1 id="mcp-consent-title">{details ? t(`连接 ${details.clientName}`, `Connect ${details.clientName}`) : t("核对连接请求", "Review connection request")}</h1>
    <p>{t("当前 PM 身份：", "Current PM identity: ")}{service.actor.name}</p>
    {!authorization && <p role="alert">{t("授权请求包含重复参数，请从外部客户端重新开始。", "The authorization request contains duplicate parameters. Start again from the external client.")}</p>}
    {loading && <p role="status">{t("正在核验客户端和您可授予的精确范围…", "Checking the client and your exact grantable scope…")}</p>}
    {error && <p role="alert">{error}</p>}
    {!details && !loading && authorization && <Button variant="secondary" onClick={() => void load()}>{t("重新核验请求", "Check request again")}</Button>}
    {details && <>
      <p>{t("名称由客户端自行提供。只批准您刚刚发起的连接；授权会返回：", "The client chooses its own name. Only approve a connection you just started. Authorization returns to: ")}<strong>{details.redirectHost}</strong></p>
      <p>{t("授权不会泄露 PM 登录 cookie、密码或 Provider 凭据。客户端只能访问明确选中的范围和线程，不能自动读取同项目历史。", "This does not expose your PM login cookie, password or provider credentials. The client can access only the selected scope and explicit threads, not all project history.")}</p>
      <form onSubmit={event => { event.preventDefault(); void decide(true); }}>
        <fieldset disabled={pending || unknown}>
          <label>{t("工作区", "Workspace")}<RadixSelect value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setProjectId(""); setThreadIds([]); }}><option value="">{t("明确选择工作区", "Choose a workspace explicitly")}</option>{details.catalog.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</RadixSelect></label>
          <label>{t("项目 / 工作区范围", "Project / workspace scope")}<RadixSelect value={projectId} disabled={!workspace} onChange={event => { setProjectId(event.target.value); setThreadIds([]); }}><option value="">{t("明确选择授权范围", "Choose a grant scope explicitly")}</option>{workspace?.workspaceAllowed && <option value="workspace">{t("仅工作区会话（不包含任何项目）", "Workspace sessions only (no projects)")}</option>}{workspace?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</RadixSelect></label>
          <fieldset className="mcp-access-options"><legend>{t("权限上限", "Access ceiling")}</legend>{details.allowedAccess.map(option => <label key={option}><input type="radio" name="mcp-access" value={option} checked={access === option} onChange={() => { setAccess(option); setFullWarningAccepted(false); }} /><span><strong>{option === "read-only" ? t("只读（默认）", "Read-only (default)") : t("完整访问", "Full access")}</strong><small>{option === "read-only" ? t("只读取明确授权的信息；不能创建、发送、停止 Chat 或修改 PM。", "Read explicitly authorized data only; cannot create, message or stop Chat, or change PM.") : t("可启动模型并产生费用、发送或停止授权会话、发起允许的 PM 写操作；受保护动作仍需原审批。", "Can run paid model turns, message or stop authorized sessions and request permitted PM writes; protected actions still require existing approvals.")}</small></span></label>)}</fieldset>
          {access === "full" && <label className="mcp-full-warning"><input type="checkbox" checked={fullWarningAccepted} onChange={event => setFullWarningAccepted(event.target.checked)} />{t("我理解完整访问可以运行原生 Agent 并产生副作用，不等于批准所有破坏性操作。", "I understand full access can run native Agents and cause side effects; it does not approve every destructive action.")}</label>}
          <fieldset className="mcp-thread-options" disabled={!scopeValid}><legend>{t("明确授权的现有线程（默认不选）", "Explicit existing threads (none selected by default)")}</legend>{!scopeValid ? <p>{t("先选择范围。", "Select a scope first.")}</p> : !threads.length ? <p>{t("该精确范围没有可选线程。", "No selectable threads in this exact scope.")}</p> : threads.map(thread => <label key={thread.id}><input type="checkbox" checked={threadIds.includes(thread.id)} onChange={event => setThreadIds(previous => event.target.checked ? [...previous, thread.id] : previous.filter(id => id !== thread.id))} /><span>{thread.title || thread.id}<small>{thread.id}</small></span></label>)}<p>{t("不选线程不会开放历史。完整访问仍可在选中范围新建自己的线程。", "An empty selection grants no historical threads. Full access may create its own threads in the selected scope.")}</p></fieldset>
          <div className="mcp-consent-actions"><Button type="submit" disabled={!scopeValid || access === "full" && !fullWarningAccepted}>{pending ? t("正在提交…", "Submitting…") : t("批准此精确授权", "Approve this exact grant")}</Button><Button type="button" variant="secondary" onClick={() => void decide(false)}>{t("拒绝", "Deny")}</Button></div>
        </fieldset>
      </form>
    </>}
    {unknown && <p role="alert">{t("授权提交结果未知，不会自动重放。请返回外部客户端重新发起连接，并在已授权客户端页检查或撤销原授权。", "The authorization outcome is unknown and will not be replayed. Start again from the external client; check or revoke the original grant in authorized clients.")}</p>}
    <Link to="/agent/settings/mcp-clients">{t("查看 / 撤销已授权客户端", "View / revoke authorized clients")}</Link>
  </section>;
}
export default function ConnectAgentPage() {
  return <PmServiceProvider><PmAuthPageShell split={false}><Consent /></PmAuthPageShell></PmServiceProvider>;
}
