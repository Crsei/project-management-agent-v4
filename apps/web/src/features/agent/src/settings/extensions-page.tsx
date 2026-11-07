import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { CcSwitchManagement, type ManagementContext, type ManagementEvent } from "@pm/cc-switch-ui";
import { OpenHandsExtensionSurface, OpenHandsProviderSetupSurface } from "@pm/openhands-extensions";
import { PmServiceProvider, usePmService } from "@/features/pm/service/pm-service";
import { PmLoginPage } from "@/features/pm/service/pm-auth-page";
import { useAgentText } from "../i18n";
import { useI18n } from "@/lib/i18n-provider";
import { ExtensionManagementError, extensionJson, readExtensionEvents, uploadExtensionZip } from "./extensions-api";
import { SettingsNotice, useSettingsGuard } from "./settings-layout";
import McpExternalAccess from "./mcp-external-access";

type RemoteTarget = { providerInstanceId?: string; driver?: string; label: string; app: string; sharedProviderInstanceIds?: string[]; warnings?: string[] };

type LoadedSelection = { scope: string; targets: RemoteTarget[]; providerId?: string; context?: ManagementContext; contexts?: ManagementContext[] };

function Management({ view }: { view: "mcp" | "skills" }) {
  const t = useAgentText();
  const { locale } = useI18n();
  const service = usePmService();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectId = useId();
  const workspaceId = params.get("workspace") ?? "";
  const projectId = params.get("project") ?? "";
  const requestedContext = params.get("context");
  const requestedProvider = params.get("provider");
  const projectScope = !!workspaceId && !!projectId;
  const scopeKey = JSON.stringify([workspaceId, projectId, requestedContext, requestedProvider]);
  const [selection, setSelection] = useState<LoadedSelection>();
  const [loadingScope, setLoadingScope] = useState<string>();
  const [errorState, setErrorState] = useState<{ scope: string; message: string }>();
  const loadSequence = useRef(0);
  const [transportBusy, setTransportBusy] = useState(0);
  const [panelBusy, setPanelBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [streamError, setStreamError] = useState<string>();
  const listeners = useRef(new Set<(event: ManagementEvent) => void>());
  const streamReady = useRef<PromiseWithResolvers<void> | undefined>(undefined);
  const streamFailure = useRef<string | undefined>(undefined);
  streamFailure.current = streamError;
  const live = useRef(true);
  const { setGuard } = useSettingsGuard();
  const current = selection?.scope === scopeKey ? selection : undefined;
  const error = errorState?.scope === scopeKey ? errorState.message : undefined;
  const loading = loadingScope === scopeKey || (!current && !error);
  const context = !loading && !error ? current?.context : undefined;
  const id = context?.id;
  const locked = transportBusy > 0 || panelBusy || dirty;
  useEffect(() => { setGuard(transportBusy > 0 || panelBusy ? "busy" : dirty ? "dirty" : "clean"); }, [transportBusy, panelBusy, dirty, setGuard]);
  useEffect(() => { live.current = true; return () => { live.current = false; ++loadSequence.current; }; }, []);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoadingScope(scopeKey); setErrorState(undefined);
    const resolveLegacyTarget = async (): Promise<LoadedSelection> => {
      const response = await extensionJson<{ targets: RemoteTarget[] }>("/targets");
      const targets = response.targets.filter(target => !!target.providerInstanceId);
      const target = requestedProvider !== null ? targets.find(item => item.providerInstanceId === requestedProvider) : targets[0];
      if (requestedProvider !== null && !target) throw new Error(t("请求的 Agent 不存在或不支持扩展管理；未选择其他 Agent。", "The requested Agent is unavailable or does not support extension management; no other Agent was selected."));
      const providerId = target?.providerInstanceId;
      const resolved = providerId ? await extensionJson<{ context: ManagementContext }>(`/providers/${encodeURIComponent(providerId)}/context`, { method: "POST", body: JSON.stringify({}) }) : undefined;
      return { scope: scopeKey, targets, providerId, context: resolved?.context };
    };
    try {
      let result: LoadedSelection;
      if (requestedContext !== null || (projectScope && requestedProvider === null)) {
        const [native, project] = await Promise.all([
          requestedContext !== null ? extensionJson<{ contexts: ManagementContext[] }>("/contexts") : Promise.resolve({ contexts: [] as ManagementContext[] }),
          projectScope ? extensionJson<{ contexts: ManagementContext[] }>(`/contexts?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(projectId)}`) : Promise.resolve({ contexts: [] as ManagementContext[] }),
        ]);
        const selected = requestedContext !== null
          ? [...native.contexts, ...project.contexts].find(item => item.id === requestedContext)
          : project.contexts.find(item => item.kind === "project");
        if (requestedContext !== null && !selected) throw new Error(t("请求的配置不可访问；未切换到其他目标。", "The requested configuration is inaccessible; no other target was selected."));
        if (requestedProvider !== null && (!selected || !selected.providerInstanceIds.includes(requestedProvider))) throw new Error(t("请求的 Agent 与指定配置不匹配。", "The requested Agent does not match the specified configuration."));
        result = { scope: scopeKey, targets: [], providerId: requestedProvider ?? undefined, context: selected, contexts: [...native.contexts, ...project.contexts] };
      } else if (requestedProvider === null) {
        try {
          const enabled = await extensionJson<{ contexts: ManagementContext[] }>("/contexts/resolve-enabled", { method: "POST", body: JSON.stringify({}) });
          const selected = [...enabled.contexts].sort((left, right) => right.apps.length - left.apps.length)[0];
          result = { scope: scopeKey, targets: [], contexts: enabled.contexts, context: selected };
        } catch (cause) {
          if (!(cause instanceof ExtensionManagementError && (cause.status === 404 || cause.status === 405))) throw cause;
          result = await resolveLegacyTarget();
        }
      } else {
        result = await resolveLegacyTarget();
      }
      if (live.current && sequence === loadSequence.current) setSelection(result);
    } catch (cause) {
      if (live.current && sequence === loadSequence.current) setErrorState({ scope: scopeKey, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (live.current && sequence === loadSequence.current) setLoadingScope(undefined);
    }
  }, [projectScope, workspaceId, projectId, requestedContext, requestedProvider, scopeKey, t]);
  useEffect(() => { if (!projectScope || service.actor) void load(); }, [load, projectScope, service.actor?.id]);

  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    const ready = Promise.withResolvers<void>(); streamReady.current = ready;
    void ready.promise.catch(() => undefined);
    setStreamError(undefined);
    void readExtensionEvents(id, abort.signal, () => {
      ready.resolve();
      if (streamVersion > 0) for (const listener of listeners.current) listener({ event: "reconnected", data: {} });
    }, event => {
      for (const listener of listeners.current) listener(event);
      if (event.event === "changed") {
        setSelection(item => item?.scope === scopeKey && item.context?.id === id ? { ...item, context: { ...item.context, reloadRequired: item.context.kind === "native" || item.context.reloadRequired } } : item);
        window.dispatchEvent(new CustomEvent("agent-native-configuration-changed", { detail: { providerInstanceIds: context?.providerInstanceIds ?? [] } }));
      } else if (event.event === "operation" && event.data && typeof event.data === "object" && "state" in event.data && event.data.state === "completed") {
        setSelection(item => item?.scope === scopeKey && item.context?.id === id && item.context.status !== "failed" ? { ...item, context: { ...item.context, lastError: undefined } } : item);
      } else if (event.event === "status" && event.data && typeof event.data === "object" && "status" in event.data && ["stopped", "starting", "ready", "failed"].includes(String(event.data.status))) {
        const value = event.data as Partial<ManagementContext> & { error?: ManagementContext["lastError"] };
        setSelection(item => item?.scope === scopeKey && item.context?.id === id ? { ...item, context: { ...item.context, status: value.status!, lastError: value.error ?? value.lastError, reloadRequired: value.reloadRequired ?? item.context.reloadRequired } } : item);
      }
    }).catch(cause => {
      ready.reject(cause);
      if (!abort.signal.aborted) setStreamError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { abort.abort(); ready.reject(new Error("Management target changed.")); if (streamReady.current === ready) streamReady.current = undefined; };
  }, [id, scopeKey, streamVersion]);
  const subscribe = useCallback((listener: (event: ManagementEvent) => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }, []);
  const invoke = useCallback(async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (!id) throw new Error("Choose an Agent or project configuration.");
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
    if (!id) throw new Error("Choose an Agent or project configuration before uploading.");
    setTransportBusy(count => count + 1); setGuard("busy");
    try {
      if (streamFailure.current) throw new Error(streamFailure.current);
      if (!streamReady.current) throw new Error("The management event stream is not connected.");
      await streamReady.current.promise;
      return await uploadExtensionZip(id, file);
    } finally { setTransportBusy(count => count - 1); }
  }, [id, setGuard]);
  const selectProvider = (providerId: string) => {
    if (locked || loading || !current?.targets.some(target => target.providerInstanceId === providerId)) return;
    const next = new URLSearchParams(params);
    next.set("provider", providerId); next.delete("context");
    setParams(next);
  };
  const selectContext = (contextId: string) => {
    if (locked || loading || !current?.contexts?.some(context => context.id === contextId)) return;
    const next = new URLSearchParams(params);
    next.set("context", contextId); next.delete("provider");
    setParams(next);
  };
  if (projectScope && !service.actor) return <PmLoginPage />;
  return <div className="settings-extensions-page">
    <section className="settings-extension-context" aria-label={t("扩展配置目标", "Extension configuration target")}>
      {(!projectScope || requestedProvider !== null) && current && current.contexts && current.contexts.length > 1 && <div className="settings-extension-context-controls">
        <label htmlFor={selectId}><span>{t("配置目标", "Configuration target")}</span><select id={selectId} value={context?.id ?? ""} disabled={locked || loading} onChange={event => selectContext(event.target.value)}>{current.contexts.map(item => <option key={item.id} value={item.id}>{item.label} · {item.apps.length} {t("个目标", "targets")}</option>)}</select></label>
      </div>}
      {requestedContext === null && (!projectScope || requestedProvider !== null) && current && !current.contexts && current.targets.length > 1 && <div className="settings-extension-context-controls">
        <label htmlFor={selectId}><span>{t("配置目标", "Configuration target")}</span><select id={selectId} value={current.providerId ?? ""} disabled={locked || loading} onChange={event => selectProvider(event.target.value)}>{current.targets.map(item => <option key={item.providerInstanceId} value={item.providerInstanceId}>{item.label} · {item.driver ?? item.app} · {item.providerInstanceId}</option>)}</select></label>
      </div>}
      {locked && <p className="settings-extension-scope-note" role="status">{dirty ? t("请先保存或取消当前草稿，再切换 Agent。", "Save or cancel the current draft before switching Agents.") : t("请等待当前操作完成后再切换 Agent。", "Wait for the current operation before switching Agents.")}</p>}
      {loading && <SettingsNotice kind="loading">{t("正在读取配置…", "Loading configuration…")}</SettingsNotice>}
      {error && <SettingsNotice kind="error" onRetry={() => void load()}>{error}</SettingsNotice>}
      {context?.lastError && <SettingsNotice kind="error">{context.lastError.message}</SettingsNotice>}
    </section>
    {!loading && !error && requestedContext === null && requestedProvider === null && !projectScope && current && !current.context && current.targets.length === 0 && <OpenHandsProviderSetupSurface view={view} locale={locale} onConfigureProvider={() => navigate("/agent/settings/providers")} />}
    {context && streamError && <SettingsNotice kind="error" onRetry={() => setStreamVersion(version => version + 1)}>{streamError}</SettingsNotice>}
    {context && <CcSwitchManagement key={`${scopeKey}:${id}`} context={context} contexts={[context]} locale={locale} invoke={invoke} upload={upload} subscribe={subscribe} onDirtyChange={setDirty}>
      <OpenHandsExtensionSurface view={view} onInteractionBlockedChange={setPanelBusy} />
    </CcSwitchManagement>}
  </div>;
}
function ScopedManagement({ view }: { view: "mcp" | "skills" }) {
  const service = usePmService();
  return <Management key={`${service.actor?.id ?? "anonymous"}:${service.actorEpoch}`} view={view} />;
}
export default function ExtensionsPage({ view = "mcp" }: { view?: "mcp" | "skills" }) {
  const t = useAgentText();
  const location = useLocation();
  const [params] = useSearchParams();
  const external = view === "mcp" && params.get("section") === "external";
  const sectionLink = (section: "servers" | "external") => {
    const next = new URLSearchParams(params);
    if (section === "external") next.set("section", section);
    else next.delete("section");
    return { pathname: location.pathname, search: next.toString() };
  };
  return <PmServiceProvider>
    {view === "mcp" && <nav className="settings-mcp-navigation" aria-label={t("MCP 设置分区", "MCP settings sections")}>
      <Link to={sectionLink("servers")} state={location.state} aria-current={!external ? "page" : undefined}>{t("MCP 服务器", "MCP servers")}</Link>
      <Link to={sectionLink("external")} state={location.state} aria-current={external ? "page" : undefined}>{t("外部访问", "External access")}</Link>
    </nav>}
    {external ? <McpExternalAccess /> : <ScopedManagement view={view} />}
  </PmServiceProvider>;
}
export function NativeSkillsPage() { return <ExtensionsPage view="skills" />; }
