"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/documents/document-writing-workspace/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const DocumentWritingWorkspaceRemainingExplorer = createRemainingExplorer({
  pageId: "document-writing-workspace",
  routeId: "document-writing-workspace",
  title: { "zh-CN": "Document 2", en: "Document 2" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
