import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal read cache for the automation view. Agent Chat has no PM query client;
 * writes remain receipt-based and are reconciled by the journal, never by this cache.
 */
export function useAutomationQuery<T>(key: string, read: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const latest = useRef(read);
  latest.current = read;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: enabled });
  useEffect(() => {
    if (!enabled) { setState({ loading: false }); return; }
    const controller = new AbortController();
    setState(current => ({ ...current, loading: true, error: undefined }));
    latest.current(controller.signal).then(
      data => { if (!controller.signal.aborted) setState({ data, loading: false }); },
      error => { if (!controller.signal.aborted) setState(current => ({ data: current.data, error, loading: false })); },
    );
    return () => controller.abort();
  }, [key, version, enabled]);
  const refetch = useCallback(() => setVersion(value => value + 1), []);
  return { ...state, refetch };
}
