import { useEffect, useMemo, useState } from "react";
import { createAutomationIntegrationsClient } from "../../../../../../../../packages/contracts/src/automation-integrations-client.ts";
import type { AutomationIntegrationConnection } from "../../../../../../../../packages/contracts/src/automation-integrations";
import { automationTemplateTags } from "../../../../../../../../packages/automation-resources/catalog.ts";
import type { AutomationCatalogTemplate } from "../../../../../../../../packages/contracts/src/automation-catalog.ts";
import type { StudioCapabilities, StudioConfig } from "../../../../../../../../packages/contracts/src/automation-studio";
import { isPmAutomationTemplateId, pmAutomationArgumentsSchema } from "../../../../../../../../packages/contracts/src/automation-pm.ts";
import { studioConnectionSupportsAction } from "./studio-setup.ts";

/** Metadata read only: opening templates never verifies a connector or invokes MCP. */
export function useStudioConnections(workspaceId: string, projectId?: string) {
  const client = useMemo(() => createAutomationIntegrationsClient({}), []);
  const [connections, setConnections] = useState<AutomationIntegrationConnection[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refreshOnFocus = () => setRevision(value => value + 1);
    window.addEventListener("focus", refreshOnFocus);
    let current = true;
    setConnections([]); setError("");
    if (!projectId) { setLoading(false); return () => window.removeEventListener("focus", refreshOnFocus); }
    setLoading(true);
    void client.list(workspaceId, projectId).then(value => { if (current) setConnections(value.connections); }, (reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "Cannot load integration status"); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; window.removeEventListener("focus", refreshOnFocus); };
  }, [client, workspaceId, projectId, revision]);
  return { connections, error, loading, refresh: () => setRevision(value => value + 1) };
}
export function studioPrerequisites(template: AutomationCatalogTemplate | undefined, connections: AutomationIntegrationConnection[], capabilities: StudioCapabilities | null, action?: StudioConfig["action"]): { id: string; required: boolean; available: boolean; reason: string }[] {
  if (!template) return [];
  const requirements: AutomationCatalogTemplate["requires"]["integrations"] = template.setup?.bundle && action && action.kind !== "template" ? {} : template.requires.integrations;
  const kind = action?.kind ?? (template.setup?.bundle ? "template" : "prompt");
  const dependencies = Object.entries(requirements).map(([id, requirement]) => ({ id, required: requirement.required !== false, available: connections.some(connection => connection.provider === id && studioConnectionSupportsAction(connection, kind)), reason: requirement.message ?? "A verified project integration is required" }));
  if (action?.kind === "template" && isPmAutomationTemplateId(action.templateId)) {
    const args = pmAutomationArgumentsSchema.safeParse(action.arguments);
    const provider = args.success ? args.data.repository?.provider : undefined;
    if (provider) dependencies.push({ id: provider, required: true, available: connections.some(connection => connection.provider === provider && studioConnectionSupportsAction(connection, "template") && action.plugins.some(plugin => plugin.id === `integration:${connection.id}` && plugin.version === String(connection.revision))), reason: "An explicit external source requires its selected, currently verified project API connection and revision. PM-only analysis needs no external connector." });
  } else if (action?.kind === "template") {
    for (const id of automationTemplateTags(template)) if (!dependencies.some(item => item.id === id)) dependencies.push({ id, required: true, available: connections.some(connection => connection.provider === id && studioConnectionSupportsAction(connection, "template")), reason: "Native workflows require independently verified native API access, not MCP presence or source environment tokens" });
  }
  const features = capabilities?.features ?? [];
  const requiredFeatures = action?.kind === "template" ? [`template:${action.templateId}`]
    : template.setup?.bundle ? action?.kind === "script" ? ["customTarball", ...(action.bundleRef?.startsWith("catalog:") ? ["sourceBundleRuntime"] : [])] : ["presetPrompt"]
    : template.requires.features ?? [];
  for (const id of requiredFeatures) {
    const feature = features.find(value => value.id === id);
    dependencies.push({ id, required: true, available: feature?.available === true, reason: feature?.reason ?? "The runtime has not declared this template capability available" });
  }
  return dependencies;
}
