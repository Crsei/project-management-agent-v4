import React from "react";
import type { IntegrationCatalogEntry as MarketplaceEntry, MarketplaceField } from "@openhands/extensions/integrations";
import { McpLogoBadge } from "@pm/openhands-source/components/features/mcp-logo-badge";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { getInstallableMcpConnectionOptions, type McpMarketplaceConnectionOption } from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { toMcpServerName } from "@pm/openhands-source/utils/mcp-server-name";
import type { MCPServerConfig } from "@pm/openhands-source/types/mcp-server";
import { useSaveMcpDefinition } from "@pm/cc-switch-source/hooks/useMcp";
import { uniqueId } from "@pm/cc-switch-source/components/mcp/mcpDraft";
import { V7Dialog } from "@pm/cc-switch-source/components/mcp/formBits";
import { DialogTitle, DialogDescription } from "@pm/cc-switch-source/components/ui/dialog";
import { useUnsavedChangesTracker } from "@pm/cc-switch-source/lib/unsavedChanges";
import { webPlatform } from "@pm/openhands-source/web/bridge";

/** Source helper text keeps safe documentation links, never javascript/data URLs. */
function renderHelperText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index));
    parts.push(<a key={match.index} href={/^https?:\/\//i.test(match[2]) ? match[2] : "#"} target="_blank" rel="noreferrer">{match[1]}</a>);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function initialValues(option?: McpMarketplaceConnectionOption): Record<string, string> {
  const template = option?.transport;
  if (!template) return {};
  const fields = template.kind === "stdio" ? [...(template.envFields ?? []), ...(template.argFields ?? [])] : template.headerFields ?? [];
  return { ...Object.fromEntries(fields.map(field => [field.key, ""])), ...(template.kind !== "stdio" ? { url: template.url } : {}) };
}

function unavailableReason(option: McpMarketplaceConnectionOption, project: boolean): string | null {
  if (option.auth.strategy === "oauth2") return "MCP_PM$OAUTH_UNAVAILABLE";
  if (option.auth.strategy === "basic") return "MCP_PM$BASIC_UNAVAILABLE";
  if (project && option.transport.kind !== "shttp") return "MCP_PM$PROJECT_TRANSPORT";
  return null;
}

interface InstallServerModalProps {
  entry: MarketplaceEntry;
  existingServers: MCPServerConfig[];
  onClose: () => void;
  onSuccess?: (entry: MarketplaceEntry) => void;
  onInteractionBlockedChange?: (blocked: boolean) => void;
}

/** Adapted OpenHands add-only catalog form. Its field/template rules are retained;
 * persistence is CC Switch, without source cloud auth, secret store, or implicit probes. */
export function InstallServerModal({ entry, existingServers, onClose, onSuccess, onInteractionBlockedChange }: InstallServerModalProps) {
  const { t } = useOpenHandsTranslation();
  const project = webPlatform().context.kind === "project";
  const options = React.useMemo(() => getInstallableMcpConnectionOptions(entry), [entry]);
  const [selectedOptionIndex, setSelectedOptionIndex] = React.useState(() => Math.max(0, options.findIndex(candidate => !unavailableReason(candidate, project))));
  const option = options[selectedOptionIndex];
  const template = option?.transport;
  const [drafts, setDrafts] = React.useState<Record<string, Record<string, string>>>({});
  const values = drafts[option?.id ?? ""] ?? initialValues(option);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [globalError, setGlobalError] = React.useState<string | null>(null);
  const save = useSaveMcpDefinition();
  const lock = React.useRef(false);
  const tracker = useUnsavedChangesTracker();
  const dirty = Object.keys(drafts).length > 0;
  const reason = option ? unavailableReason(option, project) : "MCP_PM$NO_CONNECTION_OPTION";
  React.useEffect(() => {
    onInteractionBlockedChange?.(save.isPending);
    return () => onInteractionBlockedChange?.(false);
  }, [save.isPending, onInteractionBlockedChange]);
  const close = () => { if (!lock.current && (!dirty || window.confirm(t("MCP_PM$DISCARD")))) onClose(); };
  const setValue = (key: string, value: string) => {
    if (lock.current || !option) return;
    setDrafts(previous => ({ ...previous, [option.id]: { ...values, [key]: value } }));
    setErrors(previous => ({ ...previous, [key]: "" }));
    setGlobalError(null);
  };
  const fields: MarketplaceField[] = template?.kind === "stdio" ? [...(template.envFields ?? []), ...(template.argFields ?? [])] : template?.headerFields ?? [];
  const needsCredential = !!option && ["api_key", "bearer"].includes(option.auth.strategy) && template?.kind !== "stdio";
  const credentialOptional = option?.auth.apiKeyOptional ?? (template && template.kind !== "stdio" ? template.apiKeyOptional : false) ?? false;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || reason || !template || !option) return;
    const nextErrors: Record<string, string> = {};
    for (const field of fields) if (field.required && !(values[field.key] ?? "").trim()) nextErrors[field.key] = t("MCP$ERROR_FIELD_REQUIRED");
    const apiKey = values.api_key?.trim() ?? "";
    if (needsCredential && !credentialOptional && !apiKey) nextErrors.api_key = t("MCP$ERROR_FIELD_REQUIRED");
    const url = template.kind !== "stdio" ? (template.urlEditable ? values.url?.trim() ?? "" : template.url) : "";
    if (template.kind !== "stdio") {
      try { if (!["http:", "https:"].includes(new URL(url).protocol)) nextErrors.url = t("SETTINGS$MCP_ERROR_URL_INVALID_PROTOCOL"); }
      catch { nextErrors.url = t("SETTINGS$MCP_ERROR_URL_INVALID"); }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    let server: Record<string, unknown>;
    if (template.kind === "stdio") {
      const env = Object.fromEntries((template.envFields ?? []).map(field => [field.key, values[field.key]?.trim() ?? ""]).filter(([, value]) => value));
      // OpenHands argFields intentionally split whitespace into appended CLI tokens.
      const extraArgs = (template.argFields ?? []).flatMap(field => (values[field.key]?.trim() ?? "").split(/\s+/).filter(Boolean));
      server = { type: "stdio", command: template.command, args: [...template.args, ...extraArgs], ...(Object.keys(env).length ? { env } : {}) };
    } else {
      const headers = Object.fromEntries((template.headerFields ?? []).map(field => [field.key, values[field.key]?.trim() ?? ""]).filter(([, value]) => value));
      if (needsCredential && apiKey) headers[option.auth.strategy === "api_key" ? option.auth.apiKeyHeaderName ?? "Authorization" : "Authorization"] = option.auth.strategy === "api_key" && option.auth.apiKeyHeaderName ? apiKey : `Bearer ${apiKey}`;
      server = { type: template.kind === "shttp" ? "http" : "sse", url, ...(Object.keys(headers).length ? { headers } : {}) };
    }
    const id = uniqueId(toMcpServerName(template.kind === "stdio" ? template.serverName : entry.id), existingServers.map(server => server.id));
    lock.current = true;
    try {
      await save.mutateAsync({ id, name: entry.name, description: entry.description, docs: entry.docsUrl, ...(entry.appUrl ? { homepage: entry.appUrl } : {}), ...(entry.categories ? { tags: entry.categories } : {}), server });
      onSuccess?.(entry);
      onClose();
    } catch (error) { setGlobalError(error instanceof Error ? error.message : String(error)); }
    finally { lock.current = false; }
  };
  const renderField = (field: MarketplaceField) => <label key={field.key}>{t(`MCP_PM$FIELD_${field.key}`, { defaultValue: field.label })}{!field.required && ` (${t("MCP_PM$OPTIONAL")})`}<input type={field.type === "password" ? "password" : "text"} autoComplete="off" value={values[field.key] ?? ""} onChange={event => setValue(field.key, event.target.value)} placeholder={field.placeholder} required={field.required} disabled={save.isPending || !!reason} data-testid={`mcp-install-field-${field.key}`} />{field.helperText && <small>{renderHelperText(field.helperText)}</small>}{errors[field.key] && <small className="oh-mcp-error">{errors[field.key]}</small>}</label>;
  return <V7Dialog open width={580} className="oh-mcp-install-dialog" onOpenChange={open => { if (!open) close(); }} describedBy="mcp-install-description">
    <form onSubmit={event => void submit(event)} className="oh-mcp-form" data-testid="mcp-install-modal" data-marketplace-id={entry.id} {...tracker}>
      <div className="oh-mcp-heading"><McpLogoBadge entry={entry} /><DialogTitle>{entry.name}</DialogTitle></div>
      <DialogDescription id="mcp-install-description">{entry.description}</DialogDescription>
      {entry.installHint && <p>{entry.installHint}</p>}
      {/^https?:\/\//i.test(entry.docsUrl) && <a href={entry.docsUrl} target="_blank" rel="noreferrer">{t("MCP$VIEW_DOCS")}</a>}
      <fieldset className="oh-mcp-connection-options" data-unsaved-ignore><legend>{t("MCP$CONNECTION_METHOD")}</legend><div className="oh-mcp-options">{options.map((candidate, index) => {
        const unavailable = unavailableReason(candidate, project);
        const authLabel = candidate.auth.strategy === "oauth2" ? "MCP$OPTION_OAUTH" : candidate.auth.strategy === "api_key" || candidate.auth.strategy === "bearer" ? "MCP$OPTION_API_KEY" : candidate.auth.strategy === "basic" ? "MCP_PM$AUTH_BASIC" : candidate.transport.kind !== "stdio" && candidate.transport.headerFields?.length ? "SETTINGS$MCP_HEADERS" : "MCP_PM$AUTH_NONE";
        return <div key={candidate.id}><button type="button" disabled={save.isPending || !!unavailable} aria-pressed={selectedOptionIndex === index} onClick={() => { setSelectedOptionIndex(index); setErrors({}); setGlobalError(null); }} title={unavailable ? t(unavailable) : undefined}>{candidate.transport.kind === "shttp" ? "HTTP" : candidate.transport.kind.toUpperCase()} · {t(authLabel)}{unavailable ? ` · ${t("MCP_PM$UNAVAILABLE")}` : ""}</button>{unavailable && <small className="oh-mcp-option-reason">{t(unavailable)}</small>}</div>;
      })}</div></fieldset>
      {reason && <p className="oh-mcp-warning" role="note">{t(reason)}</p>}
      {template?.kind === "stdio" ? <label>{t("MCP$COMMAND_LABEL")}<input readOnly value={`${template.command} ${template.args.join(" ")}`} /></label> : template && <label>{t("SETTINGS$MCP_URL")}<input type="url" value={values.url ?? template.url} readOnly={!template.urlEditable} disabled={save.isPending || !!reason} onChange={event => setValue("url", event.target.value)} />{errors.url && <small className="oh-mcp-error">{errors.url}</small>}</label>}
      {fields.map(renderField)}
      {needsCredential && renderField({ key: "api_key", label: t(`MCP_PM$CREDENTIAL_${entry.id}`, { defaultValue: option.auth.credentialLabel ?? t("SETTINGS$MCP_API_KEY") }), type: "password", required: !credentialOptional, placeholder: option.auth.credentialPlaceholder, helperText: option.auth.credentialHelp })}
      <p className="oh-mcp-muted">{t("MCP_PM$INSTALL_BOUNDARY")}</p>
      {globalError && <p role="alert" className="oh-mcp-error">{globalError}</p>}
      <div className="oh-mcp-actions"><button type="button" disabled={save.isPending} onClick={close}>{t("BUTTON$CANCEL")}</button><button type="submit" className="oh-mcp-primary" disabled={save.isPending || !!reason}>{save.isPending ? t("SETTINGS$SAVING") : t("MCP$INSTALL_BUTTON")}</button></div>
    </form>
  </V7Dialog>;
}
