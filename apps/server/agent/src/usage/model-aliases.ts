// Usage model alias semantics adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageSettings } from "@agent-workspace/contracts/usage";

/** Invalid cycles never select an arbitrary intermediate price or merge unrelated models. */
export function resolveUsageModelAlias(model: string, aliases?: UsageSettings["usageModelAliases"]): string {
  const seen = new Set<string>();
  let target = model;
  while (aliases && Object.hasOwn(aliases, target)) {
    if (seen.has(target)) return model;
    seen.add(target);
    target = aliases[target]!;
  }
  return target;
}
