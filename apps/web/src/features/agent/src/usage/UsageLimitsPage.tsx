// Subscription pooling adapted from t3code UsageLimitsPooled.tsx and usageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useMemo, useState } from "react";
import type { ProviderConsumeResetCreditInput, UsageLimitsReport } from "@agent-workspace/contracts/usage";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { accountMatchesInstance, collectLimitPools, countdown, dedupeAccounts, type LimitAccount } from "@agent-workspace/contracts/usage-limits";
import { useAgentText, type AgentText } from "../i18n";
import { usageApi } from "./api";

type Props = { report: UsageLimitsReport; instanceId: string; now: number; onRefresh: () => Promise<void> };

const resetOutcomeText = (t: AgentText) => ({
  reset: t("已重置", "Reset"),
  nothingToReset: t("无需重置", "Nothing to reset"),
  noCredit: t("没有可用额度", "No credit available"),
  alreadyRedeemed: t("已兑换", "Already redeemed"),
});

export function UsageLimitsPage({ report, instanceId, now, onRefresh }: Props) {
  const t = useAgentText();
  const accounts = useMemo(() => dedupeAccounts(report.accounts).filter(account => accountMatchesInstance(account, instanceId)), [report, instanceId]);
  const [confirmation, setConfirmation] = useState<{ account: LimitAccount; input: ProviderConsumeResetCreditInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pools = useMemo(() => collectLimitPools(accounts, now), [accounts, now]);

  async function redeem() {
    if (!confirmation || busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await usageApi.reset(confirmation.input);
      setConfirmation(null);
      setMessage(`${t("重置结果：", "Reset result: ")}${resetOutcomeText(t)[result.outcome]}${result.warning ? ` · ${result.warning}` : ""}`);
      try { await onRefresh(); }
      catch (error) { setMessage(previous => `${previous}${t(" · 动作结果已确认，但额度快照刷新失败：", " · The action result was confirmed, but refreshing the limit snapshot failed: ")}${error instanceof Error ? error.message : String(error)}${t("。请刷新核对余额，不要自动再次兑换。", ". Please refresh to verify the balance and do not redeem again automatically.")}`); }
    } catch (error) {
      setConfirmation(null);
      setMessage(`${t("重置请求结果未知：", "Reset request outcome unknown: ")}${error instanceof Error ? error.message : String(error)}${t("。请刷新确认，切勿自动重试。", ". Please refresh to confirm; do not retry automatically.")}`);
    } finally { setBusy(false); }
  }

  return <section aria-label={t("订阅额度", "Subscription limits")} className="usage-limits">
    {report.notices.map((notice, index) => <p className="usage-notice" key={`${index}:${notice}`}>{notice}</p>)}
    {message && <p role="status" className="usage-notice">{message}</p>}
    {accounts.length === 0 && <p>{t("当前筛选没有额度账号。可在设置中配置实例或 Usage 来源。", "No limit accounts match the current filter. Configure instances or Usage sources in settings.")}</p>}
    {pools.map(({ driver, accounts: members, windows }) => {
      return <section className="usage-panel" key={driver}><h2>{driver} {t("账号池", "account pool")}</h2><p className="usage-muted">{t("同一账号仅计一次；池中比例是报告该窗口的账号剩余比例的平均值，并非供应商账单。", "Each account is counted once; the pool percentage is the average remaining percentage of accounts reporting that window, not a provider bill.")}</p>
        {windows.length === 0 && <p role="status" className="usage-notice">{t("尚无可用的额度窗口；未报告或查询失败不代表剩余额度为零。", "No usable quota windows were reported; missing or failed checks do not mean zero remaining quota.")}</p>}
        <div className="usage-pool-grid">{windows.map(({ id, label, rows, remaining }) => {
          return <div className="usage-pool" key={id}><h3>{label}</h3><strong>{t(`${remaining.toFixed(1)}% 剩余`, `${remaining.toFixed(1)}% remaining`)}</strong>
            <div className="usage-segments" aria-label={t(`${label}，平均剩余 ${remaining.toFixed(1)}%`, `${label}, average remaining ${remaining.toFixed(1)}%`)}>{members.map(account => {
              const row = rows.find(item => item.account.id === account.id);
              return row ? <div key={account.id} className="usage-segment" title={`${account.displayName || account.email || account.label}: ${row.effective.remaining.toFixed(1)}%`}><span style={{ width: `${row.effective.remaining}%` }} /></div> : <div key={account.id} className="usage-segment usage-segment-missing" title={`${account.displayName || account.email || account.label}${t("：未报告此窗口", ": window not reported")}`} />;
            })}</div>
            <ul className="usage-rows">{rows.map(({ account, effective }) => <li key={account.id}><span>{account.displayName || account.email || account.label}</span><span>{effective.remaining.toFixed(1)}% · {countdown(effective.resetsAt, now)}{effective.blocked ? t(" · 周额度耗尽", " · weekly limit exhausted") : ""}{effective.refill > 0 && effective.resetsAt ? t(` · 预计恢复 ${effective.refill.toFixed(1)}%`, ` · projected recovery ${effective.refill.toFixed(1)}%`) : ""}</span></li>)}</ul>
          </div>;
        })}</div>
        <h3>{t("账号详情", "Account details")}</h3><ul className="usage-account-list">{members.map(account => <li key={account.id}><div><strong>{account.displayName || account.label}</strong>{account.email && <span> · {account.email}</span>}{account.plan && <span> · {account.plan}</span>}{account.sourceLabel && <span> · {account.sourceLabel}</span>}<p className="usage-muted">{account.limits.unavailable?.reason === "probeFailed" ? t("保留数据时间", "Retained data time") : t("数据时间", "Data time")} {new Date(account.limits.checkedAt).toLocaleString()}{account.limits.lastProbeAt && account.limits.lastProbeAt !== account.limits.checkedAt ? t(` · 最近探测 ${new Date(account.limits.lastProbeAt).toLocaleString()}`, ` · last probe ${new Date(account.limits.lastProbeAt).toLocaleString()}`) : ""}</p>
          {account.limits.unavailable && <p className="usage-notice">{account.limits.unavailable.reason === "unsupported" ? t("不支持额度查询", "Limit queries are not supported") : account.limits.lastProbeAt ? t("额度查询失败", "Limit query failed") : t("尚未独立检查账号额度", "Account limits have not been checked independently")}{account.limits.unavailable.message ? t(`：${account.limits.unavailable.message}`, `: ${account.limits.unavailable.message}`) : ""}</p>}
          {account.limits.externalUsage && <a href={account.limits.externalUsage.url} target="_blank" rel="noreferrer">{account.limits.externalUsage.label} ↗</a>}
          {account.limits.resetCredits && <p>{t("重置 credits：", "Reset credits: ")}{account.limits.resetCredits.availableCount}{account.limits.resetCredits.nextExpiresAt ? t(` · 到期 ${new Date(account.limits.resetCredits.nextExpiresAt).toLocaleString()}`, ` · expires ${new Date(account.limits.resetCredits.nextExpiresAt).toLocaleString()}`) : ""}</p>}</div>
          {!account.limits.unavailable && account.resetCreditInput && (account.limits.resetCredits?.availableCount ?? 0) > 0 && <button type="button" onClick={() => setConfirmation({ account, input: account.resetCreditInput! })}>{t("使用重置 credit", "Use reset credit")}</button>}
        </li>)}</ul>
      </section>;
    })}
    <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader><DialogTitle>{t("确认使用重置 credit？", "Use a reset credit?")}</DialogTitle><DialogDescription>{t("将为 ", "This will consume one credit for ")}{confirmation?.account.displayName || confirmation?.account.email || confirmation?.account.label}{t(" 消耗一个 credit。此操作不可自动撤销。", ". This action cannot be undone automatically.")}</DialogDescription></DialogHeader>
        <DialogFooter><button type="button" autoFocus disabled={busy} onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</button><button type="button" disabled={busy} onClick={() => void redeem()}>{busy ? t("正在提交…", "Submitting…") : t("确认使用", "Confirm use")}</button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
