import { taskWorkflowRoutes } from "./task-workflows/index.ts";
import { taskDeliveryRoutes } from "./task-delivery/index.ts";
import { Hono } from "hono";
import { chatRoutes } from "./chat.ts";
import { inspectorRoutes } from "./inspector/index.ts";
import { providerRoutes } from "./providers/routes.ts";
import { workspaceRoutes } from "./workspace.ts";
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

/** API application; imports alone never start listeners or background workers. */
export const app = new Hono()
  .route("/", mcpIntrospectionRoutes)
  .route("/", mcpOAuthRoutes)
  .route("/", mcpRoutes)
  .route("/internal/automation-executions", automationExecutionRoutes)
  .route("/api", accessRoutes)
  .use("/api/*", accessGuard)
  .route("/api", mcpAppRoutes)
  .route("/api", chatRoutes)
  .route("/api", taskDeliveryRoutes)
  .route("/api", taskWorkflowRoutes)
  .route("/api", pmToolRoutes)
  .route("/api", pmCoreChangesRoutes)
  .route("/api", pmCapabilityRoutes)
  .route("/api", workspaceRoutes)
  .route("/api", automationRoutes)
  .route("/api", providerRoutes)
  .route("/api", settingsRoutes)
  .route("/api", diagnosticsRoutes)
  .route("/api", inspectorRoutes)
  .route("/api", usageRoutes);
