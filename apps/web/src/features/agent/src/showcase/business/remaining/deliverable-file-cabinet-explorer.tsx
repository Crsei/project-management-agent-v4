"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/documents/deliverable-file-cabinet/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const DeliverableFileCabinetRemainingExplorer = createRemainingExplorer({
  pageId: "deliverable-file-cabinet",
  routeId: "deliverable-file-cabinet",
  title: { "zh-CN": "Document 4", en: "Document 4" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
