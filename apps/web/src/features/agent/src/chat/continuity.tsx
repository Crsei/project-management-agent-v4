import { useCallback, useEffect, useRef, useState } from "react";
import { useAui, useAuiState, type AssistantRuntime } from "@assistant-ui/react";
import { Button } from "@agent/components/ui/button";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import type { QuotaRecovery } from "@agent-workspace/contracts/automation";
import { chatStreams, getChatCancellationTarget } from "./transport";
import { preserveThreadHistoryPosition } from "./history-position";
import { reconcileChatSubmission, usePendingChatSubmission } from "./submission-recovery";
import {
  clearQuotaSnooze,
  formatQuotaCountdown,
  quotaPollDelayMs,
  quotaRecoveryFailure,
  quotaResetReached,
  quotaResetTime,
  quotaSnoozeActive,
  quotaSnoozeTarget,
  quotaWakeAction,
  readQuotaSnooze,
  writeQuotaSnooze,
  type QuotaSnooze,
  type QuotaSnoozeStorage,
} from "./continuity-quota";
import "./continuity-quota.css";

/** Session-scoped dismissal; a failed quota recovery is one session's state, not a global preference. */
const quotaSnoozeStorage: QuotaSnoozeStorage = {
  getItem: (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* A blocked write only loses the dismissal; recovery state stays visible. */
    }
  },
  removeItem: (key) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Ignore; readQuotaSnooze ignores stale values. */
    }
  },
};

