"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-studio-integrations/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentStudioIntegrationsRemainingExplorer = createRemainingExplorer({
  pageId: "agent-studio-integrations",
  routeId: "agent-studio/integrations",
  title: { "zh-CN": "Integrations", en: "Integrations" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
