"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/applications/visual-inspection/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const VisualInspectionRemainingExplorer = createRemainingExplorer({
  pageId: "visual-inspection",
  routeId: "visual-inspection",
  title: { "zh-CN": "Visual inspection", en: "Visual inspection" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
