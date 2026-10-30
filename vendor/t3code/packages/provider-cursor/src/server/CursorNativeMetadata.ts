import type * as Effect from "effect/Effect";
import type { CursorAgentSdkSession } from "./CursorAgentSdk.ts";

export interface CursorNativeMetadata {
  readonly agentId: string;
  readonly runtime: "local";
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly runs: ReadonlyArray<{ readonly id: string; readonly status: string; readonly model?: string }>;
}
const readers = new WeakMap<CursorAgentSdkSession, Effect.Effect<CursorNativeMetadata, unknown>>();
export function bindCursorNativeMetadata(session: CursorAgentSdkSession, read: Effect.Effect<CursorNativeMetadata, unknown>): void {
  readers.set(session, read);
}
export function readCursorNativeMetadata(session: CursorAgentSdkSession): Effect.Effect<CursorNativeMetadata, unknown> | undefined {
  return readers.get(session);
}
