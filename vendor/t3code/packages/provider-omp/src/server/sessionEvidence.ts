import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type {
  ProviderAdapterV2SessionRuntime, ProviderAdapterV2EnsureThreadInput,
  ProviderAdapterV2ThreadSnapshot, ProviderNativeCompletedTurnRef,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind } from "@t3tools/contracts";
import { ompRecordField as field, ompRecordString as string } from "./rpc.ts";

export interface OmpSessionEvidence {
  readonly probe: Effect.Effect<{ readonly protocol: string; readonly cwd: string; readonly homeDirectory: string }, unknown>;
  readonly readLegacy: (input: { readonly nativeSessionId: string; readonly turnId?: string; readonly messageId?: string;
    readonly ensure: ProviderAdapterV2EnsureThreadInput }) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, unknown>;
}
const sessions = new WeakMap<ProviderAdapterV2SessionRuntime, OmpSessionEvidence>();
export function bindOmpSessionEvidence(runtime: ProviderAdapterV2SessionRuntime, evidence: OmpSessionEvidence): () => void {
  sessions.set(runtime, evidence);
  return () => { if (sessions.get(runtime) === evidence) sessions.delete(runtime); };
}
export function readOmpSessionEvidence(runtime: ProviderAdapterV2SessionRuntime): OmpSessionEvidence | undefined {
  return sessions.get(runtime);
}

/** v18.13.2 session-entries.ts: a fixed-width title slot may precede the
 * session header. Read metadata only, never credential/config files. */
export const readOmpSessionHeader = Effect.fn("readOmpSessionHeader")(function* (
  input: { readonly sessionFile: string; readonly sessionsDirectory: string; readonly cwd: string },
) {
  const fs = yield* FileSystem.FileSystem;
  if (!NodePath.isAbsolute(input.sessionFile) || !input.sessionFile.endsWith(".jsonl"))
    return yield* Effect.fail(new Error("OMP session identity must be an absolute native JSONL path"));
  const root = yield* fs.realPath(input.sessionsDirectory);
  const file = yield* fs.realPath(input.sessionFile);
  const relative = NodePath.relative(root, file);
  if (!relative || relative.startsWith(`..${NodePath.sep}`) || relative === ".." || NodePath.isAbsolute(relative))
    return yield* Effect.fail(new Error("OMP session is outside the bound native Home/Profile"));
  const header = yield* Effect.scoped(Effect.gen(function* () {
    const handle = yield* fs.open(file, { flag: "r" });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let buffer = "";
    let line = 0;
    while (bytes < 64 * 1024) {
      const chunk = yield* handle.readAlloc(Math.min(4096, 64 * 1024 - bytes));
      if (Option.isNone(chunk)) return yield* Effect.fail(new Error("OMP session has no complete metadata header"));
      bytes += chunk.value.byteLength;
      const decoded = yield* Effect.try({ try: () => decoder.decode(chunk.value, { stream: true }), catch: cause => new Error("Invalid OMP metadata UTF-8", { cause }) });
      buffer += decoded;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const entry = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: cause => new Error("Invalid OMP metadata JSON", { cause }) });
        if (line++ === 0 && field(entry, "type") === "title") continue;
        const id = string(entry, "id");
        const cwd = string(entry, "cwd");
        if (field(entry, "type") !== "session" || !id || !cwd || field(entry, "version") !== 3)
          return yield* Effect.fail(new Error("OMP session does not have a v3 native session header"));
        return { id, cwd, file };
      }
    }
    return yield* Effect.fail(new Error("OMP metadata header exceeds its 64 KiB boundary"));
  }));
  const expectedCwd = yield* fs.realPath(input.cwd);
  const recordedCwd = yield* fs.realPath(header.cwd);
  if (expectedCwd !== recordedCwd) return yield* Effect.fail(new Error("OMP session belongs to another cwd"));
  return header;
});

/** get_entries is append-history, NOT a transcript. Walk only its active leaf,
 * rejecting cycles, missing/duplicate identities and malformed parents. */
export function readOmpActiveBranch(payload: unknown): {
  readonly leafId: string | null;
  readonly entries: ReadonlyArray<unknown>;
  readonly completedTurnRefs: ReadonlyArray<ProviderNativeCompletedTurnRef>;
} | undefined {
  const entries = field(payload, "entries");
  const leafId = field(payload, "leafId");
  if (!Array.isArray(entries) || !(leafId === null || typeof leafId === "string")) return undefined;
  const byId = new Map<string, unknown>();
  for (const entry of entries) {
    const id = string(entry, "id");
    const parent = field(entry, "parentId");
    if (!id || byId.has(id) || !(parent === null || typeof parent === "string")) return undefined;
    byId.set(id, entry);
  }
  const branch: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) return undefined;
    branch.push(entry);
    cursor = field(entry, "parentId") as string | null;
  }
  branch.reverse();
  const completedTurnRefs: ProviderNativeCompletedTurnRef[] = [];
  for (const entry of branch) {
    const message = field(entry, "message");
    if (field(entry, "type") === "message" && field(message, "role") === "assistant" && field(message, "stopReason") === "stop")
      completedTurnRefs.push({ driver: ProviderDriverKind.make("omp"), nativeId: string(entry, "id")!, strength: "strong" });
  }
  return { leafId, entries: branch, completedTurnRefs };
}

/** A native append leaf is not the conversational cursor: stock 18.13.2
 * appends normal session_exit records during dispose, after the host saved
 * its completed assistant head. SessionEntry `custom` records do not enter
 * buildSessionContext; normal exits without pending calls cause no recovery
 * turn (session/exit-diagnostics.ts). Permit only these proven metadata
 * descendants, never a missing ancestor, message, context rewrite or unknown
 * custom record. Model/thinking selections are reapplied by the host.
 */
export function ompBranchPreservesConversationHead(entries: ReadonlyArray<unknown>, savedHead: string): boolean {
  const index = entries.findIndex(entry => string(entry, "id") === savedHead);
  if (!savedHead || index < 0) return false;
  for (let cursor = index + 1; cursor < entries.length; cursor++) {
    const entry = entries[cursor];
    const type = string(entry, "type");
    if (type === "model_change") {
      const role = field(entry, "role");
      if (string(entry, "model") && (role === undefined || typeof role === "string")) continue;
      return false;
    }
    if (type === "thinking_level_change") {
      const level = field(entry, "thinkingLevel"), configured = field(entry, "configured");
      if ((level === undefined || level === null || typeof level === "string") &&
        (configured === undefined || configured === null || typeof configured === "string")) continue;
      return false;
    }
    if (type === "custom" && field(entry, "customType") === "session_exit") {
      const data = field(entry, "data");
      const pending = field(data, "pendingToolCalls");
      const recordedAt = string(data, "recordedAt");
      if (field(data, "kind") === "normal" && string(data, "reason") && recordedAt && Number.isFinite(Date.parse(recordedAt)) &&
        (pending === undefined || (Array.isArray(pending) && pending.length === 0))) continue;
    }
    return false;
  }
  return true;
}
