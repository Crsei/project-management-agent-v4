"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/composers/composer-3/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Composer3RemainingExplorer = createRemainingExplorer({
  pageId: "composer-3",
  routeId: "composer-3",
  title: { "zh-CN": "Composer 3", en: "Composer 3" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: true,
});
