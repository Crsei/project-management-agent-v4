import { startTaskWorkflows, stopTaskWorkflows } from "./task-workflows/runner.ts";
import { startExecution, stopExecution } from "./durable/engine.ts";
import { startChatRuntime, stopChatRuntime } from "./durable/chat-runtime.ts";
import { closeStore, getDatabase } from "./durable/store.ts";
import { startAutomation, stopAutomation } from "./automation/index.ts";
import { startPmProviderApplication, stopPmProviderApplication, stopPmProviderMaintenance } from "./providers/t3code/application.ts";
import { providerApplicationOptions } from "./providers/t3code/production.ts";
import { migrateProviderStartupState } from "./providers/instances.ts";
import { startAutomationExecutionRuntime, stopAutomationExecutionRuntime } from "./automation-execution/index.ts";
import { recoverAutomationGenerationConnectors } from "./automation-execution/connectors.ts";
import { closeMcpServer, startMcpServer } from "./mcp/server.ts";

let starting: Promise<void> | null = null;
let stopping: Promise<void> | null = null;

/** Hosts call this before accepting requests; imports alone never start workers. */
export function startRuntime(): Promise<void> {
  if (stopping) return stopping.then(() => startRuntime());
  if (starting) return starting;
  starting = (async () => {
    try {
      // Claim the existing app-private store owner before any one-time native state conversion.
      getDatabase();
      await migrateProviderStartupState();
      if (stopping) return;
      await startPmProviderApplication(providerApplicationOptions);
      if (stopping) return;
      await startChatRuntime();
      if (stopping) return;
      await recoverAutomationGenerationConnectors();
      if (stopping) return;
      await startExecution();
      if (stopping) return;
      await startAutomation();
      if (stopping) return;
      await startAutomationExecutionRuntime();
      if (stopping) return;
      startTaskWorkflows();
      startMcpServer();
    } catch (error) {
      const protocols = Promise.allSettled([closeMcpServer()]);
      const maintenance = Promise.allSettled([stopPmProviderMaintenance()]);
      const workflows = await Promise.allSettled([stopTaskWorkflows()]);
      const automationExecutions = await Promise.allSettled([stopAutomationExecutionRuntime()]);
      const workers = await Promise.allSettled([stopAutomation(), stopExecution(), stopChatRuntime()]);
      const drained = await maintenance;
      const protocolResults = await protocols;
      const providers = await Promise.allSettled([stopPmProviderApplication()]);
      closeStore();
      starting = null;
      const cleanupFailures = [...workflows, ...automationExecutions, ...workers, ...drained, ...protocolResults, ...providers].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], "工作区启动失败且后台清理失败。");
      throw error;
    }
  })();
  return starting;
}

export function stopRuntime(): Promise<void> {
  if (stopping) return stopping;
  // Fence admissions and signal HTTP/direct installers before awaiting any worker or cleanup.
  const maintenance = Promise.allSettled([stopPmProviderMaintenance()]);
  const protocols = Promise.allSettled([closeMcpServer()]);
  stopping = (async () => {
    if (starting) await starting.catch(() => undefined);
    try {
      const workflows = await Promise.allSettled([stopTaskWorkflows()]);
      const automation = await Promise.allSettled([stopAutomation(), stopAutomationExecutionRuntime()]);
      const workers = await Promise.allSettled([stopExecution(), stopChatRuntime()]);
      const drained = await maintenance;
      const protocolResults = await protocols;
      const providers = await Promise.allSettled([stopPmProviderApplication()]);
      const failures = [...workflows, ...automation, ...workers, ...drained, ...protocolResults, ...providers].flatMap((result) =>
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
