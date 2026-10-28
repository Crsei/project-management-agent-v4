"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/applications/creative-canvas/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const CreativeCanvasRemainingExplorer = createRemainingExplorer({
  pageId: "creative-canvas",
  routeId: "creative-canvas",
  title: { "zh-CN": "Video variations", en: "Video variations" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
