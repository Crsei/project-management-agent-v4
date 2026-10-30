import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Textarea } from "@agent/components/ui/textarea";
import type {
  AutomationDispatch,
  AutomationRunTemplate,
  AutomationSchedule,
  DispatchesResponse,
  PullRequestWatch,
  PullRequestWatchInput,
  QuotaRecovery,
  RecoveryResponse,
  ScheduleInput,
  SchedulesResponse,
  WatchesResponse,
} from "@agent-workspace/contracts/automation";
import { useWorkspace } from "./provider";
import { errorMessage, getActionIdentity, releaseActionIdentity, timestamp } from "./api";
import { usePanelDraft } from "./use-panel-draft";
import { workspaceClient } from "../network";

type TargetDraft = { source: string; input: string; snapshot?: AutomationRunTemplate };
type ScheduleDraft = TargetDraft & {
  id?: string;
  name: string;
  enabled: boolean;
  timing: "interval" | "fixed_time";
  minutes: string;
  time: string;
  weekdays: number[];
  missedPolicy: "skip" | "run_once";
};
type WatchDraft = TargetDraft & {
  id?: string;
  name: string;
  enabled: boolean;
  owner: string;
  repo: string;
  number: string;
  pollIntervalSeconds: string;
};
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const watchLabels: Record<PullRequestWatch["status"], string> = {
  watching: "监测中",
  paused: "已停止",
  closed: "PR 已关闭",
  merged: "PR 已合并",
  error: "读取失败",
};
const recoveryLabels: Record<QuotaRecovery["state"], string> = {
  waiting: "等待 reset 时间",
  cancelled: "授权已取消",
  dispatched: "已创建续跑",
  blocked: "恢复已阻止",
};
const dispatchLabels: Record<AutomationDispatch["status"], string> = {
  pending: "待派发",
  dispatched: "已派发（不代表运行成功）",
  failed: "派发失败",
  cancelled: "派发已取消",
};

function DispatchDetails({ dispatch }: { dispatch?: AutomationDispatch }) {
  if (!dispatch) return <p className="live-panel-status">尚无派发记录。</p>;
  return (
    <div className="live-automation-dispatch">
      <p>
        {dispatchLabels[dispatch.status]} · {timestamp(dispatch.createdAt)}
      </p>
      <p>{dispatch.reason}</p>
      {dispatch.runId && (
        <p className="break-all">
          运行：{dispatch.runId} · 实际执行状态：{dispatch.runStatus ?? "尚未读取"}
        </p>
      )}
      {dispatch.error && (
        <p className="live-panel-error" role="alert">
          {dispatch.error}
        </p>
      )}
    </div>
  );
}

function TargetFields({
  draft,
  change,
}: {
  draft: TargetDraft;
  change: (patch: Partial<TargetDraft>) => void;
}) {
  const { state } = useWorkspace();
  return (
    <fieldset className="live-panel-section">
      <legend className="text-sm font-medium">执行模板</legend>
      <label className="live-panel-field">
        <span>Agent / 工作流</span>
        <select
          className="live-panel-select"
          value={draft.source}
          onChange={(event) => change({ source: event.target.value })}
          required
        >
          <option value="">请选择执行对象</option>
          {draft.snapshot && <option value="snapshot">保留已保存的执行快照</option>}
          {state.agents.map((agent) => (
            <option key={agent.id} value={`agent:${agent.id}`}>
              Agent · {agent.name || "未命名"}
            </option>
          ))}
          {state.workflows.map((workflow) => (
            <option key={workflow.id} value={`workflow:${workflow.id}`}>
              工作流 · {workflow.name || "未命名"}
            </option>
          ))}
          {draft.source &&
            draft.source !== "snapshot" &&
            ![
              ...state.agents.map((item) => `agent:${item.id}`),
              ...state.workflows.map((item) => `workflow:${item.id}`),
            ].includes(draft.source) && (
              <option value={draft.source}>原执行对象已删除，请重新选择</option>
            )}
        </select>
      </label>
      <label className="live-panel-field">
        <span>任务输入（最多 8,000 字符）</span>
        <Textarea
          value={draft.input}
          maxLength={8000}
          required
          onChange={(event) => change({ input: event.target.value })}
        />
      </label>
      {draft.source === "snapshot" && draft.snapshot && (
        <p className="live-panel-status">
          保存的模型：
          {draft.snapshot.steps
            .map((step) => `${step.providerInstanceId ?? "默认实例"} / ${step.model}`)
            .join(" → ")}
        </p>
      )}
      <p className="live-panel-status">
        保存时捕获模型、实例、指令和上下文；以后编辑 Agent
        不会悄悄改变此模板。自动触发可能产生模型费用；只有常驻服务在线时才会派发。
      </p>
    </fieldset>
  );
}

