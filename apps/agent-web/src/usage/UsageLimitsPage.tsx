// Subscription pooling adapted from t3code UsageLimitsPooled.tsx and usageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useMemo, useState } from "react";
import type { ProviderConsumeResetCreditInput, UsageLimitsReport } from "@agent-workspace/contracts/usage";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { accountMatchesInstance, countdown, dedupeAccounts, effectiveWindow, type LimitAccount } from "./page-data";
import { usageApi } from "./api";

type Props = { report: UsageLimitsReport; instanceId: string; now: number; onRefresh: () => Promise<void> };

export function UsageLimitsPage({ report, instanceId, now, onRefresh }: Props) {
  const accounts = useMemo(() => dedupeAccounts(report.accounts.filter(account => accountMatchesInstance(account, instanceId))), [report, instanceId]);
  const [confirmation, setConfirmation] = useState<{ account: LimitAccount; input: ProviderConsumeResetCreditInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const drivers = [...new Set(accounts.map(account => account.driver))];

  async function redeem() {
    if (!confirmation || busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await usageApi.reset(confirmation.input);
      setConfirmation(null);
      setMessage(`重置结果：${{ reset: "已重置", nothingToReset: "无需重置", noCredit: "没有可用额度", alreadyRedeemed: "已兑换" }[result.outcome]}${result.warning ? ` · ${result.warning}` : ""}`);
      await onRefresh();
    } catch (error) {
      setConfirmation(null);
      setMessage(`重置请求结果未知：${error instanceof Error ? error.message : String(error)}。请刷新确认，切勿自动重试。`);
    } finally { setBusy(false); }
  }

  return <section aria-label="订阅额度" className="usage-limits">
    {report.notices.map((notice, index) => <p className="usage-notice" key={`${index}:${notice}`}>{notice}</p>)}
    {message && <p role="status" className="usage-notice">{message}</p>}
    {accounts.length === 0 && <p>当前筛选没有额度账号。可在设置中配置实例或 Usage 来源。</p>}
    {drivers.map(driver => {
      const members = accounts.filter(account => account.driver === driver).sort((a, b) => {
        const reset = (account: LimitAccount) => {
          const window = account.limits.windows.find(item => item.kind === "session") ?? account.limits.windows[0];
          const value = window && effectiveWindow(account, window, now).resetsAt;
          const parsed = value ? Date.parse(value) : NaN;
          return Number.isFinite(parsed) && parsed > now ? parsed : Number.POSITIVE_INFINITY;
        };
        return reset(a) - reset(b) || (a.displayName || a.email || a.label).localeCompare(b.displayName || b.email || b.label);
      });
      const windows = new Map<string, { label: string; rows: { account: LimitAccount; window: LimitAccount["limits"]["windows"][number] }[] }>();
      for (const account of members) for (const window of account.limits.windows) {
        const pooledKey = driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
        const key = windows.get(pooledKey)?.rows.some(row => row.account.id === account.id) ? `${window.kind}:${window.id}` : pooledKey;
        const group = windows.get(key) ?? { label: window.label, rows: [] };
        group.rows.push({ account, window }); windows.set(key, group);
      }
      return <section className="usage-panel" key={driver}><h2>{driver} 账号池</h2><p className="usage-muted">同一账号仅计一次；池中比例是报告该窗口的账号剩余比例的平均值，并非供应商账单。</p>
        <div className="usage-pool-grid">{[...windows.entries()].map(([key, group]) => {
          const rows = group.rows.map(({ account, window }) => ({ account, window, effective: effectiveWindow(account, window, now) }));
          const remaining = rows.reduce((sum, row) => sum + row.effective.remaining, 0) / rows.length;
          return <div className="usage-pool" key={key}><h3>{group.label}</h3><strong>{remaining.toFixed(1)}% 剩余</strong>
            <div className="usage-segments" aria-label={`${group.label}，平均剩余 ${remaining.toFixed(1)}%`}>{members.map(account => {
              const row = rows.find(item => item.account.id === account.id);
              return row ? <div key={account.id} className="usage-segment" title={`${account.displayName || account.email || account.label}: ${row.effective.remaining.toFixed(1)}%`}><span style={{ width: `${row.effective.remaining}%` }} /></div> : <div key={account.id} className="usage-segment usage-segment-missing" title={`${account.displayName || account.email || account.label}: 未报告此窗口`} />;
            })}</div>
            <ul className="usage-rows">{rows.map(({ account, effective }) => <li key={account.id}><span>{account.displayName || account.email || account.label}</span><span>{effective.remaining.toFixed(1)}% · {countdown(effective.resetsAt, now)}{effective.blocked ? " · 周额度耗尽" : ""}{effective.refill > 0 && effective.resetsAt ? ` · 预计恢复 ${effective.refill.toFixed(1)}%` : ""}</span></li>)}</ul>
          </div>;
        })}</div>
        <h3>账号详情</h3><ul className="usage-account-list">{members.map(account => <li key={account.id}><div><strong>{account.displayName || account.label}</strong>{account.email && <span> · {account.email}</span>}{account.plan && <span> · {account.plan}</span>}{account.sourceLabel && <span> · {account.sourceLabel}</span>}<p className="usage-muted">检查于 {new Date(account.limits.checkedAt).toLocaleString()}</p>
          {account.limits.unavailable && <p className="usage-notice">{account.limits.unavailable.reason === "unsupported" ? "不支持额度查询" : "额度查询失败"}{account.limits.unavailable.message ? `：${account.limits.unavailable.message}` : ""}</p>}
          {account.limits.externalUsage && <a href={account.limits.externalUsage.url} target="_blank" rel="noreferrer">{account.limits.externalUsage.label} ↗</a>}
          {account.limits.resetCredits && <p>重置 credits：{account.limits.resetCredits.availableCount}{account.limits.resetCredits.nextExpiresAt ? ` · 到期 ${new Date(account.limits.resetCredits.nextExpiresAt).toLocaleString()}` : ""}</p>}</div>
          {!account.limits.unavailable && account.resetCreditInput && (account.limits.resetCredits?.availableCount ?? 0) > 0 && <button type="button" onClick={() => setConfirmation({ account, input: account.resetCreditInput! })}>使用重置 credit</button>}
        </li>)}</ul>
      </section>;
    })}
    <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader><DialogTitle>确认使用重置 credit？</DialogTitle><DialogDescription>将为 {confirmation?.account.displayName || confirmation?.account.email || confirmation?.account.label} 消耗一个 credit。此操作不可自动撤销。</DialogDescription></DialogHeader>
        <DialogFooter><button type="button" autoFocus disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button type="button" disabled={busy} onClick={() => void redeem()}>{busy ? "正在提交…" : "确认使用"}</button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
