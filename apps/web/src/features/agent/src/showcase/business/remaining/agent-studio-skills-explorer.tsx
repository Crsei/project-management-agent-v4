"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/agents/agent-studio-skills/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const AgentStudioSkillsRemainingExplorer = createRemainingExplorer({
  pageId: "agent-studio-skills",
  routeId: "agent-studio/skills",
  title: { "zh-CN": "Skills workspace", en: "Skills workspace" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
