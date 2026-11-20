// Banner stack adapted from t3code's composer banners. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAui } from "@assistant-ui/react";
import {
  CircleAlertIcon,
  ClockIcon,
  ListChecksIcon,
  ListTodoIcon,
  RefreshCwIcon,
  RouteIcon,
  ServerOffIcon,
  WifiOffIcon,
} from "lucide-react";
import type { AgentOutputSnapshot, NativeOutputItem } from "@agent-workspace/contracts/output";
import { AGENT_API_VERSION } from "@agent-workspace/contracts/chat";
import type { QueueSnapshot } from "./queue-coordinator";
import { accountMatchesInstance, dedupeAccounts, effectiveWindow } from "@agent-workspace/contracts/usage-limits";
import { useAgentText } from "../i18n";
import { usageApi } from "../usage/api";
import { workspaceClient } from "../network";
import { useChatActions } from "./chat-actions";
import { useGenerationOutput } from "./output-stream";
import { nativeContextSourceAnchor } from "./context-source-navigation";
import { planMarkdown } from "./plan-presenter";
import { implementPlan } from "./thread-actions";
import {
  classifyReadiness,
  compareApiVersion,
  dismissComposerBanner,
  parseRuntimeInfo,
  readDismissedBanners,
  splitBannerPeek,
  summarizeTodoProgress,
  visibleComposerBanners,
  writeDismissedBanners,
  type ComposerBannerModel,
  type RuntimeVersionState,
  type SyncReadiness,
} from "./composer-banner-model";
import "./composer-banner.css";

type BannerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** sessionStorage may be unavailable; a blocked read only means nothing is dismissed. */
function bannerStorage(): BannerStorage | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

type GenerationBannerData = { snapshot?: AgentOutputSnapshot; error?: string };
type BannerView = ComposerBannerModel & { title: string; detail?: string; hint?: string; actions?: ReactNode };

export type ComposerBannerStackProps = {
  /** Session key for dismissals: remote thread id, or the local draft id. */
  scopeKey: string;
  /** Remote thread id; queue/plan operations need it. */
  threadId?: string;
  providerInstanceId: string;
  saveError?: string;
  onRetrySave?: () => void | Promise<void>;
  onOpenLimits?: () => void;
  latestGenerationId?: string;
};

/**
 * Composer banners fed only by existing contracts: connection, provider
 * catalog/save failures, server/UI version identity, PM readiness for Worker
 * and quarantined events, queue state, saved usage limits, run progress from
 * the latest generation's to-do list, and a ready plan. Feedback still has no
 * product contract, so it stays absent.
 */
export function ComposerBannerStack(props: ComposerBannerStackProps) {
  if (!props.latestGenerationId) return <BannerStackBody {...props} />;
  return (
    <GenerationFrame
      generationId={props.latestGenerationId}
      render={(data) => <BannerStackBody {...props} generation={data} />}
    />
  );
}

function GenerationFrame({ generationId, render }: { generationId: string; render: (data: GenerationBannerData) => ReactNode }) {
  const { snapshot, error } = useGenerationOutput(generationId);
  return <>{render({ snapshot, error })}</>;
}

