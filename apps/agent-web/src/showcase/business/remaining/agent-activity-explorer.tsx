"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-activity/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentActivityRemainingExplorer = createRemainingExplorer({
  pageId: "agent-activity",
  routeId: "agent-activity",
  title: { "zh-CN": "Agent 1", en: "Agent 1" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
