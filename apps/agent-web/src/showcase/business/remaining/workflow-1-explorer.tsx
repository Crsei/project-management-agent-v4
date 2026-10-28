"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/workflows/workflow-1/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Workflow1RemainingExplorer = createRemainingExplorer({
  pageId: "workflow-1",
  routeId: "workflow-1",
  title: { "zh-CN": "Workflow 1", en: "Workflow 1" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
