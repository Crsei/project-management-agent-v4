"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/skills/skills-manager/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const SkillsManagerRemainingExplorer = createRemainingExplorer({
  pageId: "skills-manager",
  routeId: "skills-manager",
  title: { "zh-CN": "Skills manager", en: "Skills manager" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
