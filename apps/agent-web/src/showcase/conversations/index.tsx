import { lazy } from "react";
import type { ComponentType } from "react";
import { composerScenarios } from "@easyuse-ui/agent-workspace-views/fixtures";
import { composer2Scenarios } from "@easyuse-ui/agent-workspace-views/composer-2-fixtures";
import type { ShowcasePage } from "../types";
import { conversationShowcases } from "./conversations-catalog";

// The router validates the scenario against each page's catalog before rendering.
function lazyPage<View extends ComponentType<never>>(
  load: () => Promise<{ default: View }>,
): ShowcasePage["Component"] {
  return lazy(load as unknown as () => Promise<{ default: ShowcasePage["Component"] }>);
}

const conversationComponents = {
  "conversation-1": lazyPage(() =>
    import("./conversations-explorer").then((module) => ({
      default: module.Conversation1Explorer,
    })),
  ),
  "conversation-2": lazyPage(() =>
    import("./conversations-explorer").then((module) => ({
      default: module.Conversation2Explorer,
    })),
  ),
  "conversation-3": lazyPage(() =>
    import("./conversations-explorer").then((module) => ({
      default: module.Conversation3Explorer,
    })),
  ),
  "conversation-4": lazyPage(() =>
    import("./conversation-4-explorer").then((module) => ({
      default: module.Conversation4Explorer,
    })),
  ),
  "conversation-5": lazyPage(() =>
    import("./conversation-5-explorer").then((module) => ({
      default: module.Conversation5Explorer,
    })),
  ),
  "conversation-6": lazyPage(() =>
    import("./conversation-6-explorer").then((module) => ({
      default: module.Conversation6Explorer,
    })),
  ),
  "conversation-7": lazyPage(() =>
    import("./conversation-7-explorer").then((module) => ({
      default: module.Conversation7Explorer,
    })),
  ),
  "conversation-8": lazyPage(() =>
    import("./conversation-8-explorer").then((module) => ({
      default: module.Conversation8Explorer,
    })),
  ),
  "conversation-9": lazyPage(() =>
    import("./conversation-9-explorer").then((module) => ({
      default: module.Conversation9Explorer,
    })),
  ),
  "conversation-10": lazyPage(() =>
    import("./conversation-10-explorer").then((module) => ({
      default: module.Conversation10Explorer,
    })),
  ),
  "conversation-11": lazyPage(() =>
    import("./conversation-11-explorer").then((module) => ({
      default: module.Conversation11Explorer,
    })),
  ),
  "conversation-12": lazyPage(() =>
    import("./conversation-12-explorer").then((module) => ({
      default: module.Conversation12Explorer,
    })),
  ),
  "conversation-13": lazyPage(() =>
    import("./conversation-13-explorer").then((module) => ({
      default: module.Conversation13Explorer,
    })),
  ),
  "conversation-14": lazyPage(() =>
    import("./conversation-14-explorer").then((module) => ({
      default: module.Conversation14Explorer,
    })),
  ),
  "conversation-15": lazyPage(() =>
    import("./conversation-15-explorer").then((module) => ({
      default: module.Conversation15Explorer,
    })),
  ),
  "conversation-16": lazyPage(() =>
    import("./conversation-16-explorer").then((module) => ({
      default: module.Conversation16Explorer,
    })),
  ),
  "conversation-17": lazyPage(() =>
    import("./conversation-17-explorer").then((module) => ({
      default: module.Conversation17Explorer,
    })),
  ),
  "conversation-18": lazyPage(() =>
    import("./conversation-18-explorer").then((module) => ({
      default: module.Conversation18Explorer,
    })),
  ),
  "conversation-19": lazyPage(() =>
    import("./conversation-19-explorer").then((module) => ({
      default: module.Conversation19Explorer,
    })),
  ),
  "conversation-20": lazyPage(() =>
    import("./conversation-20-explorer").then((module) => ({
      default: module.Conversation20Explorer,
    })),
  ),
  "parent-child-conversations": lazyPage(() =>
    import("./conversation-21-explorer").then((module) => ({
      default: module.Conversation21Explorer,
    })),
  ),
  "web-answer": lazyPage(() =>
    import("./conversation-22-explorer").then((module) => ({
      default: module.Conversation22Explorer,
    })),
  ),
  "conversation-23": lazyPage(() =>
    import("./conversation-23-explorer").then((module) => ({
      default: module.Conversation23Explorer,
    })),
  ),
} satisfies Record<(typeof conversationShowcases)[number]["id"], ShowcasePage["Component"]>;

export const pages: ShowcasePage[] = [
  {
    id: "composer",
    group: "Composers",
    title: { "zh-CN": "Composer 工作台", en: "Composer workspace" },
    description: {
      "zh-CN": "双侧栏对话工作台，包含会话、草稿、上下文引用和模型选择。",
      en: "A conversation workspace with two sidebars, sessions, drafts, context references and model selection.",
    },
    scenarios: composerScenarios,
    Component: lazyPage(() =>
      import("./composer-explorer").then((module) => ({ default: module.ComposerExplorer })),
    ),
  },
  {
    id: "composer-2",
    group: "Composers",
    title: { "zh-CN": "Composer 2 附件输入", en: "Composer 2 attachments" },
    description: {
      "zh-CN": "附件摘要、引用移除与上下文工具；仅本地固定场景。",
      en: "Attachment summaries, reference removal and context tools with local fixtures.",
    },
    scenarios: composer2Scenarios,
    Component: lazyPage(() =>
      import("./composer-2-explorer").then((module) => ({ default: module.Composer2Explorer })),
    ),
  },
  ...conversationShowcases.map((page) => ({
    ...page,
    Component: conversationComponents[page.id],
  })),
];
