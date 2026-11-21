import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { acceptedChatContextSchema, canonicalChatContextJson } from "@agent-workspace/contracts/message-context";
import { chatDraftInputSchema } from "@agent-workspace/contracts/chat";
import { EVALUATION_NAMESPACES, validateEvaluationRecord, fenceEvaluationCopy } from "../evaluation-feedback/persistence.ts";

export const PERSISTENCE_NAMESPACE = "agent:persistence:v1";
export const PERSISTENCE_VERSION = 1;
const WRITE_GATE_FUNCTION = "agent_persistence_writer_version";
const WRITE_GATES: Record<string, string> = Object.fromEntries(["records", "run_events", "worker_owner"].flatMap(table =>
  ["INSERT", "UPDATE", "DELETE"].map(operation => {
    const name = `agent_persistence_${table}_${operation.toLowerCase()}_v1`;
    return [name, `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Agent persistence writer version is incompatible') WHERE ${WRITE_GATE_FUNCTION}() < COALESCE((SELECT CAST(json_extract(value, '$.minimumWriterVersion') AS INTEGER) FROM records WHERE namespace='${PERSISTENCE_NAMESPACE}' AND key='store'), 1) OR ${WRITE_GATE_FUNCTION}() < COALESCE((SELECT CAST(json_extract(value, '$.formatVersion') AS INTEGER) FROM records WHERE namespace='${PERSISTENCE_NAMESPACE}' AND key='store'), 1); END`];
  })));
