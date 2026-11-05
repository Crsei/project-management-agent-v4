import { useTranslation } from "react-i18next";
import i18n from "@pm/cc-switch-source/i18n";
import en from "../../source-inputs/locales/en.json";
import zh from "../../source-inputs/locales/zh-CN.json";
import zhTW from "../../source-inputs/locales/zh-TW.json";
import { mcpMessages } from "./mcp/messages";
import { skillsMessages } from "./skills/messages";

// Pinned generated OpenHands locale inputs, not another application-wide i18n
// instance. The existing management host owns language changes and its provider.
const namespace = "openhands";
i18n.addResourceBundle("en", namespace, en, true, false);
i18n.addResourceBundle("zh", namespace, zh, true, false);
i18n.addResourceBundle("zh-TW", namespace, zhTW, true, false);

// Local integration copy is separate from the immutable generated source assets.
const frameMessages: Record<"en" | "zh" | "zh-TW", Record<string, string>> = {
  en: {
  "PM$RELATED_SETTINGS": "Related settings",
  "PM$RELATED_SETTINGS_SUMMARY": "Agents · Plugins unavailable",
  "PM$AGENTS_SETTINGS": "Agents / Provider settings",
  "PM$AGENTS_LINK": "Agents opens the existing Provider settings. Native configuration bindings do not create a new Agent runtime.",
  "PM$PLUGINS_UNAVAILABLE": "Plugins unavailable: this host has no Plugin installation backend or runtime.",
  "PM$UNAVAILABLE": "Unavailable",
  "PM$NATIVE_SKILLS_UNAVAILABLE": "No authorized native Skills target",
  "PM$NATIVE_SKILLS_BINDING": "Project-private contexts manage MCP definitions only. Choose an explicitly bound native context to discover, install, update, restore or migrate Skills.",
  },
  zh: {
  "PM$RELATED_SETTINGS": "相关设置",
  "PM$RELATED_SETTINGS_SUMMARY": "Agent · 插件不可用",
  "PM$AGENTS_SETTINGS": "Agent / Provider 设置",
  "PM$AGENTS_LINK": "Agents 打开现有 Provider 设置。原生配置绑定不会创建新的 Agent 运行时。",
  "PM$PLUGINS_UNAVAILABLE": "Plugins 不可用：此宿主尚无插件安装后端或运行时。",
  "PM$UNAVAILABLE": "不可用",
  "PM$NATIVE_SKILLS_UNAVAILABLE": "没有已授权的原生 Skills 目标",
  "PM$NATIVE_SKILLS_BINDING": "项目私有上下文仅管理 MCP 定义。请明确选择已绑定的原生上下文，才能发现、安装、更新、恢复或迁移 Skills。",
  },
  "zh-TW": {
  "PM$RELATED_SETTINGS": "相關設定",
  "PM$RELATED_SETTINGS_SUMMARY": "Agent · 外掛不可用",
  "PM$AGENTS_SETTINGS": "Agent / Provider 設定",
  "PM$AGENTS_LINK": "Agents 開啟既有 Provider 設定。原生設定綁定不會建立新的 Agent 執行環境。",
  "PM$PLUGINS_UNAVAILABLE": "Plugins 不可用：此宿主尚無外掛安裝後端或執行環境。",
  "PM$UNAVAILABLE": "不可用",
  "PM$NATIVE_SKILLS_UNAVAILABLE": "沒有已授權的原生 Skills 目標",
  "PM$NATIVE_SKILLS_BINDING": "專案私有上下文僅管理 MCP 定義。請明確選擇已綁定的原生上下文，才能探索、安裝、更新、還原或遷移 Skills。",
  },
};

for (const language of ["en", "zh", "zh-TW"] as const) {
  i18n.addResourceBundle(language, namespace, frameMessages[language], true, false);
  i18n.addResourceBundle(language, namespace, mcpMessages[language], true, false);
  i18n.addResourceBundle(language, namespace, skillsMessages[language], true, false);
  // The reused CC Switch panels retain their own default namespace and never
  // import this presentation fork. Register only the agreed integration keys.
  i18n.addResourceBundle(language, "translation", mcpMessages[language], true, false);
  i18n.addResourceBundle(language, "translation", skillsMessages[language], true, false);
}

export function useOpenHandsTranslation() {
  return useTranslation(namespace, { i18n });
}
