import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CcSwitchManagement, MANAGED_APPS, type ManagementContext, type ManagementEvent } from "@pm/cc-switch-ui";
import { OpenHandsExtensionSurface } from "@pm/openhands-extensions";
import { PmServiceProvider, usePmService } from "@/features/pm/service/pm-service";
import { PmLoginPage } from "@/features/pm/service/pm-auth-page";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { useI18n } from "@/lib/i18n-provider";
import { extensionJson, readExtensionEvents, uploadExtensionZip } from "./extensions-api";
import { SettingsNotice, useSettingsGuard } from "./settings-layout";

type RemoteTarget = { providerInstanceId?: string; externalTargetId?: string; providerRevision?: number; driver?: string; label: string; app: string; sharedProviderInstanceIds?: string[]; bindingFingerprint: string; warnings?: string[] };
type Target = RemoteTarget & { key: string };
function Management({ view }: { view: "mcp" | "skills" }) {
  const t = useAgentText();
  const { locale } = useI18n();
  const service = usePmService();
  const [params, setParams] = useSearchParams();
  const contextSelectId = useId();
  const contextHintId = useId();
  const workspaceId = params.get("workspace") ?? "";
  const projectId = params.get("project") ?? "";
  const requested = params.get("context") ?? "";
  const requestedProvider = params.get("provider") ?? "";
  const scopeKey = JSON.stringify([workspaceId, projectId, requestedProvider]);
  const [loadedScope, setLoadedScope] = useState("");
  const loadSequence = useRef(0);
  const [contexts, setContexts] = useState<ManagementContext[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [completedBindingId, setCompletedBindingId] = useState<string>();
  const [transportBusy, setTransportBusy] = useState(0);
  const [panelBusy, setPanelBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [surfaceVersion, setSurfaceVersion] = useState(0);
  const [streamVersion, setStreamVersion] = useState(0);
  const [streamError, setStreamError] = useState<string>();
  const listeners = useRef(new Set<(event: ManagementEvent) => void>());
  const streamReady = useRef<PromiseWithResolvers<void> | undefined>(undefined);
  const streamFailure = useRef<string | undefined>(undefined);
  streamFailure.current = streamError;
  const live = useRef(true);
  const { setGuard } = useSettingsGuard();
  const context = loadedScope === scopeKey ? contexts.find(item => item.id === requested) ?? (!requested ? contexts.find(item => requestedProvider ? item.kind === "native" && item.providerInstanceIds.includes(requestedProvider) : workspaceId && projectId ? item.kind === "project" : item.kind === "native") : undefined) : undefined;
  const id = context?.id;
  const locked = busy || transportBusy > 0 || panelBusy || dirty;
  useEffect(() => { setGuard(busy || transportBusy > 0 || panelBusy ? "busy" : dirty ? "dirty" : "clean"); }, [busy, transportBusy, panelBusy, dirty, setGuard]);
  useEffect(() => {
    // Publish only after this page's completed operation has released its guard.
    // An in-flight request or a real dirty panel must never be bypassed.
    if (!completedBindingId || locked) return;
    const next = new URLSearchParams(params);
    next.set("context", completedBindingId);
    setParams(next, { replace: true });
    setCompletedBindingId(undefined);
  }, [completedBindingId, locked, params, setParams]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError(undefined);
    try {
      const [native, candidate, project] = await Promise.all([
        extensionJson<{ contexts: ManagementContext[] }>("/contexts"),
        extensionJson<{ targets: RemoteTarget[] }>("/targets"),
        workspaceId && projectId && !requestedProvider ? extensionJson<{ contexts: ManagementContext[] }>(`/contexts?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(projectId)}`) : Promise.resolve({ contexts: [] as ManagementContext[] }),
      ]);
      if (!live.current || sequence !== loadSequence.current) return;
      setContexts([...new Map([...native.contexts, ...project.contexts].map(item => [item.id, item])).values()]);
      setTargets(candidate.targets.map(target => ({ ...target, key: target.providerInstanceId ? `provider:${target.providerInstanceId}` : `external:${target.externalTargetId}` })));
      setLoadedScope(scopeKey);
    } catch (cause) { if (live.current && sequence === loadSequence.current) { setContexts([]); setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (live.current && sequence === loadSequence.current) setLoading(false); }
  }, [workspaceId, projectId, requestedProvider, scopeKey]);
  useEffect(() => { if (!workspaceId || !projectId || service.actor) void load(); else setLoading(false); }, [load, service.actor?.id]);
  useEffect(() => {
    setSelectedTargets(context ? [...context.providerInstanceIds.map(id => `provider:${id}`), ...(context.externalTargetIds ?? []).map(id => `external:${id}`)] : requestedProvider ? [`provider:${requestedProvider}`] : []);
    setConfirmed(false);
  }, [id, surfaceVersion, requestedProvider, context?.providerInstanceIds.join(","), context?.externalTargetIds.join(",")]);
  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    const ready = Promise.withResolvers<void>(); streamReady.current = ready;
    // A rejected readiness promise is also reported visibly below, even if no check was requested.
    void ready.promise.catch(() => undefined);
    setStreamError(undefined);
    void readExtensionEvents(id, abort.signal, () => {
      ready.resolve();
      if (streamVersion > 0) for (const listener of listeners.current) listener({ event: "reconnected", data: {} });
    }, event => {
      for (const listener of listeners.current) listener(event);
      if (event.event === "changed") {
        setContexts(items => items.map(item => item.id === id ? { ...item, reloadRequired: item.kind === "native" || item.reloadRequired } : item));
        window.dispatchEvent(new CustomEvent("agent-native-configuration-changed", { detail: { providerInstanceIds: context?.providerInstanceIds ?? [] } }));
      } else if (event.event === "operation" && event.data && typeof event.data === "object" && "state" in event.data && event.data.state === "completed") {
        // The host clears its prior mutation failure only on confirmed completion.
        setContexts(items => items.map(item => item.id === id && item.status !== "failed" ? { ...item, lastError: undefined } : item));
      } else if (event.event === "status" && event.data && typeof event.data === "object" && "status" in event.data && ["stopped", "starting", "ready", "failed"].includes(String(event.data.status))) {
        const value = event.data as Partial<ManagementContext> & { error?: ManagementContext["lastError"] };
        setContexts(items => items.map(item => item.id === id ? { ...item, status: value.status!, lastError: value.error ?? value.lastError, reloadRequired: value.reloadRequired ?? item.reloadRequired } : item));
      }
    }).catch(cause => {
      ready.reject(cause);
      if (!abort.signal.aborted) setStreamError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { abort.abort(); ready.reject(new Error("Management context changed.")); if (streamReady.current === ready) streamReady.current = undefined; };
  }, [id, streamVersion]);
  const subscribe = useCallback((listener: (event: ManagementEvent) => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }, []);
  const invoke = useCallback(async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (!id) throw new Error("Choose an authorized management context.");
    const readOnly = /^(get_|read_|scan_|discover_|search_)/.test(command) || command === "browse_directory" || command === "check_skill_updates" || command === "cancel_mcp_connectivity_checks" || command === "preview_mcp_import";
    if (!readOnly) { setTransportBusy(count => count + 1); setGuard("busy"); }
    try {
      if (!readOnly) {
        if (streamFailure.current) throw new Error(streamFailure.current);
        if (!streamReady.current) throw new Error("The management event stream is not connected.");
        await streamReady.current.promise;
      }
      const value = await extensionJson<{ result: T }>(`/contexts/${encodeURIComponent(id)}/invoke`, { method: "POST", body: JSON.stringify({ command, args }) });
      return value.result;
    } finally { if (!readOnly) setTransportBusy(count => count - 1); }
  }, [id, setGuard]);
  const upload = useCallback(async (file: File) => {
    if (!id) throw new Error("Choose a context before uploading.");
    setTransportBusy(count => count + 1); setGuard("busy");
    try {
      if (streamFailure.current) throw new Error(streamFailure.current);
      if (!streamReady.current) throw new Error("The management event stream is not connected.");
      await streamReady.current.promise;
      return await uploadExtensionZip(id, file);
    } finally { setTransportBusy(count => count - 1); }
  }, [id, setGuard]);
  const select = useCallback(async (value: string): Promise<boolean> => {
    if (locked || loading || completedBindingId || loadedScope !== scopeKey || !contexts.some(item => item.id === value)) return false;
    if (value === id) return true;
    const next = new URLSearchParams(params); next.set("context", value);
    // A real host selection is published only after every current guard passed.
    setParams(next); setError(undefined);
    return true;
  }, [locked, loading, completedBindingId, loadedScope, scopeKey, contexts, id, params, setParams]);
  const bind = async (rebind: boolean) => {
    if (!confirmed || !selectedTargets.length || locked || rebind && context?.kind !== "native") return;
    setBusy(true); setError(undefined);
    try {
      const providerInstanceIds = selectedTargets.filter(key => key.startsWith("provider:")).map(key => key.slice(9));
      const externalTargetIds = selectedTargets.filter(key => key.startsWith("external:")).map(key => key.slice(9));
      const value = await extensionJson<{ context: ManagementContext }>(rebind ? `/contexts/${encodeURIComponent(id!)}/binding` : "/contexts", { method: "POST", body: JSON.stringify({ providerInstanceIds, externalTargetIds, confirmed: true }) });
      await load();
      setCompletedBindingId(value.context.id);
      setConfirmed(false); setSurfaceVersion(version => version + 1);
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : String(cause)} ${t("请重新读取权威状态后核对；不会自动重放。", "Read authoritative state to reconcile; this operation is not replayed.")}`); }
    finally { setBusy(false); }
  };
  const shared = useMemo(() => targets.filter(target => selectedTargets.includes(target.key) && (target.sharedProviderInstanceIds?.length ?? 0) > 1), [targets, selectedTargets]);
  const contextStatus = context ? {
    stopped: t("配置服务已停止", "Configuration service stopped"),
    starting: t("配置服务启动中", "Configuration service starting"),
    ready: t("配置服务就绪", "Configuration service ready"),
    failed: t("配置服务异常", "Configuration service failed"),
  }[context.status] : "";
  if (workspaceId && projectId && !service.actor) return <PmLoginPage />;
  return <div className="settings-extensions-page">
    <section className="settings-extension-context" aria-label={t("管理范围与目标", "Management scope and targets")}>
      <details className="settings-extension-context-disclosure" open={!context}>
        <summary className="settings-extension-context-summary">
          <span className="settings-extension-context-name"><span>{t("管理范围", "Scope")}</span><strong title={context?.label}>{context?.label ?? t("选择已授权上下文", "Choose an authorized context")}</strong></span>
          {context && <span className="settings-extension-context-facts"><span className="settings-scope-badge">{context.kind === "project" ? t("项目私有", "Project private") : t("已绑定原生 Home", "Bound native Home")} · {context.apps.length} {t("个目标", "targets")}</span><span data-context-status={context.status}>{contextStatus}</span>{context.reloadRequired && <span className="settings-extension-reload">{t("原生会话需重新加载", "Native session reload required")}</span>}</span>}
        </summary>
        <div className="settings-extension-context-body">
          <div className="settings-extension-context-controls"><label htmlFor={contextSelectId}><span>{t("管理上下文", "Management context")}</span><select id={contextSelectId} value={id ?? ""} title={context?.label} aria-describedby={contextHintId} disabled={locked || loading} onChange={event => void select(event.target.value)}><option value="">{t("选择已授权上下文", "Choose an authorized context")}</option>{contexts.map(item => <option key={item.id} value={item.id}>{item.label} · {item.kind === "project" ? t("项目私有", "Project private") : t("原生目标", "Native targets")}</option>)}</select></label><Button variant="outline" disabled={locked || loading} onClick={() => void load()}>{t("重新读取上下文", "Reload contexts")}</Button></div>
          <p id={contextHintId} className="settings-extension-scope-note">{t("仅管理所选的已授权原生 Home 或项目私有范围；不会授权整机或自动创建工作区配置。保存定义、原生文件同步与运行会话重载是不同状态。", "Only the selected authorized native Home or private project is managed, not the whole machine or a workspace-only configuration. Saved definitions, native file synchronization and session reloads are separate states.")}</p>
          {locked && <p className="settings-extension-scope-note" role="status">{dirty ? t("请先保存或取消当前草稿，再切换管理上下文。", "Save or cancel the current draft before switching management contexts.") : t("当前操作进行中，完成后才能切换或重新绑定上下文。", "Wait for the current operation before switching or rebinding contexts.")}</p>}
          {!context && !requested && !loading && !error && <SettingsNotice kind="info">{t("请选择已授权上下文，或在下方确认绑定真实原生目标。未选择时不会读取其他 Home 或假定工作区配置可用。", "Choose an authorized context or explicitly bind real native targets below. No other Home or workspace-only configuration is assumed when none is selected.")}</SettingsNotice>}
          {context && <>
        <p className="settings-extension-selected-context"><strong>{context.label}</strong>{context.scope && <code>{context.scope.workspaceId} / {context.scope.projectId}</code>}</p>
        {context.warnings.map(message => <SettingsNotice key={message} kind="info">{message}</SettingsNotice>)}
        {context.kind === "project" && <SettingsNotice kind="info">{t("项目私有定义不导出到原生 Home。应用开关不是项目工具授权；执行仍复核 PM 范围、工具策略与批准版本。", "Project-private definitions are not exported to a native Home. App switches do not authorize project tools; execution rechecks PM scope, tool policies and approved revisions.")}</SettingsNotice>}
        {context.kind === "project" && context.scope && <SettingsNotice kind="info">{t("项目连通性与工具目录验证只在 Studio 显式执行，沿用 PM 固定 DNS、无代理、无自动重试的传输；此处不运行原生探测。", "Project connectivity and tool catalogs are verified explicitly in Studio using PM's pinned-DNS, no-proxy, no-retry transport; native probes are disabled here.")}{" "}<Link className="underline" to={`/agent/automations/integrations?${new URLSearchParams({ workspace: context.scope.workspaceId, project: context.scope.projectId })}`}>{t("打开当前项目的连接验证", "Open this project's connection verification")}</Link></SettingsNotice>}
        <details><summary>{t("12 个来源应用 / 当前目标可用性", "12 upstream apps / target availability")}</summary><ul>{MANAGED_APPS.map(app => <li key={app.id}>{app.label}: {context.apps.includes(app.id) ? t("已登记授权目标（不等于 CLI 已安装或支持 PM Chat）", "Authorized target registered (not a claim of installed CLI or PM Chat support)") : t("未登记目标；禁止原生读写", "No registered target; native reads/writes disabled")}</li>)}</ul></details>
        {context.reloadRequired && <SettingsNotice kind="info">{t("配置已变更。新请求将重新发现原生目录；活跃执行不会被停止。返回 Composer 刷新目录，并按需显式重启原生 session 或新建对话。", "Configuration changed. New requests rediscover native catalogs; active executions are not stopped. Refresh the catalog in Composer and explicitly restart the native session or start a new chat when needed.")}</SettingsNotice>}
      </>}
      <details className="settings-extension-binding" open={!context}>
        <summary>{t("绑定与原生目标", "Bindings and native targets")}</summary>
        <p>{t("选中实例或宿主管理员登记的外部 CLI 目标并确认后才授权原生文件写入。同类不同 Home 请创建不同上下文；同一应用在一个上下文只能绑定一个原生根。", "Native writes require explicit confirmation of provider instances or host-admin registered external CLI targets. Use separate contexts for different Homes of the same app; one root per app in each context.")}</p>
        <p>{t("定义保存、文件同步、Provider 可调用目录与运行会话重载是不同状态。OpenHands 负责扩展页面，CC Switch 负责真实原生配置与生命周期。", "Saved definitions, deployed files, provider invocation catalogs and session reloads are separate states. OpenHands presents extensions; CC Switch manages real native configuration and lifecycle.")}</p>
        <fieldset disabled={locked}>
          {targets.map(target => <label key={target.key} className="flex items-center gap-2 py-1">
            <input type="checkbox" checked={selectedTargets.includes(target.key)} onChange={event => { setSelectedTargets(items => event.target.checked ? [...items, target.key] : items.filter(id => id !== target.key)); setConfirmed(false); }} />
            {target.label} · {target.app} · {target.externalTargetId ? t("外部 CLI（不提供 PM Chat）", "External CLI (not PM Chat)") : `r${target.providerRevision}`} {target.warnings?.join("; ")}
          </label>)}
          {selectedTargets.filter(key => !targets.some(target => target.key === key)).map(key => <div key={key} role="alert">{t("原绑定目标当前不可用：", "Previously bound target is unavailable: ")}<code>{key}</code> <Button variant="outline" size="sm" onClick={() => { setSelectedTargets(items => items.filter(item => item !== key)); setConfirmed(false); }}>{t("从本次绑定选择移除", "Remove from this binding selection")}</Button></div>)}
          {!targets.length && <p>{t("没有宿主登记且布局已核实的目标。未登记的应用保持不可写；外部目标由宿主管理员登记，不接受浏览器绝对路径。", "No host-registered targets with verified layouts. Unregistered apps remain non-writable; an administrator registers external targets, never a browser-supplied absolute path.")}</p>}
          {shared.length > 0 && <SettingsNotice kind="info">{t("此目标根被多个 Provider 实例共享；变更影响全部共享实例：", "Target roots shared by multiple provider instances affect all: ")}{shared.map(item => `${item.label}: ${item.sharedProviderInstanceIds?.join(", ")}`).join("; ")}</SettingsNotice>}
          <label className="flex items-center gap-2 py-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("我确认这些原生目标与共享影响，授权将受管配置写入此上下文。", "I confirm these native targets and shared effects, authorizing managed configuration writes in this context.")}</label>
          <div className="settings-extension-binding-actions"><Button disabled={!confirmed || !selectedTargets.length} onClick={() => void bind(false)}>{t("创建独立上下文", "Create separate context")}</Button><Button variant="outline" disabled={!confirmed || !selectedTargets.length || context?.kind !== "native"} onClick={() => void bind(true)}>{t("重新绑定当前上下文", "Rebind current context")}</Button></div>
        </fieldset>
      </details>
        </div>
      </details>
      {workspaceId && !projectId && <SettingsNotice kind="info">{t("工作区独立配置当前不可用。此工作区参数不会授权原生 Home；下方仅管理明确选中的已授权上下文。项目私有定义需要现有项目范围。", "Workspace-only configuration is unavailable. A workspace parameter does not authorize a native Home; only the explicitly selected authorized context is managed below. Private project definitions require an existing project scope.")}</SettingsNotice>}
      {loading && <SettingsNotice kind="loading">{t("正在读取授权与目标绑定…", "Loading authorization and target bindings…")}</SettingsNotice>}
      {error && <SettingsNotice kind="error" onRetry={() => void load()}>{error}</SettingsNotice>}
      {requested && !context && !loading && !error && <SettingsNotice kind="error">{t("请求的上下文不可访问。未切换到其他范围，也不会使用旧配置。", "The requested context is inaccessible. No other scope or old configuration is substituted.")}</SettingsNotice>}
      {context?.lastError && <SettingsNotice kind="error">{context.lastError.message}</SettingsNotice>}
    </section>
    {streamError && <SettingsNotice kind="error" onRetry={() => setStreamVersion(version => version + 1)}>{streamError} {t("新写入已暂停。重新连接只恢复事件并重读权威状态，不丢弃表单草稿或重放写入。", "New writes are paused. Reconnection restores events and rereads authoritative state without discarding form drafts or replaying writes.")}</SettingsNotice>}
    {context && !loading && !error && !busy && !completedBindingId && <CcSwitchManagement key={`${id}:${surfaceVersion}`} context={context} contexts={contexts} onContextChange={select} locale={locale} invoke={invoke} upload={upload} subscribe={subscribe} onDirtyChange={setDirty}>
      <OpenHandsExtensionSurface view={view} onInteractionBlockedChange={setPanelBusy} />
    </CcSwitchManagement>}
  </div>;
}
function ScopedManagement({ view }: { view: "mcp" | "skills" }) {
  const service = usePmService();
  return <Management key={`${service.actor?.id ?? "anonymous"}:${service.actorEpoch}`} view={view} />;
}
export default function ExtensionsPage({ view = "mcp" }: { view?: "mcp" | "skills" }) { return <PmServiceProvider><ScopedManagement view={view} /></PmServiceProvider>; }
export function NativeSkillsPage() { return <ExtensionsPage view="skills" />; }
