import type * as Effect from "effect/Effect";
import type { PiDiscoveredCommands } from "./commands.ts";

type Reader = () => Effect.Effect<PiDiscoveredCommands, unknown>;
const readers = new Map<string, Reader>();
const key = (instanceId: string, threadId: string, executionId: string, cwd: string) => JSON.stringify([instanceId, threadId, executionId, cwd]);

/** Only the already-admitted native Chat session may expose extension commands. */
export function registerLivePiWorkspace(instanceId: string, threadId: string, executionId: string, cwd: string, read: Reader): () => void {
  const identity = key(instanceId, threadId, executionId, cwd);
  readers.set(identity, read);
  return () => { if (readers.get(identity) === read) readers.delete(identity); };
}
export function livePiWorkspace(instanceId: string, threadId: string, executionId: string, cwd: string): Reader | undefined {
  return readers.get(key(instanceId, threadId, executionId, cwd));
}
