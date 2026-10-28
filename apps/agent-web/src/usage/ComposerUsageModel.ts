// Usage semantics adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ContextWindowUsage, ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";

export function isUsageLimitsCommand(text: string): boolean {
  return text.trim() === "/usage-limits";
}

export function consumeUsageLimitsCommand(composer: { getState(): { text: string }; setText(text: string): void }, openLimits: () => void): boolean {
  if (!isUsageLimitsCommand(composer.getState().text)) return false;
  composer.setText("");
  openLimits();
  return true;
}
export function scopedThreadSnapshot(threadId: string | undefined, providerInstanceId: string, snapshot: ThreadUsageSnapshot | null): ThreadUsageSnapshot | null {
  return threadId && snapshot?.threadId === threadId && (!snapshot.providerInstanceId || snapshot.providerInstanceId === providerInstanceId) ? snapshot : null;
}

export function accountMatchesInstance(account: { instanceId?: string; instanceIds?: string[] }, instanceId: string): boolean {
  return account.instanceId === instanceId || account.instanceIds?.includes(instanceId) === true;
}

export function contextPercent(context: ContextWindowUsage): number | null {
  return context.maxTokens === undefined ? null : Math.min(100, (context.usedTokens / context.maxTokens) * 100);
}

/** Report only native counters that exist; do not combine partial classifications. */
export function turnUsageFields(snapshot: ThreadUsageSnapshot | null): { incomplete: boolean; fields: { label: string; value: number }[] } | null {
  if (!snapshot) return null;
  if (snapshot.totals) {
    const totals = snapshot.totals;
    return { incomplete: false, fields: [
      { label: "未缓存输入", value: totals.uncachedInputTokens },
      { label: "缓存读取", value: totals.cachedInputTokens },
      { label: "缓存写入", value: totals.cacheCreationTokens },
      { label: "输出", value: totals.outputTokens },
      { label: "其中 reasoning", value: totals.reasoningTokens },
    ] };
  }
  const reported = snapshot.reportedTurn;
  if (!reported) return null;
  const fields = [{ label: "供应商报告输入", value: reported.inputTokens }, { label: "供应商报告输出", value: reported.outputTokens }];
  if (reported.cachedInputTokens !== undefined) fields.push({ label: "缓存读取", value: reported.cachedInputTokens });
  if (reported.cacheCreationTokens !== undefined) fields.push({ label: "缓存写入", value: reported.cacheCreationTokens });
  if (reported.reasoningTokens !== undefined) fields.push({ label: "其中 reasoning", value: reported.reasoningTokens });
  return { incomplete: true, fields };
}
