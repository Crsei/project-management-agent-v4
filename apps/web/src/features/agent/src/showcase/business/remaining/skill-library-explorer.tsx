"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/skills/skill-library/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const SkillLibraryRemainingExplorer = createRemainingExplorer({
  pageId: "skill-library",
  routeId: "skill-library",
  title: { "zh-CN": "Skill 1", en: "Skill 1" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
