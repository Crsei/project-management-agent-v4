// Adapted from t3code UsageLimitSources; Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { usageLimitSourceInputSchema, type UsageLimitSourceInput, type UsageLimitSourceView } from "@agent-workspace/contracts/usage";
import { providerDataDirectory } from "../providers/instances.ts";

export const USAGE_SOURCES_FILE = "usage-sources.json";
export type StoredUsageSource = Omit<UsageLimitSourceView, "managementKeyConfigured"> & { managementKey?: string };
type Store = { version: 1; revisionClock: number; sources: StoredUsageSource[] };

export function validateHubUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw Object.assign(new Error("Invalid hub URL."), { status: 400, code: "invalid_request" }); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash)
    throw Object.assign(new Error("Hub URL must use HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment."), { status: 400, code: "invalid_request" });
  return url.toString().replace(/\/$/, "");
}
function readStore(): Store {
  let text: string;
  try { text = readFileSync(path.join(providerDataDirectory(), USAGE_SOURCES_FILE), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revisionClock: 0, sources: [] }; throw error; }
  try {
    const store = JSON.parse(text) as Store;
    if (store.version !== 1 || !Number.isSafeInteger(store.revisionClock) || store.revisionClock < 0 || !Array.isArray(store.sources)) throw new Error();
    const ids = new Set<string>();
    for (const source of store.sources) {
      if (!source || typeof source.id !== "string" || !source.id || ids.has(source.id) || source.kind !== "cliproxy" || typeof source.label !== "string" || !source.label || typeof source.enabled !== "boolean" || !Number.isSafeInteger(source.revision) || source.revision < 1 || source.revision > store.revisionClock || (source.managementKey !== undefined && typeof source.managementKey !== "string")) throw new Error();
      validateHubUrl(source.url); ids.add(source.id);
    }
    return store;
  } catch { throw new Error("Invalid usage source store; original data was not overwritten."); }
}
function persist(store: Store): void {
  const directory = providerDataDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.usage-sources.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path.join(directory, USAGE_SOURCES_FILE)); chmodSync(path.join(directory, USAGE_SOURCES_FILE), 0o600);
}
function view(source: StoredUsageSource): UsageLimitSourceView {
  return { id: source.id, kind: source.kind, label: source.label, url: source.url, enabled: source.enabled, revision: source.revision, managementKeyConfigured: Boolean(source.managementKey) };
}
export function listStoredUsageSources(): StoredUsageSource[] { return readStore().sources; }
export function listUsageSources(): UsageLimitSourceView[] { return readStore().sources.map(view); }
function sourceValues(input: UsageLimitSourceInput, old?: StoredUsageSource) {
  const value = usageLimitSourceInputSchema.parse(input);
  if (value.clearManagementKey && value.managementKey) throw Object.assign(new Error("Cannot set and clear a management key together."), { status: 400, code: "invalid_request" });
  const managementKey = value.clearManagementKey ? undefined : value.managementKey || old?.managementKey;
  if (value.enabled && !managementKey) throw Object.assign(new Error("An enabled hub requires a management key."), { status: 400, code: "invalid_request" });
  return { kind: value.kind, label: value.label, url: validateHubUrl(value.url), enabled: value.enabled, ...(managementKey ? { managementKey } : {}) };
}
export function createUsageSource(input: UsageLimitSourceInput): UsageLimitSourceView {
  const store = readStore(); const source: StoredUsageSource = { id: randomUUID(), ...sourceValues(input), revision: ++store.revisionClock };
  store.sources.push(source); persist(store); return view(source);
}
export function updateUsageSource(id: string, input: UsageLimitSourceInput): UsageLimitSourceView {
  const store = readStore(); const index = store.sources.findIndex((source) => source.id === id);
  if (index < 0) throw Object.assign(new Error("Unknown usage source."), { status: 404 });
  const old = store.sources[index]!;
  if (input.revision === undefined || input.revision !== old.revision) throw Object.assign(new Error("Usage source changed; reload before saving."), { status: 409 });
  const source: StoredUsageSource = { id, ...sourceValues(input, old), revision: ++store.revisionClock };
  store.sources[index] = source; persist(store); return view(source);
}
export function deleteUsageSource(id: string, revision: number): void {
  const store = readStore(); const index = store.sources.findIndex((source) => source.id === id);
  if (index < 0) throw Object.assign(new Error("Unknown usage source."), { status: 404 });
  if (revision !== store.sources[index]!.revision) throw Object.assign(new Error("Usage source changed; reload before deleting."), { status: 409 });
  store.sources.splice(index, 1); ++store.revisionClock; persist(store);
}
