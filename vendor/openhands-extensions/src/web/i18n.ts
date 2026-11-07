import { useTranslation } from "react-i18next";
import { i18n } from "@pm/cc-switch-ui";
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
  "PM$AGENTS_LINK": "Agents opens the existing Provider settings. Extension management uses these saved instances.",
  "PM$PLUGINS_UNAVAILABLE": "Plugins unavailable: this host has no Plugin installation backend or runtime.",
  "PM$UNAVAILABLE": "Unavailable",
  "PM$NATIVE_SKILLS_UNAVAILABLE": "Skills require an Agent target",
  "PM$NATIVE_SKILLS_BINDING": "Private projects manage MCP definitions only. Open Skills for a saved Agent instance to discover, install, update, restore or migrate Skills.",
  },
  zh: {
  "PM$RELATED_SETTINGS": "相关设置",
  "PM$RELATED_SETTINGS_SUMMARY": "Agent · 插件不可用",
  "PM$AGENTS_SETTINGS": "Agent / Provider 设置",
  "PM$AGENTS_LINK": "Agents 打开现有 Provider 设置。扩展管理直接使用这些已保存的实例。",
  "PM$PLUGINS_UNAVAILABLE": "Plugins 不可用：此宿主尚无插件安装后端或运行时。",
  "PM$UNAVAILABLE": "不可用",
  "PM$NATIVE_SKILLS_UNAVAILABLE": "Skills 需要 Agent 目标",
  "PM$NATIVE_SKILLS_BINDING": "私有项目仅管理 MCP 定义。请打开已保存 Agent 实例的 Skills 页面，以发现、安装、更新、恢复或迁移 Skills。",
  },
  "zh-TW": {
  "PM$RELATED_SETTINGS": "相關設定",
  "PM$RELATED_SETTINGS_SUMMARY": "Agent · 外掛不可用",
  "PM$AGENTS_SETTINGS": "Agent / Provider 設定",
  "PM$AGENTS_LINK": "Agents 開啟既有 Provider 設定。擴充管理直接使用這些已儲存的執行個體。",
  "PM$PLUGINS_UNAVAILABLE": "Plugins 不可用：此宿主尚無外掛安裝後端或執行環境。",
  "PM$UNAVAILABLE": "不可用",
  "PM$NATIVE_SKILLS_UNAVAILABLE": "Skills 需要 Agent 目標",
  "PM$NATIVE_SKILLS_BINDING": "私有專案僅管理 MCP 定義。請開啟已儲存 Agent 執行個體的 Skills 頁面，以探索、安裝、更新、還原或遷移 Skills。",
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
