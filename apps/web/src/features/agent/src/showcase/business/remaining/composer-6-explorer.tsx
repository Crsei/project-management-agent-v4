"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/composers/composer-6/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Composer6RemainingExplorer = createRemainingExplorer({
  pageId: "composer-6",
  routeId: "composer-6",
  title: { "zh-CN": "Composer 6", en: "Composer 6" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: true,
});
