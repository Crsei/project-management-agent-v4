"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/applications/mobile-screen-workspace/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const MobileScreenWorkspaceRemainingExplorer = createRemainingExplorer({
  pageId: "mobile-screen-workspace",
  routeId: "mobile-screen-workspace",
  title: { "zh-CN": "Mobile screen workspace", en: "Mobile screen workspace" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: false,
});
