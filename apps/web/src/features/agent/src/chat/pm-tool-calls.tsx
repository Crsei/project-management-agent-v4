import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { pmToolCallProjectionSchema, type PmToolCallProjection } from "@agent-workspace/contracts/pm-tools";
import { workspaceClient } from "../network";

type CallsState = { items: PmToolCallProjection[]; loading: boolean; error?: string };
type CallsContext = CallsState & { refresh: () => void; update: (record: PmToolCallProjection) => void };
const Context = createContext<CallsContext | null>(null);

/** One thread-scoped read feeds both native timeline cards and PM context. */
export function PmToolCallsProvider({ threadId, children }: { threadId?: string; children: ReactNode }) {
  const [state, setState] = useState<CallsState>({ items: [], loading: !!threadId });
  const active = useRef(true);
  const running = useRef(false);
  const dirty = useRef(false);
  const epoch = useRef(0);
  const refresh = useCallback(() => {
    if (!threadId) return;
    if (running.current) { dirty.current = true; return; }
    running.current = true;
    const requestEpoch = epoch.current;
    setState(previous => ({ ...previous, loading: true }));
    void (async () => {
      do {
        dirty.current = false;
        try {
          const result = await workspaceClient.json<{ items: unknown[] }>(`/api/pm-tools/threads/${encodeURIComponent(threadId)}/calls`);
          const items = pmToolCallProjectionSchema.array().parse(result.items);
          if (active.current && epoch.current === requestEpoch) setState({ items, loading: false });
        } catch (cause) {
          if (active.current && epoch.current === requestEpoch) setState({ items: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) });
        }
      } while (active.current && epoch.current === requestEpoch && dirty.current);
      if (epoch.current === requestEpoch) running.current = false;
    })();
  }, [threadId]);
  useEffect(() => {
    epoch.current++;
    active.current = true; running.current = false; dirty.current = false;
    setState({ items: [], loading: !!threadId });
    refresh();
    const recheck = () => refresh();
    window.addEventListener("focus", recheck);
    window.addEventListener("online", recheck);
    return () => { epoch.current++; active.current = false; window.removeEventListener("focus", recheck); window.removeEventListener("online", recheck); };
  }, [refresh, threadId]);
  const update = useCallback((record: PmToolCallProjection) => {
    setState(previous => ({ ...previous, items: previous.items.map(item => item.operationId === record.operationId ? record : item) }));
    refresh();
  }, [refresh]);
  return <Context.Provider value={{ ...state, refresh, update }}>{children}</Context.Provider>;
}

export function usePmToolCalls() { return useContext(Context); }
