import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import type { StudioDefinition, StudioExecution } from "../../../../../../../../packages/contracts/src/automation-studio";
import { useAgentText } from "../../i18n";
import { StudioActionStore } from "./studio-action-store";

export type StudioCommand = { kind: "run" | "remove" | "status"; id: string; expectedRevision: number; status?: "enabled" | "paused" } | { kind: "cancel"; id: string };
export type StudioSettled = { command: StudioCommand; definition?: StudioDefinition; execution?: StudioExecution };
const stores = new Map<string, StudioActionStore>();

/** Shared ownership uses the existing journal; no definition snapshots are stored in the browser. */
export function useStudioActions(api: StudioClient, actorId: string, workspaceId: string, onSettled: (result: StudioSettled) => void, onAccessFailure: () => void, membershipVersion: string | number) {
  const text = useAgentText();
  const key = `pm-automation-studio-actions:${window.location.origin}:${actorId}:${workspaceId}`;
  const store = useMemo(() => {
    let current = stores.get(key);
    if (!current) { current = new StudioActionStore(key); stores.set(key, current); }
    return current;
  }, [key]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener, membershipVersion), [store, membershipVersion]);
  const state = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
  const owner = useMemo(() => ({ active: false }), [store, membershipVersion]);
  const callbacks = useRef({ onSettled, onAccessFailure });
  callbacks.current = { onSettled, onAccessFailure };
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const context = {
    version: membershipVersion, text,
    settled: (result: StudioSettled) => { if (owner.active && currentOwner.current === owner) callbacks.current.onSettled(result); },
    accessFailure: () => { if (owner.active && currentOwner.current === owner) callbacks.current.onAccessFailure(); },
  };
  const latest = useRef(context); latest.current = context;
  useEffect(() => {
    owner.active = true;
    if (store.getSnapshot().pending) void store.reconcile(api, latest.current);
    return () => { owner.active = false; };
  }, [api, store, owner]);
  return {
    pending: state.pending, busy: state.busy, storageError: state.storageError,
    error: state.errorVersion === membershipVersion ? state.error : "",
    settled: state.settledVersion === membershipVersion ? state.settled : null,
    execute: (command: StudioCommand) => store.execute(api, command, context),
    reconcile: () => store.reconcile(api, context),
    retryStorage: () => store.retryStorage(api, context),
  };
}
