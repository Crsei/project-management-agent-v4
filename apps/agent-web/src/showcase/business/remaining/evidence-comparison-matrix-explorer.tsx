"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/research/evidence-comparison-matrix/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const EvidenceComparisonMatrixRemainingExplorer = createRemainingExplorer({
  pageId: "evidence-comparison-matrix",
  routeId: "evidence-comparison-matrix",
  title: { "zh-CN": "Evidence comparison matrix", en: "Evidence comparison matrix" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