function BannerStackBody(props: ComposerBannerStackProps & { generation?: GenerationBannerData }) {
  const t = useAgentText();
  const online = useOnlineStatus();
  const queue = useQueueSnapshot(props.threadId);
  const usageBlocked = useBlockedUsage(props.providerInstanceId);
  const runtime = useRuntimeVersion();
  const sync = useSyncHealth();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => {
    const storage = bannerStorage();
    return storage ? readDismissedBanners(storage, props.scopeKey) : new Set<string>();
  });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const storage = bannerStorage();
    setDismissed(() => (storage ? readDismissedBanners(storage, props.scopeKey) : new Set<string>()));
    setExpanded(false);
  }, [props.scopeKey]);

  const views: BannerView[] = [];
  if (!online)
    views.push({
      id: "offline",
      kind: "offline",
      severity: "alert",
      dismissible: false,
      title: t("网络已离线", "You are offline"),
      detail: t("发送与流式更新会暂停；恢复网络后会自动重连。", "Sending and streaming pause until the network returns; reconnection is automatic."),
    });
  if (props.generation?.error)
    views.push({
      id: "stream",
      kind: "stream",
      severity: "alert",
      dismissible: false,
      signature: props.generation.error,
      title: t("输出流已断开", "Output stream disconnected"),
      detail: props.generation.error,
    });
  const runtimeResult = runtime.result;
  if (runtimeResult.state === "mismatch") {
    const mismatch = runtimeResult;
    views.push({
      id: "runtime",
      kind: "runtime",
      severity: "alert",
      dismissible: true,
      signature: mismatch.remote ? `remote:${mismatch.remote}` : "remote:missing",
      title: t("服务端与界面版本不匹配，请更新并重启 Agent 服务", "The server and UI versions do not match; update and restart the Agent service"),
      detail: mismatch.remote
        ? t(`界面 ${mismatch.local} · 服务端 ${mismatch.remote}。界面与 API 可能不兼容；未更新前不要继续重要操作。`, `UI ${mismatch.local} · server ${mismatch.remote}. The UI and API may be incompatible; avoid important operations until updated.`)
        : t(`界面 ${mismatch.local}；服务端未报告版本，可能是旧版本。请更新并重启 Agent 服务。`, `UI ${mismatch.local}; the server reported no version, so it is likely an older build. Update and restart the Agent service.`),
      actions: (
        <>
          <button type="button" onClick={() => window.location.reload()}>{t("重新加载界面", "Reload the UI")}</button>
          <button type="button" onClick={runtime.recheck}>{t("重新检查", "Check again")}</button>
        </>
      ),
    });
  }
  if (props.saveError)
    views.push({
      id: "save",
      kind: "save",
      severity: "alert",
      dismissible: true,
      signature: props.saveError,
      title: t("会话参数保存失败", "Saving session settings failed"),
      detail: props.saveError,
      actions: props.onRetrySave ? (
        <button type="button" onClick={() => void props.onRetrySave?.()}>
          {t("重试保存", "Retry save")}
        </button>
      ) : undefined,
    });
  const readiness = sync.readiness;
  if (readiness?.kind === "degraded") {
    const { workerOffline, quarantinedEvents } = readiness;
    views.push({
      id: "sync",
      kind: "sync",
      severity: "warning",
      dismissible: true,
      signature: `worker:${workerOffline ? 1 : 0}:quarantine:${quarantinedEvents}`,
      title: workerOffline && quarantinedEvents > 0
        ? t(`Worker 离线，${quarantinedEvents} 个事件待核对`, `Worker offline with ${quarantinedEvents} event${quarantinedEvents === 1 ? "" : "s"} to review`)
        : workerOffline
          ? t("Worker 离线", "Worker offline")
          : t(`${quarantinedEvents} 个事件待核对`, `${quarantinedEvents} event${quarantinedEvents === 1 ? "" : "s"} to review`),
      detail: [
        workerOffline
          ? t("服务端就绪检查在最近 20 秒内没有收到 Worker 心跳；新写入可能排队，核对前不要重发操作。", "The readiness check saw no Worker heartbeat in the last 20 seconds; new writes may queue. Do not resend operations before reviewing.")
          : undefined,
        quarantinedEvents > 0
          ? t(`有 ${quarantinedEvents} 个事件超过重试上限并被隔离；它们是待人工核对的失败事件，不是已同步。`, `${quarantinedEvents} event${quarantinedEvents === 1 ? "" : "s"} exceeded the retry limit and are quarantined; they are failures awaiting review, not synced.`)
          : undefined,
      ].filter((part): part is string => !!part).join(" "),
      actions: (
        <button type="button" onClick={sync.recheck}>{t("重新检查", "Check again")}</button>
      ),
    });
  } else if (readiness?.kind === "unreadable")
    views.push({
      id: "sync",
      kind: "sync",
      severity: "info",
      dismissible: true,
      signature: "unreadable",
      title: t("无法读取健康状态", "Health status is unavailable"),
      detail: t("没有读到服务端就绪检查的数据；这不代表同步正常或异常，也不会自动重试写入。", "No readiness data was read; this says nothing about whether sync is healthy or broken, and writes are not replayed."),
      actions: (
        <button type="button" onClick={sync.recheck}>{t("重新检查", "Check again")}</button>
      ),
    });
  const queueBanner = describeQueue(queue, t);
  if (queueBanner)
    views.push({
      id: "queue",
      kind: "queue",
      severity: queueBanner.severity,
      dismissible: true,
      signature: queueBanner.signature,
      title: queueBanner.title,
      detail: queueBanner.detail,
    });
  if (usageBlocked)
    views.push({
      id: "usage",
      kind: "usage",
      severity: "warning",
      dismissible: true,
      signature: props.providerInstanceId,
      title: t("已保存的额度快照显示额度耗尽", "Saved usage snapshot reports an exhausted limit"),
      detail: t("快照只读，不会自动探测；打开额度查看时间与重置信息。", "The snapshot is read-only and never probed automatically; open limits for times and reset details."),
      actions: props.onOpenLimits ? (
        <button type="button" onClick={props.onOpenLimits}>
          {t("查看额度", "View limits")}
        </button>
      ) : undefined,
    });

  const snapshot = props.generation?.snapshot;
  const progressGenerationId = props.latestGenerationId;
  const progress = summarizeTodoProgress(snapshot);
  if (progress && progressGenerationId)
    views.push({
      id: `progress:${progress.itemId}`,
      kind: "progress",
      severity: "info",
      dismissible: true,
      signature: progress.itemId,
      title: t(`任务进度 ${progress.completed}/${progress.total}`, `Task progress ${progress.completed}/${progress.total}`),
      actions: progress.running.length ? (
        <>
          {progress.running.map((step) => (
            <button
              key={step.id}
              type="button"
              title={t("跳到这条待办", "Jump to this to-do")}
              onClick={() => document.getElementById(nativeContextSourceAnchor(progressGenerationId, progress.itemId))?.scrollIntoView({ block: "center", behavior: "smooth" })}
            >
              {step.text}
            </button>
          ))}
        </>
      ) : undefined,
      hint: t("点击步骤跳到对应待办行；进度只来自本次运行的待办快照。", "Select a step to jump to its to-do row; progress comes only from this run's to-do snapshot."),
    });
  const plan = snapshot?.status === "completed"
    ? snapshot.items.find((item) => item.type === "proposed_plan" && item.visibility !== "redacted" && item.visibility !== "unavailable")
    : undefined;
  if (plan && props.latestGenerationId)
    views.push({
      id: `plan:${plan.id}`,
      kind: "plan",
      severity: "info",
      dismissible: true,
      signature: plan.id,
      title: plan.title?.trim() || t("计划已就绪", "Plan ready"),
      actions: (
        <PlanActions
          generationId={props.latestGenerationId}
          item={plan}
          generationStatus={snapshot?.status}
        />
      ),
      hint: t("“在新会话实施”会显式创建并发送新的 Agent 会话，不会完成 PM 任务。", "“Implement in new thread” explicitly creates and sends a new Agent session; it never completes a PM task."),
    });

  const visible = visibleComposerBanners(views, dismissed);
  if (!visible.length) return null;
  const { primary, hidden } = splitBannerPeek(visible);
  const showHidden = expanded && hidden.length > 0;
  const dismiss = (banner: BannerView) => {
    const next = dismissComposerBanner(visible, dismissed, banner);
    setDismissed(next);
    const storage = bannerStorage();
    if (storage) writeDismissedBanners(storage, props.scopeKey, next);
  };
  return (
    <section className="composer-banner-stack" aria-label={t("输入区提示", "Composer notices")} data-expanded={showHidden || undefined}>
      {primary && <BannerRow banner={primary} onDismiss={() => dismiss(primary)} />}
      {showHidden && hidden.map((banner) => <BannerRow key={banner.id} banner={banner} onDismiss={() => dismiss(banner)} />)}
      {hidden.length > 0 && (
        <button type="button" className="composer-banner-peek" aria-expanded={showHidden} onClick={() => setExpanded((value) => !value)}>
          {showHidden ? t("收起提示", "Collapse notices") : t(`还有 ${hidden.length} 条提示`, `${hidden.length} more notice${hidden.length === 1 ? "" : "s"}`)}
        </button>
      )}
    </section>
  );
}

