"use client";

import { useEffect, useMemo } from "react";
import {
  AssistantRuntimeProvider, useAuiState, useRemoteThreadListRuntime,
  WebSpeechDictationAdapter, WebSpeechSynthesisAdapter,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useChatSettings, useVoiceSettings } from "@/hooks/use-chat-settings";
import { createServerThreadAdapter, registerThreadListRefresh } from "./chat/remote-adapter";
import { DurableChatTransport } from "./chat/transport";
import { PmChatSurface } from "./pm/chat-surface";
import { canSendThread, usePmChatState } from "./pm/state";

const ACTIVE_THREAD_KEY = "pm-v3:agent-active-thread";
function readActiveThread(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  if (params.get("thread")) return params.get("thread")!;
  // A PM context entry starts in that explicit scope, never an unrelated old thread.
  if (params.has("workspace")) return undefined;
  try { return localStorage.getItem(ACTIVE_THREAD_KEY) ?? undefined; }
  catch { return undefined; }
}
function PersistentAssistant({ dictation, speak }: { dictation: boolean; speak: boolean }) {
  const adapter = useMemo(createServerThreadAdapter, []);
  const transport = useMemo(() => new DurableChatTransport(), []);
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: function useDurableChat() {
      const localId = useAuiState((state) => state.threadListItem.id);
      const remoteId = useAuiState((state) => state.threadListItem.remoteId);
      const { ready, settings, saving, error } = useChatSettings(remoteId, undefined, localId);
      usePmChatState();
      return useChatRuntime({
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        // Each durable assistant message carries its own generation timeline.
        joinStrategy: "none",
        transport,
        isSendDisabled: !ready || saving || !!error || !canSendThread(localId, remoteId, settings.providerInstanceId, settings.model),
        adapters: {
          ...(dictation ? { dictation: new WebSpeechDictationAdapter() } : {}),
          ...(speak ? { speech: new WebSpeechSynthesisAdapter() } : {}),
        },
      });
    },
    adapter,
    initialThreadId: readActiveThread(),
    onThreadIdChange(id) {
      try {
        if (id) localStorage.setItem(ACTIVE_THREAD_KEY, id);
        else localStorage.removeItem(ACTIVE_THREAD_KEY);
      } catch { /* This mounted runtime still retains its selection. */ }
    },
  });
  useEffect(() => registerThreadListRefresh(() => runtime.threads.reload()), [runtime]);
  return <AssistantRuntimeProvider runtime={runtime}><PmChatSurface runtime={runtime} /></AssistantRuntimeProvider>;
}
export function Assistant() {
  const voice = useVoiceSettings();
  // Remounting only detaches subscriptions; durable server generations are not cancelled.
  return <PersistentAssistant key={`${voice.dictation}:${voice.speak}`} {...voice} />;
}
