"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/documents/knowledge-base/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const KnowledgeBaseRemainingExplorer = createRemainingExplorer({
  pageId: "knowledge-base",
  routeId: "knowledge-base",
  title: { "zh-CN": "Document 6", en: "Document 6" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
