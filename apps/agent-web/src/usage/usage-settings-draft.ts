// Adapted from t3code usage price settings. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageLimitSourceInput, UsageLimitSourceView, UsageModelPriceOverride, UsageSettings, UsageSettingsUpdate } from "@agent-workspace/contracts/usage";

export type PriceDraft = { model: string; input: string; output: string; cacheRead: string; cacheWrite: string };
export type AliasDraft = { model: string; target: string };
export type SettingsDraft = { prices: PriceDraft[]; aliases: AliasDraft[]; cursorKeychainUsageEnabled: boolean };
export type SourceDraft = { label: string; url: string; enabled: boolean; managementKey: string; clearManagementKey: boolean };

export function settingsDraft(settings: UsageSettings): SettingsDraft {
  return {
    prices: Object.entries(settings.usagePriceOverrides).map(([model, price]) => ({ model, input: String(price.inputCostPerMillionTokens), output: String(price.outputCostPerMillionTokens), cacheRead: price.cacheReadCostPerMillionTokens === undefined ? "" : String(price.cacheReadCostPerMillionTokens), cacheWrite: price.cacheWriteCostPerMillionTokens === undefined ? "" : String(price.cacheWriteCostPerMillionTokens) })),
    aliases: Object.entries(settings.usageModelAliases).map(([model, target]) => ({ model, target })),
    cursorKeychainUsageEnabled: settings.cursorKeychainUsageEnabled,
  };
}
function priceNumber(value: string, optional: boolean): number | undefined {
  if (!value.trim()) { if (optional) return undefined; throw new Error("输入和输出价格为必填项。"); }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("价格必须是有限的非负数字。");
  return number;
}
export function settingsPatch(base: UsageSettings, draft: SettingsDraft, revision = base.revision): UsageSettingsUpdate {
  const prices: Record<string, UsageModelPriceOverride> = Object.create(null);
  const aliases: Record<string, string> = Object.create(null);
  for (const row of draft.prices) {
    const model = row.model.trim();
    if (!model || model.length > 512 || Object.hasOwn(prices, model)) throw new Error("价格模型 ID 不能为空、超过 512 字符或重复。");
    const input = priceNumber(row.input, false)!; const output = priceNumber(row.output, false)!;
    const read = priceNumber(row.cacheRead, true); const write = priceNumber(row.cacheWrite, true);
    prices[model] = { inputCostPerMillionTokens: input, outputCostPerMillionTokens: output, ...(read === undefined ? {} : { cacheReadCostPerMillionTokens: read }), ...(write === undefined ? {} : { cacheWriteCostPerMillionTokens: write }) };
  }
  for (const row of draft.aliases) {
    const model = row.model.trim(); const target = row.target.trim();
    if (!model || !target || model.length > 512 || target.length > 512 || Object.hasOwn(aliases, model)) throw new Error("别名和目标模型不能为空、超过 512 字符或重复。");
    aliases[model] = target;
  }
  const priceChanges: Record<string, UsageModelPriceOverride | null> = Object.create(null);
  const aliasChanges: Record<string, string | null> = Object.create(null);
  for (const model of new Set([...Object.keys(base.usagePriceOverrides), ...Object.keys(prices)])) {
    if (JSON.stringify(base.usagePriceOverrides[model]) !== JSON.stringify(prices[model])) priceChanges[model] = prices[model] ?? null;
  }
  for (const model of new Set([...Object.keys(base.usageModelAliases), ...Object.keys(aliases)])) {
    if (base.usageModelAliases[model] !== aliases[model]) aliasChanges[model] = aliases[model] ?? null;
  }
  return { revision, ...(Object.keys(priceChanges).length ? { usagePriceOverrides: priceChanges } : {}), ...(Object.keys(aliasChanges).length ? { usageModelAliases: aliasChanges } : {}), ...(base.cursorKeychainUsageEnabled !== draft.cursorKeychainUsageEnabled ? { cursorKeychainUsageEnabled: draft.cursorKeychainUsageEnabled } : {}) };
}
export function sourceDraft(source?: UsageLimitSourceView): SourceDraft {
  return { label: source?.label ?? "", url: source?.url ?? "", enabled: source?.enabled ?? true, managementKey: "", clearManagementKey: false };
}
export function sourceInput(draft: SourceDraft, revision?: number): UsageLimitSourceInput {
  return { kind: "cliproxy", label: draft.label.trim(), url: draft.url.trim(), enabled: draft.enabled, ...(draft.managementKey ? { managementKey: draft.managementKey } : {}), ...(draft.clearManagementKey ? { clearManagementKey: true } : {}), ...(revision === undefined ? {} : { revision }) };
}
