"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/composers/composer-5/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Composer5RemainingExplorer = createRemainingExplorer({
  pageId: "composer-5",
  routeId: "composer-5",
  title: { "zh-CN": "Composer 5", en: "Composer 5" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: true,
});
