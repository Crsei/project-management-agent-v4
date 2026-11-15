"use client";

import { memo } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useI18n } from "@/lib/i18n-provider";
import { Markdown } from "@agent/src/chat/markdown";

/** Transport adapter only: native and fallback text share parsing, controls and URL policy. */
export const MarkdownText = memo(function MarkdownText() {
  const { locale } = useI18n();
  const text = useAuiState(state => state.part.type === "text" || state.part.type === "reasoning" ? state.part.text : null);
  const streaming = useAuiState(state => state.part.status.type === "running");
  if (text === null) return null;
  return <Markdown content={text} locale={locale === "en" ? "en" : "zh-CN"} streaming={streaming} className="aui-md" />;
});
