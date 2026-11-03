import type * as EffectAcpSchema from "effect-acp/compat";

export type AcpWorkspaceCommands = ReadonlyArray<EffectAcpSchema.AvailableCommand>;
type Reader = () => AcpWorkspaceCommands | undefined;
const readers = new Map<string, Reader>();
const key = (instanceId: string, threadId: string, executionId: string, cwd: string) => JSON.stringify([instanceId, threadId, executionId, cwd]);

/** Only an existing execution-bound ACP session can publish its command notifications. */
export function registerLiveAcpWorkspace(instanceId: string, threadId: string, executionId: string, cwd: string, read: Reader): () => void {
  const identity = key(instanceId, threadId, executionId, cwd);
  readers.set(identity, read);
  return () => { if (readers.get(identity) === read) readers.delete(identity); };
}
export function liveAcpWorkspace(instanceId: string, threadId: string, executionId: string, cwd: string): Reader | undefined {
  return readers.get(key(instanceId, threadId, executionId, cwd));
}
