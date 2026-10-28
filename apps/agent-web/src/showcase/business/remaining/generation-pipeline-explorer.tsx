"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/applications/generation-pipeline/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const GenerationPipelineRemainingExplorer = createRemainingExplorer({
  pageId: "generation-pipeline",
  routeId: "generation-pipeline",
  title: { "zh-CN": "YouTube content", en: "YouTube content" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