function BannerRow({ banner, onDismiss }: { banner: BannerView; onDismiss: () => void }) {
  const t = useAgentText();
  const Icon = banner.kind === "offline" ? WifiOffIcon
    : banner.kind === "queue" ? ListTodoIcon
      : banner.kind === "progress" ? ListChecksIcon
        : banner.kind === "usage" ? ClockIcon
          : banner.kind === "plan" ? RouteIcon
            : banner.kind === "runtime" ? RefreshCwIcon
              : banner.kind === "sync" ? ServerOffIcon
                : CircleAlertIcon;
  return (
    <div className="composer-banner" role={banner.severity === "alert" ? "alert" : "status"} data-severity={banner.severity} data-kind={banner.kind}>
      <Icon aria-hidden="true" className="composer-banner-icon" />
      <div className="composer-banner-body">
        <p className="composer-banner-title">{banner.title}</p>
        {banner.detail && <p className="composer-banner-detail">{banner.detail}</p>}
      </div>
      {banner.actions && <div className="composer-banner-actions">{banner.actions}</div>}
      {banner.dismissible ? (
        <button type="button" className="composer-banner-dismiss" aria-label={t("关闭这条提示（本会话）", "Dismiss this notice (this session)")} title={t("关闭这条提示（本会话）", "Dismiss this notice (this session)")} onClick={onDismiss}>
          ×
        </button>
      ) : null}
      {banner.hint && <p className="composer-banner-hint">{banner.hint}</p>}
    </div>
  );
}

