"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/composers/composer-7/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Composer7RemainingExplorer = createRemainingExplorer({
  pageId: "composer-7",
  routeId: "composer-7",
  title: { "zh-CN": "Composer 7", en: "Composer 7" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: true,
});