export function ChatContinuity({ runtime, canContinue }: { runtime: AssistantRuntime; canContinue: boolean }) {
  const t = useAgentText();
  const aui = useAui();
  const localId = useAuiState((state) => state.threads.mainThreadId);
  const threadId = useAuiState(
    (state) =>
      state.threads.threadItems.find((thread) => thread.id === state.threads.mainThreadId)
        ?.remoteId,
  );
  const running = useAuiState((state) => state.thread.isRunning);
  const [storedLatest, setLatest] = useState<ChatGenerationView | null>(null);
  const latest = storedLatest?.threadId === threadId ? storedLatest : null;
  const submission = usePendingChatSubmission(threadId);
  const [storedRecovery, setRecovery] = useState<{ runId: string; view: QuotaRecovery } | null>(null);
  const recovery = storedRecovery && latest && storedRecovery.runId === latest.id ? storedRecovery.view : null;
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [snooze, setSnooze] = useState<QuotaSnooze | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef(new Map<string, string>());
  const reloading = useRef<Promise<void> | null>(null);
  const fetching = useRef<string | null>(null);
  const latestRef = useRef<ChatGenerationView | null>(latest);
  const recoveryRef = useRef<QuotaRecovery | null>(recovery);
  /** Failed quota generation whose reset deadline still needs one output-stream attach. */
  const quotaArmed = useRef<{ runId: string; resetAt: string } | null>(null);
  const resumed = useRef(new Set<string>());

  useEffect(() => {
    latestRef.current = latest;
  }, [latest]);
  useEffect(() => {
    recoveryRef.current = recovery;
  }, [recovery]);

  const reload = useCallback(async () => {
    if (reloading.current) return reloading.current;
    const request = (async () => {
      const target = threadId;
      const draft = runtime.thread.composer.getState();
      const restorePosition = preserveThreadHistoryPosition(localId);
      await runtime.threads.reloadMainThread();
      if (target !== aui.threads.item("main").getState().remoteId) return;
      runtime.thread.composer.setText(draft.text);
      runtime.thread.composer.setQuote(draft.quote);
      for (const attachment of draft.attachments)
        if (!runtime.thread.composer.getState().attachments.some((item) => item.id === attachment.id)) {
          if (attachment.content !== undefined)
            await runtime.thread.composer.addAttachment({ ...attachment, content: attachment.content });
          else if (attachment.file) await runtime.thread.composer.addAttachment(attachment.file);
        }
      requestAnimationFrame(restorePosition);
    })();
    reloading.current = request;
    try { await request; }
    finally { if (reloading.current === request) reloading.current = null; }
  }, [aui, localId, runtime, threadId]);

  /**
   * Read generation and recovery state. Recovery scheduling stays server-side:
   * this page only observes, then attaches to the continuation stream once.
   */
  const read = useCallback(async () => {
    if (!threadId || fetching.current === threadId) return;
    fetching.current = threadId;
    const target = threadId;
    try {
      const { generations } = await workspaceClient.json<{ generations: ChatGenerationView[] }>(
        `/api/chat/threads/${encodeURIComponent(threadId)}/generations`,
      );
      if (aui.threads.item("main").getState().remoteId !== target) return;
      const current = generations[0] ?? null;
      setLatest(current);
      if (current?.errorClass === "usage_limit") {
        const body = await workspaceClient.json<{ recoveries: QuotaRecovery[] }>(
          "/api/automation/recovery",
        );
        if (aui.threads.item("main").getState().remoteId !== target) return;
        const view = body.recoveries.find((item) => item.runId === current.id) ?? null;
        setRecovery(view ? { runId: current.id, view } : null);
        const wake = quotaWakeAction({ latest: current, recovery: view, now: Date.now() });
        if (wake === "resume" && view?.continuationRunId && !resumed.current.has(view.continuationRunId)) {
          resumed.current.add(view.continuationRunId);
          chatStreams.setStreamId(view.continuationRunId, localId);
          await reload();
          return;
        }
      } else {
        setRecovery(null);
        // The server dispatched the continuation after reset: attach once, never re-dispatch.
        const armed = quotaArmed.current;
        if (
          armed &&
          current &&
          current.id !== armed.runId &&
          quotaResetReached(armed.resetAt, Date.now()) &&
          (current.status === "queued" || current.status === "running") &&
          !resumed.current.has(current.id)
        ) {
          resumed.current.add(current.id);
          quotaArmed.current = null;
          chatStreams.setStreamId(current.id, localId);
          await reload();
          return;
        }
      }
      if (current) {
        const stamp = `${current.id}:${current.status}`;
        const old = seen.current.get(threadId);
        seen.current.set(threadId, stamp);
        // Refresh saved output that completed while this browser was detached.
        // Active streams reconnect from a clean server snapshot, never by replaying a prompt.
        if (!running && old && stamp !== old && current.status === "completed") await reload();
      }
    } catch (reason) {
      if (aui.threads.item("main").getState().remoteId === target)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (fetching.current === target) fetching.current = null;
    }
  }, [aui, localId, reload, running, threadId]);

  useEffect(() => {
    if (!latest || latest.errorClass !== "usage_limit") return;
    const resetAt = latest.resetAt;
    if (!resetAt || quotaResetTime(resetAt) === null) return;
    quotaArmed.current = { runId: latest.id, resetAt };
  }, [latest]);

  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: unknown; generationId?: unknown; reload?: unknown }>).detail;
      if (!detail || detail.threadId !== threadId || detail.reload !== true) return;
      if (typeof detail.generationId === "string") chatStreams.setStreamId(detail.generationId, localId);
      void reload().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    };
    window.addEventListener("agent-thread-action", changed);
    return () => window.removeEventListener("agent-thread-action", changed);
  }, [localId, reload, threadId]);

  useEffect(() => {
    const cancel = (event: { threadId: string }) => {
      const item = aui.threads.item({ id: event.threadId });
      const remoteId = item.getState().remoteId;
      if (!remoteId) return;
      const target = getChatCancellationTarget(event.threadId);
      void workspaceClient
        .json(`/api/chat/threads/${encodeURIComponent(remoteId)}/cancel`, {
          method: "POST",
          body: JSON.stringify(target),
        })
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        );
    };
    // Composer Stop and command-palette Stop use distinct assistant-ui events.
    const unsubscribeThread = aui.on({ scope: "*", event: "thread.cancelRun" }, cancel);
    const unsubscribeComposer = aui.on({ scope: "*", event: "composer.cancel" }, cancel);
    return () => {
      unsubscribeThread();
      unsubscribeComposer();
    };
  }, [aui]);

  useEffect(() => {
    setLatest(null);
    setRecovery(null);
    setError(undefined);
    setConfirmed(false);
    setSnooze(null);
    setNow(Date.now());
    quotaArmed.current = null;
    resumed.current.clear();
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    setSnooze(readQuotaSnooze(quotaSnoozeStorage, threadId, latest, Date.now()));
  }, [latest?.id, latest?.resetAt, threadId]);

  // Countdown ticks once per second; the reset itself is handled by the poll timer.
  useEffect(() => {
    if (!latest || latest.errorClass !== "usage_limit") return;
    if (quotaResetTime(latest.resetAt) === null) return;
    let alive = true;
    let timer: number | undefined;
    const tick = () => {
      if (!alive) return;
      if (!document.hidden) setNow(Date.now());
      timer = window.setTimeout(tick, 1000);
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [latest?.id, latest?.errorClass, latest?.resetAt]);

  // Adaptive polling: active 2s, authorized reset wait slow, one wake at the deadline.
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    let timer: number | undefined;
    const schedule = () => {
      if (!alive || document.hidden) return;
      const delay = quotaPollDelayMs({
        hidden: false,
        latest: latestRef.current,
        recovery: recoveryRef.current,
        now: Date.now(),
      });
      if (delay === null) return;
      timer = window.setTimeout(() => {
        if (!alive) return;
        // A tab hidden after scheduling must not keep polling; visibilitychange resumes.
        if (document.hidden) return;
        void read().finally(() => {
          if (alive) schedule();
        });
      }, delay);
    };
    const wake = () => {
      if (document.hidden) return;
      setNow(Date.now());
      void read().finally(() => {
        if (alive) schedule();
      });
    };
    void read().finally(() => {
      if (alive) schedule();
    });
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    };
  }, [
    read,
    threadId,
    latest?.id,
    latest?.status,
    latest?.resetAt,
    recovery?.enabled,
    recovery?.state,
    recovery?.updatedAt,
    recovery?.error,
  ]);

  // Expired or stale snooze restores the banner; state stays live underneath it.
  useEffect(() => {
    if (!threadId || !snooze || quotaSnoozeActive(snooze, latest, now)) return;
    clearQuotaSnooze(quotaSnoozeStorage, threadId);
    setSnooze(null);
    void read();
  }, [latest, now, read, snooze, threadId]);

  const act = async (action: () => Promise<void>) => {
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  const resetMs = quotaResetTime(latest?.resetAt);
  const remaining = resetMs === null ? null : resetMs - now;
  const resetDone = resetMs !== null && now >= resetMs;
  const awaitingDispatch = Boolean(recovery?.enabled) || recovery?.state === "dispatched";
  const failure = quotaRecoveryFailure(recovery);
  // A failure must stay visible even if the waiting banner was snoozed.
  useEffect(() => {
    if (!threadId || !snooze || !failure) return;
    clearQuotaSnooze(quotaSnoozeStorage, threadId);
    setSnooze(null);
  }, [failure, snooze, threadId]);
  const snoozed = snooze !== null && failure === null;
  const canSnooze = resetMs !== null && !resetDone;
  const stateLabel = recovery
    ? recovery.state === "waiting"
      ? t("等待重置", "waiting for reset")
      : recovery.state === "cancelled"
        ? t("已取消", "cancelled")
        : recovery.state === "dispatched"
          ? t("已自动续跑", "resumed automatically")
          : recovery.state === "blocked"
            ? t("已被阻止", "blocked")
            : t(`未知状态（${recovery.state}）`, `unknown state (${recovery.state})`)
    : null;
  const snoozeUntilReset = () => {
    if (!threadId || !latest) return;
    const target = quotaSnoozeTarget(latest);
    if (!target) return;
    writeQuotaSnooze(quotaSnoozeStorage, threadId, target);
    setSnooze(target);
  };
  const expandSnoozed = () => {
    if (threadId) clearQuotaSnooze(quotaSnoozeStorage, threadId);
    setSnooze(null);
  };
  const active = latest && (latest.status === "queued" || latest.status === "running");
  const resumable =
    latest &&
    ["interrupted", "failed", "cancelled"].includes(latest.status) &&
    !latest.continuationId;
  if (!active && !resumable && !error && !submission) return null;
  return (
    <section
      aria-label={t("聊天连续性", "Chat continuity")}
      className="border-border text-muted-foreground flex max-h-[45dvh] shrink-0 flex-wrap items-center gap-2 overflow-y-auto border-b px-4 py-2 text-xs"
      aria-live="polite"
    >
      {submission && <><span>{t("原消息受理结果待核对，不自动重发。", "Original message acceptance is unresolved; no automatic replay.")} <code>{submission.submissionId}</code></span><Button size="sm" variant="outline" disabled={pending} onClick={() => void act(async () => {
        if (!threadId) return;
        const result = await reconcileChatSubmission(threadId);
        if (result?.status === "accepted" && result.generationId) { chatStreams.setStreamId(result.generationId, localId); await reload(); }
        else if (result?.status === "not_accepted") setError(t("已确认原消息未受理；请检查保留的输入，再显式发送。", "Original message is confirmed not accepted. Review the retained input before explicitly sending."));
        else setError(result?.reason ?? t("仍无法确认原受理结果；继续保留原身份，不重放。", "Acceptance remains unknown. Original identity retained; no replay."));
      })}>{t("只读核对原消息", "Check original message (read-only)")}</Button></>}
      {active && (
        <>
          <span>
            {latest.status === "queued"
              ? t("回复已持久保存，等待执行", "Reply saved; waiting to run")
              : t("回复正在服务端生成", "Reply is generating on the server")}
          </span>
          {!running && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void act(reload)}>
              {t("恢复输出", "Resume output")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await workspaceClient.json(
                  `/api/chat/threads/${encodeURIComponent(threadId!)}/cancel`,
                  {
                    method: "POST",
                    body: JSON.stringify({ generationId: latest.id }),
                  },
                );
                chatStreams.clear(localId);
                await reload();
              })
            }
          >
            {t("取消生成", "Cancel generation")}
          </Button>
        </>
      )}
      {resumable && (
        <>
          <span className="text-warning">
            {latest.status === "interrupted"
              ? t("回复已中断", "Reply was interrupted")
              : latest.status === "cancelled"
                ? t("回复已取消", "Reply was cancelled")
                : t("回复失败", "Reply failed")}
          </span>
          {latest.error && <span className="basis-full break-words">{latest.error}</span>}
          <label className="flex min-h-8 items-center gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t("已核对可能发生的外部副作用，授权仅继续未完成部分", "I have reviewed possible external side effects and authorize continuing only the unfinished part")}
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !confirmed || !canContinue}
            onClick={() =>
              void act(async () => {
                const { generation } = await workspaceClient.json<{
                  generation: ChatGenerationView;
                }>(`/api/chat/generations/${encodeURIComponent(latest.id)}/continue`, {
                  method: "POST",
                  body: JSON.stringify({ confirmSideEffects: confirmed }),
                });
                setLatest(generation);
                await reload();
              })
            }
          >
            {t("继续未完成部分", "Continue unfinished part")}
          </Button>
          {latest.errorClass === "usage_limit" && (
            <div className="pm-quota-recovery" data-state={recovery?.state ?? "idle"}>
              {snoozed && snooze ? (
                <div className="pm-quota-recovery-entry" role="status">
                  <span>
                    {t("额度恢复已稍后提醒至 ", "Quota recovery snoozed until ")}
                    {new Date(snooze.resetAt).toLocaleString()}
                    {stateLabel ? ` · ${t("状态：", "status: ")}${stateLabel}` : ""}
                  </span>
                  <span className="pm-quota-recovery-countdown" aria-live="off">
                    {resetDone
                      ? t("已到重置时间", "reset time reached")
                      : t(
                          `剩余 ${formatQuotaCountdown(remaining ?? 0, t)}`,
                          `${formatQuotaCountdown(remaining ?? 0, t)} remaining`,
                        )}
                  </span>
                  <Button size="sm" variant="outline" onClick={expandSnoozed}>
                    {t("展开恢复状态", "Show recovery status")}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="pm-quota-recovery-headline">
                    {resetMs === null ? (
                      <span>
                        {t(
                          "未提供重置时间：无法定时自动恢复；稍后提醒不可用，可手动核对状态或继续未完成部分。",
                          "No reset time was provided: timed automatic recovery and snooze until reset are unavailable. Check state manually or continue the unfinished part.",
                        )}
                      </span>
                    ) : (
                      <>
                        <span>
                          {t("额度重置：", "Quota reset: ")}
                          {new Date(resetMs).toLocaleString()}
                        </span>
                        <span className="pm-quota-recovery-countdown" aria-live="off">
                          {resetDone
                            ? awaitingDispatch
                              ? t("已到重置时间，正在核对恢复状态", "Reset time reached; checking recovery state")
                              : t("已到重置时间", "Reset time reached")
                            : t(
                                `剩余 ${formatQuotaCountdown(remaining ?? 0, t)}`,
                                `${formatQuotaCountdown(remaining ?? 0, t)} remaining`,
                              )}
                        </span>
                      </>
                    )}
                  </div>
                  {failure ? (
                    <>
                      <span role="alert" className="pm-quota-recovery-error">
                        {failure.state === "failed"
                          ? t("额度恢复派发失败：", "Quota recovery dispatch failed: ")
                          : failure.state === "skipped"
                            ? t("额度恢复被跳过：", "Quota recovery was skipped: ")
                            : t("额度恢复已被阻止：", "Quota recovery was blocked: ")}
                        {failure.error ?? t("服务端未提供失败原因。", "The server did not report a failure reason.")}
                      </span>
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => void act(read)}>
                        {pending ? t("核对中…", "Checking…") : t("重新核对恢复状态", "Re-check recovery status")}
                      </Button>
                      <span className="pm-quota-recovery-note">
                        {t(
                          "不会自动重试派发；如已核对副作用，可使用上方“继续未完成部分”。",
                          "No automatic retry is dispatched. If side effects are reviewed, use “Continue unfinished part” above.",
                        )}
                      </span>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || (!recovery?.enabled && (!canContinue || !latest.resetAt || !confirmed))}
                        onClick={() =>
                          void act(async () => {
                            const body = await workspaceClient.json<{ recovery: QuotaRecovery }>(
                              `/api/automation/recovery/${encodeURIComponent(latest.id)}`,
                              {
                                method: "PUT",
                                body: JSON.stringify({ enabled: !recovery?.enabled }),
                              },
                            );
                            setRecovery({ runId: latest.id, view: body.recovery });
                          })
                        }
                      >
                        {recovery?.enabled ? t("取消额度恢复", "Cancel quota recovery") : t("授权额度恢复", "Authorize quota recovery")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || !canSnooze}
                        title={
                          canSnooze
                            ? undefined
                            : resetMs === null
                              ? t("未提供重置时间，稍后提醒不可用", "No reset time provided; snooze is unavailable")
                              : t("已到重置时间，稍后提醒不可用", "Reset time reached; snooze is unavailable")
                        }
                        onClick={snoozeUntilReset}
                      >
                        {t("稍后提醒（至额度重置）", "Snooze until reset")}
                      </Button>
                      {recovery && stateLabel && (
                        <span className="pm-quota-recovery-state">
                          {t("额度恢复：", "Quota recovery: ")}
                          {stateLabel}
                        </span>
                      )}
                      {!canSnooze && (
                        <span className="pm-quota-recovery-note">
                          {resetMs === null
                            ? t("未提供重置时间，稍后提醒已禁用。", "No reset time provided; snooze is disabled.")
                            : t("已到重置时间，稍后提醒已禁用。", "Reset time reached; snooze is disabled.")}
                        </span>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <span role="alert" className="text-destructive basis-full break-words">
          {error}
        </span>
      )}
    </section>
  );
}
