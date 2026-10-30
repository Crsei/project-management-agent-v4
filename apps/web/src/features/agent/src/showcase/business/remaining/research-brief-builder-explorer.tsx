"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/research/research-brief-builder/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const ResearchBriefBuilderRemainingExplorer = createRemainingExplorer({
  pageId: "research-brief-builder",
  routeId: "research-brief-builder",
  title: { "zh-CN": "Research 1", en: "Research 1" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
