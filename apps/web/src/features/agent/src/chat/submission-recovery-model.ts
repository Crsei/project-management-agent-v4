import type { ChatSubmissionLookup } from "@agent-workspace/contracts/chat";

type PendingSubmission = { threadId: string; submissionId: string; inputMessageId: string | null };
type Dependencies = {
  client: { json<T>(path: string, init?: RequestInit): Promise<T> };
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};
export function createChatSubmissionRecovery({ client, storage }: Dependencies) {
  const pending = new Map<string, PendingSubmission | null>();
  const listeners = new Set<() => void>();
  const storageKey = (threadId: string) => `agent-chat:submission:${threadId}`;
  function getPendingChatSubmission(threadId: string): PendingSubmission | null {
    if (pending.has(threadId)) return pending.get(threadId) ?? null;
    let value: PendingSubmission | null = null;
    const raw = storage.getItem(storageKey(threadId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PendingSubmission>;
      if (parsed.threadId === threadId && typeof parsed.submissionId === "string") value = { threadId, submissionId: parsed.submissionId, inputMessageId: typeof parsed.inputMessageId === "string" ? parsed.inputMessageId : null };
    }
    pending.set(threadId, value);
    return value;
  }
  function rememberChatSubmission(value: PendingSubmission) {
    // Refuse dispatch if the original identity cannot survive a page refresh.
    storage.setItem(storageKey(value.threadId), JSON.stringify(value));
    pending.set(value.threadId, value);
    for (const listener of listeners) listener();
  }
  function forgetChatSubmission(threadId: string, submissionId: string) {
    if (getPendingChatSubmission(threadId)?.submissionId !== submissionId) return;
    storage.removeItem(storageKey(threadId)); pending.set(threadId, null);
    for (const listener of listeners) listener();
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  async function reconcileChatSubmission(threadId: string): Promise<ChatSubmissionLookup | null> {
    const original = getPendingChatSubmission(threadId);
    if (!original) return null;
    const result = await client.json<ChatSubmissionLookup>(`/api/chat/threads/${encodeURIComponent(threadId)}/submissions/${encodeURIComponent(original.submissionId)}`, { cache: "no-store" });
    if (result.status === "accepted" || result.status === "not_accepted") forgetChatSubmission(threadId, original.submissionId);
    return result;
  }
  return { getPendingChatSubmission, rememberChatSubmission, forgetChatSubmission, reconcileChatSubmission, subscribe };
}
