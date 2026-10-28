"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-studio-builder/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentStudioBuilderRemainingExplorer = createRemainingExplorer({
  pageId: "agent-studio-builder",
  routeId: "agent-studio/builder",
  title: { "zh-CN": "Agent builder", en: "Agent builder" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
