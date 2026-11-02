import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal read cache for the automation view. Agent Chat has no PM query client;
 * writes remain receipt-based and are reconciled by the journal, never by this cache.
 */
export function useAutomationQuery<T>(key: string, read: (signal: AbortSignal) => Promise<T>, enabled = true, pollWhile?: (data: T) => boolean) {
  const latest = useRef(read); const polling = useRef(pollWhile);
  latest.current = read; polling.current = pollWhile;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: enabled });
  useEffect(() => {
    if (!enabled) { setState({ loading: false }); return; }
    const controller = new AbortController();
    setState(current => ({ ...current, loading: true, error: undefined }));
    let timer: number | undefined;
    // Poll only reads, after the previous response settles. Errors require an explicit retry.
    const load = () => latest.current(controller.signal).then(
      data => {
        if (controller.signal.aborted) return;
        setState({ data, loading: false });
        if (polling.current?.(data)) timer = window.setTimeout(load, 2000);
      },
      error => { if (!controller.signal.aborted) setState(current => ({ data: current.data, error, loading: false })); },
    );
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [key, version, enabled]);
  const refetch = useCallback(() => setVersion(value => value + 1), []);
  return { ...state, refetch };
}
