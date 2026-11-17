import { useEffect, useState } from "react";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { workspaceClient } from "../network";
import { indexMessageTimes, type MessageTimes } from "./generation-times-model";

export type GenerationRecords = ReadonlyMap<string, ChatGenerationView>;
export type { MessageTimes };

const CACHE_MS = 30_000;
const emptyTimes: MessageTimes = new Map();
const emptyRecords: GenerationRecords = new Map();
const cache = new Map<string, { at: number; records: GenerationRecords }>();
const inflight = new Map<string, Promise<GenerationRecords>>();

function indexRecords(generations: readonly ChatGenerationView[]): Map<string, ChatGenerationView> {
  const records = new Map<string, ChatGenerationView>();
  for (const generation of generations) if (generation.messageId) records.set(generation.messageId, generation);
  return records;
}

function load(threadId: string): Promise<GenerationRecords> {
  const running = inflight.get(threadId);
  if (running) return running;
  const promise = workspaceClient.json<{ generations: ChatGenerationView[] }>(`/api/chat/threads/${encodeURIComponent(threadId)}/generations`)
    .then(body => {
      const records = indexRecords(body.generations);
      cache.set(threadId, { at: Date.now(), records });
      return records;
    })
    .finally(() => { inflight.delete(threadId); });
  inflight.set(threadId, promise);
  return promise;
}

const useRecords = (threadId: string | undefined): GenerationRecords => {
  const [records, setRecords] = useState<GenerationRecords>(emptyRecords);
  useEffect(() => {
    if (!threadId) { setRecords(emptyRecords); return; }
    const cached = cache.get(threadId);
    if (cached && Date.now() - cached.at < CACHE_MS) { setRecords(cached.records); return; }
    let alive = true;
    void load(threadId).then(value => { if (alive) setRecords(value); }, () => { if (alive) setRecords(emptyRecords); });
    return () => { alive = false; };
  }, [threadId]);
  return records;
};

/** Read-only generation records; missing data stays missing rather than inferred. */
export function useGenerationRecords(threadId: string | undefined): GenerationRecords {
  return useRecords(threadId);
}

export function useMessageTimes(threadId: string | undefined): MessageTimes {
  const records = useRecords(threadId);
  const [times, setTimes] = useState<MessageTimes>(emptyTimes);
  useEffect(() => { setTimes(records.size ? indexMessageTimes([...records.values()]) : emptyTimes); }, [records]);
  return times;
}
