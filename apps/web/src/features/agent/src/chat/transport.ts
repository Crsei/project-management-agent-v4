import { AssistantChatTransport, type ResumableClientStorage } from "@assistant-ui/ai-sdk";
import type { UIMessage, ChatTransport } from "ai";
import { flushThreadSettings } from "@agent/hooks/use-chat-settings";
import { workspaceClient } from "../network";
import { agentText } from "../i18n-text.ts";
import { canSendThread } from "../pm/state";
import { capturePmReferences, consumePmReferences, type PmReferenceSnapshot } from "../pm/pm-chat-bridge";
import { getResponseStreamingMode } from "./response-streaming";
import { forgetChatSubmission, getPendingChatSubmission, rememberChatSubmission } from "./submission-recovery";
import { consumeMessageContext, getMessageContextBlocker, takeMessageContextSubmission, type MessageContextSnapshot } from "./message-context-store";
import { contextAttachmentBindings, readContextAttachmentBindings } from "./context-attachments";

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
    const outgoing = new Map<string, { pm: PmReferenceSnapshot; context: MessageContextSnapshot }>();
    super({
      api: workspaceClient.url("/api/chat"),
      fetch: async (input, init) => {
        const request = typeof init?.body === "string" ? JSON.parse(init.body) as { id?: string; idempotencyKey?: string; messages?: UIMessage[] } : null;
        if (request?.id && request.idempotencyKey) {
          if (getPendingChatSubmission(request.id)) throw new Error(agentText("原消息受理结果未确认；先核对原请求，不重发。", "Original message acceptance is unresolved. Reconcile it before sending."));
          rememberChatSubmission({ threadId: request.id, submissionId: request.idempotencyKey, inputMessageId: request.messages?.at(-1)?.id ?? null });
        }
        const response = await workspaceClient.fetch(input, init);
        const acceptedId = response.headers.get("x-accepted-input-message-id");
        if (response.ok && acceptedId && request?.id) {
          if (request.idempotencyKey) forgetChatSubmission(request.id, request.idempotencyKey);
          const key = JSON.stringify([request.id, acceptedId]);
          const snapshot = outgoing.get(key);
          if (snapshot) {
            if (snapshot.context.pmReferences === undefined) consumePmReferences(snapshot.pm);
            consumeMessageContext(snapshot.context); outgoing.delete(key);
          }
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
        const preparedContext = inputMessage?.role === "user" && options.trigger !== "regenerate-message" && !outgoing.has(inputKey) ? takeMessageContextSubmission(options.id) : undefined;
        const snapshot = inputMessage?.role === "user" && options.trigger !== "regenerate-message"
          ? outgoing.get(inputKey) ?? { pm: preparedContext?.pmDraft ?? capturePmReferences(options.id), context: preparedContext! } : undefined;
        if (snapshot && getMessageContextBlocker(snapshot.context.owner)) throw new Error(getMessageContextBlocker(snapshot.context.owner));
        const inputMetadata = inputMessage?.metadata && typeof inputMessage.metadata === "object" ? inputMessage.metadata as Record<string, unknown> : {};
        const inputCustom = inputMetadata.custom && typeof inputMetadata.custom === "object" ? inputMetadata.custom as Record<string, unknown> : {};
        if (inputCustom.quote) throw new Error(agentText("选中文字引用尚未核验，请等待核验完成，或移除后重新选择。草稿未发送。", "The selected-text quote has not been verified. Wait, or remove it and select again. The draft was not sent."));
        const bindings = snapshot && inputMessage ? [...new Map([
          ...(snapshot.context.attachments === undefined ? readContextAttachmentBindings(inputCustom.contextAttachments) : []),
          ...contextAttachmentBindings(inputMessage.parts, snapshot.context.items.map(item => item.input), snapshot.context.attachments ?? []),
        ].map(binding => [binding.attachmentId, binding])).values()] : [];
        const messages = inputMessage && snapshot ? options.messages.map(message => message === inputMessage ? { ...message, metadata: { ...inputMetadata, custom: { ...inputCustom, contextAttachments: bindings } } } : message) : options.messages;
        if (snapshot) outgoing.set(inputKey, snapshot);
        // Save thread-level settings before accepting a provider request. A
        // failed/conflicting save never silently falls back to a global model.
        const settings = await flushThreadSettings(options.id);
        if (!canSendThread(options.id, options.id, settings.settings.providerInstanceId, settings.settings.model, settings.settings.modelOptions))
          throw new Error(agentText("无法发送：请确认会话执行绑定、Provider 和模型选项均可用。", "Cannot send: check the session execution binding, Provider, and model options."));
        return {
          body: {
            ...options.body,
            id: options.id,
            idempotencyKey: typeof options.body?.idempotencyKey === "string" ? options.body.idempotencyKey : crypto.randomUUID(),
            messages,
            config: {
              ...(options.body?.config as Record<string, unknown> | undefined),
              threadSettingsRevision: settings.revision,
              responseStreamingMode: getResponseStreamingMode(),
            },
            trigger: options.trigger,
            messageId: options.messageId,
            ...(snapshot ? {
              pmReferences: snapshot.context.pmReferences === undefined ? [...snapshot.pm.references] : snapshot.context.pmReferences.map(({ workspaceId, projectId, kind, id, revision }) => ({ workspaceId, projectId, kind, id, revision })),
              contextItems: snapshot.context.items.map(item => item.input),
            } : {}),
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
