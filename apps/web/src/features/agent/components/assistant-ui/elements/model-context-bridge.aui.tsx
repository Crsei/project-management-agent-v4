"use client";

import { useEffect } from "react";
import { useAui } from "@assistant-ui/react";
import type { ChatSettings } from "@agent/hooks/use-chat-settings";

/**
 * Publishes explicit session settings onto each transport request. No model or
 * option defaults are synthesized here; the saved thread revision remains the
 * server's authority for accepting POST /api/chat.
 */
export const ModelContextBridge = ({ settings }: { settings: ChatSettings }) => {
  const aui = useAui();

  useEffect(() => {
    // The transport forwards `config` verbatim; the extra key is read by the
    // server's provider runtime.
    const config = {
      providerInstanceId: settings.providerInstanceId,
      modelName: settings.model,
      ...(settings.modelOptions !== undefined ? { modelOptions: settings.modelOptions } : {}),
      ...(settings.interactionMode !== undefined ? { interactionMode: settings.interactionMode } : {}),
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
    settings.modelOptions,
    settings.interactionMode,
  ]);

  return null;
};
