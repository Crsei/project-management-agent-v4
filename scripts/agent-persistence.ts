import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { withOfflineSessionCutover } from "../apps/server/agent/src/maintenance/session-cutover.ts";
import { bootstrapLegacyPersistence, inventoryPersistence, rollbackLegacyPersistence, type PersistenceInventory } from "../apps/server/agent/src/durable/persistence-schema.ts";

try {
const { values } = parseArgs({ strict: true, options: {
  data: { type: "string" }, stopped: { type: "boolean" }, "isolated-copy": { type: "boolean" },
  output: { type: "string" }, plan: { type: "string" }, apply: { type: "boolean" }, rollback: { type: "boolean" },
  "history-thread": { type: "string" },
} });
if (!values.data || !values.stopped || !values["isolated-copy"] || values.apply && values.rollback || (values.apply || values.rollback) && !values.plan || values["history-thread"] && (!values.output || values.apply || values.rollback))
  throw new Error("Usage: node scripts/agent-persistence.ts --data /absolute/stopped-copy --stopped --isolated-copy [--output /private/new-plan.json | --apply --plan /private/reviewed-plan.json | --rollback --plan /private/original-plan.json | --history-thread ID --output /private/history.json]. This command never stops services; source/production migration is not authorized.");
const result = withOfflineSessionCutover(values.data, true, (db, root) => {
  if (values["history-thread"]) {
    const rows = db.prepare("SELECT value FROM records WHERE namespace='chat:history' AND json_extract(value,'$.threadId')=? ORDER BY key").all(values["history-thread"]);
    return { format: "agent-private-history-export-v1", threadId: values["history-thread"], histories: rows.map(row => JSON.parse(String(row.value)) as unknown), readOnly: true, executionRestored: false };
  }
  if (values.apply || values.rollback) {
    const plan = JSON.parse(readFileSync(values.plan!, "utf8")) as PersistenceInventory & { dataDirectory: string };
    if (plan.format !== "agent-persistence-inventory-v1" || plan.dataDirectory !== root || plan.blockers.length)
      throw new Error("Reviewed plan is incompatible, blocked, or belongs to another copy.");
    if (values.rollback) { rollbackLegacyPersistence(db, plan.fingerprint); return { mode: "rolled-back-unchanged-copy", inventory: inventoryPersistence(db) }; }
    const identity = bootstrapLegacyPersistence(db, plan.fingerprint);
    return { mode: "applied-nondestructive-copy-bootstrap", identity, inventory: inventoryPersistence(db) };
  }
  return { ...inventoryPersistence(db), dataDirectory: root };
});
if (values.output) writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(values["history-thread"] ? { mode: "private-history-export", output: values.output, executionRestored: false } : result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: "persistence_maintenance_failed",
    message: error instanceof SyntaxError ? "Invalid persisted JSON; original data was not migrated." : error instanceof Error ? error.message : "Persistence maintenance failed without replay." }));
  process.exitCode = 1;
}
