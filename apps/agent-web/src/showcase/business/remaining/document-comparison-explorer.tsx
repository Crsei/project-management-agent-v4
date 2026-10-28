"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/documents/document-comparison/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const DocumentComparisonRemainingExplorer = createRemainingExplorer({
  pageId: "document-comparison",
  routeId: "document-comparison",
  title: { "zh-CN": "Document 5", en: "Document 5" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
