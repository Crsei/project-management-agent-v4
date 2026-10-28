// Usage UI adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useAuiState } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import type { ThreadUsageSnapshot, UsageLimitsReport } from "@agent-workspace/contracts/usage";
import { usageApi } from "./api";
import { accountMatchesInstance, contextPercent, scopedThreadSnapshot, turnUsageFields } from "./ComposerUsageModel";

const POLL_MS = 5_000;
const number = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function ComposerUsage({ providerInstanceId, limitsRequest, onCloseLimits }: { providerInstanceId: string; limitsRequest: number; onCloseLimits: () => void }) {
  const threadId = useAuiState((state) => state.threads.threadItems.find((thread) => thread.id === state.threads.mainThreadId)?.remoteId);
  const [snapshot, setSnapshot] = useState<ThreadUsageSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string>();
  const [report, setReport] = useState<UsageLimitsReport | null>(null);
  const [limitsError, setLimitsError] = useState<string>();
  const [loadingLimits, setLoadingLimits] = useState(false);

  useEffect(() => {
    setSnapshot(null);
    setSnapshotError(undefined);
    if (!threadId) return;
    let alive = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await usageApi.thread(threadId);
        if (alive) { setSnapshot(value); setSnapshotError(undefined); }
      } catch (error) {
        if (alive) { setSnapshot(null); setSnapshotError(error instanceof Error ? error.message : String(error)); }
      } finally { pending = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [threadId]);

  useEffect(() => {
    setReport(null);
    setLimitsError(undefined);
    if (!limitsRequest) { setLoadingLimits(false); return; }
    let alive = true;
    setLoadingLimits(true);
    void usageApi.limits().then((value) => { if (alive) setReport(value); }, (error: unknown) => {
      if (alive) setLimitsError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (alive) setLoadingLimits(false); });
    return () => { alive = false; };
  }, [limitsRequest]);

  const current = scopedThreadSnapshot(threadId, providerInstanceId, snapshot);
  const context = current?.context;
  const percent = context ? contextPercent(context) : null;
  const turn = turnUsageFields(current);
  const accounts = report?.accounts.filter((account) => accountMatchesInstance(account, providerInstanceId)) ?? [];
  return <div className="flex flex-col gap-2 px-2 text-xs text-muted-foreground">
    <div aria-label="当前会话用量" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {context ? <span>上下文：{number.format(context.usedTokens)}{context.maxTokens !== undefined ? ` / ${number.format(context.maxTokens)}` : " / 容量未知"} tokens</span> : <span>{snapshotError ? `上下文不可用：${snapshotError}` : "上下文用量尚未报告"}</span>}
      {percent !== null && <progress aria-label="上下文使用比例" max={100} value={percent} className="w-20" />}
      {current?.costUsd !== undefined && <span>本轮费用估算：{money.format(current.costUsd)}</span>}
      <button type="button" disabled title="当前不支持手动压缩上下文">手动压缩不可用</button>
    </div>
    {turn && <details><summary>本轮供应商用量{turn.incomplete ? " · 分类未完整报告" : ""}</summary><div className="flex flex-wrap gap-x-3 gap-y-1">{turn.fields.map(field => <span key={field.label}>{field.label}：{number.format(field.value)}</span>)}</div>{turn.incomplete && <p>输入保持供应商原始口径；未报告的分类不作推算。</p>}</details>}
    {limitsRequest > 0 && <section aria-label="额度快照" className="max-h-48 overflow-y-auto rounded border border-border p-2 text-foreground" aria-live="polite">
      <div className="flex items-center justify-between gap-2"><strong>额度快照</strong><button type="button" onClick={onCloseLimits} aria-label="关闭额度快照">关闭</button></div>
      <p className="text-muted-foreground">只读取已保存快照，不自动探测或刷新。</p>
      {loadingLimits && <p>读取中…</p>}
      {limitsError && <p role="alert">读取额度失败：{limitsError}</p>}
      {report && <>
        <p className="text-muted-foreground">快照时间：{report.createdAt}</p>
        {accounts.length === 0 && <p>当前实例没有已保存的额度账号。</p>}
        {accounts.map((account) => <div key={account.id} className="mt-2 border-t border-border pt-2">
          <strong>{account.displayName || account.label}</strong>{account.sourceLabel && <span> · {account.sourceLabel}</span>}{account.plan && <span> · {account.plan}</span>}
          <p className="text-muted-foreground">检查时间：{account.limits.checkedAt}</p>
          {account.limits.unavailable && <p>{account.limits.unavailable.reason === "unsupported" ? "不支持" : "探测失败"}{account.limits.unavailable.message ? `：${account.limits.unavailable.message}` : ""}</p>}
          {account.limits.windows.length === 0 && !account.limits.unavailable && <p>没有已报告的额度窗口。</p>}
          {account.limits.windows.map((window) => <p key={window.id}>{window.label}：已用 {window.usedPercent}%{window.resetsAt ? ` · 重置 ${window.resetsAt}` : ""}</p>)}
          {account.limits.resetCredits && <p>可用重置额度：{number.format(account.limits.resetCredits.availableCount)}</p>}
        </div>)}
        {report.notices.map((notice, index) => <p key={`${index}:${notice}`}>{notice}</p>)}
      </>}
    </section>}
  </div>;
}
