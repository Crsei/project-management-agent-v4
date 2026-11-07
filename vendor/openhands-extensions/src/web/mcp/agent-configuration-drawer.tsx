import React from "react";
import type { ExtensionAppId, ExtensionMcpAgentConfiguration, ExtensionMcpDefinition, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import {
  MCP_APP_IDS, APP_DISPLAY_NAME, Sheet, SheetContent, SheetHeader, SheetTitle,
  SheetBody, useSetMcpAgentConfiguration, useDeleteMcpServer,
  useResyncMcpToApps, useUnsavedChangesTracker, type McpConnectivity,
} from "@pm/cc-switch-ui";
import { webPlatform } from "@pm/openhands-source/web/bridge";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { mcpReasonText } from "./management";

const json = (value: unknown) => JSON.stringify(value, null, 2) ?? "";

function AgentDraft({ row, busy, onSave, onDirtyChange }: {
  row: ExtensionMcpAgentConfiguration;
  busy: boolean;
  onSave: (enabled: boolean, override: Record<string, unknown> | null) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useOpenHandsTranslation();
  const [enabled, setEnabled] = React.useState(row.enabled);
  const [text, setText] = React.useState(json(row.override));
  const [error, setError] = React.useState<string | null>(null);
  const [baseline, setBaseline] = React.useState({ enabled: row.enabled, text: json(row.override) });
  const dirty = enabled !== baseline.enabled || text !== baseline.text;
  const tracker = useUnsavedChangesTracker();
  React.useEffect(() => {
    if (!dirty) {
      const next = { enabled: row.enabled, text: json(row.override) };
      setEnabled(next.enabled); setText(next.text); setBaseline(next);
    }
  }, [row.enabled, row.override, dirty]);
  React.useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const save = async () => {
    if (busy || !dirty) return;
    let override: unknown;
    try {
      override = JSON.parse(text);
      if (override !== null && (typeof override !== "object" || Array.isArray(override))) throw new Error(t("MCP_PM$OVERRIDE_INVALID"));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return; }
    setError(null);
    await onSave(enabled, override as Record<string, unknown> | null);
  };
  return <div className="oh-mcp-form" {...tracker}>
    <label className="oh-mcp-checkbox oh-mcp-assignment"><input type="checkbox" checked={enabled} disabled={busy || (!row.compatibility.supported && !row.enabled)} onChange={event => setEnabled(event.target.checked)} />{t("MCP_PM$ASSIGN_AGENT")}</label>
    <p className={row.compatibility.supported ? "oh-mcp-compatible" : "oh-mcp-warning"}>{row.compatibility.supported ? t("MCP_PM$COMPATIBLE") : t("MCP_PM$INCOMPATIBLE", { reason: row.compatibility.reason ? mcpReasonText(row.compatibility.reason, t) : t("MCP_PM$NO_SUPPORTED_CONFIG") })}</p>
    <div className="oh-mcp-saved-states"><span className="oh-mcp-badge">{t(row.override === null ? "MCP_PM$INHERITED" : "MCP_PM$OVERRIDE_SAVED")}</span><span className="oh-mcp-badge" data-sync-state={row.sync.state}>{t("MCP_PM$SYNC_LABEL", { state: t(`MCP_PM$SYNC_${row.sync.state}`) })}</span></div>
    {row.sync.reason && <p className="oh-mcp-warning">{mcpReasonText(row.sync.reason, t)}</p>}
    <label>{t("MCP_PM$MERGE_PATCH")}<textarea aria-label={t("MCP_PM$MERGE_PATCH")} spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setError(null); }} rows={8} /></label>
    <div className="oh-mcp-actions"><button type="button" disabled={busy || text === "null"} data-unsaved-edit onClick={() => setText("null")}>{t("MCP_PM$RESTORE_INHERITANCE")}</button><button type="button" className="oh-mcp-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t("SETTINGS$SAVING") : t("MCP_PM$SAVE_AGENT")}</button></div>
    {dirty && <p className="oh-mcp-warning" role="status">{t("MCP_PM$UNSAVED_AGENT")}</p>}
    {error && <p role="alert" className="oh-mcp-error">{error}</p>}
    <details className="oh-mcp-config-details"><summary>{t("MCP_PM$SAVED_EFFECTIVE")}</summary><pre>{json(row.effective)}</pre></details>
  </div>;
}

