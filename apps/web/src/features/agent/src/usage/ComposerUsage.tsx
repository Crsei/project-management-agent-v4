// Usage UI adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useEffect, useState } from "react";
import type { UsageLimitsReport } from "@agent-workspace/contracts/usage";
import { usageApi } from "./api";
import { accountMatchesInstance, countdown, dedupeAccounts, effectiveWindow } from "@agent-workspace/contracts/usage-limits";
import { useAgentText } from "../i18n";

const number = new Intl.NumberFormat();

export function ComposerUsage({ providerInstanceId, limitsRequest, onCloseLimits }: { providerInstanceId: string; limitsRequest: number; onCloseLimits: () => void }) {
  const t = useAgentText();
  const [report, setReport] = useState<UsageLimitsReport | null>(null);
  const [limitsError, setLimitsError] = useState<string>();
  const [loadingLimits, setLoadingLimits] = useState(false);

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

  if (!limitsRequest) return null;
  const accounts = report ? dedupeAccounts(report.accounts).filter(account => accountMatchesInstance(account, providerInstanceId)) : [];
  const now = Date.now();
  return <div className="flex flex-col gap-2 px-2 text-xs text-muted-foreground">
    <section aria-label={t("额度快照", "Limits snapshot")} className="max-h-48 overflow-y-auto rounded border border-border p-2 text-foreground" aria-live="polite">
      <div className="flex items-center justify-between gap-2"><strong>{t("额度快照", "Limits snapshot")}</strong><button type="button" onClick={onCloseLimits} aria-label={t("关闭额度快照", "Close limits snapshot")}>{t("关闭", "Close")}</button></div>
      <p className="text-muted-foreground">{t("只读取已保存快照，不自动探测或刷新。", "Reads the saved snapshot only; nothing is probed or refreshed automatically.")}</p>
      {loadingLimits && <p>{t("读取中…", "Loading…")}</p>}
      {limitsError && <p role="alert">{t("读取额度失败：", "Failed to load limits: ")}{limitsError}</p>}
      {report && <>
        <p className="text-muted-foreground">{t("快照时间：", "Snapshot time: ")}{report.createdAt}</p>
        {accounts.length === 0 && <p>{t("当前实例没有已保存的额度账号。", "No saved limit accounts for the current instance.")}</p>}
        {accounts.map((account) => <div key={account.id} className="mt-2 border-t border-border pt-2">
          <strong>{account.displayName || account.label}</strong>{account.sourceLabel && <span> · {account.sourceLabel}</span>}{account.plan && <span> · {account.plan}</span>}
          <p className="text-muted-foreground">{t("数据时间：", "Data time: ")}{account.limits.checkedAt}{account.limits.lastProbeAt && account.limits.lastProbeAt !== account.limits.checkedAt ? t(` · 最近探测：${account.limits.lastProbeAt}`, ` · last probe: ${account.limits.lastProbeAt}`) : ""}</p>
          {account.limits.unavailable && <p>{account.limits.unavailable.reason === "unsupported" ? t("不支持", "Not supported") : account.limits.lastProbeAt ? t("探测失败", "Probe failed") : t("尚未独立检查", "Not checked independently yet")}{account.limits.unavailable.message ? t(`：${account.limits.unavailable.message}`, `: ${account.limits.unavailable.message}`) : ""}</p>}
          {account.limits.windows.length === 0 && !account.limits.unavailable && <p>{t("没有已报告的额度窗口。", "No limit windows have been reported.")}</p>}
          {account.limits.windows.map((window) => {
            const effective = effectiveWindow(account, window, now);
            return <p key={window.id}>{window.label}{t("：剩余 ", ": ")}{effective.remaining}% · {countdown(effective.resetsAt, now)}{effective.blocked ? t(" · 周额度耗尽", " · weekly limit exhausted") : ""}</p>;
          })}
          {account.limits.resetCredits && <p>{t("可用重置额度：", "Available reset credits: ")}{number.format(account.limits.resetCredits.availableCount)}</p>}
        </div>)}
        {report.notices.map((notice, index) => <p key={`${index}:${notice}`}>{notice}</p>)}
      </>}
    </section>
  </div>;
}
