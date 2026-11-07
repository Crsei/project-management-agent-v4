"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider, useAuiState, useRemoteThreadListRuntime,
  WebSpeechDictationAdapter, WebSpeechSynthesisAdapter,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useChatSettings, useVoiceSettings } from "@agent/hooks/use-chat-settings";
import { createHistoryLoadStore, createServerThreadAdapter, HistoryLoadContext, registerThreadListRefresh, useHistoryLoadOutcome } from "./chat/remote-adapter";
import { DurableChatTransport } from "./chat/transport";
import { PmChatSurface } from "./pm/chat-surface";
import { canSendThread, usePmChatState } from "./pm/state";

const ACTIVE_THREAD_KEY = "pm-v4:agent-active-thread:execution-v2";
function readActiveThread(entry?: URLSearchParams): string | undefined {
  const params = entry ?? new URLSearchParams(window.location.search);
  if (params.get("thread")) return params.get("thread")!;
  // An explicit PM hand-off starts a fresh chat; it never selects or rebinds a code folder.
  if (params.has("workspace")) return undefined;
  try { return localStorage.getItem(ACTIVE_THREAD_KEY) ?? undefined; }
  catch { return undefined; }
}
function PersistentAssistant({ dictation, speak, entry, onExpand, onClose, onThreadChange }: { dictation: boolean; speak: boolean; entry?: URLSearchParams; onExpand?: (params: URLSearchParams) => void; onClose?: () => void; onThreadChange?: (id: string | null) => void }) {
  const [historyStatus] = useState(createHistoryLoadStore);
  const adapter = useMemo(() => createServerThreadAdapter(historyStatus), [historyStatus]);
  const transport = useMemo(() => new DurableChatTransport(), []);
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: function useDurableChat() {
      const localId = useAuiState((state) => state.threadListItem.id);
      const remoteId = useAuiState((state) => state.threadListItem.remoteId);
      const history = useHistoryLoadOutcome(localId);
      const { ready, settings, saving, error } = useChatSettings(remoteId, undefined, localId);
      usePmChatState();
      return useChatRuntime({
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        // Each durable assistant message carries its own generation timeline.
        joinStrategy: "none",
        transport,
        isSendDisabled: !ready || saving || !!error || history.status === "loading" || history.status === "error" || !canSendThread(localId, remoteId, settings.providerInstanceId, settings.model, settings.modelOptions),
        adapters: {
          ...(dictation ? { dictation: new WebSpeechDictationAdapter() } : {}),
          ...(speak ? { speech: new WebSpeechSynthesisAdapter() } : {}),
        },
      });
    },
    adapter,
    initialThreadId: readActiveThread(entry),
    onThreadIdChange(id) {
      try {
        if (id) localStorage.setItem(ACTIVE_THREAD_KEY, id);
        else localStorage.removeItem(ACTIVE_THREAD_KEY);
      } catch { /* This mounted runtime still retains its selection. */ }
    },
  });
  useEffect(() => registerThreadListRefresh(() => runtime.threads.reload()), [runtime]);
  return <HistoryLoadContext.Provider value={historyStatus}><AssistantRuntimeProvider runtime={runtime}><PmChatSurface runtime={runtime} entry={entry} onExpand={onExpand} onClose={onClose} onThreadChange={onThreadChange} /></AssistantRuntimeProvider></HistoryLoadContext.Provider>;
}
export function Assistant({ entry, onExpand, onClose, onThreadChange }: { entry?: URLSearchParams; onExpand?: (params: URLSearchParams) => void; onClose?: () => void; onThreadChange?: (id: string | null) => void } = {}) {
  const voice = useVoiceSettings();
  // Remounting only detaches subscriptions; durable server generations are not cancelled.
  return <PersistentAssistant key={`${voice.dictation}:${voice.speak}`} {...voice} entry={entry} onExpand={onExpand} onClose={onClose} onThreadChange={onThreadChange} />;
}
