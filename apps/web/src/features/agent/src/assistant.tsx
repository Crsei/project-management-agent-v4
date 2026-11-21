"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { requestedChatThread } from "./pm/run-board-navigation";

const ACTIVE_THREAD_KEY = "pm-v4:agent-active-thread:execution-v2";
function readActiveThread(entry?: URLSearchParams): string | undefined {
  const params = entry ?? new URLSearchParams(window.location.search);
  // Route hand-offs are selected by ChatSurface with unarchive:false. The SDK's
  // initialThreadId switch would otherwise unarchive an opened history Session.
  if (!entry && params.has("thread")) return undefined;
  return requestedChatThread(params, () => {
    try { return localStorage.getItem(ACTIVE_THREAD_KEY) ?? undefined; }
    catch { return undefined; }
  });
}
type AssistantProps = { entry?: URLSearchParams; runBoard?: ReactNode; onExpand?: (params: URLSearchParams) => void; onClose?: () => void; onThreadChange?: (id: string | null) => void };
function PersistentAssistant({ dictation, speak, entry, runBoard, onExpand, onClose, onThreadChange }: AssistantProps & { dictation: boolean; speak: boolean }) {
  const boardMode = runBoard !== undefined;
  const boardSessionId = boardMode && typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("sessionId") ?? undefined : undefined;
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
    initialThreadId: boardMode ? boardSessionId : readActiveThread(entry),
    onThreadIdChange(id) {
      if (boardMode) return;
      try {
        if (id) localStorage.setItem(ACTIVE_THREAD_KEY, id);
        else localStorage.removeItem(ACTIVE_THREAD_KEY);
      } catch { /* This mounted runtime still retains its selection. */ }
    },
  });
  useEffect(() => registerThreadListRefresh(() => runtime.threads.reload()), [runtime]);
  return <HistoryLoadContext.Provider value={historyStatus}><AssistantRuntimeProvider runtime={runtime}><PmChatSurface runtime={runtime} entry={entry} runBoard={runBoard} onExpand={onExpand} onClose={onClose} onThreadChange={onThreadChange} /></AssistantRuntimeProvider></HistoryLoadContext.Provider>;
}
export function Assistant({ entry, runBoard, onExpand, onClose, onThreadChange }: AssistantProps = {}) {
  const voice = useVoiceSettings();
  // Remounting only detaches subscriptions; durable server generations are not cancelled.
  return <PersistentAssistant key={`${runBoard !== undefined ? "board" : "chat"}:${voice.dictation}:${voice.speak}`} {...voice} entry={entry} runBoard={runBoard} onExpand={onExpand} onClose={onClose} onThreadChange={onThreadChange} />;
}
