import { productCanvasRoutes } from "./product-canvas/index.ts";
import { taskWorkflowRoutes } from "./task-workflows/index.ts";
import { taskDeliveryRoutes } from "./task-delivery/index.ts";
import { Hono } from "hono";
import { chatRoutes } from "./chat.ts";
import { inspectorRoutes } from "./inspector/index.ts";
import { providerRoutes } from "./providers/routes.ts";
import { workspaceRoutes } from "./workspace.ts";
import { agentWorkspaceRoutes, internalAgentWorkspaceRoutes } from "./agent-workspace-routes.ts";
import { accessGuard, accessRoutes } from "./access.ts";
import { automationRoutes } from "./automation/index.ts";
import { settingsRoutes } from "./settings/routes.ts";
import { diagnosticsRoutes } from "./settings/diagnostics.ts";
import { usageRoutes } from "./usage/routes.ts";
import { pmToolRoutes } from "./pm-tools.ts";
import { pmCoreChangesRoutes } from "./pm-core-changes/index.ts";
import { pmCapabilityRoutes } from "./pm-capability-routes.ts";
import { automationExecutionRoutes } from "./automation-execution/index.ts";
import { mcpOAuthRoutes, mcpIntrospectionRoutes } from "./mcp/routes.ts";
import { mcpRoutes } from "./mcp/server.ts";
import { mcpAppRoutes } from "./mcp-apps/routes.ts";
import { extensionRoutes, extensionDefinitionRoutes } from "./extensions/index.ts";
import { collaborationDefinitionRoutes } from "./collaboration/definition-routes.ts";
import { runRoutes } from "./collaboration/run-routes.ts";
import { collaborationCapabilityRoutes } from "./collaboration/capability-routes.ts";
import { collaborationInboxRoutes } from "./collaboration/inbox-routes.ts";
import { evaluationFeedbackRoutes } from "./evaluation-feedback/routes.ts";
import { AGENT_API_VERSION, type AgentRuntimeInfo } from "@agent-workspace/contracts/chat";

/** Optional, operator-declared build identity; omitted rather than guessed. */
const buildMode = process.env.AGENT_WORKSPACE_BUILD_MODE?.trim();
const runtimeInfo: AgentRuntimeInfo = { apiVersion: AGENT_API_VERSION, ...(buildMode ? { buildMode } : {}) };

/** API application; imports alone never start listeners or background workers. */
export const app = new Hono()
  .route("/", mcpIntrospectionRoutes)
  .route("/", mcpOAuthRoutes)
  .route("/", mcpRoutes)
  .route("/internal/automation-executions", automationExecutionRoutes)
  .route("/internal/extensions/definitions", extensionDefinitionRoutes)
  .route("/internal/agent-workspaces", internalAgentWorkspaceRoutes)
  .route("/api", accessRoutes)
  .use("/api/*", accessGuard)
  // Read-only Agent identity for the bundled UI; no paths, tokens or configuration.
  .get("/api/runtime", (c) =>
    c.json(runtimeInfo, 200, { "cache-control": "no-store" }),
  )
  .route("/api", mcpAppRoutes)
  .route("/api", extensionRoutes)
  .route("/api", chatRoutes)
  .route("/api", collaborationDefinitionRoutes)
  .route("/api", runRoutes)
  .route("/api", collaborationCapabilityRoutes)
  .route("/api", collaborationInboxRoutes)
  .route("/api", evaluationFeedbackRoutes)
  .route("/api", taskDeliveryRoutes)
  .route("/api", taskWorkflowRoutes)
  .route("/api", productCanvasRoutes)
  .route("/api", pmToolRoutes)
  .route("/api", pmCoreChangesRoutes)
  .route("/api", pmCapabilityRoutes)
  .route("/api", workspaceRoutes)
  .route("/api", agentWorkspaceRoutes)
  .route("/api", automationRoutes)
  .route("/api", providerRoutes)
  .route("/api", settingsRoutes)
  .route("/api", diagnosticsRoutes)
  .route("/api", inspectorRoutes)
  .route("/api", usageRoutes);
