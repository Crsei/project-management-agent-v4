import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inventoryPersistence } from "../durable/persistence-schema.ts";

/** Isolated behavior-test fixture only. Refuses any nonempty/noncanonical directory and never opens an existing database. */
export function seedLegacyPersistenceCopy(directory: string, options: { isolated: true }) {
  if (options.isolated !== true || !path.isAbsolute(directory) || realpathSync(directory) !== directory || !lstatSync(directory).isDirectory() || readdirSync(directory).length)
    throw new Error("Legacy testkit requires an explicitly isolated, canonical, empty directory.");
  chmodSync(directory, 0o700);
  const threadId = "legacy-proof-thread", generationId = "legacy-proof-generation", submissionId = "legacy-proof-submission";
  const user = { id: "legacy-proof-input", role: "user", parts: [{ type: "text", text: "Private legal historical input; never replay." }] };
  const assistant = { id: "legacy-proof-output", role: "assistant", parts: [{ type: "text", text: "Saved historical output fixture." }] };
  const now = "2026-01-01T00:00:00.000Z";
  const request = { id: threadId, messages: [user], idempotencyKey: submissionId };
  const db = new DatabaseSync(path.join(directory, "workspace.sqlite"));
  try {
    db.exec("CREATE TABLE records(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)); CREATE TABLE run_events(run_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(run_id,seq)); CREATE TABLE worker_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,token TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO records VALUES(?,?,?)");
    insert.run("chat:threads", threadId, JSON.stringify({ remoteId: threadId, status: "archived", title: "Legacy proof history", revision: 0,
      createdAt: now, updatedAt: now, settings: { providerInstanceId: "historical-provider", model: "historical-model", systemPrompt: "", temperature: 0 } }));
    insert.run("chat:history", JSON.stringify([threadId, "ai-sdk/v6"]), JSON.stringify({ threadId, format: "ai-sdk/v6", headId: assistant.id,
      messages: [{ id: user.id, parent_id: null, format: "ai-sdk/v6", content: user }, { id: assistant.id, parent_id: user.id, format: "ai-sdk/v6", content: assistant }], authoritativeIds: [user.id, assistant.id] }));
    insert.run("chat:generations", generationId, JSON.stringify({ id: generationId, threadId, inputMessageId: user.id, messageId: assistant.id, parentId: user.id,
      status: "completed", createdAt: now, endedAt: now, seq: 0, request, providerInstanceId: "historical-provider", providerInstanceRevision: 1, modelId: "historical-model", temperature: 0, output: assistant }));
    const identity = createHash("sha256").update(JSON.stringify({ threadId, key: submissionId })).digest("hex");
    insert.run("chat:requests", identity, JSON.stringify({ id: generationId, fingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex") }));
    const inventory = inventoryPersistence(db);
    if (inventory.blockers.length) throw new Error("Legacy fixture has invalid relationships.");
    chmodSync(path.join(directory, "workspace.sqlite"), 0o600);
    return { directory, threadId, generationId, submissionId, fingerprint: inventory.fingerprint, recordCount: inventory.records };
  } finally { db.close(); }
}
