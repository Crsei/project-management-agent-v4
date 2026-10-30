"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/documents/artifact-version-review/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const ArtifactVersionReviewRemainingExplorer = createRemainingExplorer({
  pageId: "artifact-version-review",
  routeId: "artifact-version-review",
  title: { "zh-CN": "Document 3", en: "Document 3" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
