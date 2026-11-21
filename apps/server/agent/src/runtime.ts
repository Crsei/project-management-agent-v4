import { startProductCanvases, stopProductCanvases } from "./product-canvas/index.ts";
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
import { startCollaborationRuntime, stopCollaborationRuntime } from "./collaboration/runs.ts";
import { startEvaluationMaintenance, stopEvaluationMaintenance } from "./evaluation-feedback/service.ts";

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
      startEvaluationMaintenance();
      await startCollaborationRuntime({ newLifecycle: true });
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
      startProductCanvases();
      startMcpServer();
    } catch (error) {
      stopEvaluationMaintenance();
      const protocols = Promise.allSettled([closeMcpServer()]);
      const maintenance = Promise.allSettled([stopPmProviderMaintenance()]);
      const collaboration = Promise.allSettled([stopCollaborationRuntime()]);
      const canvas = await Promise.allSettled([stopProductCanvases()]);
      const workflows = [...canvas, ...await Promise.allSettled([stopTaskWorkflows()])];
      const automationExecutions = await Promise.allSettled([stopAutomationExecutionRuntime()]);
      const collaborationResults = await collaboration;
      const workers = await Promise.allSettled([stopAutomation(), stopExecution(), stopChatRuntime()]);
      const drained = await maintenance;
      const protocolResults = await protocols;
      const providers = await Promise.allSettled([stopPmProviderApplication()]);
      closeStore();
      starting = null;
      const cleanupFailures = [...workflows, ...automationExecutions, ...collaborationResults, ...workers, ...drained, ...protocolResults, ...providers].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], "工作区启动失败且后台清理失败。");
      throw error;
    }
  })();
  return starting;
}

export function stopRuntime(): Promise<void> {
  if (stopping) return stopping;
  stopEvaluationMaintenance();
  // Fence admissions and signal HTTP/direct installers before awaiting any worker or cleanup.
  const collaboration = Promise.allSettled([stopCollaborationRuntime()]);
  const maintenance = Promise.allSettled([stopPmProviderMaintenance()]);
  const protocols = Promise.allSettled([closeMcpServer()]);
  stopping = (async () => {
    if (starting) await starting.catch(() => undefined);
    try {
      const canvas = await Promise.allSettled([stopProductCanvases()]);
      const workflows = [...canvas, ...await Promise.allSettled([stopTaskWorkflows()])];
      const automation = await Promise.allSettled([stopAutomation(), stopAutomationExecutionRuntime()]);
      const collaborationResults = await collaboration;
      const workers = await Promise.allSettled([stopExecution(), stopChatRuntime()]);
      const drained = await maintenance;
      const protocolResults = await protocols;
      const providers = await Promise.allSettled([stopPmProviderApplication()]);
      const failures = [...workflows, ...automation, ...collaborationResults, ...workers, ...drained, ...protocolResults, ...providers].flatMap((result) =>
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
