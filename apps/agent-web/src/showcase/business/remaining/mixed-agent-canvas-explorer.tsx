"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/mixed-agent-canvas/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const MixedAgentCanvasRemainingExplorer = createRemainingExplorer({
  pageId: "mixed-agent-canvas",
  routeId: "mixed-agent-canvas",
  title: { "zh-CN": "Mixed agent canvas", en: "Mixed agent canvas" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
