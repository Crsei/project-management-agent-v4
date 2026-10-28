"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/workflows/workflow-3/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Workflow3RemainingExplorer = createRemainingExplorer({
  pageId: "workflow-3",
  routeId: "workflow-3",
  title: { "zh-CN": "Workflow 3", en: "Workflow 3" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: true,
});
