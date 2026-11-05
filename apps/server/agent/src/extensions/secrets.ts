import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ExtensionAppId, ExtensionMcpDefinition, ExtensionMcpImportPreview, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import { ExtensionError } from "./rpc.ts";

const MASK_PREFIX = "__CC_SWITCH_SECRET_V2__";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
type MaskAuthority = readonly [contextId: string, kind: "definition", serverId: string] | readonly [contextId: string, kind: "override" | "effective", serverId: string, app: ExtensionAppId] | readonly [contextId: string, kind: "preview", previewId: string, entryId: string, app: ExtensionAppId, serverId: string];
type Field = readonly (string | number)[];
function token(key: string, authority: MaskAuthority, field: Field, value: unknown): string {
  return MASK_PREFIX + createHmac("sha256", key).update(JSON.stringify([authority, field, value])).digest("hex");
}
const hasMask = (value: string) => value.includes("__CC_SWITCH_SECRET_");
const rootField = (field: Field, name: string) => field.length === 1 && field[0] === name;
function safeUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
function maskUrl(value: string, key: string, authority: MaskAuthority): string {
  if (safeUrl(value)) return value;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return token(key, authority, ["url"], value);
    if (url.username) url.username = token(key, authority, ["url", "username"], url.username);
    if (url.password) url.password = token(key, authority, ["url", "password"], url.password);
    const counts = new Map<string, number>();
    const entries = [...url.searchParams.entries()];
    url.search = "";
    for (const [name, item] of entries) {
      const index = counts.get(name) ?? 0;
      counts.set(name, index + 1);
      url.searchParams.append(name, item ? token(key, authority, ["url", "query", name, index], item) : "");
    }
    if (url.hash) url.hash = token(key, authority, ["url", "hash"], url.hash);
    return url.href;
  } catch { return token(key, authority, ["url"], value); }
}
/** All non-public scalar config values are protected, including absolute commands and unknown extension fields. */
function maskSpec(value: unknown, key: string, authority: MaskAuthority, field: Field = []): unknown {
  if (Array.isArray(value)) return value.map((item, index) => maskSpec(item, key, authority, [...field, index]));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskSpec(item, key, authority, [...field, name])]));
  if (value === null || value === "") return value;
  if (typeof value === "string") {
    if (rootField(field, "type") && ["stdio", "http", "sse", "streamable-http"].includes(value)) return value;
    if (rootField(field, "command") && /^[a-zA-Z0-9_.+-]+$/.test(value) && !hasMask(value)) return value;
    if (rootField(field, "url")) return maskUrl(value, key, authority);
  }
  return token(key, authority, field, value);
}
export function redactMcpServers(value: unknown, key: string, contextId: string): unknown {
  if (!object(value)) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an invalid server list.");
  return Object.fromEntries(Object.entries(value).map(([id, raw]) => {
    if (!object(raw) || !object(raw.server)) throw new ExtensionError(502, "sidecar_protocol_invalid", "The configuration service returned an invalid server definition.");
    return [id, { ...raw, server: maskSpec(raw.server, key, [contextId, "definition", id]) }];
  }));
}
export function redactMcpManagement(value: ExtensionMcpManagement, key: string, contextId: string): ExtensionMcpManagement {
  return {
    definitions: Object.fromEntries(Object.entries(value.definitions).map(([id, definition]) => [id, { ...definition, server: maskSpec(definition.server, key, [contextId, "definition", id]) as Record<string, unknown> }])),
    agentConfigurations: Object.fromEntries(Object.entries(value.agentConfigurations).map(([id, rows]) => [id, Object.fromEntries(Object.entries(rows).flatMap(([app, row]) => row ? [[app, { ...row, override: row.override === null ? null : maskSpec(row.override, key, [contextId, "override", id, row.app]), effective: maskSpec(row.effective, key, [contextId, "effective", id, row.app]) }]] : []))])),
    boundApps: value.boundApps,
  };
}
export function redactMcpImportPreview(value: ExtensionMcpImportPreview, key: string, contextId: string): ExtensionMcpImportPreview {
  return { ...value, entries: value.entries.map(entry => ({ ...entry, definition: { ...entry.definition, server: maskSpec(entry.definition.server, key, [contextId, "preview", value.previewId, entry.entryId, entry.sourceApp, entry.serverId]) as Record<string, unknown> } })) };
}
function staleMask(): never { throw new ExtensionError(409, "secret_mask_stale", "A protected value changed or belongs to another context, definition, assignment, preview or field. Refresh before saving."); }
function mergeValue(incoming: unknown, previous: unknown, key: string, authority: MaskAuthority, field: Field = [], preservePrivateMaps = false): unknown {
  if (typeof incoming === "string" && incoming.startsWith(MASK_PREFIX)) {
    const actual = Buffer.from(incoming), wanted = Buffer.from(token(key, authority, field, previous));
    if (previous === undefined || actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return staleMask();
    return previous;
  }
  if (rootField(field, "url") && typeof incoming === "string" && hasMask(incoming)) {
    if (typeof previous !== "string") return staleMask();
    if (incoming === maskUrl(previous, key, authority)) return previous;
    try {
      const next = new URL(incoming), prior = new URL(previous);
      if (hasMask(next.username)) next.username = String(mergeValue(next.username, prior.username, key, authority, ["url", "username"]));
      if (hasMask(next.password)) next.password = String(mergeValue(next.password, prior.password, key, authority, ["url", "password"]));
      const counts = new Map<string, number>();
      const entries = [...next.searchParams.entries()];
      next.search = "";
      for (const [name, item] of entries) {
        const index = counts.get(name) ?? 0;
        counts.set(name, index + 1);
        next.searchParams.append(name, hasMask(item) ? String(mergeValue(item, prior.searchParams.getAll(name)[index], key, authority, ["url", "query", name, index])) : item);
      }
      if (hasMask(next.hash)) next.hash = String(mergeValue(next.hash.slice(1), prior.hash, key, authority, ["url", "hash"]));
      if (hasMask(next.href)) return staleMask();
      return next.href;
    } catch { return staleMask(); }
  }
  if (typeof incoming === "string" && hasMask(incoming)) return staleMask();
  if (Array.isArray(incoming)) return incoming.map((item, index) => mergeValue(item, Array.isArray(previous) ? previous[index] : undefined, key, authority, [...field, index]));
  if (object(incoming)) {
    const prior = object(previous) ? previous : {};
    const merged = Object.fromEntries(Object.entries(incoming).map(([name, item]) => [name, mergeValue(item, Object.hasOwn(prior, name) ? prior[name] : undefined, key, authority, [...field, name])]));
    if (preservePrivateMaps && field.length === 0) for (const name of ["headers", "env"]) if (!Object.hasOwn(incoming, name) && Object.hasOwn(prior, name)) merged[name] = prior[name];
    return merged;
  }
  return incoming;
}
export function mergeMcpServerSecrets(incoming: Record<string, unknown>, previous: unknown, key: string, contextId: string): Record<string, unknown> {
  const id = incoming.id;
  if (typeof id !== "string" || !object(incoming.server)) throw new ExtensionError(400, "invalid_server", "A server ID and transport definition are required.");
  const before = object(previous) ? previous.server : undefined;
  return { ...incoming, server: mergeValue(incoming.server, before, key, [contextId, "definition", id], [], true) };
}
export function mergeMcpDefinitionSecrets(incoming: ExtensionMcpDefinition, previous: ExtensionMcpDefinition | undefined, key: string, contextId: string): ExtensionMcpDefinition {
  return { ...incoming, server: mergeValue(incoming.server, previous?.server, key, [contextId, "definition", incoming.id], [], true) as Record<string, unknown> };
}
export function mergeMcpOverrideSecrets(incoming: Record<string, unknown>, previous: Record<string, unknown> | null | undefined, key: string, contextId: string, serverId: string, app: ExtensionAppId): Record<string, unknown> {
  return mergeValue(incoming, previous, key, [contextId, "override", serverId, app]) as Record<string, unknown>;
}
/** Shared with the PM migration client: canonical identity does not depend on display labels or native app flags. */
export function definitionFingerprint(endpoint: string, headers: Record<string, string>): string {
  const canonical = (value: unknown): string => {
    if (object(value)) return `{${Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  const normalized = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return createHash("sha256").update(canonical({ transport: "streamable-http", endpoint, headers: normalized })).digest("hex");
}
/** Native projection errors may echo values; retain failure structure but not arbitrary diagnostics. */
export function redactOperationResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOperationResult);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (name === "backupPath" && typeof item === "string" && item) return [name, "Context-private Skill backup (path withheld)"];
    if (name === "preservedPiPath" && typeof item === "string" && item) return [name, "Preserved Pi native Skill (path withheld)"];
    const diagnostic = /^(?:error|errors|message|stderr|stdout|diagnostic)$/i.test(name);
    const withheld = "The native operation reported a failure; private diagnostic details are withheld.";
    return [name, diagnostic && typeof item === "string" ? withheld : diagnostic && Array.isArray(item) ? item.map(entry => typeof entry === "string" ? withheld : redactOperationResult(entry)) : redactOperationResult(item)];
  }));
}
export function hasOperationFailures(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOperationFailures);
  if (!object(value)) return false;
  if (value.ok === false || (Array.isArray(value.errors) && value.errors.length > 0) || (Array.isArray(value.failures) && value.failures.length > 0) || (Array.isArray(value.failedSkills) && value.failedSkills.length > 0) || value.piCleanupIncomplete === true) return true;
  return Object.values(value).some(item => typeof item === "object" && item !== null && hasOperationFailures(item));
}
