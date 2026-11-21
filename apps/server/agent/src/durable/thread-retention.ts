import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { inventoryPersistence, namespacePolicy, persistenceRecords } from "./persistence-schema.ts";
import { deleteEvaluationThread } from "../evaluation-feedback/persistence.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const threadFields: Record<string, true> = { threadId: true, ownerThreadId: true, sourceThreadId: true, parentThreadId: true, targetThreadId: true };
const generationFields: Record<string, true> = { generationId: true, lastGenerationId: true, sourceGenerationId: true, parentGenerationId: true };
/** Follow declared identity fields, never arbitrary prompt/text matches. */
function links(value: unknown, threads: Set<string>, generations: Set<string>): void {
  if (Array.isArray(value)) { for (const child of value) links(child, threads, generations); return; }
  const record = object(value); if (!record) return;
  for (const [field, child] of Object.entries(record)) {
    // Typed references are dependency edges, not ownership. Deleting A must not
    // delete B's immutable history/queue merely because B selected content from A.
    if (field === "contextItems" || field === "acceptedContextItems" || field === "sourceThreadId" && record.forkContext === true) continue;
    if (Object.hasOwn(threadFields, field) && typeof child === "string") threads.add(child);
    else if (Object.hasOwn(generationFields, field) && typeof child === "string") generations.add(child);
    else if ((field === "threadIds" || field === "previousThreadIds") && Array.isArray(child)) for (const id of child) { if (typeof id === "string") threads.add(id); }
    else if (field === "generationIds" && Array.isArray(child)) for (const id of child) { if (typeof id === "string") generations.add(id); }
    else if (child !== null && typeof child === "object") links(child, threads, generations);
  }
}
export type ThreadRetention = {
  threadId: string; generationIds: string[]; retainedGenerationIds: string[];
  references: { namespace: string; key: string }[]; blockers: string[];
  deleteRecords: { namespace: string; key: string }[];
};
export function inspectThreadRetention(db: DatabaseSync, threadId: string, allowActive = false): ThreadRetention {
  const inventory = inventoryPersistence(db, { omitCredentialValues: true }), records = persistenceRecords(db);
  const blockers = [...inventory.blockers];
  const generations = records.filter(row => row.namespace === "chat:generations" && object(row.value)?.threadId === threadId);
  const generationIds = generations.map(row => row.key), ids = new Set(generationIds), retained = new Set<string>();
  const references: ThreadRetention["references"] = [];
  const deliveryIds = new Set(records.filter(row => {
    const value = object(row.value), previous = value?.previousThreadIds;
    return row.namespace === "task-code-delivery-v1" && (value?.threadId === threadId || Array.isArray(previous) && previous.includes(threadId));
  }).map(row => row.key));
  for (const row of records) {
    const threads = new Set<string>(), gens = new Set<string>(); links(row.value, threads, gens);
    // Workspace scratch and immutable acceptance identities are not business references.
    const related = threads.has(threadId) || [...gens].some(id => ids.has(id)) || row.namespace === "task-workflow-runs-v1" && deliveryIds.has(row.key);
    if (!related) continue;
    const value = object(row.value), record = object(value?.record);
    const provenance = row.namespace === "pm-content-provenance" || row.namespace === "pm-quote-provenance";
    const hasDependencies = value?.complete === false || ["operationIds", "targets", "authorities", "contextSources"].some(field => {
      const entries = value?.[field]; return Array.isArray(entries) && entries.length > 0;
    });
    const crossThreadEvidence = ["durable:forks", "durable:transfers"].includes(row.namespace) && threads.size > 1;
    if (namespacePolicy(row.namespace)?.owner === "business" && (!provenance || hasDependencies) || row.namespace === "mcp:tool-receipts" || crossThreadEvidence) {
      references.push({ namespace: row.namespace, key: row.key });
      const exact = [...gens].filter(id => ids.has(id));
      for (const id of exact.length ? exact : generationIds) retained.add(id);
    }
    if (row.namespace === "pm-tool-calls") {
      const status = record?.status, certainty = object(record?.certainty);
      if (["unknown", "running", "pending_approval"].includes(String(status)) || status === "failed" && !["local_rejection", "pm_result", "internal_proof"].includes(String(certainty?.evidence)))
        blockers.push(`unresolved_pm_operation:${row.key}`);
    }
    if (row.namespace === "chat:steering" && value?.status !== "accepted") blockers.push(`unresolved_steering:${row.key}`);
    if (row.namespace === "chat:message-queue" && ["dispatching", "unknown"].includes(String(value?.status))) blockers.push(`unresolved_queue:${row.key}`);
    if (row.namespace === "task-code-delivery-v1" && (value?.pending || ["preparing", "developing"].includes(String(value?.step)))) blockers.push(`managed_delivery:${row.key}`);
    if (row.namespace === "task-workflow-runs-v1" && ["running", "waiting", "queued"].includes(String(value?.status))) blockers.push(`active_workflow:${row.key}`);
    if (row.namespace.startsWith("pm-automation:") && ["accepted", "admitted", "preparing", "submitting", "starting", "created", "container-created", "running", "unknown"].includes(String(value?.phase))) blockers.push(`unresolved_automation:${row.key}`);
    if (row.namespace === "pm-automation:native-operations" && ["pending", "running", "unknown", "dispatching"].includes(String(value?.status))) blockers.push(`unresolved_native_operation:${row.key}`);
    if (row.namespace === "collaboration:runs:v1" && ["queued", "running", "waiting", "interrupted", "unknown"].includes(String(value?.status))) blockers.push(`unresolved_collaboration_run:${row.key}`);
    if (row.namespace === "collaboration:delegations:v1" && !["succeeded", "failed", "cancelled"].includes(String(value?.state ?? value?.status))) blockers.push(`unresolved_delegation:${row.key}`);
  }
  const thread = object(records.find(row => row.namespace === "chat:threads" && row.key === threadId)?.value);
  if (thread?.pendingFork) blockers.push("pending_native_fork");
  if (!allowActive) for (const row of generations) if (["queued", "running"].includes(String(object(row.value)?.status))) blockers.push(`active_generation:${row.key}`);
  const deleteRecords: ThreadRetention["deleteRecords"] = [];
  for (const row of records) {
    const value = object(row.value), threads = new Set<string>(), gens = new Set<string>(); links(row.value, threads, gens);
    if (row.namespace === "chat:sidebar" && row.key === threadId) threads.add(threadId);
    if (row.namespace === "provider:t3code:continuations" && value?.ownerThreadId === threadId) threads.add(threadId);
    const related = threads.has(threadId) || [...gens].some(id => ids.has(id));
    if (!related) continue;
    const policy = namespacePolicy(row.namespace);
    if (policy?.deletion === "visible" || row.namespace === "provider:t3code:continuations" || row.namespace === "mcp-app-model-context-v1") deleteRecords.push({ namespace: row.namespace, key: row.key });
    else if (["chat:events", "native-output", "chat:execution-grants", "mcp-app-producing-items-v1"].includes(row.namespace) && ![...gens].some(id => retained.has(id))) deleteRecords.push({ namespace: row.namespace, key: row.key });
    else if (["pm-content-provenance", "pm-quote-provenance"].includes(row.namespace) && !references.some(reference => reference.namespace === row.namespace && reference.key === row.key))
      deleteRecords.push({ namespace: row.namespace, key: row.key });
  }
  return { threadId, generationIds, retainedGenerationIds: [...retained].sort(), references, blockers: [...new Set(blockers)], deleteRecords };
}
/** Only after actual owned runtimes stopped, under the lifecycle commit transaction. No bytes/PM records are deleted. */
export function commitThreadRetention(db: DatabaseSync, retention: ThreadRetention): void {
  deleteEvaluationThread(db, retention.threadId);
  const remove = db.prepare("DELETE FROM records WHERE namespace=? AND key=?");
  for (const row of retention.deleteRecords) remove.run(row.namespace, row.key);
  const retained = new Set(retention.retainedGenerationIds);
  for (const row of db.prepare("SELECT key,value FROM records WHERE namespace='chat:steering'").all()) {
    const value = JSON.parse(String(row.value)) as ObjectValue;
    if (value.threadId !== retention.threadId || retained.has(String(value.generationId))) continue;
    db.prepare("UPDATE records SET value=? WHERE namespace='chat:steering' AND key=?").run(JSON.stringify({
      id: value.id, threadId: value.threadId, generationId: value.generationId, status: value.status, createdAt: value.createdAt,
      inputDigest: createHash("sha256").update(String(value.text ?? "")).digest("hex"), deletedSource: true,
    }), String(row.key));
  }
  for (const id of retention.generationIds) {
    if (retained.has(id)) continue;
    const row = db.prepare("SELECT value FROM records WHERE namespace='chat:generations' AND key=?").get(id);
    if (!row) continue;
    const old = JSON.parse(String(row.value)) as ObjectValue;
    const request = object(old.request);
    const tombstone: ObjectValue = { persistenceTombstone: true };
    for (const field of ["id", "threadId", "messageId", "inputMessageId", "parentId", "status", "createdAt", "endedAt", "seq", "providerInstanceId", "providerInstanceRevision", "modelId", "temperature"]) if (old[field] !== undefined) tombstone[field] = old[field];
    tombstone.request = { id: retention.threadId, messages: [], ...(request?.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}) };
    db.prepare("UPDATE records SET value=? WHERE namespace='chat:generations' AND key=?").run(JSON.stringify(tombstone), id);
    db.prepare("DELETE FROM run_events WHERE run_id=?").run(id);
  }
}
