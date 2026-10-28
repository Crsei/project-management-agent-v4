"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/documents/pdf-evidence-chat/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const PdfEvidenceChatRemainingExplorer = createRemainingExplorer({
  pageId: "pdf-evidence-chat",
  routeId: "pdf-evidence-chat",
  title: { "zh-CN": "Document 1", en: "Document 1" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
