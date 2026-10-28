"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-configuration/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentConfigurationRemainingExplorer = createRemainingExplorer({
  pageId: "agent-configuration",
  routeId: "agent-configuration",
  title: { "zh-CN": "Agent configuration", en: "Agent configuration" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
