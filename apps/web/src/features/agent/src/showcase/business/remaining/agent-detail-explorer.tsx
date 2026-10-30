"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-detail/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentDetailRemainingExplorer = createRemainingExplorer({
  pageId: "agent-detail",
  routeId: "agent-detail",
  title: { "zh-CN": "Agent workspace", en: "Agent workspace" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
