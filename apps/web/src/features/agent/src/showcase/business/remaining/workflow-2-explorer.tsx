"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/workflows/workflow-2/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Workflow2RemainingExplorer = createRemainingExplorer({
  pageId: "workflow-2",
  routeId: "workflow-2",
  title: { "zh-CN": "Workflow 2", en: "Workflow 2" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
