"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/automations/automation-run-history/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AutomationRunHistoryRemainingExplorer = createRemainingExplorer({
  pageId: "automation-run-history",
  routeId: "automation-run-history",
  title: { "zh-CN": "Automation 2", en: "Automation 2" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
