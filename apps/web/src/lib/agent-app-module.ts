import { createRouteModuleLoader } from "./route-module"

// Importing code does not mount the Agent access gate, Chat runtime, or subscriptions.
export const loadAgentApp = createRouteModuleLoader(() =>
  import("@/features/agent/src/app").then(module => ({ default: module.App })),
)
