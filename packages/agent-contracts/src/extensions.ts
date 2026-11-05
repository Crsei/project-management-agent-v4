import { z } from "zod";

export const extensionAppIds = ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes", "pi", "mcode", "kimi", "dsh", "agy", "omp"] as const;
export type ExtensionAppId = (typeof extensionAppIds)[number];
export const extensionProjectScopeSchema = z.strictObject({ actorId: z.uuid(), workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/) });
export type ExtensionProjectScope = z.infer<typeof extensionProjectScopeSchema>;
export type ExtensionFailure = { code: string; message: string };
export type ExtensionContext = {
  id: string;
  label: string;
  kind: "native" | "project";
  apps: ExtensionAppId[];
  providerInstanceIds: string[];
  sharedProviderInstanceIds: string[];
  scope?: { workspaceId: string; projectId: string };
  status: "stopped" | "starting" | "ready" | "failed";
  lastError?: ExtensionFailure;
  reloadRequired: boolean;
  externalTargetIds: string[];
  warnings: string[];
  unifiedStorageOwned: boolean;
};
export type ExtensionEvent = {
  event: "mcp-connectivity" | "operation" | "changed" | "status" | "warning";
  data: unknown;
  requestId?: string;
};
export const extensionInvokeSchema = z.strictObject({ command: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).default({}) });
export const extensionBindSchema = z.strictObject({ providerInstanceIds: z.array(z.string().min(1).max(200)).max(12).default([]), externalTargetIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(12).default([]), confirmed: z.literal(true) }).refine(value => value.providerInstanceIds.length + value.externalTargetIds.length > 0, "Select at least one native target");
export type ExtensionDefinitionReference = { contextId: string; serverId: string; name: string; configFingerprint: string; transport: "streamable-http" };
export type ResolvedExtensionDefinition = Omit<ExtensionDefinitionReference, "name"> & { endpoint: string; headers: Record<string, string> };
export type ExtensionDirectory = { label: string; entries: Array<{ name: string; kind: "file" | "directory"; size?: number }> };

/** Shared library metadata; assignment authority belongs to agentConfigurations, never a definition. */
export type ExtensionMcpDefinition = {
  id: string;
  name: string;
  server: Record<string, unknown>;
  description?: string;
  homepage?: string;
  docs?: string;
  tags?: string[];
};
export type ExtensionMcpAgentConfiguration = {
  serverId: string;
  app: ExtensionAppId;
  enabled: boolean;
  override: Record<string, unknown> | null;
  effective: Record<string, unknown>;
  compatibility: { supported: boolean; reason: string | null };
  sync: { state: "unassigned" | "synced" | "pending" | "error" | "unavailable"; reason: string | null };
};
export type ExtensionMcpManagement = {
  definitions: Record<string, ExtensionMcpDefinition>;
  agentConfigurations: Record<string, Partial<Record<ExtensionAppId, ExtensionMcpAgentConfiguration>>>;
  boundApps: ExtensionAppId[];
};
export type ExtensionMcpImportResolution = "import" | "merge-override" | "skip";
export type ExtensionMcpImportEntry = {
  entryId: string;
  sourceApp: ExtensionAppId;
  serverId: string;
  name: string;
  definition: ExtensionMcpDefinition;
  enabled: boolean;
  classification: "new" | "duplicate" | "conflict";
  conflicts: string[];
  resolutions: ExtensionMcpImportResolution[];
};
export type ExtensionMcpImportWarning = { app: ExtensionAppId; message: string };
export type ExtensionMcpImportPreview = {
  previewId: string;
  entries: ExtensionMcpImportEntry[];
  warnings: ExtensionMcpImportWarning[];
};
export type ExtensionMcpImportSelection = { entryId: string; resolution: ExtensionMcpImportResolution };
export type ExtensionMcpImportResult = { applied: number; skipped: number; warnings: ExtensionMcpImportWarning[] };
export type ExtensionMcpCommands = {
  get_mcp_management: { args: Record<string, never>; result: ExtensionMcpManagement };
  save_mcp_definition: { args: { definition: ExtensionMcpDefinition }; result: null };
  set_mcp_agent_configuration: { args: { serverId: string; app: ExtensionAppId; enabled: boolean; override?: Record<string, unknown> | null }; result: null };
  preview_mcp_import: { args: Record<string, never>; result: ExtensionMcpImportPreview };
  apply_mcp_import: { args: { previewId: string; selections: ExtensionMcpImportSelection[] }; result: ExtensionMcpImportResult };
};