/** Plan-ready actions mirror the timeline plan card: same API, same session semantics. */
function PlanActions({ generationId, item, generationStatus }: { generationId: string; item: NativeOutputItem; generationStatus?: AgentOutputSnapshot["status"] }) {
  const t = useAgentText();
  const aui = useAui();
  const actions = useChatActions();
  const [pending, setPending] = useState<"implement">();
  const [createdThread, setCreatedThread] = useState<string>();
  const [error, setError] = useState<string>();
  const idempotency = useRef<string | undefined>(undefined);
  const ready = item.status === "completed" && !item.error && !!item.text?.trim();
  const canImplement = !!actions && generationStatus === "completed" && ready && !pending;
  const reason = !actions ? t("当前视图没有可用的会话导航。", "Session navigation is unavailable in this view.")
    : generationStatus !== "completed" ? t("只能在计划回复完整成功结束后实施。", "Implementation requires a fully completed plan turn.")
      : !ready ? t("计划没有完整、可执行的权威文本。", "The plan has no complete authoritative text available for implementation.")
        : undefined;
  const implement = async () => {
    if (!canImplement || !actions) return;
    setPending("implement");
    setError(undefined);
    try {
      let target = createdThread;
      if (!target) {
        idempotency.current ??= crypto.randomUUID();
        target = (await implementPlan(generationId, item.id, idempotency.current)).threadId;
        setCreatedThread(target);
      }
      await actions.navigateSession(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(undefined);
    }
  };
  const refine = () => {
    setError(undefined);
    try {
      const markdown = planMarkdown(item);
      if (!markdown.trim()) throw new Error(t("计划没有可回填的文本。", "The plan has no text to refine."));
      const current = aui.composer.getState().text;
      aui.composer.setText(current.trim() ? `${current}\n\n${markdown}` : markdown);
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".aui-composer-root [contenteditable='true']")?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <>
      <button type="button" onClick={() => document.getElementById(nativeContextSourceAnchor(generationId, item.id))?.scrollIntoView({ block: "center", behavior: "smooth" })}>
        {t("查看计划", "View plan")}
      </button>
      <button type="button" disabled={!!pending} onClick={refine} title={t("把计划填回输入框并聚焦，不发送。", "Fill the plan into the composer and focus it; nothing is sent.")}>
        {t("细化", "Refine")}
      </button>
      <button type="button" className="composer-banner-primary" disabled={!canImplement} title={reason ?? t("在新会话中实施计划", "Implement the plan in a new session")} onClick={() => void implement()}>
        {pending === "implement" ? t("正在打开…", "Opening…") : createdThread ? t("打开实施会话", "Open implementation session") : t("在新会话实施", "Implement in new thread")}
      </button>
      {error && <span role="alert" className="composer-banner-error">{error}</span>}
    </>
  );
}

type Translate = (zh: string, en: string) => string;

function describeQueue(queue: QueueSnapshot | undefined, t: Translate): { severity: ComposerBannerModel["severity"]; title: string; detail?: string; signature: string } | undefined {
  if (!queue) return undefined;
  const rows = queue.messages.filter((row) => row.status !== "removed");
  if (!rows.length) return undefined;
  const unknown = rows.filter((row) => row.status === "unknown" || row.status === "dispatching");
  if (unknown.length)
    return {
      severity: "warning",
      title: t("队列有未明结果", "The queue has an unknown dispatch"),
      detail: t(`${unknown.length} 条消息的派发结果未明；请在队列中只核对原操作，不要重发。`, `${unknown.length} message(s) have an unknown dispatch result; reconcile the original operation in the queue instead of resending.`),
      signature: `unknown:${unknown.map((row) => row.id).join(",")}`,
    };
  const pending = rows.filter((row) => row.status === "queued" || row.status === "blocked");
  if (!pending.length) return undefined;
  const latest = queue.latest;
  const paused = !!latest && latest.status !== "running" && latest.status !== "queued" && latest.status !== "completed";
  return {
    severity: paused ? "warning" : "info",
    title: paused ? t("队列待确认后才会继续", "The queue continues only after review") : t(`队列中有 ${pending.length} 条待发送`, `${pending.length} queued message${pending.length === 1 ? "" : "s"}`),
    detail: paused
      ? t("上一执行未正常完成；发送新消息前请核对副作用。队列不会自动重放。", "The previous execution did not complete normally; review side effects before sending. The queue never replays automatically.")
      : t("页面保持可见并已授权时，上一轮完成后自动发送下一条。", "While this page stays visible and authorized, the next message is sent after the previous turn completes."),
    signature: `pending:${pending.length}:${latest?.id ?? "none"}:${latest?.status ?? "none"}`,
  };
}

function useQueueSnapshot(threadId?: string): QueueSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>();
  useEffect(() => {
    setSnapshot(undefined);
    if (!threadId) return;
    let alive = true;
    let inFlight = false;
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      void workspaceClient.json<QueueSnapshot>(`/api/chat/threads/${encodeURIComponent(threadId)}/queue`).then(
        (value) => { if (alive) setSnapshot(value); },
        () => { /* A failed read hides the banner; the queue panel owns the error. */ },
      ).finally(() => { inFlight = false; });
    };
    load();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: unknown }>).detail;
      if (detail?.threadId === threadId) load();
    };
    const focus = () => load();
    window.addEventListener("agent-message-actions-changed", changed);
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      window.removeEventListener("agent-message-actions-changed", changed);
      window.removeEventListener("focus", focus);
    };
  }, [threadId]);
  return snapshot;
}

