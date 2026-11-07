import React from "react";
import type { ExtensionMcpImportResolution } from "@agent-workspace/contracts/extensions";
import {
  usePreviewMcpImport, useApplyMcpImport, V7Dialog, DialogTitle, DialogDescription,
  APP_DISPLAY_NAME, useUnsavedChangesTracker,
} from "@pm/cc-switch-ui";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { mcpReasonText } from "./management";

export function McpImportPreviewDialog({ onClose, onInteractionBlockedChange }: {
  onClose: () => void;
  onInteractionBlockedChange?: (blocked: boolean) => void;
}) {
  const { t } = useOpenHandsTranslation();
  const preview = usePreviewMcpImport();
  const apply = useApplyMcpImport();
  const [choices, setChoices] = React.useState<Record<string, ExtensionMcpImportResolution>>({});
  const started = React.useRef(false);
  const applyLock = React.useRef(false);
  const busy = preview.isPending || apply.isPending;
  const dirty = !apply.data && Object.values(choices).some(value => value !== "skip");
  const tracker = useUnsavedChangesTracker(!apply.data);
  React.useEffect(() => {
    if (!started.current) { started.current = true; preview.mutate(); }
  }, [preview.mutate]);
  React.useEffect(() => {
    onInteractionBlockedChange?.(busy);
    return () => onInteractionBlockedChange?.(false);
  }, [busy, onInteractionBlockedChange]);
  const close = () => {
    if (!busy && !applyLock.current && (!dirty || window.confirm(t("MCP_PM$DISCARD")))) onClose();
  };
  const submit = () => {
    if (busy || applyLock.current || !preview.data || apply.data || apply.error) return;
    applyLock.current = true;
    apply.mutate({ previewId: preview.data.previewId, selections: preview.data.entries.map(entry => ({
      entryId: entry.entryId, resolution: choices[entry.entryId] ?? "skip",
    })) }, { onSettled: () => { applyLock.current = false; } });
  };
  const error = apply.error ?? preview.error;
  const selectedCount = Object.values(choices).filter(value => value !== "skip").length;
  return <V7Dialog open width={720} className="oh-mcp-import-dialog" onOpenChange={open => { if (!open) close(); }} describedBy="mcp-import-description">
    <DialogTitle>{t("MCP_PM$IMPORT_REVIEW")}</DialogTitle>
    <DialogDescription id="mcp-import-description">{t("MCP_PM$IMPORT_BOUNDARY")}</DialogDescription>
    {busy && <p role="status">{t("MCP_PM$WORKING")}</p>}
    {error && <div role="alert"><p className="oh-mcp-error">{String(error instanceof Error ? error.message : error)}</p><p className="oh-mcp-muted">{t("MCP_PM$IMPORT_RECOVERY")}</p></div>}
    {!apply.data && !!preview.data?.entries.length && <p className="oh-mcp-import-selection" role="status">{t("MCP_PM$IMPORT_SELECTED", { selected: selectedCount, total: preview.data.entries.length })}</p>}
    <div className="oh-mcp-import-list" {...tracker}>
      {preview.data?.warnings.map((warning, index) => <p className="oh-mcp-warning" key={`${warning.app}:${index}`}>{APP_DISPLAY_NAME[warning.app]}: {mcpReasonText(warning.message, t)}</p>)}
      {!apply.data && preview.data?.entries.map(entry => <section className="oh-mcp-import-entry" data-classification={entry.classification} key={entry.entryId}>
        <div className="oh-mcp-section-heading"><strong>{entry.name || entry.serverId}</strong><span className="oh-mcp-badge">{t(`MCP_PM$CLASS_${entry.classification}`)}</span></div>
        <p className="oh-mcp-muted">{APP_DISPLAY_NAME[entry.sourceApp]} · <code>{entry.serverId}</code> · {t(entry.enabled ? "MCP_PM$SOURCE_ENABLED" : "MCP_PM$SOURCE_DISABLED")}</p>
        {entry.conflicts.length > 0 && <ul className="oh-mcp-warning">{entry.conflicts.map(reason => <li key={reason}>{mcpReasonText(reason, t)}</li>)}</ul>}
        <details className="oh-mcp-config-details"><summary>{t("MCP_PM$REVIEW_DEFINITION")}</summary><pre>{JSON.stringify(entry.definition, null, 2)}</pre></details>
        <label>{t("MCP_PM$RESOLUTION")}<select disabled={busy} value={choices[entry.entryId] ?? "skip"} onChange={event => setChoices(previous => ({ ...previous, [entry.entryId]: event.target.value as ExtensionMcpImportResolution }))}>
          {entry.resolutions.map(resolution => <option key={resolution} value={resolution}>{t(resolution === "skip" ? "MCP_PM$SKIP" : resolution === "merge-override" ? "MCP_PM$MERGE_OVERRIDE" : entry.classification === "duplicate" ? "MCP_PM$REGISTER_DUPLICATE" : "MCP_PM$IMPORT_DEFINITION")}</option>)}
        </select></label>
      </section>)}
      {preview.data?.entries.length === 0 && <p>{t("MCP_PM$NO_IMPORT")}</p>}
      {apply.data && <div role="status" className="oh-mcp-import-result"><strong>{t("MCP_PM$IMPORT_RESULT", { applied: apply.data.applied, skipped: apply.data.skipped })}</strong><p>{t("MCP_PM$IMPORT_NO_WRITE")}</p>{apply.data.warnings.map((warning, index) => <p className="oh-mcp-warning" key={`${warning.app}:${index}`}>{APP_DISPLAY_NAME[warning.app]}: {mcpReasonText(warning.message, t)}</p>)}</div>}
    </div>
    <div className="oh-mcp-actions"><button type="button" disabled={busy} onClick={close}>{t("MCP_PM$CLOSE")}</button>{!apply.data && <button type="button" className="oh-mcp-primary" disabled={busy || !preview.data || !dirty || !!apply.error} onClick={submit}>{t("MCP_PM$APPLY_IMPORT")}</button>}</div>
  </V7Dialog>;
}