export function AgentConfigurationDrawer({ definition, definitionAvailable, management, probe, onClose, onEditDefinition, onInteractionBlockedChange }: {
  definition: ExtensionMcpDefinition;
  definitionAvailable: boolean;
  management: ExtensionMcpManagement;
  probe: McpConnectivity;
  onClose: () => void;
  onEditDefinition: () => void;
  onInteractionBlockedChange?: (blocked: boolean) => void;
}) {
  const { t } = useOpenHandsTranslation();
  const platform = webPlatform();
  const context = platform.context;
  const currentRows = management.agentConfigurations[definition.id] ?? {};
  const retainedRows = React.useRef(currentRows);
  if (definitionAvailable) retainedRows.current = currentRows;
  const rows = definitionAvailable ? currentRows : retainedRows.current;
  const [selectedApp, setSelectedApp] = React.useState<ExtensionAppId | null>(management.boundApps[0] ?? null);
  const [dirtyApps, setDirtyApps] = React.useState<Partial<Record<ExtensionAppId, boolean>>>({});
  const [revisions, setRevisions] = React.useState<Partial<Record<ExtensionAppId, number>>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [syncReport, setSyncReport] = React.useState<string | null>(null);
  const setConfiguration = useSetMcpAgentConfiguration();
  const remove = useDeleteMcpServer();
  const resync = useResyncMcpToApps();
  const lock = React.useRef(false);
  const busy = setConfiguration.isPending || remove.isPending || resync.isPending || probe.checking;
  const dirty = Object.values(dirtyApps).some(Boolean);
  const dirtyCallbacks = React.useMemo(() => Object.fromEntries(MCP_APP_IDS.map(app => [app, (value: boolean) => setDirtyApps(previous => previous[app] === value ? previous : { ...previous, [app]: value })])) as Record<ExtensionAppId, (dirty: boolean) => void>, []);
  React.useEffect(() => { onInteractionBlockedChange?.(busy); return () => onInteractionBlockedChange?.(false); }, [busy, onInteractionBlockedChange]);
  React.useEffect(() => {
    if (!selectedApp || !management.boundApps.includes(selectedApp)) setSelectedApp(management.boundApps[0] ?? null);
  }, [management.boundApps, selectedApp]);
  const allowDiscard = () => !dirty || window.confirm(t("MCP_PM$DISCARD"));
  const close = () => { if (!lock.current && !busy && allowDiscard()) onClose(); };
  const saveAgent = async (app: ExtensionAppId, enabled: boolean, override: Record<string, unknown> | null) => {
    if (lock.current || busy) return false;
    lock.current = true; setFailure(null); setSyncReport(null);
    try {
      await setConfiguration.mutateAsync({ serverId: definition.id, app, enabled, override });
      setRevisions(previous => ({ ...previous, [app]: (previous[app] ?? 0) + 1 }));
      return true;
    } catch (error) { setFailure(`${error instanceof Error ? error.message : String(error)} · ${t("MCP_PM$SAVE_PARTIAL")}`); return false; }
    finally { lock.current = false; }
  };
  const sync = async () => {
    if (lock.current || busy || dirty || !selectedApp || !management.boundApps.includes(selectedApp)) return;
    lock.current = true; setFailure(null);
    try {
      const results = await resync.mutateAsync([selectedApp]);
      setSyncReport(results.map(result => `${APP_DISPLAY_NAME[result.app]}: ${result.ok ? t("MCP_PM$RESYNC_OK") : result.error ? mcpReasonText(result.error, t) : t("MCP_PM$RESYNC_FAILED")}`).join("\n"));
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { lock.current = false; }
  };
  const deleteDefinition = async () => {
    if (lock.current || busy || !allowDiscard() || !window.confirm(t("MCP_PM$REMOVE_CONFIRM", { name: definition.name }))) return;
    lock.current = true; setFailure(null);
    try { await remove.mutateAsync(definition.id); onClose(); }
    catch (error) { setFailure(`${error instanceof Error ? error.message : String(error)} · ${t("MCP_PM$DELETE_PARTIAL")}`); }
    finally { lock.current = false; }
  };
  const studioUrl = context.scope ? `/agent/automations/integrations?workspace=${encodeURIComponent(context.scope.workspaceId)}&project=${encodeURIComponent(context.scope.projectId)}` : undefined;
  return <Sheet open modal={false} onOpenChange={open => { if (!open) close(); }}><SheetContent width={620} closeLabel={t("MCP_PM$CLOSE")} className="oh-mcp-drawer" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
    <SheetHeader><SheetTitle>{definition.name || definition.id}</SheetTitle></SheetHeader>
    <SheetBody className="oh-mcp-form">
      {!definitionAvailable && <p role="alert" className="oh-mcp-warning">{t("MCP_PM$STALE_DEFINITION")}</p>}
      <fieldset disabled={!definitionAvailable} className="oh-mcp-form">
        <section className="oh-mcp-drawer-section oh-mcp-shared-section" aria-labelledby="mcp-shared-heading">
          <div className="oh-mcp-section-heading"><h3 id="mcp-shared-heading">{t("MCP_PM$SHARED_DEFINITION")}</h3><span className="oh-mcp-badge">{t(definitionAvailable ? "MCP_PM$LIBRARY_SAVED" : "MCP_PM$LIBRARY_REMOVED")}</span></div>
          <p className="oh-mcp-muted"><code>{definition.id}</code> · {definition.server.type === "sse" ? "SSE" : definition.server.type === "stdio" || typeof definition.server.command === "string" ? "STDIO" : "HTTP"}</p>
          {definition.description && <p className="oh-mcp-definition-description">{definition.description}</p>}
          <details className="oh-mcp-config-details"><summary>{t("MCP_PM$REVIEW_DEFINITION")}</summary><pre>{json(definition.server)}</pre></details>
          <div className="oh-mcp-actions"><button type="button" disabled={busy || dirty} onClick={onEditDefinition}>{t("MCP_PM$EDIT_SHARED")}</button><button type="button" className="oh-mcp-danger" disabled={busy} onClick={() => void deleteDefinition()}>{t("MCP_PM$REMOVE")}</button></div>
        </section>
        {context.kind === "project" ? <section className="oh-mcp-drawer-section"><h3>{t("MCP_PM$PROJECT_AUTHORIZATION")}</h3><p>{t("MCP_PM$PROJECT_NOTE")}</p>{studioUrl && <a href={studioUrl}>{t("MCP_PM$STUDIO_LINK")}</a>}</section> : <section className="oh-mcp-drawer-section oh-mcp-agent-section" aria-labelledby="mcp-agent-heading">
          <div><h3 id="mcp-agent-heading">{t("MCP_PM$AGENT_CONFIGURATIONS")}</h3><p className="oh-mcp-muted">{context.label}</p></div>
          <div className="oh-mcp-target-picker" role="group" aria-label={t("MCP_PM$AGENT")}>{management.boundApps.map(app => <button key={app} type="button" data-unsaved-ignore aria-pressed={selectedApp === app} disabled={busy} onClick={() => setSelectedApp(app)}>{APP_DISPLAY_NAME[app]}{dirtyApps[app] ? ` · ${t("MCP_PM$UNSAVED")}` : ""}</button>)}</div>
          {!management.boundApps.length && <p className="oh-mcp-warning">{t("MCP_PM$MATRIX_NO_TARGETS")}</p>}
          {selectedApp === "pi" && <p className="oh-mcp-warning">{t("MCP_PM$PI_NOTE")}</p>}
          {selectedApp === "omp" && <p className="oh-mcp-warning">{t("MCP_PM$OMP_NOTE")}</p>}
          {management.boundApps.map(app => <div key={app} hidden={selectedApp !== app}>{rows[app] ? <AgentDraft key={`${app}:${revisions[app] ?? 0}`} row={rows[app]!} busy={busy} onSave={(enabled, override) => saveAgent(app, enabled, override)} onDirtyChange={dirtyCallbacks[app]} /> : <p className="oh-mcp-warning">{t("MCP_PM$MISSING_AGENT", { agent: APP_DISPLAY_NAME[app] })}</p>}</div>)}
          <div className="oh-mcp-actions"><button type="button" disabled={busy || dirty || !selectedApp || !rows[selectedApp] || !management.boundApps.includes(selectedApp)} onClick={() => void sync()}>{t("MCP_PM$RESYNC_AGENT")}</button></div>
        </section>}
        {context.kind !== "project" && <section className="oh-mcp-drawer-section oh-mcp-probe-section">
          <h3>{t("MCP_PM$EXPLICIT_PROBE")}</h3>
          <p role="status" className="oh-mcp-probe-status" data-probe-state={probe.states[definition.id] ?? "unavailable"}>{t("MCP_PM$PROBE_LABEL", { state: t(`MCP_PM$PROBE_${probe.states[definition.id] ?? "unavailable"}`) })}</p>
          <div className="oh-mcp-actions"><button type="button" disabled={busy || dirty || !(definition.id in probe.states)} title={!(definition.id in probe.states) ? t("MCP_PM$ASSIGN_TO_PROBE") : undefined} onClick={() => probe.checkServer(definition.id)}>{t("MCP_PM$TEST_SHARED")}</button>{probe.checking && <button type="button" onClick={probe.cancelAll}>{t("MCP_PM$CANCEL_PROBE")}</button>}</div>
        </section>}
        <details className="oh-mcp-context-details"><summary>{t("MCP_PM$AUTHORIZED_CONTEXT")}</summary><div className="oh-mcp-form">
          {platform.contexts && platform.selectContext ? <label>{t("MCP_PM$CONTEXT")}<select data-unsaved-ignore value={context.id} disabled={busy} onChange={event => { setFailure(null); void platform.selectContext!(event.target.value).then(changed => { if (!changed) setFailure(t("MCP_PM$CONTEXT_BLOCKED")); }).catch(error => setFailure(error instanceof Error ? error.message : String(error))); }}>{platform.contexts.map(item => <option key={item.id} value={item.id}>{item.label} · {t(`MCP_PM$CONTEXT_${item.kind}`)}</option>)}</select></label> : <p>{context.label} · {t(`MCP_PM$CONTEXT_${context.kind}`)}</p>}
          {context.sharedProviderInstanceIds.length > 0 && <p className="oh-mcp-warning">{t("MCP_PM$SHARED_ROOT", { instances: context.sharedProviderInstanceIds.join(", ") })}</p>}
        </div></details>
        {context.reloadRequired && <p className="oh-mcp-warning" role="status">{t("MCP_PM$RELOAD_REQUIRED")}</p>}
        {syncReport && <p role="status" className="oh-mcp-prewrap">{t("MCP_PM$RESYNC_REPORT")}{"\n"}{syncReport}</p>}
        {failure && <p role="alert" className="oh-mcp-error">{failure}</p>}
      </fieldset>
    </SheetBody>
  </SheetContent></Sheet>;
}
