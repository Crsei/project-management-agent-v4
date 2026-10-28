// Adapted from t3code Codex, Claude, Grok and Pi usage readers.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageSpeed, UsageTokenTotals } from "@agent-workspace/contracts/usage";
import { parseTimestampMs, tokenCount, totalTokens, type UsageRecord } from "../types.ts";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Obj : null;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const cost = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const speed = (value: unknown): UsageSpeed => value === "fast" || value === "priority" ? "fast" : value === "ultrafast" ? "ultrafast" : "standard";
type Counters = { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number };
const fields: (keyof Counters)[] = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
function counters(value: unknown): Counters | null {
  const raw = object(value);
  if (!raw || typeof raw.input_tokens !== "number" || typeof raw.output_tokens !== "number") return null;
  const result = { input_tokens: raw.input_tokens, cached_input_tokens: raw.cached_input_tokens ?? 0, cache_write_input_tokens: raw.cache_write_input_tokens ?? 0, output_tokens: raw.output_tokens, reasoning_output_tokens: raw.reasoning_output_tokens ?? 0, total_tokens: raw.total_tokens ?? raw.input_tokens + raw.output_tokens };
  if (!fields.every((key) => typeof result[key] === "number" && Number.isSafeInteger(result[key]) && (result[key] as number) >= 0)) return null;
  const r = result as Counters;
  return r.cached_input_tokens + r.cache_write_input_tokens <= r.input_tokens && r.reasoning_output_tokens <= r.output_tokens && r.total_tokens >= r.input_tokens + r.output_tokens ? r : null;
}
function add(a: Counters | null, b: Counters): Counters | null { return counters(Object.fromEntries(fields.map((k) => [k, (a?.[k] ?? 0) + b[k]]))); }
export interface TranscriptState { model: string; speed: UsageSpeed; sessionId: string; lastSignature: string | null; cumulative: Counters | null; malformed: number; sawMeta: boolean; modelProvider: string; turnId: string; sawSettings: boolean; fork: boolean; forkTime: number }
export function initialState(): TranscriptState { return { model: "", speed: "standard", sessionId: "", lastSignature: null, cumulative: null, malformed: 0, sawMeta: false, modelProvider: "", turnId: "", sawSettings: false, fork: false, forkTime: 0 }; }
function codex(record: Obj, state: TranscriptState): UsageRecord[] {
  const p = object(record.payload); if (!p) return [];
  if (record.type === "session_meta") {
    if (state.sawMeta) return [];
    state.sawMeta = true; state.sessionId = str(p.id ?? p.session_id); state.modelProvider = str(p.model_provider);
    const t = parseTimestampMs(record.timestamp); const spawn = object(object(p.source)?.subagent); const thread = object(spawn?.thread_spawn);
    if (t !== null && (typeof p.forked_from_id === "string" || typeof thread?.parent_thread_id === "string")) { state.fork = true; state.forkTime = t; }
    return [];
  }
  if (record.type === "turn_context") { if (typeof p.model === "string") state.model = p.model; state.turnId = typeof p.turn_id === "string" && str(p.model) ? p.turn_id : ""; return []; }
  if (p.type === "thread_settings_applied") { state.sawSettings = true; const settings = object(p.thread_settings); if (settings) state.speed = speed(settings.service_tier); return []; }
  if (p.type !== "token_count") return [];
  const info = object(p.info); const timestampMs = parseTimestampMs(record.timestamp);
  if (!info || timestampMs === null || !state.model) return [];
  const last = counters(info.last_token_usage); const hasCumulative = info.total_token_usage != null; const current = hasCumulative ? counters(info.total_token_usage) : null;
  if (state.fork) {
    if (timestampMs - state.forkTime < 1000) { state.forkTime = timestampMs; const signature = last && JSON.stringify(last); if (current) state.cumulative = current; else if (!hasCumulative && last && signature !== state.lastSignature) state.cumulative = add(state.cumulative, last); state.lastSignature = signature; return []; }
    state.fork = false; state.lastSignature = null;
  }
  const previous = state.cumulative; if (current) state.cumulative = current;
  if (!last || (hasCumulative && !current)) { state.malformed++; return []; }
  if (last.input_tokens + last.output_tokens === 0) { state.lastSignature = null; return []; }
  if (current && previous && fields.every((k) => current[k] === previous[k])) return [];
  if (last.total_tokens !== last.input_tokens + last.output_tokens) { state.malformed++; return []; }
  const signature = JSON.stringify(last);
  if (current) {
    const restarted = fields.every((k) => current[k] === last[k]);
    const reconciled = previous ? fields.every((k) => current[k] - previous[k] === last[k]) : counters(Object.fromEntries(fields.map((k) => [k, current[k] - last[k]]))) !== null;
    if (!restarted && !reconciled) { state.malformed++; return []; }
  } else { if (signature === state.lastSignature) return []; const advanced = add(previous, last); if (!advanced) { state.malformed++; return []; } state.cumulative = advanced; }
  state.lastSignature = signature;
  const totals = { uncachedInputTokens: last.input_tokens - last.cached_input_tokens - last.cache_write_input_tokens, cachedInputTokens: last.cached_input_tokens, cacheCreationTokens: last.cache_write_input_tokens, outputTokens: last.output_tokens, reasoningTokens: last.reasoning_output_tokens };
  return [{ provider: "codex", timestampMs, model: state.model, sessionId: state.sessionId, totals, reportedCostUsd: null, speed: state.speed, ...(!state.sawSettings && state.modelProvider === "openai" && state.sessionId && state.turnId ? { unresolvedServiceTierTurnId: state.turnId, nativeTurnId: state.turnId } : state.turnId ? { nativeTurnId: state.turnId } : {}), dedupeKey: null }];
}
function claude(record: Obj): UsageRecord[] {
  if (record.type !== "assistant") return [];
  const message = object(record.message); const usage = object(message?.usage); const timestampMs = parseTimestampMs(record.timestamp); const model = str(message?.model);
  if (!message || !usage || timestampMs === null || !model || model === "<synthetic>") return [];
  const messageId = str(message.id), requestId = str(record.requestId);
  return [{ provider: "claude", timestampMs, model, sessionId: str(record.sessionId), totals: { uncachedInputTokens: tokenCount(usage.input_tokens), cachedInputTokens: tokenCount(usage.cache_read_input_tokens), cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens), outputTokens: tokenCount(usage.output_tokens), reasoningTokens: 0 }, reportedCostUsd: cost(record.costUSD), speed: usage.speed === "fast" ? "fast" : "standard", dedupeKey: messageId || requestId ? `${messageId}:${requestId}` : null }];
}
type GrokTotals = { input: number; output: number; cached: number; write: number; reasoning: number; ticks: number | null };
function grokTotals(value: unknown): GrokTotals | null { const v = object(value); return v ? { input: tokenCount(v.inputTokens), output: tokenCount(v.outputTokens), cached: tokenCount(v.cachedReadTokens), write: tokenCount(v.cacheCreationTokens), reasoning: tokenCount(v.reasoningTokens), ticks: cost(v.costUsdTicks) } : null; }
function grokTokens(v: GrokTotals): UsageTokenTotals { return { uncachedInputTokens: Math.max(0, v.input - v.cached - v.write), cachedInputTokens: v.cached, cacheCreationTokens: v.write, outputTokens: v.output, reasoningTokens: Math.min(v.output, v.reasoning) }; }
function grok(record: Obj): UsageRecord[] {
  const params = object(record.params), update = object(params?.update), usage = object(update?.usage);
  if (!params || !update || update.sessionUpdate !== "turn_completed" || !usage) return [];
  const t = object(params._meta)?.agentTimestampMs; const rawTime = record.timestamp;
  const timestampMs = typeof t === "number" && Number.isFinite(t) ? t : typeof rawTime === "number" && Number.isFinite(rawTime) ? (rawTime > 1e12 ? rawTime : rawTime * 1000) : null;
  if (timestampMs === null) return [];
  const top = grokTotals(usage)!; const sessionId = str(params.sessionId), prompt = str(update.prompt_id);
  let entries = Object.entries(object(usage.modelUsage) ?? {}).flatMap(([model, value]) => { const totals = grokTotals(value); return model && totals ? [{ model, totals }] : []; });
  if (!entries.length) entries = [{ model: "grok", totals: top }];
  entries = entries.filter((e) => totalTokens(grokTokens(e.totals)) > 0);
  const remainder = top.ticks === null ? null : Math.max(0, top.ticks - entries.reduce((n, e) => n + (e.totals.ticks ?? 0), 0));
  const denominator = entries.reduce((n, e) => n + (e.totals.ticks === null ? totalTokens(grokTokens(e.totals)) : 0), 0);
  return entries.map(({ model, totals: v }) => { const totals = grokTokens(v); const ticks = v.ticks ?? (remainder !== null && denominator ? remainder * totalTokens(totals) / denominator : null); return { provider: "grok", timestampMs, model, sessionId, totals, reportedCostUsd: ticks === null ? null : ticks / 10_000_000_000, speed: "standard", dedupeKey: prompt ? `${sessionId}:${prompt}:${model}` : null, ...(prompt ? { nativeTurnId: prompt } : {}) }; });
}
function pi(record: Obj, state: TranscriptState): UsageRecord[] {
  if (record.type === "session") { if (str(record.id)) state.sessionId = str(record.id); return []; }
  const id = str(record.id), timestampMs = parseTimestampMs(record.timestamp);
  if (!id || timestampMs === null) return [];
  const message = record.type === "message" ? object(record.message) : null;
  if (record.type === "message" && (!message || (message.role !== "assistant" && message.role !== "toolResult"))) return [];
  if (!["message", "usage", "compaction", "branch_summary"].includes(str(record.type))) return [];
  const source = message ?? record, usage = object(source.usage); if (!usage) return [];
  const needsModel = record.type === "usage" || (record.type === "message" && message?.role === "assistant");
  if (needsModel && (!str(source.provider) || !str(source.model))) return [];
  const rateModel = needsModel ? str(source.responseModel) || str(source.model) : undefined;
  const model = rateModel ? `${str(source.provider)}/${rateModel}` : "Tools/summaries";
  const outputTokens = tokenCount(usage.output);
  const totals = { uncachedInputTokens: tokenCount(usage.input), cachedInputTokens: tokenCount(usage.cacheRead), cacheCreationTokens: tokenCount(usage.cacheWrite), outputTokens, reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning)) };
  const reported = cost(object(usage.cost)?.total); const reportedCostUsd = reported && reported > 0 ? reported : null;
  if (!totalTokens(totals) && reportedCostUsd === null) return [];
  return [{ provider: "pi", timestampMs, model, ...(rateModel ? { rateModel } : {}), sessionId: state.sessionId, totals, reportedCostUsd, speed: "standard", dedupeKey: JSON.stringify(["pi", id, record.timestamp, model]) }];
}
export type TranscriptProvider = "codex" | "claude" | "grok" | "pi";
export function parseTranscriptRecord(provider: TranscriptProvider, value: unknown, state: TranscriptState): UsageRecord[] {
  const record = object(value); if (!record) return [];
  switch (provider) { case "codex": return codex(record, state); case "claude": return claude(record); case "grok": return grok(record); case "pi": return pi(record, state); }
}
