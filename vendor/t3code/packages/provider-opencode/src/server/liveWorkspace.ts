import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/** Borrow only an already admitted native session; this registry never starts a server. */
export type LiveOpenCodeInventory = {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly pending?: boolean;
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
};
type Entry = { readonly read: () => Effect.Effect<LiveOpenCodeInventory, unknown> };
const sessions = new Map<string, Set<Entry>>();
const keyOf = (instanceId: string, threadId: string, executionId: string, cwd: string) => JSON.stringify([instanceId, threadId, executionId, cwd]);

export function registerLiveOpenCodeInventory(instanceId: string, threadId: string, executionId: string, cwd: string, read: Entry["read"]): () => void {
  const key = keyOf(instanceId, threadId, executionId, cwd);
  const entries = sessions.get(key) ?? new Set<Entry>();
  const entry = { read };
  entries.add(entry);
  sessions.set(key, entries);
  return () => {
    entries.delete(entry);
    if (entries.size === 0 && sessions.get(key) === entries) sessions.delete(key);
  };
}

export function liveOpenCodeInventory(instanceId: string, threadId: string, executionId: string, cwd: string): Entry["read"] | undefined {
  return [...sessions.get(keyOf(instanceId, threadId, executionId, cwd)) ?? []].at(-1)?.read;
}
