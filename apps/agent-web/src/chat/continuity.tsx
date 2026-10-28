import { useCallback, useEffect, useRef, useState } from "react";
import { useAui, useAuiState, type AssistantRuntime } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { workspaceClient } from "../network";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { chatStreams, getChatCancellationTarget } from "./transport";

type RecoveryView = {
  runId: string;
  enabled: boolean;
  state: string;
  error?: string;
  continuationRunId?: string;
};
export function ChatContinuity({ runtime, canContinue }: { runtime: AssistantRuntime; canContinue: boolean }) {
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
  const [recovery, setRecovery] = useState<RecoveryView | null>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const seen = useRef(new Map<string, string>());
  const reload = useCallback(async () => {
    const target = threadId;
    const draft = runtime.thread.composer.getState();
    const viewport = document.querySelector<HTMLElement>(
      ".aui-thread-root [data-slot='aui_thread-viewport']",
    );
    const scrollTop = viewport?.scrollTop;
    await runtime.threads.reloadMainThread();
    if (target !== aui.threads.item("main").getState().remoteId) return;
    runtime.thread.composer.setText(draft.text);
    runtime.thread.composer.setQuote(draft.quote);
    for (const attachment of draft.attachments)
      if (
        !runtime.thread.composer.getState().attachments.some((item) => item.id === attachment.id)
      ) {
        if (attachment.content !== undefined)
          await runtime.thread.composer.addAttachment({
            ...attachment,
            content: attachment.content,
          });
        else if (attachment.file) await runtime.thread.composer.addAttachment(attachment.file);
      }
    if (scrollTop !== undefined)
      requestAnimationFrame(() => {
        const current = document.querySelector<HTMLElement>(
          ".aui-thread-root [data-slot='aui_thread-viewport']",
        );
        if (current) current.scrollTop = scrollTop;
      });
  }, [aui, runtime, threadId]);

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
  }, [threadId]);
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    let fetching = false;
    const read = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const { generations } = await workspaceClient.json<{ generations: ChatGenerationView[] }>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/generations`,
        );
        if (!alive) return;
        const current = generations[0] ?? null;
        setLatest(current);
        if (current) {
          const stamp = `${current.id}:${current.status}`;
          const old = seen.current.get(threadId);
          seen.current.set(threadId, stamp);
          // Refresh saved output that completed while this browser was detached.
          // Active streams reconnect from a clean server snapshot, never by replaying a prompt.
          if (!running && old && stamp !== old && current.status === "completed") await reload();
          if (current.errorClass === "usage_limit") {
            const body = await workspaceClient.json<{ recoveries: RecoveryView[] }>(
              "/api/automation/recovery",
            );
            if (alive)
              setRecovery(body.recoveries.find((item) => item.runId === current.id) ?? null);
          }
        }
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        fetching = false;
      }
    };
    void read();
    const interval = window.setInterval(() => {
      void read();
    }, 2000);
    const online = () => {
      void read();
    };
    window.addEventListener("online", online);
    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener("online", online);
    };
  }, [threadId, running, reload]);

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
  const active = latest && (latest.status === "queued" || latest.status === "running");
  const resumable =
    latest &&
    ["interrupted", "failed", "cancelled"].includes(latest.status) &&
    !latest.continuationId;
  if (!latest && !error) return null;
  return (
    <section
      aria-label="聊天连续性"
      className="border-border text-muted-foreground flex max-h-[45dvh] shrink-0 flex-wrap items-center gap-2 overflow-y-auto border-b px-4 py-2 text-xs"
      aria-live="polite"
    >
      {active && (
        <>
          <span>
            {latest.status === "queued"
              ? "回复已持久保存，等待执行"
              : "回复正在服务端生成；关闭页面不会取消"}
          </span>
          {!running && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void act(reload)}>
              恢复输出
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
            取消生成
          </Button>
        </>
      )}
      {resumable && (
        <>
          <span className="text-warning">
            {latest.status === "interrupted"
              ? "回复已中断"
              : latest.status === "cancelled"
                ? "回复已取消"
                : "回复失败"}
            ；部分输出已保留，不会自动重发原始任务。
          </span>
          {latest.error && <span className="basis-full break-words">{latest.error}</span>}
          <label className="flex min-h-8 items-center gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            已核对可能发生的外部副作用，授权仅继续未完成部分
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
            继续未完成部分
          </Button>
          {latest.errorClass === "usage_limit" && (
            <>
              <span>
                {latest.resetAt
                  ? `额度重置：${new Date(latest.resetAt).toLocaleString()}`
                  : "未提供重置时间，不能自动恢复"}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || (!recovery?.enabled && (!canContinue || !latest.resetAt || !confirmed))}
                onClick={() =>
                  void act(async () => {
                    const body = await workspaceClient.json<{ recovery: RecoveryView }>(
                      `/api/automation/recovery/${encodeURIComponent(latest.id)}`,
                      {
                        method: "PUT",
                        body: JSON.stringify({ enabled: !recovery?.enabled }),
                      },
                    );
                    setRecovery(body.recovery);
                  })
                }
              >
                {recovery?.enabled ? "取消额度恢复" : "授权额度恢复"}
              </Button>
              {recovery && (
                <span>
                  额度恢复：{recovery.state}
                  {recovery.error ? ` · ${recovery.error}` : ""}
                </span>
              )}
            </>
          )}
        </>
      )}
      {!active && !resumable && latest?.handoff && (
        <span title={latest.handoff.reason}>
          {latest.handoff.mode === "portable" ? "已使用保存上下文移交" : "已使用原生会话连续性"}
        </span>
      )}
      {error && (
        <span role="alert" className="text-destructive basis-full break-words">
          {error}
        </span>
      )}
    </section>
  );
}
