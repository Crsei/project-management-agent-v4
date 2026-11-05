import { z } from "zod";
import { extensionAppIds, type ExtensionMcpDefinition, type ExtensionMcpImportPreview, type ExtensionMcpImportResult, type ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import { ExtensionError } from "./rpc.ts";

const app = z.enum(extensionAppIds);
const config = z.record(z.string(), z.unknown());
const reason = z.enum(["invalid_configuration", "unsupported_transport", "invalid_server_id", "unsupported_app", "native_read_failed", "invalid_native_configuration", "native_profiles_conflict", "native_not_initialized", "native_configuration_differs", "native_comparison_failed"]);
// Strip unknown sidecar fields: authority paths, internal snapshots and assignment flags are never public metadata.
const definition = z.object({ id: z.string(), name: z.string(), server: config, description: z.string().optional(), homepage: z.string().optional(), docs: z.string().optional(), tags: z.array(z.string()).optional() });
const configuration = z.object({ serverId: z.string(), app, enabled: z.boolean(), override: config.nullable(), effective: config, compatibility: z.object({ supported: z.boolean(), reason: reason.nullable() }), sync: z.object({ state: z.enum(["unassigned", "synced", "pending", "error", "unavailable"]), reason: reason.nullable() }) });
const management = z.object({ definitions: z.record(z.string(), definition), agentConfigurations: z.record(z.string(), z.partialRecord(app, configuration)), boundApps: z.array(app) });
const warning = z.object({ app, message: z.enum(["invalid_native_configuration", "native_read_failed", "native_profiles_conflict", "invalid_import_entry"]) });
const preview = z.object({ previewId: z.string(), entries: z.array(z.object({ entryId: z.string(), sourceApp: app, serverId: z.string(), name: z.string(), definition, enabled: z.boolean(), classification: z.enum(["new", "duplicate", "conflict"]), conflicts: z.array(z.enum(["server_configuration_differs", "same_id_native_configuration_differs"])), resolutions: z.array(z.enum(["import", "merge-override", "skip"])) })), warnings: z.array(warning) });
const result = z.object({ applied: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), warnings: z.array(warning) });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an invalid MCP management payload.");
  return parsed.data;
}
export function parseMcpDefinition(value: unknown): ExtensionMcpDefinition { return parse(definition, value); }
export function parseMcpManagement(value: unknown): ExtensionMcpManagement {
  const parsed = parse(management, value);
  for (const [id, item] of Object.entries(parsed.definitions)) if (id !== item.id) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned mismatched definition identities.");
  if (parsed.boundApps.length !== new Set(parsed.boundApps).size) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned duplicate native targets.");
  for (const id of Object.keys(parsed.definitions)) if (parsed.boundApps.some(appId => !parsed.agentConfigurations[id]?.[appId])) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service omitted a bound assignment row.");
  for (const [id, rows] of Object.entries(parsed.agentConfigurations)) {
    if (!Object.hasOwn(parsed.definitions, id)) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an unknown assignment definition.");
    for (const [appId, row] of Object.entries(rows)) if (row && (row.serverId !== id || row.app !== appId || !parsed.boundApps.includes(row.app))) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an unbound or mismatched assignment.");
  }
  return parsed;
}
export function parseMcpImportPreview(value: unknown): ExtensionMcpImportPreview {
  const parsed = parse(preview, value);
  const ids = new Set<string>();
  for (const entry of parsed.entries) {
    if (ids.has(entry.entryId) || entry.serverId !== entry.definition.id) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned duplicate or mismatched preview entries.");
    ids.add(entry.entryId);
  }
  return parsed;
}
export function parseMcpImportResult(value: unknown): ExtensionMcpImportResult { return parse(result, value); }
