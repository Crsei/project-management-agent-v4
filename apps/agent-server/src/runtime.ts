import { startExecution, stopExecution } from "./durable/engine.ts";
import { startChatRuntime, stopChatRuntime } from "./durable/chat-runtime.ts";
import { closeStore } from "./durable/store.ts";
import { startAutomation, stopAutomation } from "./automation/index.ts";

let starting: Promise<void> | null = null;
let stopping: Promise<void> | null = null;

/** Hosts call this before accepting requests; imports alone never start workers. */
export function startRuntime(): Promise<void> {
  if (stopping) return stopping.then(() => startRuntime());
  if (starting) return starting;
  starting = (async () => {
    try {
      await startChatRuntime();
      await startExecution();
      await startAutomation();
    } catch (error) {
      await Promise.allSettled([stopAutomation(), stopExecution(), stopChatRuntime()]);
      closeStore();
      starting = null;
      throw error;
    }
  })();
  return starting;
}

export function stopRuntime(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    if (starting) await starting.catch(() => undefined);
    try {
      const automation = await Promise.allSettled([stopAutomation()]);
      const workers = await Promise.allSettled([stopExecution(), stopChatRuntime()]);
      const failures = [...automation, ...workers].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "工作区后台任务关闭失败。");
    } finally {
      closeStore();
      starting = null;
      stopping = null;
    }
  })();
  return stopping;
}
