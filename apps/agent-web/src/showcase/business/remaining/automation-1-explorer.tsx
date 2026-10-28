"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/automations/automation-1/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Automation1RemainingExplorer = createRemainingExplorer({
  pageId: "automation-1",
  routeId: "automation-1",
  title: { "zh-CN": "Automation 1", en: "Automation 1" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
