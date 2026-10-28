// Adapted from t3code usage settings semantics.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { usageSettingsSchema, usageSettingsUpdateSchema, type UsageSettings, type UsageSettingsUpdate } from "@agent-workspace/contracts/usage";
import { readRecord, transaction, writeRecord } from "../durable/store.ts";

const NAMESPACE = "settings:usage";
const KEY = "default";

export class UsageSettingsError extends Error {
  readonly status: 400 | 409 | 500;
  readonly code: string;
  constructor(status: 400 | 409 | 500, code: string, message: string) {
    super(message);
    this.name = "UsageSettingsError";
    this.status = status;
    this.code = code;
  }
}

function hasAliasCycle(aliases: UsageSettings["usageModelAliases"]): boolean {
  const complete = new Set<string>();
  for (const start of Object.keys(aliases)) {
    const visiting = new Set<string>();
    let current = start;
    while (Object.hasOwn(aliases, current) && !complete.has(current)) {
      if (visiting.has(current)) return true;
      visiting.add(current);
      current = aliases[current]!;
    }
    for (const model of visiting) complete.add(model);
  }
  return false;
}

export function getUsageSettings(): UsageSettings {
  const stored = readRecord<unknown>(NAMESPACE, KEY);
  if (stored === null) return { revision: 0, usagePriceOverrides: {}, usageModelAliases: {}, cursorKeychainUsageEnabled: false };
  const parsed = usageSettingsSchema.safeParse(stored);
  if (!parsed.success || hasAliasCycle(parsed.data.usageModelAliases))
    throw new UsageSettingsError(500, "invalid_usage_settings", "Usage settings are invalid; the stored settings were not replaced.");
  return parsed.data;
}

/** Updates are patches; null deletes an entry, and the revision is checked atomically. */
export function updateUsageSettings(input: UsageSettingsUpdate): UsageSettings {
  const update = usageSettingsUpdateSchema.parse(input);
  return transaction(() => {
    const current = getUsageSettings();
    if (current.revision !== update.revision)
      throw new UsageSettingsError(409, "usage_settings_conflict", "Usage settings changed in another window; reload before saving your draft.");
    const overrides = new Map(Object.entries(current.usagePriceOverrides));
    const aliases = new Map(Object.entries(current.usageModelAliases));
    for (const [model, price] of Object.entries(update.usagePriceOverrides ?? {})) {
      if (price === null) overrides.delete(model);
      else overrides.set(model, price);
    }
    for (const [model, target] of Object.entries(update.usageModelAliases ?? {})) {
      if (target === null) aliases.delete(model);
      else aliases.set(model, target);
    }
    const next: UsageSettings = {
      revision: current.revision + 1,
      usagePriceOverrides: Object.fromEntries(overrides),
      usageModelAliases: Object.fromEntries(aliases),
      cursorKeychainUsageEnabled: update.cursorKeychainUsageEnabled ?? current.cursorKeychainUsageEnabled,
    };
    if (hasAliasCycle(next.usageModelAliases))
      throw new UsageSettingsError(400, "usage_alias_cycle", "Model aliases must not contain a cycle.");
    usageSettingsSchema.parse(next);
    writeRecord(NAMESPACE, KEY, next);
    return next;
  });
}
