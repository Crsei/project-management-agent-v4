"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-factory-1/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentFactory1RemainingExplorer = createRemainingExplorer({
  pageId: "agent-factory-1",
  routeId: "agent-factory-1",
  title: { "zh-CN": "Agent Factory 1", en: "Agent Factory 1" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
