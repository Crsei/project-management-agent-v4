import { useCallback, useState, type SetStateAction } from "react";

const memoryDrafts = new Map<string, unknown>();

/** Panel closure is not form cancellation; keep each thread's draft until explicitly discarded. */
export function usePanelDraft<T>(threadId: string | undefined, name: string) {
  const key = `agent-workspace:panel-draft:${threadId ?? "new"}:${name}`;
  const [value, setValue] = useState<T | null>(() => {
    if (memoryDrafts.has(key)) return memoryDrafts.get(key) as T | null;
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  });
  const setDraft = useCallback(
    (next: SetStateAction<T | null>) => {
      setValue((current) => {
        const draft =
          typeof next === "function" ? (next as (value: T | null) => T | null)(current) : next;
        memoryDrafts.set(key, draft);
        try {
          if (draft === null) localStorage.removeItem(key);
          else localStorage.setItem(key, JSON.stringify(draft));
        } catch {
          /* The in-memory draft still survives panel closure. */
        }
        return draft;
      });
    },
    [key],
  );
  return [value, setDraft] as const;
}
