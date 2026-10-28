import { EventEmitter } from "node:events";
import type { WorkspaceRun, WorkspaceRunEvent } from "@agent-workspace/contracts/workspace";
import { getDatabase, transaction, writeRecord } from "./store.ts";
import { RUN_NAMESPACE } from "./resources.ts";

const eventsKey = Symbol.for("agent-workspace.run-event-notifications");
const globals = globalThis as typeof globalThis & { [eventsKey]?: EventEmitter };
const notifications = (globals[eventsKey] ??= new EventEmitter());
notifications.setMaxListeners(0);

/** Commit a run and its next sequence in the same transaction. Notification is only a wakeup. */
export function saveRun(run: WorkspaceRun): void {
  transaction(() => {
    run.seq = (run.seq ?? 0) + 1;
    const event: WorkspaceRunEvent = {
      type: "snapshot",
      runId: run.id,
      seq: run.seq,
      at: new Date().toISOString(),
      run,
    };
    writeRecord(RUN_NAMESPACE, run.id, run);
    getDatabase()
      .prepare("INSERT INTO run_events(run_id, seq, event) VALUES (?, ?, ?)")
      .run(run.id, run.seq, JSON.stringify(event));
  });
  notifications.emit(run.id);
}
export function readRunEvents(runId: string, after: number, limit = 100): WorkspaceRunEvent[] {
  return getDatabase()
    .prepare("SELECT event FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(runId, after, limit)
    .map((row) => JSON.parse(String(row.event)) as WorkspaceRunEvent);
}
export function onRunEvent(runId: string, notify: () => void): () => void {
  notifications.on(runId, notify);
  return () => {
    notifications.off(runId, notify);
  };
}
