import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { workspaceClient } from "../network";

type CallsState = { items: PmToolCallRecord[]; loading: boolean; error?: string };
type CallsContext = CallsState & { refresh: () => void; update: (record: PmToolCallRecord) => void };
const Context = createContext<CallsContext | null>(null);

/** One thread-scoped read feeds both native timeline cards and PM context. */
export function PmToolCallsProvider({ threadId, children }: { threadId?: string; children: ReactNode }) {
  const [state, setState] = useState<CallsState>({ items: [], loading: !!threadId });
  const active = useRef(true);
  const running = useRef(false);
  const dirty = useRef(false);
  const refresh = useCallback(() => {
    if (!threadId) return;
    if (running.current) { dirty.current = true; return; }
    running.current = true;
    setState(previous => ({ ...previous, loading: true }));
    void (async () => {
      do {
        dirty.current = false;
        try {
          const result = await workspaceClient.json<{ items: PmToolCallRecord[] }>(`/api/pm-tools/threads/${encodeURIComponent(threadId)}/calls`);
          if (active.current) setState({ items: result.items, loading: false });
        } catch (cause) {
          if (active.current) setState(previous => ({ ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
        }
      } while (active.current && dirty.current);
      running.current = false;
    })();
  }, [threadId]);
  useEffect(() => { active.current = true; refresh(); return () => { active.current = false; }; }, [refresh]);
  const update = useCallback((record: PmToolCallRecord) => {
    setState(previous => ({ ...previous, items: previous.items.map(item => item.operationId === record.operationId ? record : item) }));
    refresh();
  }, [refresh]);
  return <Context.Provider value={{ ...state, refresh, update }}>{children}</Context.Provider>;
}

export function usePmToolCalls() { return useContext(Context); }
