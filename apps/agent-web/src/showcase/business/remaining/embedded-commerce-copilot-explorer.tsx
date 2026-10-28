"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/applications/embedded-commerce-copilot/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const EmbeddedCommerceCopilotRemainingExplorer = createRemainingExplorer({
  pageId: "embedded-commerce-copilot",
  routeId: "embedded-commerce-copilot",
  title: { "zh-CN": "Commerce copilot", en: "Commerce copilot" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
