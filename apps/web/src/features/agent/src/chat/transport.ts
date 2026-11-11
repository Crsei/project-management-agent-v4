import { AssistantChatTransport, type ResumableClientStorage } from "@assistant-ui/ai-sdk";
import type { UIMessage, ChatTransport } from "ai";
import { flushThreadSettings } from "@agent/hooks/use-chat-settings";
import { workspaceClient } from "../network";
import { agentText } from "../i18n-text.ts";
import { canSendThread } from "../pm/state";
import { capturePmReferences, consumePmReferences, type PmReferenceSnapshot } from "../pm/pm-chat-bridge";
import { getResponseStreamingMode } from "./response-streaming";

const slots = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
const pendingMessages = new Map<string, string>();
export function getChatCancellationTarget(threadId: string): {
  generationId?: string;
  messageId?: string;
} {
  return { generationId: slots.get(threadId), messageId: pendingMessages.get(threadId) };
}
export const chatStreams: ResumableClientStorage = {
  getStreamId(threadId) {
    return threadId ? (slots.get(threadId) ?? null) : null;
  },
  setStreamId(id, threadId) {
    if (!threadId) return;
    slots.set(threadId, id);
    for (const listener of listeners.get(threadId) ?? []) listener();
  },
  clear(threadId) {
    if (!threadId) return;
    slots.delete(threadId);
    for (const listener of listeners.get(threadId) ?? []) listener();
  },
  subscribe(listener, threadId) {
    if (!threadId) return () => {};
    const bucket = listeners.get(threadId) ?? new Set<() => void>();
    listeners.set(threadId, bucket);
    bucket.add(listener);
    return () => {
      bucket.delete(listener);
      if (!bucket.size) listeners.delete(threadId);
    };
  },
};

export class DurableChatTransport extends AssistantChatTransport<UIMessage> {
  constructor() {
    const outgoing = new Map<string, PmReferenceSnapshot>();
    super({
      api: workspaceClient.url("/api/chat"),
      fetch: async (input, init) => {
        const response = await workspaceClient.fetch(input, init);
        const acceptedId = response.headers.get("x-accepted-input-message-id");
        if (response.ok && acceptedId && typeof init?.body === "string") {
          const request = JSON.parse(init.body) as { id?: string };
          const key = JSON.stringify([request.id, acceptedId]);
          const snapshot = outgoing.get(key);
          if (snapshot) { consumePmReferences(snapshot); outgoing.delete(key); }
          window.dispatchEvent(new CustomEvent("pm-turn-accepted", { detail: { threadId: request.id, messageId: acceptedId } }));
        }
        return response;
      },
      resumable: {
        storage: chatStreams,
        resumeApi: (streamId) =>
          workspaceClient.url(`/api/chat/streams/${encodeURIComponent(streamId)}`),
      },
      prepareSendMessagesRequest: async (options) => {
        const inputMessage = options.messages.at(-1);
        const inputKey = JSON.stringify([options.id, inputMessage?.id]);
        const snapshot = inputMessage?.role === "user" && options.trigger !== "regenerate-message"
          ? outgoing.get(inputKey) ?? capturePmReferences(options.id) : undefined;
        // Save thread-level settings before accepting a provider request. A
        // failed/conflicting save never silently falls back to a global model.
        const settings = await flushThreadSettings(options.id);
        if (!canSendThread(options.id, options.id, settings.settings.providerInstanceId, settings.settings.model, settings.settings.modelOptions))
          throw new Error(agentText("无法发送：请确认会话执行绑定、Provider 和模型选项均可用。", "Cannot send: check the session execution binding, Provider, and model options."));
        if (snapshot) outgoing.set(inputKey, snapshot);
        return {
          body: {
            ...options.body,
            id: options.id,
            messages: options.messages,
            config: {
              ...(options.body?.config as Record<string, unknown> | undefined),
              threadSettingsRevision: settings.revision,
              responseStreamingMode: getResponseStreamingMode(),
            },
            trigger: options.trigger,
            messageId: options.messageId,
            ...(snapshot ? { pmReferences: [...snapshot.references] } : {}),
          },
        };
      },
    });
  }
  override async sendMessages(options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]) {
    const last = options.messages.at(-1);
    if (last) pendingMessages.set(options.chatId, last.id);
    chatStreams.clear(options.chatId);
    return super.sendMessages(options);
  }
  override __internal_clone(): DurableChatTransport {
    return new DurableChatTransport();
  }
}
