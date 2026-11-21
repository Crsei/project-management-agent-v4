// Native usage history for the PM-owned Oh My Pi adapter.
// Session format reference: oh-my-pi e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e
// packages/coding-agent/src/session/session-entries.ts and session-manager.ts.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { OmpSettings } from "../settings.ts";
import { resolveOmpNativeHome } from "./launch.ts";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Timestamp = Schema.Union([Schema.String, Schema.Number]);
const Message = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  timestamp: Schema.optional(Timestamp),
  completedAt: Schema.optional(Schema.Number),
  usage: Usage,
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.optional(Timestamp) };
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({ ...Identity, type: Schema.Literal("message"), message: Message }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("model_usage"),
    provider: Schema.NonEmptyString,
    model: Schema.NonEmptyString,
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function recordTimestampMs(entry: { readonly timestamp?: string | number | undefined }, message?: typeof Message.Type): number | null {
  const direct = parseTimestampMs(entry.timestamp);
  if (direct !== null) return direct;
  const completed = message?.completedAt;
  if (typeof completed === "number" && Number.isFinite(completed) && completed > 0) return Math.trunc(completed);
  const started = message?.timestamp;
  if (typeof started === "number" && Number.isFinite(started) && started > 0) return Math.trunc(started);
  return parseTimestampMs(started);
}

function parseRecord(parsed: unknown, state: typeof OmpScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const source = entry.type === "message" ? entry.message : entry;
  const timestampMs = recordTimestampMs(entry, entry.type === "message" ? entry.message : undefined);
  if (timestampMs === null) return [];
  const usage = source.usage;
  const outputTokens = tokenCount(usage.output);
  const totals = {
    // OMP's input/cache counters are disjoint; reasoning is a subset of output.
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens ?? usage.reasoning)),
  };
  const total = usage.cost?.total;
  const reportedCostUsd =
    typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  const model = `${source.provider}/${source.model}`;
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      rateModel: source.model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Forks copy entry IDs/timestamps; the native call identity avoids double-counting
      // the same inference when it appears in more than one session file.
      dedupeKey: JSON.stringify(["omp", entry.type, entry.id, entry.timestamp ?? "", model]),
    },
  ];
}

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, timestamp: true, completedAt: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

export const ompUsageReader: ProviderUsageReader<OmpSettings, never> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: Effect.fn("ompUsageReader.directories")(function* ({ environment }) {
    const home = yield* HostProcess.HomeDirectory;
    const cwd = yield* HostProcess.WorkingDirectory;
    return [{ dir: resolveOmpNativeHome({ environment, homeDirectory: home, cwd }).sessionsDirectory }];
  }),
};
