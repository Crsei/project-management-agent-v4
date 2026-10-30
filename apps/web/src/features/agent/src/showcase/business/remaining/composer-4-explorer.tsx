"use client";
import {
  RemainingPageView,
  pageScenarios,
} from "@easyuse-ui/agent-workspace-views/composers/composer-4/view";
import { createRemainingExplorer } from "../remaining-explorer-factory";
export const Composer4RemainingExplorer = createRemainingExplorer({
  pageId: "composer-4",
  routeId: "composer-4",
  title: { "zh-CN": "Composer 4", en: "Composer 4" },
  View: RemainingPageView,
  scenarios: pageScenarios,
  ownShell: true,
});
