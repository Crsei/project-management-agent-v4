import { useEffect, useState } from "react";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { workspaceClient } from "../network";
import { indexMessageTimes, type MessageTimes } from "./generation-times-model";

const CACHE_MS = 30_000;
const empty: MessageTimes = new Map();
const cache = new Map<string, { at: number; value: MessageTimes }>();
const inflight = new Map<string, Promise<MessageTimes>>();

function load(threadId: string): Promise<MessageTimes> {
  const running = inflight.get(threadId);
  if (running) return running;
  const promise = workspaceClient.json<{ generations: ChatGenerationView[] }>(`/api/chat/threads/${encodeURIComponent(threadId)}/generations`)
    .then(body => {
      const value = indexMessageTimes(body.generations);
      cache.set(threadId, { at: Date.now(), value });
      return value;
    })
    .finally(() => { inflight.delete(threadId); });
  inflight.set(threadId, promise);
  return promise;
}

/** Read-only generation start times; missing data stays missing rather than inferred. */
export function useMessageTimes(threadId: string | undefined): MessageTimes {
  const [times, setTimes] = useState<MessageTimes>(empty);
  useEffect(() => {
    if (!threadId) { setTimes(empty); return; }
    const cached = cache.get(threadId);
    if (cached && Date.now() - cached.at < CACHE_MS) { setTimes(cached.value); return; }
    let alive = true;
    void load(threadId).then(value => { if (alive) setTimes(value); }, () => { if (alive) setTimes(empty); });
    return () => { alive = false; };
  }, [threadId]);
  return times;
}
