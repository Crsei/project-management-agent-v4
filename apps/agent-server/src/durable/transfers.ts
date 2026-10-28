import type { ContextTransfer, ThreadFork } from "@agent-workspace/contracts/durable";
import { boundedContext } from "./context.ts";
import { listRecords, readRecord, writeRecord } from "./store.ts";

export const FORKS = "durable:forks";
export const TRANSFERS = "durable:transfers";
export function getThreadFork(threadId: string): ThreadFork | null {
  return readRecord<ThreadFork>(FORKS, threadId);
}
/** Must be called inside the run-submission transaction, after idempotency lookup. */
export function consumeTransfers(threadId: string, runId: string): string {
  const transfers = listRecords<ContextTransfer>(TRANSFERS).filter(
    (item) => item.parentThreadId === threadId && !item.consumedAt,
  );
  // Do not silently mark context consumed if it cannot be included in the snapshot.
  let used = 0;
  const included: ContextTransfer[] = [];
  for (const transfer of transfers) {
    if (used + transfer.text.length + 2 > 20_000) break;
    used += transfer.text.length + 2;
    included.push(transfer);
  }
  for (const transfer of included) {
    writeRecord(TRANSFERS, transfer.sourceThreadId, {
      ...transfer,
      consumedAt: new Date().toISOString(),
      consumedByRunId: runId,
    });
  }
  return boundedContext(included.map((transfer) => transfer.text));
}
