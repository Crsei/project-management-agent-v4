"use client";

import { useEffect } from "react";
import { useAui } from "@assistant-ui/react";
import type { ChatSettings } from "@/hooks/use-chat-settings";

/**
 * Publishes the settings panel values onto every request: `system`,
 * `callSettings.temperature` and `config.providerInstanceId`/`config.modelName`
 * travel in the body of each POST /api/chat (see AssistantChatTransport).
 */
export const ModelContextBridge = ({ settings }: { settings: ChatSettings }) => {
  const aui = useAui();

  useEffect(() => {
    // The transport forwards `config` verbatim; the extra key is read by the
    // server's provider runtime.
    const config = {
      providerInstanceId: settings.providerInstanceId,
      modelName: settings.model,
    };
    return aui.modelContext.register({
      getModelContext: () => ({
        ...(settings.systemPrompt.trim() ? { system: settings.systemPrompt } : {}),
        callSettings: { temperature: settings.temperature },
        config,
      }),
    });
  }, [
    aui,
    settings.providerInstanceId,
    settings.systemPrompt,
    settings.temperature,
    settings.model,
  ]);

  return null;
};
