// Adapted from t3code antigravityUsageReader.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldNow } from "node:timers/promises";
import type { UsageRecord } from "../types.ts";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;
type Metadata = { model: string; timestampMs: number | null; usages: Fields[] };
export type Candidate = { record: UsageRecord; keys: string[]; quality: number };

function fields(bytes: Uint8Array): Fields {
  let offset = 0; const result: Fields = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw new Error("Invalid protobuf varint");
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint(); if (typeof tag !== "number" || tag < 8) throw new Error("Invalid protobuf field");
    const key = Math.floor(tag / 8), wire = tag % 8; let value: FieldValue;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number" || length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length); offset += length;
      if (wire !== 2) continue;
    } else throw new Error("Unsupported protobuf wire type");
    const entries = result.get(key) ?? []; entries.push(value); result.set(key, entries);
  }
  return result;
}
const num = (data: Fields, key: number) => { const value = data.get(key)?.[0]; return typeof value === "number" ? value : 0; };
const bytes = (data: Fields, key: number) => { const value = data.get(key)?.[0]; return value instanceof Uint8Array ? value : undefined; };
const nested = (data: Fields, key: number): Fields => { const value = bytes(data, key); return value ? fields(value) : new Map(); };
const text = (data: Fields, key: number) => { const value = bytes(data, key); return value ? new TextDecoder("utf-8", { fatal: true }).decode(value).trim() : ""; };
const time = (data: Fields) => num(data, 1) > 0 ? num(data, 1) * 1000 + Math.floor(num(data, 2) / 1_000_000) : null;
const models: Record<number, string> = { 246: "gemini-2.5-pro", 312: "gemini-2.5-flash", 313: "gemini-2.5-flash-thinking", 329: "gemini-2.5-flash-thinking", 330: "gemini-2.5-flash-lite", 281: "claude-sonnet-4", 282: "claude-sonnet-4", 290: "claude-opus-4", 291: "claude-opus-4", 333: "claude-sonnet-4-5", 334: "claude-sonnet-4-5", 340: "claude-haiku-4-5", 341: "claude-haiku-4-5", 1026: "claude-opus-4-6", 1035: "claude-sonnet-4-6", 1016: "gemini-3.1-pro", 1036: "gemini-3.1-pro", 1037: "gemini-3.1-pro", 1018: "gemini-3-flash-preview", 1084: "gemini-3-flash-preview", 1047: "gemini-3-flash-preview" };
function modelName(name: string, id: number): string {
  if (!name) return models[id] ?? (id ? `antigravity-model-${id}` : "");
  const value = name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replaceAll(" ", "-");
  return value.startsWith("claude-") ? value.replace(/^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1").replaceAll(".", "-") : value;
}
function metadata(blob: unknown, step: boolean): Metadata {
  if (!(blob instanceof Uint8Array)) throw new Error("Invalid metadata blob");
  const root = fields(blob); if (!step && !bytes(root, 1)) throw new Error("Missing generation metadata");
  const data = step ? root : nested(root, 1), model = step ? nested(data, 24) : data;
  const usages: Fields[] = []; const primary = bytes(data, step ? 9 : 4);
  if (primary) usages.push(fields(primary.slice()));
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const usage = bytes(fields(retry), 2); if (usage) usages.push(fields(usage.slice()));
  }
  return { model: modelName(text(model, step ? 12 : 19) || text(model, step ? 8 : 21), num(model, step ? 1 : 3)), timestampMs: step ? time(nested(data, 8)) ?? time(nested(data, 1)) : time(nested(nested(data, 9), 4)), usages };
}

export async function readAntigravityDatabase(file: string, sessionId: string, fallbackMs: number, signal?: AbortSignal): Promise<{ candidates: Candidate[]; malformed: number }> {
  const db = new DatabaseSync(file, { readOnly: true }); let malformed = 0;
  try {
    db.exec("PRAGMA busy_timeout = 100; PRAGMA query_only = ON");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has("gen_metadata") && !tables.has("steps")) throw new Error("Unrecognized Antigravity database");
    const generations: Array<{ idx: number; entry: Metadata }> = [], steps: typeof generations = [];
    const scan = async (table: string, column: string, step: boolean, target: typeof generations) => {
      const statement = db.prepare(`SELECT rowid AS row_id, idx, ${column} AS data FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
      let after = -Number.MAX_SAFE_INTEGER;
      while (true) {
        signal?.throwIfAborted(); const rows = statement.all(after, step ? 64 : 1); if (!rows.length) break;
        for (const row of rows) {
          if (step && row.data === null) continue;
          try { if (typeof row.idx !== "number") throw new Error("Invalid index"); target.push({ idx: row.idx, entry: metadata(row.data, step) }); } catch { malformed++; }
        }
        after = Number(rows[rows.length - 1]!.row_id);
        await yieldNow();
      }
      target.sort((a, b) => a.idx - b.idx);
    };
    if (tables.has("gen_metadata")) await scan("gen_metadata", "data", false, generations);
    if (tables.has("steps")) await scan("steps", "metadata", true, steps);
    let trajectory: number | null = null;
    if (tables.has("trajectory_metadata_blob")) for (const row of db.prepare("SELECT data FROM trajectory_metadata_blob").iterate()) {
      try { if (!(row.data instanceof Uint8Array)) throw new Error("Invalid trajectory"); trajectory ??= time(nested(fields(row.data), 2)); } catch { malformed++; }
    }
    const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry.model])); const candidates: Candidate[] = [];
    for (const [source, entries] of [["step", steps], ["generation", generations]] as const) for (const [index, { idx, entry }] of entries.entries()) for (const [usageIndex, usage] of entry.usages.entries()) {
      try {
        const outputTokens = Math.max(num(usage, 3), num(usage, 9) + num(usage, 10));
        const totals = { uncachedInputTokens: num(usage, 2), cachedInputTokens: num(usage, 5), cacheCreationTokens: num(usage, 4), outputTokens, reasoningTokens: Math.min(outputTokens, num(usage, 9)) };
        if (!totals.uncachedInputTokens && !totals.cachedInputTokens && !totals.cacheCreationTokens && !outputTokens) continue;
        const keys = [11, 12, 7].flatMap(key => { const id = text(usage, key); return id ? [`antigravity:${key}:${id}`] : []; });
        candidates.push({ keys, quality: entry.timestampMs !== null ? 2 : trajectory !== null ? 1 : 0, record: { provider: "antigravity", sessionId, timestampMs: entry.timestampMs ?? trajectory ?? fallbackMs, model: models[num(usage, 1)] || entry.model || (source === "step" ? generationModels.get(idx) : "") || modelName("", num(usage, 1)) || "antigravity-unknown", totals, reportedCostUsd: null, speed: "standard", dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}` } });
      } catch { malformed++; }
    }
    return { candidates, malformed };
  } finally { db.close(); }
}