export function AutomationPanel({ active = true }: { active?: boolean }) {
  const { threadId, state, buildRunRequest, setPanel, refreshRuns } = useWorkspace();
  const [savedTab, setTab] = usePanelDraft<"schedules" | "recovery" | "watches">(
    threadId,
    "automation-tab",
  );
  const tab = savedTab ?? "schedules";
  const [schedules, setSchedules] = useState<AutomationSchedule[]>([]);
  const [watches, setWatches] = useState<PullRequestWatch[]>([]);
  const [recoveries, setRecoveries] = useState<QuotaRecovery[]>([]);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = usePanelDraft<ScheduleDraft>(threadId, "schedule");
  const [watchDraft, setWatchDraft] = usePanelDraft<WatchDraft>(threadId, "pr-watch");
  const [history, setHistory] = useState<{ id: string; dispatches: AutomationDispatch[] } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    async function refresh() {
      try {
        const [scheduleData, watchData, recoveryData] = await Promise.all([
          workspaceClient.json<SchedulesResponse>("/api/automation/schedules", {
            signal: controller.signal,
          }),
          workspaceClient.json<WatchesResponse>("/api/automation/watches", {
            signal: controller.signal,
          }),
          workspaceClient.json<RecoveryResponse>("/api/automation/recovery", {
            signal: controller.signal,
          }),
        ]);
        if (disposed) return;
        setSchedules(scheduleData.schedules);
        setTimeZone(scheduleData.timeZone);
        setWatches(watchData.watches);
        setRecoveries(recoveryData.recoveries);
        setLoaded(true);
        setRefreshError(null);
      } catch (error) {
        if (!disposed)
          setRefreshError(`自动化数据读取失败，已有内容和表单均保留。${errorMessage(error)}`);
      } finally {
        if (!disposed) timer = window.setTimeout(() => void refresh(), 10000);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, refreshKey]);

  async function perform(key: string, operation: () => Promise<void>) {
    if (pending) return false;
    setPending(key);
    setActionError(null);
    setNotice(null);
    try {
      await operation();
      setRefreshKey((value) => value + 1);
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
    } finally {
      setPending(null);
    }
  }
  function targetRequest(draft: TargetDraft): AutomationRunTemplate {
    if (!draft.input.trim()) throw new Error("请填写任务输入。");
    if (draft.source === "snapshot" && draft.snapshot)
      return { ...draft.snapshot, input: draft.input };
    const separator = draft.source.indexOf(":");
    const kind = draft.source.slice(0, separator);
    if (kind !== "agent" && kind !== "workflow") throw new Error("请选择有效的执行对象。");
    const request = buildRunRequest(kind, draft.source.slice(separator + 1), draft.input);
    const {
      runId: _runId,
      idempotencyKey: _key,
      continuationOf: _continuation,
      ...template
    } = request;
    return template;
  }
  async function saveSchedule(event: FormEvent) {
    event.preventDefault();
    if (!scheduleDraft) return;
    const draft = scheduleDraft;
    const success = await perform("schedule-save", async () => {
      if (
        draft.timing === "interval" &&
        (!Number.isInteger(Number(draft.minutes)) || Number(draft.minutes) < 1)
      )
        throw new Error("执行间隔必须是至少 1 分钟的整数。");
      if (draft.timing === "fixed_time" && !draft.weekdays.length)
        throw new Error("请选择至少一个执行日。");
      const input: ScheduleInput = {
        name: draft.name,
        enabled: draft.enabled,
        timing:
          draft.timing === "interval"
            ? { type: "interval", minutes: Number(draft.minutes) }
            : { type: "fixed_time", time: draft.time, weekdays: draft.weekdays },
        missedPolicy: draft.missedPolicy,
        request: targetRequest(draft),
      };
      await workspaceClient.json(
        draft.id
          ? `/api/automation/schedules/${encodeURIComponent(draft.id)}`
          : "/api/automation/schedules",
        { method: draft.id ? "PUT" : "POST", body: JSON.stringify(input) },
      );
    });
    if (success) {
      setScheduleDraft(null);
      setNotice("定时任务已保存。");
    }
  }
  async function saveWatch(event: FormEvent) {
    event.preventDefault();
    if (!watchDraft) return;
    const draft = watchDraft;
    const success = await perform("watch-save", async () => {
      if (!Number.isInteger(Number(draft.number)) || Number(draft.number) < 1)
        throw new Error("PR 编号必须为正整数。");
      if (
        !Number.isInteger(Number(draft.pollIntervalSeconds)) ||
        Number(draft.pollIntervalSeconds) < 60
      )
        throw new Error("轮询间隔必须是至少 60 秒的整数。");
      const input: PullRequestWatchInput = {
        name: draft.name,
        owner: draft.owner.trim(),
        repo: draft.repo.trim(),
        number: Number(draft.number),
        enabled: draft.enabled,
        pollIntervalSeconds: Number(draft.pollIntervalSeconds),
        request: targetRequest(draft),
      };
      await workspaceClient.json(
        draft.id
          ? `/api/automation/watches/${encodeURIComponent(draft.id)}`
          : "/api/automation/watches",
        { method: draft.id ? "PUT" : "POST", body: JSON.stringify(input) },
      );
    });
    if (success) {
      setWatchDraft(null);
      setNotice("PR 监测已保存。首次检查建立基线，不会伪造变化或立即唤醒。");
    }
  }
  async function showHistory(id: string) {
    await perform(`history:${id}`, async () => {
      const data = await workspaceClient.json<DispatchesResponse>(
        `/api/automation/dispatches?sourceId=${encodeURIComponent(id)}`,
      );
      setHistory({ id, dispatches: data.dispatches });
    });
  }
  const currentSchedules = schedules.filter((item) => item.request.threadId === threadId);
  const currentWatches = watches.filter((item) => item.request.threadId === threadId);
  const quotaRuns = state.runs.filter(
    (run) => run.errorClass === "usage_limit" || recoveries.some((item) => item.runId === run.id),
  );

  return (
    <div className="live-panel-section">
      <nav className="live-automation-tabs" aria-label="自动化类型">
        <Button
          variant={tab === "schedules" ? "secondary" : "ghost"}
          aria-pressed={tab === "schedules"}
          onClick={() => setTab("schedules")}
        >
          定时任务
        </Button>
        <Button
          variant={tab === "recovery" ? "secondary" : "ghost"}
          aria-pressed={tab === "recovery"}
          onClick={() => setTab("recovery")}
        >
          额度恢复
        </Button>
        <Button
          variant={tab === "watches" ? "secondary" : "ghost"}
          aria-pressed={tab === "watches"}
          onClick={() => setTab("watches")}
        >
          PR Watch
        </Button>
      </nav>
      {!loaded && !refreshError && (
        <p role="status" className="live-panel-status">
          正在读取服务端自动化状态…
        </p>
      )}
      {refreshError && (
        <p className="live-panel-error" role="alert">
          {refreshError}{" "}
          <Button variant="outline" size="sm" onClick={() => setRefreshKey((value) => value + 1)}>
            重新读取
          </Button>
        </p>
      )}
      {actionError && (
        <p className="live-panel-error" role="alert">
          {actionError} 输入已保留。
        </p>
      )}
      {notice && (
        <p className="live-panel-status" role="status">
          {notice}
        </p>
      )}
      {pending && (
        <p className="live-panel-status" role="status">
          正在处理服务端操作，请等待真实回执…
        </p>
      )}

      <section hidden={tab !== "schedules"} className="live-panel-section">
        <div className="live-panel-toolbar">
          <h3 className="font-medium">本会话定时任务</h3>
          <Button
            disabled={Boolean(pending)}
            onClick={() => {
              setActionError(null);
              setScheduleDraft({
                name: "",
                enabled: true,
                timing: "interval",
                minutes: "60",
                time: "09:00",
                weekdays: [1, 2, 3, 4, 5],
                missedPolicy: "skip",
                source: "",
                input: "",
              });
            }}
          >
            新建定时任务
          </Button>
        </div>
        <p className="live-panel-status">
          服务端时区：{timeZone ?? "尚未读取"}。停机不执行；错过时段按所选策略处理，不批量补跑。
        </p>
        {loaded && currentSchedules.length === 0 && (
          <p className="live-panel-empty">尚无定时任务。保存执行模板后，可暂停、恢复或手动执行。</p>
        )}
        <div className="live-panel-list">
          {currentSchedules.map((schedule) => (
            <article className="live-panel-item live-panel-section" key={schedule.id}>
              <div className="live-panel-toolbar">
                <h4 className="font-medium">{schedule.name}</h4>
                <span className="live-panel-status">{schedule.enabled ? "已启用" : "已暂停"}</span>
              </div>
              <p className="live-panel-status">
                {schedule.timing.type === "interval"
                  ? `每 ${schedule.timing.minutes} 分钟`
                  : `${schedule.timing.time} · ${schedule.timing.weekdays.map((day) => weekdays[day]).join("、")}`}{" "}
                · {schedule.timeZone} · 错过：
                {schedule.missedPolicy === "skip" ? "跳过" : "最多补跑一次"}
              </p>
              <p className="live-panel-status">下次执行：{timestamp(schedule.nextRunAt)}</p>
              <DispatchDetails dispatch={schedule.lastDispatch} />
              <div className="live-panel-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    setScheduleDraft({
                      id: schedule.id,
                      name: schedule.name,
                      enabled: schedule.enabled,
                      timing: schedule.timing.type,
                      minutes: String(
                        schedule.timing.type === "interval" ? schedule.timing.minutes : 60,
                      ),
                      time: schedule.timing.type === "fixed_time" ? schedule.timing.time : "09:00",
                      weekdays:
                        schedule.timing.type === "fixed_time"
                          ? schedule.timing.weekdays
                          : [1, 2, 3, 4, 5],
                      missedPolicy: schedule.missedPolicy,
                      source: "snapshot",
                      input: schedule.request.input,
                      snapshot: schedule.request,
                    })
                  }
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void perform(`schedule-toggle:${schedule.id}`, async () => {
                      const { name, timing, missedPolicy, request } = schedule;
                      await workspaceClient.json(
                        `/api/automation/schedules/${encodeURIComponent(schedule.id)}`,
                        {
                          method: "PUT",
                          body: JSON.stringify({
                            name,
                            timing,
                            missedPolicy,
                            request,
                            enabled: !schedule.enabled,
                          }),
                        },
                      );
                    })
                  }
                >
                  {schedule.enabled ? "暂停" : "恢复"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void perform(`schedule-run:${schedule.id}`, async () => {
                      const scope = `schedule-run:${schedule.id}`;
                      const key = getActionIdentity(scope);
                      const { dispatch } = await workspaceClient.json<{
                        dispatch: AutomationDispatch;
                      }>(`/api/automation/schedules/${encodeURIComponent(schedule.id)}/run`, {
                        method: "POST",
                        body: JSON.stringify({ idempotencyKey: key }),
                      });
                      releaseActionIdentity(scope);
                      setNotice(
                        `手动请求：${dispatchLabels[dispatch.status]}。请在运行记录核对执行结果。`,
                      );
                      await refreshRuns();
                    })
                  }
                >
                  立即执行
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(pending)}
                  onClick={() => void showHistory(schedule.id)}
                >
                  派发记录
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={Boolean(pending)}
                  onClick={() => {
                    if (window.confirm(`删除定时任务「${schedule.name}」？已有运行记录保留。`))
                      void perform(`schedule-delete:${schedule.id}`, async () => {
                        await workspaceClient.json(
                          `/api/automation/schedules/${encodeURIComponent(schedule.id)}`,
                          { method: "DELETE" },
                        );
                      });
                  }}
                >
                  删除
                </Button>
              </div>
            </article>
          ))}
        </div>
        {scheduleDraft && (
          <form
            className="live-panel-item live-panel-section"
            onSubmit={(event) => void saveSchedule(event)}
          >
            <fieldset className="live-panel-section" disabled={Boolean(pending)}>
              <h4 className="font-medium">{scheduleDraft.id ? "编辑定时任务" : "创建定时任务"}</h4>
              <label className="live-panel-field">
                <span>名称</span>
                <Input
                  required
                  maxLength={200}
                  value={scheduleDraft.name}
                  onChange={(event) =>
                    setScheduleDraft({ ...scheduleDraft, name: event.target.value })
                  }
                />
              </label>
              <label className="live-panel-field">
                <span>时间方式</span>
                <select
                  className="live-panel-select"
                  value={scheduleDraft.timing}
                  onChange={(event) =>
                    setScheduleDraft({
                      ...scheduleDraft,
                      timing: event.target.value as ScheduleDraft["timing"],
                    })
                  }
                >
                  <option value="interval">按间隔</option>
                  <option value="fixed_time">每周固定时间</option>
                </select>
              </label>
              {scheduleDraft.timing === "interval" ? (
                <label className="live-panel-field">
                  <span>间隔（分钟）</span>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={scheduleDraft.minutes}
                    onChange={(event) =>
                      setScheduleDraft({ ...scheduleDraft, minutes: event.target.value })
                    }
                  />
                </label>
              ) : (
                <>
                  <label className="live-panel-field">
                    <span>服务端时间（{timeZone ?? "尚未读取"}）</span>
                    <Input
                      type="time"
                      required
                      value={scheduleDraft.time}
                      onChange={(event) =>
                        setScheduleDraft({ ...scheduleDraft, time: event.target.value })
                      }
                    />
                  </label>
                  <fieldset>
                    <legend className="text-sm">执行日</legend>
                    <div className="live-automation-weekdays">
                      {weekdays.map((label, day) => (
                        <label key={day}>
                          <input
                            type="checkbox"
                            checked={scheduleDraft.weekdays.includes(day)}
                            onChange={(event) =>
                              setScheduleDraft({
                                ...scheduleDraft,
                                weekdays: event.target.checked
                                  ? [...scheduleDraft.weekdays, day].sort()
                                  : scheduleDraft.weekdays.filter((item) => item !== day),
                              })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}
              <label className="live-panel-field">
                <span>停机错过策略</span>
                <select
                  className="live-panel-select"
                  value={scheduleDraft.missedPolicy}
                  onChange={(event) =>
                    setScheduleDraft({
                      ...scheduleDraft,
                      missedPolicy: event.target.value as ScheduleDraft["missedPolicy"],
                    })
                  }
                >
                  <option value="skip">跳过所有错过时段</option>
                  <option value="run_once">恢复后最多补跑一次</option>
                </select>
              </label>
              <TargetFields
                draft={scheduleDraft}
                change={(patch) => setScheduleDraft({ ...scheduleDraft, ...patch })}
              />
              <label className="live-automation-checkbox">
                <input
                  type="checkbox"
                  checked={scheduleDraft.enabled}
                  onChange={(event) =>
                    setScheduleDraft({ ...scheduleDraft, enabled: event.target.checked })
                  }
                />
                允许此任务按计划自动提交真实模型运行
              </label>
              <div className="live-panel-actions">
                <Button type="submit" disabled={Boolean(pending) || !timeZone}>
                  {pending === "schedule-save" ? "保存中…" : "保存定时任务"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() => setScheduleDraft(null)}
                >
                  放弃编辑
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </section>

      <section hidden={tab !== "recovery"} className="live-panel-section">
        <h3 className="font-medium">额度恢复授权</h3>
        <p className="live-panel-status">
          默认不自动续跑。仅服务返回真实 reset 时间后才能授权；到期时保持原 Provider
          实例，并创建新的 continuation。原运行不会被改写。
        </p>
        {!quotaRuns.length && (
          <p className="live-panel-empty">
            本会话尚无额度限制运行。未知 reset 时间不会被推测为可恢复。
          </p>
        )}
        {quotaRuns.map((run) => {
          const recovery = recoveries.find((item) => item.runId === run.id);
          const resetAt = recovery?.resetAt ?? run.resetAt;
          return (
            <article key={run.id} className="live-panel-item live-panel-section">
              <h4 className="font-medium">{run.name}</h4>
              <p className="live-panel-status">运行：{run.id}</p>
              <p className="live-panel-status">
                实例：{recovery?.providerInstanceId ?? run.providerInstanceId ?? "未记录"} · reset：
                {timestamp(resetAt)}
              </p>
              {run.error && <p className="live-panel-error">{run.error}</p>}
              {recovery && (
                <p className="live-panel-status">
                  {recoveryLabels[recovery.state]} · {recovery.enabled ? "已授权" : "未授权"}
                </p>
              )}
              {recovery?.error && (
                <p className="live-panel-error" role="alert">
                  {recovery.error}
                </p>
              )}
              {recovery?.continuationRunId && (
                <p className="live-panel-status break-all">续跑：{recovery.continuationRunId}</p>
              )}
              <div className="live-panel-actions">
                <Button
                  variant={recovery?.enabled ? "destructive" : "outline"}
                  size="sm"
                  disabled={
                    Boolean(pending) ||
                    (!recovery?.enabled && (!resetAt || recovery?.state === "dispatched"))
                  }
                  onClick={() => {
                    if (
                      !recovery?.enabled &&
                      !window.confirm(
                        "授权在真实额度 reset 时间到达后自动创建续跑？这可能产生模型费用；可随时取消授权。",
                      )
                    )
                      return;
                    void perform(`recovery:${run.id}`, async () => {
                      await workspaceClient.json(
                        `/api/automation/recovery/${encodeURIComponent(run.id)}`,
                        {
                          method: "PUT",
                          body: JSON.stringify({ enabled: !recovery?.enabled }),
                        },
                      );
                    });
                  }}
                >
                  {recovery?.enabled ? "取消自动恢复授权" : "授权额度恢复后续跑"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPanel("runs")}>
                  查看运行
                </Button>
              </div>
              {!resetAt && (
                <p className="live-panel-status">
                  没有服务端 reset 时间，不允许自动恢复。可在运行记录中手动决定是否续跑。
                </p>
              )}
            </article>
          );
        })}
      </section>

      <section hidden={tab !== "watches"} className="live-panel-section">
        <div className="live-panel-toolbar">
          <h3 className="font-medium">GitHub PR 监测</h3>
          <Button
            disabled={Boolean(pending)}
            onClick={() => {
              setActionError(null);
              setWatchDraft({
                name: "",
                owner: "",
                repo: "",
                number: "",
                enabled: true,
                pollIntervalSeconds: "120",
                source: "",
                input: "",
              });
            }}
          >
            新建 PR Watch
          </Button>
        </div>
        <p className="live-panel-status">
          使用服务端 gh / GitHub 凭据。监测
          checks、review、评论和冲突；首次读取得到基线，之后真实新事件才唤醒，忙时进入同会话队列。
        </p>
        {loaded && !currentWatches.length && (
          <p className="live-panel-empty">
            尚无 PR 监测。没有可用凭据或 GitHub 读取失败时会显示错误，不会伪造成功。
          </p>
        )}
        <div className="live-panel-list">
          {currentWatches.map((watch) => (
            <article key={watch.id} className="live-panel-item live-panel-section">
              <div className="live-panel-toolbar">
                <h4 className="font-medium">{watch.name}</h4>
                <span className="live-panel-status">
                  {watchLabels[watch.status]}
                  {watch.enabled ? "" : " · 已停止"}
                </span>
              </div>
              <a
                className="break-all text-sm underline"
                href={`https://github.com/${encodeURIComponent(watch.owner)}/${encodeURIComponent(watch.repo)}/pull/${watch.number}`}
                target="_blank"
                rel="noreferrer"
              >
                {watch.owner}/{watch.repo} #{watch.number}
              </a>
              <p className="live-panel-status">
                间隔：{watch.pollIntervalSeconds} 秒 · 上次检查：{timestamp(watch.lastCheckedAt)} ·
                下次：{timestamp(watch.nextCheckAt)}
              </p>
              {watch.headSha && (
                <p className="live-panel-status break-all">Head：{watch.headSha}</p>
              )}
              {watch.error && (
                <p className="live-panel-error" role="alert">
                  {watch.error}
                </p>
              )}
              <DispatchDetails dispatch={watch.lastDispatch} />
              <div className="live-panel-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    setWatchDraft({
                      id: watch.id,
                      name: watch.name,
                      owner: watch.owner,
                      repo: watch.repo,
                      number: String(watch.number),
                      enabled: watch.enabled,
                      pollIntervalSeconds: String(watch.pollIntervalSeconds),
                      source: "snapshot",
                      input: watch.request.input,
                      snapshot: watch.request,
                    })
                  }
                >
                  编辑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void perform(`watch-check:${watch.id}`, async () => {
                      await workspaceClient.json(
                        `/api/automation/watches/${encodeURIComponent(watch.id)}/check`,
                        { method: "POST" },
                      );
                      setNotice("检查已返回服务端状态；只有新的真实事件才会派发。");
                      await refreshRuns();
                    })
                  }
                >
                  立即检查
                </Button>
                <Button
                  variant={watch.enabled ? "destructive" : "outline"}
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void perform(`watch-toggle:${watch.id}`, async () => {
                      const { name, owner, repo, number, pollIntervalSeconds, request } = watch;
                      await workspaceClient.json(
                        `/api/automation/watches/${encodeURIComponent(watch.id)}`,
                        {
                          method: "PUT",
                          body: JSON.stringify({
                            name,
                            owner,
                            repo,
                            number,
                            pollIntervalSeconds,
                            request,
                            enabled: !watch.enabled,
                          }),
                        },
                      );
                    })
                  }
                >
                  {watch.enabled ? "停止监测" : "恢复监测"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() => void showHistory(watch.id)}
                >
                  派发记录
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={Boolean(pending)}
                  onClick={() => {
                    if (window.confirm(`删除 PR 监测「${watch.name}」？已有运行记录保留。`))
                      void perform(`watch-delete:${watch.id}`, async () => {
                        await workspaceClient.json(
                          `/api/automation/watches/${encodeURIComponent(watch.id)}`,
                          {
                            method: "DELETE",
                          },
                        );
                      });
                  }}
                >
                  删除
                </Button>
              </div>
            </article>
          ))}
        </div>
        {watchDraft && (
          <form
            className="live-panel-item live-panel-section"
            onSubmit={(event) => void saveWatch(event)}
          >
            <fieldset className="live-panel-section" disabled={Boolean(pending)}>
              <h4 className="font-medium">{watchDraft.id ? "编辑 PR Watch" : "创建 PR Watch"}</h4>
              <label className="live-panel-field">
                <span>名称</span>
                <Input
                  required
                  maxLength={200}
                  value={watchDraft.name}
                  onChange={(event) => setWatchDraft({ ...watchDraft, name: event.target.value })}
                />
              </label>
              <div className="live-automation-form-grid">
                <label className="live-panel-field">
                  <span>GitHub owner</span>
                  <Input
                    required
                    value={watchDraft.owner}
                    onChange={(event) =>
                      setWatchDraft({ ...watchDraft, owner: event.target.value })
                    }
                  />
                </label>
                <label className="live-panel-field">
                  <span>Repository</span>
                  <Input
                    required
                    value={watchDraft.repo}
                    onChange={(event) => setWatchDraft({ ...watchDraft, repo: event.target.value })}
                  />
                </label>
              </div>
              <div className="live-automation-form-grid">
                <label className="live-panel-field">
                  <span>PR 编号</span>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={watchDraft.number}
                    onChange={(event) =>
                      setWatchDraft({ ...watchDraft, number: event.target.value })
                    }
                  />
                </label>
                <label className="live-panel-field">
                  <span>轮询间隔（秒，至少 60）</span>
                  <Input
                    type="number"
                    min={60}
                    step={1}
                    required
                    value={watchDraft.pollIntervalSeconds}
                    onChange={(event) =>
                      setWatchDraft({ ...watchDraft, pollIntervalSeconds: event.target.value })
                    }
                  />
                </label>
              </div>
              <TargetFields
                draft={watchDraft}
                change={(patch) => setWatchDraft({ ...watchDraft, ...patch })}
              />
              <label className="live-automation-checkbox">
                <input
                  type="checkbox"
                  checked={watchDraft.enabled}
                  onChange={(event) =>
                    setWatchDraft({ ...watchDraft, enabled: event.target.checked })
                  }
                />
                启用监测并允许新事件提交真实模型运行
              </label>
              <div className="live-panel-actions">
                <Button type="submit" disabled={Boolean(pending)}>
                  {pending === "watch-save" ? "保存中…" : "保存 PR Watch"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() => setWatchDraft(null)}
                >
                  放弃编辑
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </section>
      {history && (
        <section className="live-panel-section">
          <div className="live-panel-toolbar">
            <h3 className="font-medium">派发历史</h3>
            <Button size="sm" variant="ghost" onClick={() => setHistory(null)}>
              收起
            </Button>
          </div>
          {!history.dispatches.length && <p className="live-panel-status">没有派发记录。</p>}
          {history.dispatches.map((dispatch) => (
            <article className="live-panel-item" key={dispatch.id}>
              <DispatchDetails dispatch={dispatch} />
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
