import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UsageSummaryInput } from "@agent-workspace/contracts/usage";
import { usageApi } from "./api.ts";
import { summaryInput, type Period } from "./page-data.ts";
import { subscribeUsageSettings, usageSettingsRevision } from "./usage-summary-data.ts";
import type { UsageSummaryRead } from "./usage-view-model.ts";

interface SummaryState {
  scope: string;
  summary: UsageSummaryRead | null;
  input: UsageSummaryInput;
  loading: boolean;
  refreshing: boolean;
  error: string;
}
export interface UsageSummaryState {
  summary: UsageSummaryRead | null;
  input: UsageSummaryInput;
  loading: boolean;
  refreshing: boolean;
  error: string;
  refresh: () => Promise<void>;
}

/** Query epochs fence late responses; partial reads are sequential, never interval-overlapped. */
export function useUsageSummary({ period, instanceId }: { period: Period; instanceId: string }): UsageSummaryState {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const settingsRevision = useSyncExternalStore(subscribeUsageSettings, usageSettingsRevision, usageSettingsRevision);
  const scope = JSON.stringify([period, instanceId, timeZone, settingsRevision]);
  const initialInput = useMemo(() => summaryInput(period, timeZone, instanceId), [period, timeZone, instanceId, settingsRevision]);
  const [state, setState] = useState<SummaryState>({ scope, summary: null, input: initialInput, loading: true, refreshing: false, error: "" });
  const epoch = useRef(0);
  const cancel = useRef<() => void>(() => {});
  const forced = useRef<{ scope: string; promise: Promise<void> } | null>(null);

  const read = useCallback((force: boolean): Promise<void> => {
    if (force && forced.current?.scope === scope) return forced.current.promise;
    cancel.current();
    const id = ++epoch.current;
    const input = summaryInput(period, timeZone, instanceId);
    let stopped = false;
    let settled = false;
    let timer: number | undefined;
    const current = () => !stopped && epoch.current === id;
    cancel.current = () => { stopped = true; clearTimeout(timer); };
    setState(previous => ({
      scope, input: previous.scope === scope && previous.summary ? previous.input : input,
      summary: previous.scope === scope ? previous.summary : null,
      loading: previous.scope !== scope || previous.summary === null, refreshing: force, error: "",
    }));
    const publish = (summary: UsageSummaryRead, refreshing: boolean) => {
      if (current()) setState({ scope, summary, input, loading: false, refreshing, error: "" });
    };
    const schedule = () => {
      timer = window.setTimeout(() => { void poll(); }, 1500);
    };
    const poll = async () => {
      try {
        const summary = await usageApi.summary(input);
        if (!current() || settled) return;
        publish(summary, force);
        if (force || summary.sources.some(source => source.refreshing)) schedule();
      } catch (error) {
        if (!current() || settled) return;
        // A pending forced read remains authoritative; transient progress errors do not replace it.
        if (force) schedule();
        else setState(previous => ({ ...previous, loading: false, refreshing: false, error: error instanceof Error ? error.message : String(error) }));
      }
    };
    const promise = (async () => {
      if (force) schedule();
      try {
        const summary = await usageApi.summary(input, force);
        if (!current()) return;
        if (force) { settled = true; clearTimeout(timer); }
        publish(summary, false);
        if (!force && summary.sources.some(source => source.refreshing)) schedule();
      } catch (error) {
        if (!current()) return;
        settled = true;
        clearTimeout(timer);
        setState(previous => ({ ...previous, loading: false, refreshing: false, error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (epoch.current === id && forced.current?.scope === scope) forced.current = null;
      }
    })();
    if (force) forced.current = { scope, promise };
    return promise;
  }, [scope, period, timeZone, instanceId]);

  useEffect(() => {
    void read(false);
    return () => { epoch.current += 1; cancel.current(); forced.current = null; };
  }, [read]);
  const refresh = useCallback(() => read(true), [read]);
  if (state.scope !== scope) return { summary: null, input: initialInput, loading: true, refreshing: false, error: "", refresh };
  return { summary: state.summary, input: state.input, loading: state.loading, refreshing: state.refreshing, error: state.error, refresh };
}