/** One read of the saved limits snapshot; never probed or refreshed from here. */
function useBlockedUsage(providerInstanceId: string): boolean {
  const [state, setState] = useState<{ instance: string; blocked: boolean }>();
  useEffect(() => {
    let alive = true;
    const target = providerInstanceId;
    void usageApi.limits().then(
      (report) => {
        if (!alive) return;
        const now = Date.now();
        const blocked = dedupeAccounts(report.accounts)
          .filter((account) => accountMatchesInstance(account, target))
          .some((account) => account.limits.windows.some((entry) => effectiveWindow(account, entry, now).blocked));
        setState({ instance: target, blocked });
      },
      () => { if (alive) setState({ instance: target, blocked: false }); },
    );
    return () => { alive = false; };
  }, [providerInstanceId]);
  return state?.instance === providerInstanceId && state.blocked;
}

function useOnlineStatus(): boolean {
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener("online", notify);
    window.addEventListener("offline", notify);
    return () => {
      window.removeEventListener("online", notify);
      window.removeEventListener("offline", notify);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => (typeof navigator === "undefined" ? true : navigator.onLine), () => true);
}

/* ------------------------------------------------------------------------- */

/** One identity read per page load; only the explicit recheck probes again. */
let runtimeIdentity: Promise<RuntimeVersionState> | undefined;

