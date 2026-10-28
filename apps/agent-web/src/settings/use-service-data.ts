import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceClient } from "../network";

/** Read-only service data, never persisted in browser storage. */
export function useServiceData<T>(resource: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await workspaceClient.json<T>(resource, { signal: controller.signal, cache: "no-store" });
      if (!controller.signal.aborted) setData(next);
    } catch {
      if (!controller.signal.aborted) setError("无法读取本机 Agent 服务。请检查连接或登录状态后重试；旧快照不代表当前状态。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [resource]);
  useEffect(() => { void refresh(); return () => active.current?.abort(); }, [refresh]);
  return { data, loading, error, refresh };
}
