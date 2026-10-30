"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-traces/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentTracesRemainingExplorer = createRemainingExplorer({
  pageId: "agent-traces",
  routeId: "agent-traces",
  title: { "zh-CN": "Agent traces", en: "Agent traces" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