async function readRuntimeIdentity(): Promise<RuntimeVersionState> {
  let response: Response;
  try {
    // `fetch` keeps non-2xx responses readable; `request` would throw before the status check.
    response = await workspaceClient.fetch("/api/runtime", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    return { state: "unknown" };
  }
  // A 404 is a server build without the runtime contract, not a transient error.
  if (response.status === 404) return compareApiVersion(AGENT_API_VERSION, { status: "missing" });
  if (!response.ok) return { state: "unknown" };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { state: "unknown" };
  }
  const info = parseRuntimeInfo(payload);
  // A JSON 200 that does not carry the contract is still a different build.
  if (!info) return compareApiVersion(AGENT_API_VERSION, { status: "missing" });
  return compareApiVersion(AGENT_API_VERSION, { status: "ok", ...info });
}

function useRuntimeVersion(): { result: RuntimeVersionState | { state: "loading" }; recheck: () => void } {
  const [result, setResult] = useState<RuntimeVersionState | { state: "loading" }>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const pending = attempt === 0 ? (runtimeIdentity ??= readRuntimeIdentity()) : (runtimeIdentity = readRuntimeIdentity());
    void pending.then((value) => { if (alive) setResult(value); });
    return () => { alive = false; };
  }, [attempt]);
  const recheck = useCallback(() => setAttempt((value) => value + 1), []);
  return { result, recheck };
}

/**
 * Reads the existing PM readiness endpoint once, then every 60s while the page
 * is visible. Hidden pages stop polling; a failed read is reported as unread,
 * never as healthy or broken.
 */
function useSyncHealth(): { readiness?: SyncReadiness; recheck: () => void } {
  const [readiness, setReadiness] = useState<SyncReadiness>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let timer: number | undefined;
    const read = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const response = await fetch("/health/ready", {
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json" },
          });
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json")) throw new Error("readiness response is not JSON");
          const payload: unknown = await response.json();
          if (alive) setReadiness(classifyReadiness(payload));
        } catch {
          if (alive) setReadiness({ kind: "unreadable" });
        } finally {
          inFlight = false;
        }
      })();
    };
    const stop = () => {
      if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, 60_000);
    };
    read();
    if (document.visibilityState === "hidden") stop();
    else start();
    const visibility = () => {
      if (document.visibilityState === "hidden") stop();
      else { read(); start(); }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [attempt]);
  const recheck = useCallback(() => setAttempt((value) => value + 1), []);
  return { readiness, recheck };
}