/** Connection-local capability: an unaware old binary fails at worker_owner claim, before any runtime recovery. */
export function registerPersistenceWriter(db: DatabaseSync): void {
  db.function(WRITE_GATE_FUNCTION, { deterministic: true, directOnly: false }, () => PERSISTENCE_VERSION);
}
function installPersistenceWriteGate(db: DatabaseSync): void {
  for (const [name, sql] of Object.entries(WRITE_GATES))
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)) db.exec(sql);
}
export type StoreIdentity = {
  storeId: string; formatVersion: 1; minimumReaderVersion: 1; minimumWriterVersion: 1;
  restoreEpoch: number; sourceStoreId?: string; restoredAt?: string;
  restoredThreads?: Record<string, true>;
  migrations: { migrationId: string; planHash: string; at: string }[];
};
export type NamespacePolicy = {
  owner: "chat" | "business" | "provider" | "mcp" | "workspace" | "settings" | "persistence" | "evaluation";
  structureVersion: number; sensitive: boolean; rebuildable: boolean;
  backup: "retain" | "revoke" | "exclude-native" | "exclude-feedback";
  deletion: "visible" | "evidence" | "identity" | "capability" | "feedback";
  retention?: "configured-expiry" | "minimal-audit-fence";
  restore?: "disable-and-purge-derived";
};
const policies = new Map<string, NamespacePolicy>();
function register(names: string[], owner: NamespacePolicy["owner"], deletion: NamespacePolicy["deletion"], backup: NamespacePolicy["backup"] = "retain", rebuildable = false): void {
  for (const name of names) policies.set(name, { owner, structureVersion: 1, sensitive: true, rebuildable, backup, deletion });
}
register([PERSISTENCE_NAMESPACE, "agent:session-cutover", "chat:lifecycle-operations"], "persistence", "identity");
register(["chat:threads", "chat:requests", "chat:cancellations", "chat:imports"], "chat", "identity");
register(["chat:history", "chat:sidebar", "chat:message-queue", "chat:draft-stash"], "chat", "visible");
register(["chat:generations", "chat:events", "chat:execution-grants", "chat:thread-actions", "chat:steering", "native-output", "durable:workspaces", "durable:imports", "durable:forks", "durable:transfers", "durable:fork-keys"], "chat", "evidence");
register(["provider:t3code:continuations"], "provider", "capability", "exclude-native");
register(["agent:workspaces:v1", "agent:scratch:v1", "chat-worktrees-v1"], "workspace", "identity");
register(["chat-fanouts-v1"], "workspace", "identity");
register(["settings:chat-defaults", "settings:usage", "usage:turns", "usage:threads", "usage:launches"], "settings", "evidence");
register(["usage:pricing"], "settings", "evidence", "retain", true);
register(["mcp:codes", "mcp:tokens", "mcp:consents", "mcp:grants", "mcp-app-model-context-v1"], "mcp", "capability", "revoke");
register(["mcp:execution-roots", "mcp:tool-receipts", "mcp-app-producing-items-v1", "mcp-app-private-assets-v1"], "mcp", "evidence");
for (const namespace of Object.values(EVALUATION_NAMESPACES)) policies.set(namespace, {
  owner: "evaluation", structureVersion: 1, sensitive: true, rebuildable: false,
  backup: namespace === EVALUATION_NAMESPACES.admissions || namespace === EVALUATION_NAMESPACES.denominators ? "exclude-feedback" :
    namespace === EVALUATION_NAMESPACES.policies ? "revoke" : "retain", deletion: "feedback",
  retention: namespace === EVALUATION_NAMESPACES.admissions ? "configured-expiry" : "minimal-audit-fence", restore: "disable-and-purge-derived",
});
register([
  "pm-tool-calls", "pm-content-provenance", "pm-quote-provenance", "pm-core:observation", "pm-analysis:scratch-v1",
  "durable:runs", "durable:requests", "durable:submissions", "durable:events",
  "task-code-delivery-v1", "task-workflow-definitions-v1", "task-workflow-runs-v1",
  "automation.schedules", "automation.watches", "automation.dispatches", "automation.recovery",
  "pm-automation:executions", "pm-automation:native-thread-bindings", "pm-automation:agent-signal-outbox", "pm-automation:agent-signal-cursors",
  "pm-automation:native-template-executions", "pm-automation:native-template-children", "pm-automation:pm-analysis-inputs",
  "pm-automation:native-repositories", "pm-automation:native-operations", "pm-automation:native-workspace-calls", "pm-automation:native-workspace-runs", "pm-automation:native-workspace-grants",
  "pm-automation:native-operations:history", "pm-automation:native-template-executions:history", "pm-automation:native-repositories:base-files",
  "collaboration:runs:v1", "collaboration:delegations:v1", "collaboration:run-requests:v1",
  "collaboration:output-budgets:v1",
  "collaboration:agents", "collaboration:agent-versions", "collaboration:teams", "collaboration:team-versions", "collaboration:definition-requests",
], "business", "evidence");
const dynamicBusinessPolicy: NamespacePolicy = { owner: "business", structureVersion: 1, sensitive: true, rebuildable: false, backup: "retain", deletion: "evidence" };
export function namespacePolicy(namespace: string): NamespacePolicy | null {
  return policies.get(namespace) ?? (/^pm-core:(?:snapshot|changes):[^:]+:[^:]+$/.test(namespace) ||
    /^pm-automation:native-(?:review-)?state:[a-f0-9]{64}(?::history)?$/.test(namespace) ? dynamicBusinessPolicy : null);
}
export const persistenceNamespaceInventory = () => [...policies].map(([namespace, policy]) => ({ namespace, ...policy }));
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export type PersistenceRecord = { namespace: string; key: string; value: unknown };
export type PersistenceInventory = {
  format: "agent-persistence-inventory-v1"; fingerprint: string; store: StoreIdentity | null;
  namespaces: { namespace: string; count: number; policy: NamespacePolicy | null }[];
  blockers: string[]; legacyWarnings: string[]; records: number; events: number;
};
export function persistenceRecords(db: DatabaseSync): PersistenceRecord[] {
  return db.prepare("SELECT namespace,key,value FROM records WHERE namespace NOT IN ('mcp:tokens','mcp:codes','mcp:consents') ORDER BY namespace,key").all().flatMap(row =>
    namespacePolicy(String(row.namespace)) ? [{ namespace: String(row.namespace), key: String(row.key), value: JSON.parse(String(row.value)) as unknown }] : []);
}
export function getStoreIdentity(db: DatabaseSync): StoreIdentity {
  const row = db.prepare("SELECT value FROM records WHERE namespace=? AND key='store'").get(PERSISTENCE_NAMESPACE);
  const value = row && object(JSON.parse(String(row.value)));
  if (!value || typeof value.storeId !== "string" || !value.storeId || value.formatVersion !== PERSISTENCE_VERSION ||
      value.minimumReaderVersion !== 1 || value.minimumWriterVersion !== 1 || !Number.isSafeInteger(value.restoreEpoch) || Number(value.restoreEpoch) < 0 || !Array.isArray(value.migrations))
    throw new Error("Unsupported Agent persistence version or identity; use a compatible reader and an explicit stopped-copy inventory.");
  if (value.migrations.some(entry => {
    const receipt = object(entry);
    return !receipt || typeof receipt.migrationId !== "string" || !receipt.migrationId || typeof receipt.planHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.planHash) || typeof receipt.at !== "string" || !Number.isFinite(Date.parse(receipt.at));
  })) throw new Error("Invalid Agent migration receipt; no writer was admitted.");
  if (Number(value.restoreEpoch) > 0 && (typeof value.sourceStoreId !== "string" || typeof value.restoredAt !== "string" || !Number.isFinite(Date.parse(value.restoredAt)) ||
      !object(value.restoredThreads) || Object.values(object(value.restoredThreads)!).some(flag => flag !== true)))
    throw new Error("Restored Store is missing its immutable read-only history fence.");
  return value as StoreIdentity;
}
/** Runs before SQLite schema/owner writes, runtime recovery or Provider initialization. */
export function preflightPersistence(db: DatabaseSync): { empty: boolean; legacy: boolean } {
  const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (!Number.isSafeInteger(userVersion) || userVersion < 0 || userVersion > PERSISTENCE_VERSION)
    throw new Error("Future Agent SQLite schema version; no writer was admitted.");
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
  if (!tables.length) return { empty: true, legacy: false };
  if (tables.some(name => !["records", "run_events", "worker_owner"].includes(name)) || !tables.includes("records") || !tables.includes("run_events") || !tables.includes("worker_owner"))
    throw new Error("Unknown Agent SQLite schema; no schema or execution owner was changed.");
  const expected: Record<string, string[]> = { records: ["namespace", "key", "value"], run_events: ["run_id", "seq", "event"], worker_owner: ["singleton", "pid", "token"] };
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const actual = columns.map(row => String(row.name));
    if (JSON.stringify(actual) !== JSON.stringify(expected[table]) ||
        columns.some((column, index) => String(column.type).toUpperCase() !== (["seq", "singleton", "pid"].includes(String(column.name)) ? "INTEGER" : "TEXT") ||
          Number(column.pk) !== (table === "worker_owner" ? index === 0 ? 1 : 0 : index < 2 ? index + 1 : 0)))
      throw new Error(`Unknown Agent table layout or uniqueness constraint: ${table}.`);
  }
  const unknown = db.prepare("SELECT DISTINCT namespace FROM records ORDER BY namespace").all().filter(row => !namespacePolicy(String(row.namespace)));
  if (unknown.length) throw new Error(`Unregistered Agent namespaces: ${unknown.map(row => String(row.namespace)).join(", ")}. Nothing was migrated.`);
  const meta = db.prepare("SELECT 1 FROM records WHERE namespace=? AND key='store'").get(PERSISTENCE_NAMESPACE);
  if (meta) getStoreIdentity(db);
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
  if (triggers.some(trigger => !Object.hasOwn(WRITE_GATES, String(trigger.name)) ||
      String(trigger.sql).replace(/\s+/g, " ").trim() !== WRITE_GATES[String(trigger.name)]!.replace(/\s+/g, " ").trim()) ||
      (meta ? triggers.length !== Object.keys(WRITE_GATES).length : triggers.length !== 0))
    throw new Error("Unknown or incomplete Agent persistence write-gate schema; explicit stopped-copy inspection is required.");
  for (const row of db.prepare("SELECT namespace,key,value FROM records WHERE namespace IN ('chat:threads','chat:requests','provider:t3code:continuations')").iterate()) {
    const value = object(JSON.parse(String(row.value)));
    const version = row.namespace === "chat:threads" ? object(value?.executionSelection)?.version : value?.version;
    if (version !== undefined && (row.namespace === "chat:threads" ? version !== 1 && version !== 2 : version !== 1))
      throw new Error(`Unsupported record structure version in ${String(row.namespace)}; no writer was admitted.`);
  }
  for (const row of db.prepare("SELECT namespace,value FROM records WHERE namespace LIKE 'evaluation:%'").iterate())
    validateEvaluationRecord(String(row.namespace), JSON.parse(String(row.value)));
  const nonempty = Boolean(db.prepare("SELECT 1 FROM records LIMIT 1").get() || db.prepare("SELECT 1 FROM run_events LIMIT 1").get());
  return { empty: !nonempty, legacy: !meta && nonempty };
}
export function initializePersistence(db: DatabaseSync, migration?: { migrationId: string; planHash: string }): StoreIdentity {
  registerPersistenceWriter(db);
  const existing = db.prepare("SELECT 1 FROM records WHERE namespace=? AND key='store'").get(PERSISTENCE_NAMESPACE);
  if (existing) { const identity = getStoreIdentity(db); installPersistenceWriteGate(db); return identity; }
  const identity: StoreIdentity = { storeId: randomUUID(), formatVersion: 1, minimumReaderVersion: 1, minimumWriterVersion: 1, restoreEpoch: 0,
    migrations: migration ? [{ ...migration, at: new Date().toISOString() }] : [] };
  db.prepare("INSERT INTO records(namespace,key,value) VALUES(?,'store',?)").run(PERSISTENCE_NAMESPACE, JSON.stringify(identity));
  installPersistenceWriteGate(db);
  return identity;
}
export function inventoryPersistence(db: DatabaseSync, options: { omitCredentialValues?: boolean } = {}): PersistenceInventory {
  const records = persistenceRecords(db), blockers: string[] = [], legacyWarnings: string[] = [];
  try { preflightPersistence(db); }
  catch (error) { blockers.push(`incompatible_schema:${error instanceof Error && !(error instanceof SyntaxError) ? error.message : "invalid_persisted_structure"}`); }
  const namespaces = db.prepare("SELECT namespace,count(*) AS count FROM records GROUP BY namespace ORDER BY namespace").all().map(row => ({ namespace: String(row.namespace), count: Number(row.count), policy: namespacePolicy(String(row.namespace)) }));
  for (const row of namespaces) if (!row.policy) blockers.push(`unregistered_namespace:${row.namespace}`);
  let store: StoreIdentity | null = null;
  if (records.some(row => row.namespace === PERSISTENCE_NAMESPACE && row.key === "store")) {
    try { store = getStoreIdentity(db); } catch { blockers.push("unsupported_store_version"); }
  }
  const threads = new Map(records.filter(row => row.namespace === "chat:threads").map(row => [row.key, object(row.value)!]));
  const generations = new Map(records.filter(row => row.namespace === "chat:generations").map(row => [row.key, object(row.value)!]));
  for (const row of records) {
    const value = object(row.value);
    if (!value && ["chat:generations", "native-output", "chat:message-queue", "pm-content-provenance"].includes(row.namespace)) {
      blockers.push(`invalid_record:${row.namespace}:${row.key}`); continue;
    }
    if (row.namespace === "chat:threads") {
      if (!value) { blockers.push(`invalid_thread:${row.key}`); continue; }
      if (value.remoteId !== undefined && value.remoteId !== row.key) blockers.push(`thread_identity_mismatch:${row.key}`);
      const selection = object(value.executionSelection);
      if (selection && selection.version !== 1 && selection.version !== 2) blockers.push(`future_execution_version:${row.key}`);
      if (value.lifecycleRevision !== undefined && (!Number.isSafeInteger(value.lifecycleRevision) || Number(value.lifecycleRevision) < 0)) blockers.push(`invalid_lifecycle_revision:${row.key}`);
    }
    if (row.namespace === "provider:t3code:continuations" && value?.version !== 1) blockers.push(`future_continuation_version:${row.key}`);
    if (row.namespace === "chat:history") {
      const messages = value?.messages;
      if (!value || !Array.isArray(messages) || typeof value.threadId !== "string" || !threads.has(value.threadId)) { blockers.push(`orphan_history:${row.key}`); continue; }
      const ids = new Set(messages.map(message => object(message)?.id));
      if (ids.size !== messages.length) blockers.push(`duplicate_message:${row.key}`);
      if (value.headId !== null && value.headId !== undefined && !ids.has(value.headId)) blockers.push(`missing_head:${row.key}`);
      const parents = new Map(messages.map(message => { const m = object(message); return [m?.id, m?.parent_id]; }));
      for (const message of messages) {
        const m = object(message); if (!m || typeof m.id !== "string") { blockers.push(`invalid_message:${row.key}`); continue; }
        if (m.parent_id != null && !ids.has(m.parent_id)) blockers.push(`missing_parent:${row.key}:${m.id}`);
        const seen = new Set<unknown>(); let cursor: unknown = m.id;
        while (cursor != null) { if (seen.has(cursor)) { blockers.push(`cyclic_history:${row.key}`); break; } seen.add(cursor); cursor = parents.get(cursor); }
        const context = object(m.turnContext);
        if (context && (context.threadId !== value.threadId || context.messageId !== m.id || object(m.content)?.role !== "user")) blockers.push(`invalid_turn_context:${row.key}:${m.id}`);
        if (context?.contextItems !== undefined) {
          const items = context.contextItems;
          if (!Array.isArray(items) || items.length > 20) blockers.push(`invalid_message_context:${row.key}:${m.id}`);
          else {
            const identities = new Set<string>();
            let total = 0;
            for (const item of items) {
              const parsed = acceptedChatContextSchema.safeParse(item);
              if (!parsed.success || parsed.data.visibility !== "available") { blockers.push(`invalid_message_context:${row.key}:${m.id}`); continue; }
              const accepted = parsed.data;
              const digest = (value: string) => createHash("sha256").update(value).digest("hex");
              if (identities.has(accepted.contextId) || accepted.contextId !== accepted.input.contextId || accepted.kind !== accepted.input.kind ||
                  canonicalChatContextJson(accepted.source) !== canonicalChatContextJson(accepted.input.source) ||
                  accepted.inputDigest !== digest(canonicalChatContextJson(accepted.input)) || accepted.digest !== digest(accepted.text))
                blockers.push(`invalid_message_context_binding:${row.key}:${m.id}`);
              if (accepted.attachments?.some(attachment => !accepted.dependencies?.some(source =>
                source.threadId === attachment.threadId && source.messageIds.includes(attachment.messageId))))
                blockers.push(`invalid_message_context_attachment:${row.key}:${m.id}`);
              identities.add(accepted.contextId); total += accepted.text.length + (accepted.input.comment?.length ?? 0);
            }
            if (total > 48000 || Buffer.byteLength(JSON.stringify(items), "utf8") > 1024 * 1024) blockers.push(`message_context_too_large:${row.key}:${m.id}`);
          }
        }
      }
    }
    if (row.namespace === "chat:requests") {
      if (!value || typeof value.fingerprint !== "string") { blockers.push(`invalid_submission:${row.key}`); continue; }
      if (value.version !== undefined && value.version !== 1) blockers.push(`future_submission_version:${row.key}`);
      if (value.state === "accepted" || value.state === undefined) {
        const generation = generations.get(String(value.id ?? value.generationId));
        if (!generation) blockers.push(`broken_submission:${row.key}`);
        else if (value.threadId !== undefined && generation.threadId !== value.threadId || value.inputMessageId !== undefined && generation.inputMessageId !== value.inputMessageId) blockers.push(`submission_identity_mismatch:${row.key}`);
      }
    }
    if (row.namespace === "chat:generations" && value) {
      if (value.id !== undefined && value.id !== row.key) blockers.push(`generation_identity_mismatch:${row.key}`);
      const request = object(value.request), context = object(value.turnContext);
      if (request?.id !== undefined && value.threadId !== undefined && request.id !== value.threadId) blockers.push(`generation_request_thread_mismatch:${row.key}`);
      if (context && (context.threadId !== value.threadId || context.messageId !== value.inputMessageId)) blockers.push(`generation_input_binding_mismatch:${row.key}`);
      if (value.threadId !== undefined && !threads.has(String(value.threadId))) blockers.push(`orphan_generation:${row.key}`);
      if (value.threadId === undefined) legacyWarnings.push(`legacy_generation_without_thread:${row.key}`);
    }
    if (row.namespace === EVALUATION_NAMESPACES.admissions) {
      const generation = generations.get(String(value?.generationId));
      if (value?.generationId !== row.key || !generation || generation.threadId !== value?.threadId ||
          !records.some(record => record.namespace === EVALUATION_NAMESPACES.policies && record.key === object(value?.observation)?.policyId))
        blockers.push(`invalid_evaluation_admission:${row.key}`);
    }
    if (row.namespace === "native-output" && value?.generationId !== undefined && value.generationId !== row.key) blockers.push(`native_output_identity_mismatch:${row.key}`);
    if (row.namespace === "chat:events" && value && (!generations.has(String(value.generationId)) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1))
      blockers.push(`orphan_or_invalid_chat_event:${row.key}`);
    if (row.namespace === "native-output" && value) {
      const generation = generations.get(String(value.generationId ?? row.key));
      if (generation?.threadId !== undefined && value.threadId !== generation.threadId) blockers.push(`native_output_thread_mismatch:${row.key}`);
    }
    if (row.namespace === "pm-content-provenance" && value && (!generations.has(String(value.generationId)) || generations.get(String(value.generationId))?.threadId !== value.threadId)) {
      const virtualId = typeof value.generationId === "string" && value.generationId.startsWith("fork:") ? value.generationId.slice(5) : null;
      const history = records.find(candidate => candidate.namespace === "chat:history" && object(candidate.value)?.threadId === value.threadId && object(candidate.value)?.format === "ai-sdk/v6");
      const messages = object(history?.value)?.messages;
      const retiredSource = threads.get(String(value.threadId));
      const retainedReferences = retiredSource?.retainedReferences;
      const retainedBinding = retiredSource?.deleted === true && Array.isArray(retainedReferences) &&
        retainedReferences.some(reference => object(reference)?.namespace === row.namespace && object(reference)?.key === row.key);
      if (!retainedBinding && (!virtualId || !Array.isArray(value.messageIds) || !value.messageIds.includes(virtualId) || !Array.isArray(messages) || !messages.some(message => object(message)?.id === virtualId)))
        blockers.push(`orphan_pm_provenance:${row.key}`);
    }
    if (row.namespace === "native-output" && value && !generations.has(String(value.generationId ?? row.key))) blockers.push(`orphan_native_output:${row.key}`);
    if (row.namespace === "chat:message-queue" && value?.status === "sent") {
      const generation = generations.get(String(value.generationId));
      if (!generation || generation.threadId !== value.threadId) blockers.push(`broken_queue_acceptance:${row.key}`);
    }
    if (["chat:message-queue", "chat:draft-stash"].includes(row.namespace) && object(value?.draft)?.contextItems !== undefined &&
        !chatDraftInputSchema.safeParse(value?.draft).success) blockers.push(`invalid_draft_context:${row.key}`);
    if (["chat:message-queue", "chat:draft-stash"].includes(row.namespace) && value?.acceptedContextItems !== undefined) {
      const draft = chatDraftInputSchema.safeParse(value.draft), snapshots = value.acceptedContextItems;
      if (!draft.success || !Array.isArray(snapshots) || snapshots.length !== (draft.data.contextItems?.length ?? 0) ||
          Buffer.byteLength(JSON.stringify(snapshots), "utf8") > 1024 * 1024) blockers.push(`invalid_draft_snapshot:${row.key}`);
      else {
        const inputs = new Map((draft.data.contextItems ?? []).map(input => [input.contextId, input]));
        const identities = new Set<string>();
        let total = 0;
        for (const snapshot of snapshots) {
          const parsed = acceptedChatContextSchema.safeParse(snapshot);
          if (!parsed.success || parsed.data.visibility !== "available") { blockers.push(`invalid_draft_snapshot:${row.key}`); continue; }
          const accepted = parsed.data, input = inputs.get(accepted.contextId);
          const digest = (text: string) => createHash("sha256").update(text).digest("hex");
          if (!input || identities.has(accepted.contextId) || accepted.contextId !== accepted.input.contextId || accepted.kind !== input.kind ||
              canonicalChatContextJson(input) !== canonicalChatContextJson(accepted.input) ||
              canonicalChatContextJson(accepted.source) !== canonicalChatContextJson(accepted.input.source) ||
              accepted.inputDigest !== digest(canonicalChatContextJson(input)) || accepted.digest !== digest(accepted.text))
            blockers.push(`invalid_draft_snapshot_binding:${row.key}`);
          if (accepted.attachments?.some(attachment => !accepted.dependencies?.some(source =>
            source.threadId === attachment.threadId && source.messageIds.includes(attachment.messageId))))
            blockers.push(`invalid_draft_snapshot_attachment:${row.key}`);
          identities.add(accepted.contextId); total += accepted.text.length + (accepted.input.comment?.length ?? 0);
        }
        if (total > 48000) blockers.push(`draft_snapshot_too_large:${row.key}`);
      }
    }
  }
  const hash = createHash("sha256");
  const fingerprintQuery = options.omitCredentialValues
    ? "SELECT namespace,key,value FROM records WHERE namespace NOT IN ('mcp:tokens','mcp:codes','mcp:consents') ORDER BY namespace,key"
    : "SELECT namespace,key,value FROM records ORDER BY namespace,key";
  if (options.omitCredentialValues) hash.update(JSON.stringify(namespaces.filter(row => ["mcp:tokens", "mcp:codes", "mcp:consents"].includes(row.namespace)).map(({ namespace, count }) => ({ namespace, count }))));
  for (const row of db.prepare(fingerprintQuery).iterate()) hash.update(JSON.stringify([row.namespace, row.key, row.value]));
  let events = 0;
  for (const row of db.prepare("SELECT run_id,seq,event FROM run_events ORDER BY run_id,seq").iterate()) { hash.update(JSON.stringify([row.run_id, row.seq, row.event])); events++; }
  return { format: "agent-persistence-inventory-v1", fingerprint: hash.digest("hex"), store, namespaces, blockers: [...new Set(blockers)], legacyWarnings: [...new Set(legacyWarnings)], records: namespaces.reduce((count, row) => count + row.count, 0), events };
}
function legacyFingerprint(db: DatabaseSync): string {
  const hash = createHash("sha256");
  for (const row of db.prepare("SELECT namespace,key,value FROM records WHERE namespace<>? ORDER BY namespace,key").iterate(PERSISTENCE_NAMESPACE))
    hash.update(JSON.stringify([row.namespace, row.key, row.value]));
  for (const row of db.prepare("SELECT run_id,seq,event FROM run_events ORDER BY run_id,seq").iterate()) hash.update(JSON.stringify([row.run_id, row.seq, row.event]));
  return hash.digest("hex");
}
/** Caller holds the explicit stopped-copy maintenance lock; never invoked on startup. */
export function bootstrapLegacyPersistence(db: DatabaseSync, expectedFingerprint: string): StoreIdentity {
  preflightPersistence(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const inventory = inventoryPersistence(db);
    if (inventory.blockers.length || legacyFingerprint(db) !== expectedFingerprint) throw new Error("Persistence inventory changed or has blockers; nothing was migrated.");
    if (inventory.store && !inventory.store.migrations.some(receipt => receipt.migrationId === "recognized-legacy-layout-v1" && receipt.planHash === expectedFingerprint))
      throw new Error("This Store was not bootstrapped by the reviewed legacy plan.");
    const identity = initializePersistence(db, { migrationId: "recognized-legacy-layout-v1", planHash: expectedFingerprint });
    db.exec("COMMIT"); return identity;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
/** Only removes this migration's metadata on an unchanged isolated copy; not a downgrade after new writes. */
export function rollbackLegacyPersistence(db: DatabaseSync, expectedFingerprint: string): void {
  preflightPersistence(db);
  registerPersistenceWriter(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const identity = getStoreIdentity(db);
    if (identity.restoreEpoch !== 0 || !identity.migrations.some(receipt => receipt.migrationId === "recognized-legacy-layout-v1" && receipt.planHash === expectedFingerprint) || legacyFingerprint(db) !== expectedFingerprint)
      throw new Error("Rollback refused: identity, plan or data changed. Preserve both checkpoints; no historical writes were undone.");
    for (const name of Object.keys(WRITE_GATES)) db.exec(`DROP TRIGGER ${name}`);
    db.prepare("DELETE FROM records WHERE namespace=? AND key='store'").run(PERSISTENCE_NAMESPACE);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
/** Restore changes identity only; original IDs and frozen directory identities are never rewritten. */
export function restorePersistenceIdentity(db: DatabaseSync): StoreIdentity {
  const source = initializePersistence(db), restoredAt = new Date().toISOString();
  if (source.restoreEpoch >= Number.MAX_SAFE_INTEGER) throw new Error("Agent restore epoch is exhausted; no target identity was allocated.");
  const restoredThreads = Object.fromEntries(db.prepare("SELECT key FROM records WHERE namespace='chat:threads'").all().map(row => [String(row.key), true as const]));
  fenceEvaluationCopy(db, source);
  const identity: StoreIdentity = { ...source, sourceStoreId: source.storeId, storeId: randomUUID(), restoreEpoch: source.restoreEpoch + 1, restoredAt, restoredThreads };
  db.prepare("UPDATE records SET value=? WHERE namespace=? AND key='store'").run(JSON.stringify(identity), PERSISTENCE_NAMESPACE);
  return identity;
}
