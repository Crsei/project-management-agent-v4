"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/canvas-workbench/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const CanvasWorkbenchRemainingExplorer = createRemainingExplorer({
  pageId: "canvas-workbench",
  routeId: "canvas-workbench",
  title: { "zh-CN": "Subagent canvas", en: "Subagent canvas" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
