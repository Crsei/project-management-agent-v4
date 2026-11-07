import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type RecordRow = { namespace: string; key: string; value: string };
type JsonObject = Record<string, unknown>;
export type SessionCutoverPlan = {
  format: "agent-session-cutover-v2"; dataDirectory: string; fingerprint: string;
  candidateIds: string[]; generationIds: string[]; retainedGenerationIds: string[];
  deleteRecords: { namespace: string; key: string }[];
  references: { namespace: string; key: string; kind: "business-evidence" | "mcp-grant" | "mcp-receipt" }[];
  blockers: string[]; unclassifiedNamespaces: { namespace: string; count: number }[];
  retainedAttachmentIds: string[];
  namespaceInventory: { namespace: string; count: number; ownership: "session" | "business" | "credentials" | "settings-usage" | "workspaces" | "audit" | "unclassified" }[];
};
const sessionOwned: Record<string, true> = { "chat:history": true, "chat:sidebar": true, "chat:generations": true, "chat:events": true, "chat:requests": true, "chat:cancellations": true, "chat:imports": true, "native-output": true, "provider:t3code:continuations": true, "mcp-app-model-context-v1": true, "mcp-app-producing-items-v1": true, "mcp-app-private-assets-v1": true, "durable:workspaces": true, "durable:imports": true, "durable:forks": true, "durable:transfers": true, "durable:fork-keys": true };
const business = /^(?:task-|pm-automation:|automation\.|pm-tool|pm-core|durable:(?:runs|requests|submissions|events))/;
const preservedMetadata: Record<string, true> = { "settings:chat-defaults": true, "settings:usage": true, "usage:turns": true, "usage:threads": true, "usage:launches": true, "usage:pricing": true, "pm-analysis:scratch-v1": true, "automation.schedules": true, "automation.watches": true, "automation.dispatches": true, "automation.recovery": true };
const credentialNamespaces: Record<string, true> = { "mcp:tokens": true, "mcp:codes": true, "mcp:consents": true };
const scanned = (namespace: string) => sessionOwned[namespace] === true || namespace === "chat:threads" || namespace === "mcp:grants" || namespace === "mcp:tool-receipts" || business.test(namespace);
function object(value: unknown): JsonObject | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function mentions(value: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some(child => mentions(child, ids));
  const record = object(value);
  return record !== null && Object.values(record).some(child => mentions(child, ids));
}
function collectReferences(value: unknown, ids: ReadonlySet<string>, found: Set<string>): void {
  if (typeof value === 'string') { if (ids.has(value)) found.add(value); return; }
  if (Array.isArray(value)) { for (const child of value) collectReferences(child, ids, found); return; }
  const record = object(value);
  if (record) for (const child of Object.values(record)) collectReferences(child, ids, found);
}
function keyValue(key: string): unknown { try { return JSON.parse(key); } catch { return key; } }
/** No credential namespace is read. Plans expose IDs/counts, never message bodies or native history. */
export function inventorySessionCutover(db: DatabaseSync, dataDirectory: string): SessionCutoverPlan {
  const namespaces = db.prepare("SELECT namespace,count(*) AS count FROM records GROUP BY namespace ORDER BY namespace").all().map(row => ({ namespace: String(row.namespace), count: Number(row.count) }));
  const namespaceInventory = namespaces.map((row): SessionCutoverPlan['namespaceInventory'][number] => ({ ...row, ownership: row.namespace === 'chat:threads' || sessionOwned[row.namespace] === true ? 'session'
    : business.test(row.namespace) || row.namespace === 'mcp:grants' || row.namespace === 'mcp:tool-receipts' ? 'business'
    : credentialNamespaces[row.namespace] === true ? 'credentials' : preservedMetadata[row.namespace] === true ? 'settings-usage'
    : row.namespace === 'agent:workspaces:v1' || row.namespace === 'agent:scratch:v1' ? 'workspaces'
    : row.namespace === 'agent:session-cutover' ? 'audit' : 'unclassified' }));
  const records: RecordRow[] = [];
  for (const { namespace } of namespaces) if (scanned(namespace)) for (const row of db.prepare("SELECT namespace,key,value FROM records WHERE namespace=? ORDER BY key").all(namespace))
    records.push({ namespace: String(row.namespace), key: String(row.key), value: String(row.value) });
  const decoded = records.map(row => ({ ...row, data: JSON.parse(row.value) as unknown }));
  const candidates = decoded.filter(row => {
    if (row.namespace !== "chat:threads" || object(object(row.data)?.sessionCutover)?.version === 2) return false;
    const version = object(object(row.data)?.executionSelection)?.version;
    return version === undefined || version === 1;
  });
  const candidateIds = candidates.map(row => row.key).sort();
  const threads = new Set(candidateIds);
  const generations = decoded.filter(row => row.namespace === "chat:generations" && mentions(object(row.data)?.threadId, threads));
  const generationIds = generations.map(row => row.key).sort(), generationSet = new Set(generationIds);
  const all = new Set([...threads, ...generationSet]);
  const references: SessionCutoverPlan['references'] = [];
  const retained = new Set<string>();
  const blockers: string[] = [];
  for (const row of decoded) {
    if (row.namespace !== "chat:threads") continue;
    const version = object(object(row.data)?.executionSelection)?.version;
    if (version !== undefined && version !== 1 && version !== 2)
      blockers.push(`Session ${row.key} has an unsupported execution version; inspect it before cutover.`);
  }
  const deliveryIds = new Set<string>();
  for (const row of decoded) {
    if (business.test(row.namespace) && (mentions(row.data, all) || mentions(keyValue(row.key), all))) {
      references.push({ namespace: row.namespace, key: row.key, kind: "business-evidence" });
      const associated = new Set<string>(); collectReferences(row.data, all, associated); collectReferences(keyValue(row.key), all, associated);
      let narrowed = false;
      for (const id of generationIds) if (associated.has(id)) { retained.add(id); narrowed = true; }
      if (!narrowed) for (const generation of generations) if (associated.has(String(object(generation.data)?.threadId))) retained.add(generation.key);
      if (row.namespace === 'durable:runs' && ['queued', 'running'].includes(String(object(row.data)?.status))) blockers.push(`Historical resource run ${row.key} is active; stop/reconcile it before cutover.`);
      if (['pm-automation:executions', 'pm-automation:native-template-executions', 'pm-automation:native-template-children', 'pm-automation:native-workspace-runs'].includes(row.namespace) && ['accepted', 'admitted', 'preparing', 'submitting', 'container-created', 'created', 'starting', 'running'].includes(String(object(row.data)?.phase)))
        blockers.push(`Automation execution ${row.key} is active; stop/reconcile its original runtime before cutover.`);
      if (row.namespace === "task-code-delivery-v1") {
        deliveryIds.add(row.key);
        if (object(row.data)?.pending) blockers.push(`Delivery ${row.key} has an unresolved operation; reconcile it before cutover.`);
      }
    }
    if (row.namespace === "mcp:grants" && mentions(object(row.data)?.threadIds, threads)) references.push({ namespace: row.namespace, key: row.key, kind: "mcp-grant" });
    if (row.namespace === "mcp:tool-receipts" && (mentions(row.data, all) || mentions(keyValue(row.key), all))) references.push({ namespace: row.namespace, key: row.key, kind: "mcp-receipt" });
  }
  for (const row of decoded) if (row.namespace === "task-workflow-runs-v1" && deliveryIds.has(row.key) && ["running", "waiting"].includes(String(object(row.data)?.status)))
    blockers.push(`Workflow ${row.key} is active; pause/reconcile through its existing controls before cutover.`);
  for (const row of generations) if (["running", "queued"].includes(String(object(row.data)?.status))) blockers.push(`Generation ${row.key} is active; use the existing stop/shutdown semantics first.`);
  const retainedIds = new Set([...threads, ...generationIds.filter(id => !retained.has(id))]);
  const deleteRecords = decoded.filter(row => sessionOwned[row.namespace] === true && (row.namespace === 'chat:imports' || row.namespace === 'durable:imports' || mentions(row.data, retainedIds) || mentions(keyValue(row.key), retainedIds)) && !(row.namespace === "chat:generations" && retained.has(row.key)) && !(row.namespace === "native-output" && retained.has(String(object(row.data)?.generationId))))
    .map(row => ({ namespace: row.namespace, key: row.key }));
  // Retained generation/output are immutable task/workflow evidence, not usable Chat Sessions.
  for (let index = deleteRecords.length - 1; index >= 0; index--) {
    const deletion = deleteRecords[index]!;
    const row = decoded.find(row => row.namespace === deletion.namespace && row.key === deletion.key)!;
    if (retained.size && (row.namespace === "chat:events" || row.namespace === "native-output" || row.namespace === "mcp-app-producing-items-v1") && (mentions(keyValue(row.key), retained) || mentions(object(row.data)?.generationId, retained))) deleteRecords.splice(index, 1);
  }
  const retainedAttachmentIds = decoded.filter(row => row.namespace === 'mcp-app-private-assets-v1' && mentions(row.data, threads)).map(row => row.key).sort();
  const attachmentSet = new Set(retainedAttachmentIds), evidenceAssets = new Set<string>();
  for (const row of decoded) if (row.namespace === 'native-output' && retained.has(row.key)) collectReferences(row.data, attachmentSet, evidenceAssets);
  for (const id of retainedAttachmentIds) {
    if (evidenceAssets.has(id)) {
      const index = deleteRecords.findIndex(row => row.namespace === 'mcp-app-private-assets-v1' && row.key === id);
      if (index >= 0) deleteRecords.splice(index, 1);
    }
  }
  const unclassifiedNamespaces = namespaceInventory.filter(row => row.ownership === 'unclassified').map(({ namespace, count }) => ({ namespace, count }));
  for (const row of unclassifiedNamespaces) blockers.push(`Unclassified namespace ${row.namespace} (${row.count} records); audit its ownership before any deletion. Values were not read.`);
  const digest = createHash("sha256").update(JSON.stringify({ dataDirectory, namespaceInventory, candidateIds, deleteRecords, retained: [...retained].sort() }));
  for (const row of records) digest.update(row.namespace).update('\0').update(row.key).update('\0').update(row.value).update('\0');
  const fingerprint = digest.digest("hex");
  return { format: "agent-session-cutover-v2", dataDirectory, fingerprint, candidateIds, generationIds, retainedGenerationIds: [...retained].sort(), deleteRecords, references, blockers,
    unclassifiedNamespaces, namespaceInventory, retainedAttachmentIds };
}
export function applySessionCutover(db: DatabaseSync, expected: SessionCutoverPlan, dataDirectory: string): SessionCutoverPlan {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = inventorySessionCutover(db, dataDirectory);
    if (expected.format !== current.format || expected.dataDirectory !== dataDirectory || expected.fingerprint !== current.fingerprint || JSON.stringify(expected.candidateIds) !== JSON.stringify(current.candidateIds))
      throw new Error("Cutover plan changed or belongs to another application directory. Generate and review a fresh inventory; nothing was deleted.");
    if (current.blockers.length) throw new Error(`Cutover blocked: ${current.blockers.join(" ")}`);
    const remove = db.prepare("DELETE FROM records WHERE namespace=? AND key=?");
    for (const row of current.deleteRecords) remove.run(row.namespace, row.key);
    const at = new Date().toISOString();
    for (const id of current.candidateIds) {
      db.prepare("UPDATE records SET value=? WHERE namespace='chat:threads' AND key=?").run(JSON.stringify({ remoteId: id, deleted: true, sessionCutover: { version: 2, at, fingerprint: current.fingerprint } }), id);
    }
    const ids = new Set(current.candidateIds);
    for (const reference of current.references.filter(row => row.kind === "mcp-grant")) {
      const row = db.prepare("SELECT value FROM records WHERE namespace=? AND key=?").get(reference.namespace, reference.key);
      const grant = object(JSON.parse(String(row!.value)))!;
      grant.threadIds = (grant.threadIds as string[]).filter(id => !ids.has(id));
      db.prepare("UPDATE records SET value=? WHERE namespace=? AND key=?").run(JSON.stringify(grant), reference.namespace, reference.key);
    }
    for (const reference of current.references.filter(row => row.kind === 'mcp-receipt')) {
      const row = db.prepare('SELECT value FROM records WHERE namespace=? AND key=?').get(reference.namespace, reference.key);
      const receipt = object(JSON.parse(String(row!.value)))!;
      db.prepare('UPDATE records SET value=? WHERE namespace=? AND key=?').run(JSON.stringify({ fingerprint: receipt.fingerprint, status: 'unknown', result: { status: 'deleted', message: 'Original Session was removed by explicit cutover; no request was replayed.' } }), reference.namespace, reference.key);
    }
    const retained = new Set(current.retainedGenerationIds);
    const removeEvents = db.prepare("DELETE FROM run_events WHERE run_id=?");
    for (const id of current.generationIds) if (!retained.has(id)) removeEvents.run(id);
    db.prepare("INSERT INTO records(namespace,key,value) VALUES('agent:session-cutover',?,?)").run(current.fingerprint, JSON.stringify({ version: 2, at, candidateIds: current.candidateIds, retainedGenerationIds: current.retainedGenerationIds, referenceCounts: current.references.reduce<Record<string, number>>((counts, row) => { counts[row.namespace] = (counts[row.namespace] ?? 0) + 1; return counts; }, {}) }));
    db.exec("COMMIT"); return current;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
/** Explicit stopped application only. Acquires the same exclusive ownership file without opening the live store. */
export function withOfflineSessionCutover<T>(directory: string, stopped: boolean, operation: (db: DatabaseSync, canonical: string) => T): T {
  if (!stopped || !path.isAbsolute(directory)) throw new Error("An explicit absolute --data directory and --stopped assertion are required.");
  const root = realpathSync(directory);
  if (root !== path.resolve(directory) || !lstatSync(root).isDirectory()) throw new Error("Cutover data directory must be canonical and not a symlink.");
  const filename = path.join(root, "workspace.sqlite"), databaseInfo = lstatSync(filename);
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink() || databaseInfo.nlink !== 1) throw new Error("Refusing nonregular, linked or missing application database.");
  const lock = path.join(root, "workspace.lock");
  if (existsSync(lock)) throw new Error("Agent ownership lock exists. Stop the owning service; verify and remove a stale lock explicitly. No process was signalled.");
  const token = randomUUID(), fd = openSync(lock, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, kind: "session-cutover" })); } finally { closeSync(fd); }
  const original = lstatSync(lock);
  let db: DatabaseSync | undefined;
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    db = new DatabaseSync(filename);
    const owner = db.prepare("SELECT pid FROM worker_owner WHERE singleton=1").get();
    if (owner) {
      if (!Number.isSafeInteger(Number(owner.pid)) || Number(owner.pid) <= 0) throw new Error('Invalid durable worker PID; refusing process inspection or cutover.');
      try { process.kill(Number(owner.pid), 0); throw new Error("Agent SQLite has a live owner; stop it before cutover."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    result = operation(db, root);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    db?.close();
    const current = lstatSync(lock), owner = JSON.parse(readFileSync(lock, "utf8")) as { token: string };
    if (current.dev !== original.dev || current.ino !== original.ino || owner.token !== token) throw new Error("Cutover lock identity changed; refusing to remove another owner's lock.");
    unlinkSync(lock);
  } catch (error) {
    if (operationFailed) throw new AggregateError([operationError, error], "Cutover and ownership cleanup both failed.");
    throw error;
  }
  if (operationFailed) throw operationError;
  return result as T;
}
