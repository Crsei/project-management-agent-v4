"use client"
import { useId, useLayoutEffect, useRef, type CSSProperties } from "react"
import {
  Boxes,
  Layers3,
  TriangleAlert,
  Download,
  Plus,
  Pause,
  Play,
  ChevronDown,
  ChevronRight,
  Circle,
  RotateCw,
  XCircle,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { TimelineRow } from "@easyuse-ui/ui/components/blocks/timeline"
import { DataTable } from "@easyuse-ui/ui/components/blocks/data-table"
import { ActivityTimeline } from "@easyuse-ui/ui/components/blocks/activity-timeline"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@easyuse-ui/ui/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@easyuse-ui/ui/components/ui/dialog"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { useApCache, useApState } from "../state"
import { ApSearch, ApSelect } from "../shared"
import { apModels } from "../fixtures/models"
import { apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  advanceBatch,
  batchCounts,
  batchIntervalEnd,
  batchOutputJson,
  batchOutputs,
  batchRows,
  createBatchState,
  deliverLateBatchOutput,
  resolveBatchOperation,
  startBatchOperation,
  type BatchState,
  type BatchView,
} from "./controller"
import {
  batchWindow,
  type BatchJob,
  type BatchShard,
  type BatchStage,
  type ShardStage,
} from "./fixtures"
import styles from "./batch-jobs.module.css"

export const pageScenarios = apScenarios

export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  const selected =
    apScenarios.find((item) => item.id === scenario)?.id ?? "default"
  return <BatchJobsView key={selected} scenario={selected} active={active} />
}

export function BatchJobsView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const nameFieldId = useId()
  const { locale } = useI18n(),
    en = locale === "en",
    c = (english: string, chinese: string) => (en ? english : chinese)
  const [state, set] = useApState<BatchState>(`batch-jobs:${scenario}`, () =>
    createBatchState(scenario),
  )
  const cache = useApCache(),
    scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scroll.current) {
      const position = cache?.get(
        `batch-jobs:${scenario}:scroll:${state.view}`,
      ) as { top: number; left: number } | undefined
      scroll.current.scrollTop = position?.top ?? 0
      scroll.current.scrollLeft = position?.left ?? 0
    }
  }, [cache, scenario, state.view])
  const views: { id: BatchView; name: string; icon: typeof Boxes }[] = [
    { id: "batches", name: c("Batches", "批任务"), icon: Boxes },
    {
      id: "timeline",
      name: c("Processing timeline", "处理时间线"),
      icon: Layers3,
    },
    {
      id: "failed",
      name: c("Failed batches", "失败批任务"),
      icon: TriangleAlert,
    },
    { id: "outputs", name: c("Outputs", "输出"), icon: Download },
  ]
  const stageName = (stage: BatchStage | ShardStage) =>
    ({
      queued: c("Queued", "排队中"),
      running: c("Running", "运行中"),
      processing: c("Processing", "处理中"),
      retrying: c("Retrying", "重试中"),
      completed: c("Completed", "已完成"),
      "partial-failure": c("Completed with errors", "完成但有错误"),
      failed: c("Failed", "失败"),
      cancelling: c("Cancelling", "取消中"),
      cancelled: c("Cancelled", "已取消"),
    })[stage]
  const title = views.find((v) => v.id === state.view)!.name,
    timeline = state.view === "timeline"
  const jobs = timeline ? state.jobs : batchRows(state, locale),
    job = state.jobs.find((j) => j.id === state.selectedId)
  const outputs = job ? batchOutputs(state, job) : [],
    preview = outputs.find((o) => o.id === state.outputId) ?? outputs[0]
  const busy = Boolean(
      state.operation &&
      ["pending", "unknown"].includes(state.operation.result),
    ),
    readonly = scenario === "readonly"
  const patch = (value: Partial<BatchState>) => set((s) => ({ ...s, ...value }))
  const selectView = (view: BatchView) =>
    set((s) => ({
      ...s,
      view,
      status:
        view === "failed" ? "failed" : view === "outputs" ? "completed" : "all",
    }))
  const modelName = (modelId: string) =>
    apModels.find((model) => model.modelId === modelId)?.name ??
    c("Unavailable model", "模型不可用")
  const percent = (value: number | null) =>
    value === null ? c("Unknown total", "总量未知") : `${value}%`
  const num = (value: number) => new Intl.NumberFormat(locale).format(value)
  const time = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }).format(new Date(value))
      : "—"
  const inspect = (batch: BatchJob, shard?: BatchShard) =>
    set((s) => ({
      ...s,
      selectedId: batch.id,
      selectedShardId: shard?.id ?? null,
      outputShard: shard?.id ?? "all",
      outputId: null,
    }))
  const expand = (id: string) =>
    set((s) => ({
      ...s,
      expanded: s.expanded.includes(id)
        ? s.expanded.filter((x) => x !== id)
        : [...s.expanded, id],
    }))
  const exportOutputs = () => {
    if (!job || !outputs.length) return
    const url = URL.createObjectURL(
      new Blob([batchOutputJson(job, outputs)], {
        type: "application/x-ndjson",
      }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${job.id}-${state.outputStatus}-outputs.jsonl`
    anchor.click()
    URL.revokeObjectURL(url)
    patch({ notice: "exported" })
  }
  const operationPanel =
    state.operation &&
    (state.operation.batchId === job?.id ||
      state.operation.kind === "create") ? (
      <div
        className={styles.receipt}
        role="status"
        data-batch-operation={state.operation.result}
      >
        <strong>
          {c("Operation receipt", "操作回执")}:{" "}
          {state.operation.result === "pending"
            ? c("Pending", "等待中")
            : state.operation.result === "unknown"
              ? c("Unknown — do not resubmit", "结果未知 — 请勿重新提交")
              : state.operation.result === "rejected"
                ? c(
                    "Rejected — original data retained",
                    "已拒绝 — 保留原始数据",
                  )
                : c("Confirmed locally", "本地已确认")}
        </strong>
        <code>{state.operation.id}</code>
        <details>
          <summary>{c("Original payload", "原始请求")}</summary>
          <pre>{JSON.stringify(state.operation.payload, null, 2)}</pre>
        </details>
        {state.operation.result === "pending" && (
          <Button
            variant="outline"
            onClick={() => set((s) => resolveBatchOperation(s))}
          >
            {c("Resolve fixture receipt", "解析样例回执")}
          </Button>
        )}
        {state.operation.result === "unknown" && (
          <Button
            variant="outline"
            onClick={() => set((s) => resolveBatchOperation(s, true))}
          >
            {c("Check operation result", "查询操作结果")}
          </Button>
        )}
      </div>
    ) : null
  const dataState =
    !state.recovered && scenario === "loading"
      ? "loading"
      : !state.recovered && scenario === "refresh-error"
        ? "error"
        : jobs.length
          ? scenario === "missing-data"
            ? "partial"
            : "success"
          : "empty"
  const batchLabel = (batch: BatchJob) => (
    <>
      <span className={styles.batchIcon}>
        <Layers3 size={16} />
      </span>
      <span className={styles.identity}>
        <strong title={batch.name[locale]}>{batch.name[locale]}</strong>
        <small>
          {batch.workload[locale]} · {modelName(batch.modelId)}
        </small>
      </span>
    </>
  )
  return (
    <main
      className={styles.page}
      data-ap-page="batch-jobs"
      data-batch-view={state.view}
    >
      <aside className={styles.navigation}>
        <h1>{c("Batch jobs", "批任务")}</h1>
        <nav aria-label={c("Batch job views", "批任务视图")}>
          {views.map(({ id, name, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              className={styles.navItem}
              aria-current={state.view === id ? "page" : undefined}
              onClick={() => selectView(id)}
            >
              <Icon size={16} />
              {name}
            </Button>
          ))}
        </nav>
        <details className={styles.fixtureControls}>
          <summary>{c("Fixture controls", "样例控制")}</summary>
          <p>
            {c(
              "Fixed local data · UTC. Pause stops demo advancement, not business jobs.",
              "固定本地数据 · UTC。暂停只停止演示推进，不暂停业务任务。",
            )}
          </p>
          <Button
            variant="outline"
            disabled={
              state.paused ||
              busy ||
              readonly ||
              dataState === "loading" ||
              !active ||
              !state.jobs.some(
                (job) => job.stage === "running" || job.stage === "queued",
              )
            }
            onClick={() => set(advanceBatch)}
          >
            <ChevronRight size={14} />
            {c("Advance", "推进")}
          </Button>
          <ApSelect
            label={c("Fixture operation outcome", "样例操作结果")}
            value={state.receipt}
            disabled={busy}
            onChange={(v) => patch({ receipt: v as BatchState["receipt"] })}
            options={[
              { value: "confirmed", label: c("Confirmed", "已确认") },
              { value: "rejected", label: c("Rejected", "已拒绝") },
              { value: "unknown", label: c("Unknown", "未知") },
            ]}
          />
          <Button
            variant="outline"
            onClick={() =>
              set((s) => ({
                ...s,
                jobs: s.jobs.map((j, i) =>
                  i
                    ? j
                    : {
                        ...j,
                        shards: j.shards.map((shard, n) =>
                          n
                            ? shard
                            : {
                                ...shard,
                                total: shard.total === null ? 3000 : null,
                              },
                        ),
                      },
                ),
              }))
            }
          >
            {c("Toggle unknown denominator", "切换未知分母")}
          </Button>
        </details>
      </aside>
      <section className={styles.content} aria-label={title}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <div>
              <h2>{title}</h2>
              <p>
                {timeline
                  ? c(
                      "Batch → shard activity across the current processing window.",
                      "当前处理窗口内的批任务 → 分片活动。",
                    )
                  : c(
                      "Inspect workload state, request progress, and generated output.",
                      "查看工作负载状态、请求进度和生成的输出。",
                    )}
              </p>
            </div>
            {!timeline && (
              <Button
                className={styles.primary}
                disabled={
                  (readonly || busy) &&
                  !(busy && state.operation?.kind === "create")
                }
                onClick={() => patch({ createOpen: true })}
              >
                <Plus size={14} />
                {busy && state.operation?.kind === "create"
                  ? c("Check creation", "核对创建结果")
                  : c("Create batch", "创建批任务")}
              </Button>
            )}
          </div>
          <div className={styles.toolbar}>
            {timeline ? (
              <>
                <span>{c("Current processing window", "当前处理窗口")} </span>
                <div className={styles.timelineActions}>
                  <Button
                    variant="outline"
                    aria-pressed={state.paused}
                    onClick={() => patch({ paused: !state.paused })}
                  >
                    {state.paused ? <Play size={14} /> : <Pause size={14} />}
                    {state.paused ? c("Resume", "继续") : c("Pause", "暂停")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className={styles.search}>
                  <ApSearch
                    label={c("Search batches", "搜索批任务")}
                    placeholder={c(
                      "Search batches, workloads, or IDs…",
                      "搜索批任务、工作负载或 ID…",
                    )}
                    value={state.search}
                    onChange={(value) => patch({ search: value })}
                  />
                </div>
                <ApSelect
                  label={c("Batch status", "批任务状态")}
                  value={state.status}
                  onChange={(v) => patch({ status: v })}
                  options={[
                    { value: "all", label: c("All batches", "所有批任务") },
                    ...(
                      [
                        "queued",
                        "running",
                        "completed",
                        "partial-failure",
                        "failed",
                        "cancelling",
                        "cancelled",
                      ] as BatchStage[]
                    ).map((value) => ({ value, label: stageName(value) })),
                  ]}
                />
              </>
            )}
          </div>
        </header>
        {readonly && (
          <p className={styles.notice} role="status">
            {c(
              "Read only — job mutations are unavailable.",
              "只读 — 无法更改批任务。",
            )}
          </p>
        )}
        {scenario === "loading" && !state.recovered && (
          <Button
            className={styles.load}
            variant="outline"
            onClick={() => patch({ recovered: true })}
          >
            {c("Load fixture", "加载样例")}
          </Button>
        )}
        <div
          className={styles.scroll}
          ref={scroll}
          data-batch-scroll
          tabIndex={0}
          aria-label={c("Batch content", "批任务内容")}
          onScroll={(e) =>
            cache?.set(`batch-jobs:${scenario}:scroll:${state.view}`, {
              top: e.currentTarget.scrollTop,
              left: e.currentTarget.scrollLeft,
            })
          }
        >
          <DataRegion
            state={dataState}
            hasContent={scenario !== "loading" && jobs.length > 0}
            emptyTitle={c("No matching batches", "没有匹配的批任务")}
            emptyDescription={c(
              "Adjust filters or create a local fixture batch.",
              "调整筛选或创建本地样例批任务。",
            )}
            partialDescription={c(
              "Request total is unavailable; progress is not a percentage.",
              "请求总量不可用；进度不显示百分比。",
            )}
            updatedAt="2026-09-13 10:00 UTC"
            error={{
              category: "network",
              message: c("Refresh failed", "刷新失败"),
              reason: c(
                "Existing batch snapshot is preserved.",
                "保留现有批任务快照。",
              ),
            }}
            onRetry={() => patch({ recovered: true })}
          >
            {timeline ? (
              <div
                className={styles.timeline}
                style={
                  {
                    "--timeline-width": "670px",
                    "--sidebar-width": "370px",
                    "--day-width": "calc(100% / 6)",
                  } as CSSProperties
                }
                data-batch-timeline
              >
                <div className={styles.axis}>
                  <div className={styles.axisLabel}>
                    <span>
                      {c("Batch / processing shard", "批任务 / 处理分片")}
                    </span>
                    <span>{c("Progress", "进度")}</span>
                  </div>
                  <div className={styles.ticks}>
                    {[8, 9, 10, 11, 12, 13].map((hour, i) => (
                      <div key={hour}>
                        <small>
                          {i === 0 ? c("Sep 13", "9月13日") : "\u00a0"}
                        </small>
                        <span>{`${hour.toString().padStart(2, "0")}:00`}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.nowViewport} aria-hidden="true">
                  <div
                    className={styles.now}
                    style={{
                      left: `${Math.min(100, ((120 + state.tick * 10) / 360) * 100)}%`,
                    }}
                  />
                </div>
                {jobs.map((batch) => (
                  <div className={styles.batchGroup} key={batch.id}>
                    <TimelineRow
                      id={batch.id}
                      sidebar={
                        <>
                          <Button
                            variant="ghost"
                            className={styles.disclosure}
                            aria-label={`${c("Toggle shards", "切换分片")} ${batch.name[locale]}`}
                            aria-expanded={!state.collapsed.includes(batch.id)}
                            onClick={() =>
                              patch({
                                collapsed: state.collapsed.includes(batch.id)
                                  ? state.collapsed.filter(
                                      (id) => id !== batch.id,
                                    )
                                  : [...state.collapsed, batch.id],
                              })
                            }
                          >
                            {state.collapsed.includes(batch.id) ? (
                              <ChevronRight size={12} />
                            ) : (
                              <ChevronDown size={12} />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            className={styles.timelineBatch}
                            onClick={() => {
                              selectView("batches")
                              patch({
                                expanded: [
                                  ...new Set([...state.expanded, batch.id]),
                                ],
                              })
                            }}
                          >
                            {batchLabel(batch)}
                          </Button>
                          <span className={styles.percent}>
                            {percent(batchCounts(batch).percent)}
                          </span>
                        </>
                      }
                    >
                      <div className={styles.track} />
                    </TimelineRow>
                    {!state.collapsed.includes(batch.id) &&
                      batch.shards.map((shard) => (
                        <TimelineRow
                          key={shard.id}
                          id={shard.id}
                          sidebar={
                            <>
                              <span className={styles.treeLine} />
                              <Button
                                variant="ghost"
                                className={styles.shardLabel}
                                onClick={() => inspect(batch, shard)}
                              >
                                {c("Shard", "分片")} {shard.number}{" "}
                                <small>
                                  {shard.total === null
                                    ? "—"
                                    : num(shard.total)}{" "}
                                  {c("req", "请求")}
                                </small>
                              </Button>
                              <span className={styles.percent}>
                                {percent(
                                  shard.total
                                    ? Math.round(
                                        ((shard.done + shard.failed) /
                                          shard.total) *
                                          100,
                                      )
                                    : null,
                                )}
                              </span>
                            </>
                          }
                        >
                          <div className={styles.track}>
                            <div className={styles.intervalArea}>
                              {shard.intervals.map((interval) => {
                                const end = batchIntervalEnd(
                                  batch,
                                  shard,
                                  interval,
                                  state.tick,
                                )
                                if (end <= interval.from) return null
                                return (
                                  <Button
                                    key={interval.id}
                                    variant="ghost"
                                    className={styles.interval}
                                    data-stage={interval.stage}
                                    aria-label={`${batch.name[locale]}, ${c("shard", "分片")} ${shard.number}, ${stageName(interval.stage)}`}
                                    title={`${stageName(interval.stage)} · ${c("attempt", "尝试")} ${interval.attempt}`}
                                    onClick={() => inspect(batch, shard)}
                                    style={{
                                      left: `${(interval.from / 360) * 100}%`,
                                      width: `${((end - interval.from) / 360) * 100}%`,
                                    }}
                                  />
                                )
                              })}
                            </div>
                          </div>
                        </TimelineRow>
                      ))}
                  </div>
                ))}
                <footer className={styles.legend}>
                  {(
                    [
                      "processing",
                      "queued",
                      "retrying",
                      "failed",
                    ] as ShardStage[]
                  ).map((s) => (
                    <span key={s}>
                      <i data-stage={s} />
                      {stageName(s)}
                    </span>
                  ))}
                  <small>
                    {c(
                      "Select a batch or interval to inspect it.",
                      "选择批任务或时间段查看详情。",
                    )}
                  </small>
                </footer>
              </div>
            ) : (
              <div className={styles.collection}>
                <div className={styles.columnHeader}>
                  <span>{c("Batch workload", "批任务工作负载")}</span>
                  <span>{c("Shard health", "分片状态")}</span>
                  <span>{c("Request activity", "请求活动")}</span>
                  <span className="sr-only">{c("Expand", "展开")}</span>
                </div>
                {jobs.map((batch) => {
                  const counts = batchCounts(batch),
                    open = state.expanded.includes(batch.id)
                  return (
                    <div
                      key={batch.id}
                      className={styles.collectionItem}
                      data-batch-id={batch.id}
                    >
                      <div className={styles.collectionRow}>
                        <Button
                          variant="ghost"
                          className={styles.batchName}
                          onClick={() => expand(batch.id)}
                        >
                          {batchLabel(batch)}
                        </Button>
                        <div className={styles.shardHealth}>
                          {batch.shards.map((s) => (
                            <Button
                              key={s.id}
                              variant="outline"
                              className={styles.health}
                              title={`${c("Shard", "分片")} ${s.number}: ${stageName(s.stage)}`}
                              aria-label={`${batch.name[locale]} ${c("shard", "分片")} ${s.number}: ${stageName(s.stage)}`}
                              onClick={() => inspect(batch, s)}
                            >
                              <small>
                                {s.number.toString().padStart(2, "0")}
                              </small>
                              {s.stage === "retrying" ? (
                                <RotateCw size={12} />
                              ) : s.stage === "queued" ? (
                                <Play size={12} />
                              ) : (
                                <Circle
                                  size={12}
                                  fill="currentColor"
                                  data-stage={s.stage}
                                />
                              )}
                            </Button>
                          ))}
                        </div>
                        <div className={styles.activity}>
                          <div className={styles.activityTop}>
                            <span
                              className={styles.miniBars}
                              aria-hidden="true"
                            >
                              {Array.from({ length: 10 }, (_, n) => (
                                <i
                                  key={n}
                                  data-stage={
                                    counts.percent !== null &&
                                    n < Math.floor(counts.percent / 10)
                                      ? "processing"
                                      : "queued"
                                  }
                                />
                              ))}
                            </span>
                            <strong>{percent(counts.percent)}</strong>
                          </div>
                          <small>
                            {batch.stage === "failed"
                              ? c("Input blocked", "输入受阻")
                              : `${num(counts.done)} ${c("done", "已完成")}${counts.failed ? ` · ${num(counts.failed)} ${c("failed", "失败")}` : counts.total === null ? "" : ` / ${num(counts.total)}`}`}
                          </small>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${open ? c("Collapse", "收起") : c("Expand", "展开")} ${batch.name[locale]}`}
                          aria-expanded={open}
                          onClick={() => expand(batch.id)}
                        >
                          {open ? (
                            <ChevronDown size={12} />
                          ) : (
                            <ChevronRight size={12} />
                          )}
                        </Button>
                      </div>
                      {open && (
                        <div className={styles.expanded}>
                          <code>{batch.id}</code>
                          <span>
                            {c("Created", "创建于")} {time(batch.createdAt)}
                          </span>
                          <span>
                            {c("Started", "开始于")} {time(batch.startedAt)}
                          </span>
                          <span>{stageName(batch.stage)}</span>
                          {counts.failed > 0 && (
                            <span className={styles.failure}>
                              {counts.failed} {c("failed requests", "失败请求")}
                            </span>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => inspect(batch)}
                          >
                            {c("Inspect details", "查看详情")}
                          </Button>
                          {state.view === "outputs" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => inspect(batch)}
                            >
                              <Download size={12} />
                              {c("Filter / export outputs", "筛选 / 导出输出")}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </DataRegion>
        </div>
      </section>
      <Sheet
        open={active && Boolean(job)}
        onOpenChange={(open) => {
          if (!open) patch({ selectedId: null, selectedShardId: null })
        }}
      >
        <SheetContent size={640}>
          <SheetHeader>
            <SheetTitle>
              {job?.name[locale] ?? c("Batch details", "批任务详情")}
            </SheetTitle>
            <SheetDescription>
              {c(
                "Local fixture · batch/shard snapshot · UTC",
                "本地样例 · 批任务/分片快照 · UTC",
              )}
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            {job && (
              <div className={styles.details}>
                <div className={styles.detailSummary}>
                  <code>{job.id}</code>
                  <Badge
                    tone={
                      job.stage === "failed" || job.stage === "partial-failure"
                        ? "danger"
                        : "neutral"
                    }
                  >
                    {stageName(job.stage)}
                  </Badge>
                  <p>
                    {modelName(job.modelId)} · {job.scope.orgId} /{" "}
                    {job.scope.projectId}
                  </p>
                  <p>
                    {num(batchCounts(job).done)} {c("successful", "成功")} ·{" "}
                    {num(batchCounts(job).failed)} {c("failed", "失败")} /{" "}
                    {batchCounts(job).total === null
                      ? c("unknown total", "总量未知")
                      : num(batchCounts(job).total!)}{" "}
                    {c("requests", "请求")}
                  </p>
                  <p>
                    {batchWindow.from} → {batchWindow.to}
                  </p>
                </div>
                <div className={styles.detailActions}>
                  <Button
                    variant="destructive"
                    disabled={
                      readonly ||
                      busy ||
                      !["running", "queued"].includes(job.stage)
                    }
                    onClick={() =>
                      set((s) => startBatchOperation(s, "cancel", job.id))
                    }
                  >
                    <XCircle size={14} />
                    {c("Cancel batch", "取消批任务")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      readonly ||
                      busy ||
                      !job.shards.some(
                        (s) =>
                          (!state.selectedShardId ||
                            s.id === state.selectedShardId) &&
                          (s.failed > 0 || s.stage === "failed"),
                      )
                    }
                    onClick={() =>
                      set((s) =>
                        startBatchOperation(
                          s,
                          "retry",
                          job.id,
                          state.selectedShardId,
                        ),
                      )
                    }
                  >
                    <RotateCw size={14} />
                    {c("Retry failed shards", "重试失败分片")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={readonly || job.outputs.some((o) => o.late)}
                    onClick={() =>
                      set((s) => deliverLateBatchOutput(s, job.id))
                    }
                  >
                    {c("Deliver late output", "交付迟到输出")}
                  </Button>
                </div>
                {readonly && (
                  <p>
                    {c(
                      "Read only; cancel and retry are unavailable.",
                      "只读；无法取消或重试。",
                    )}
                  </p>
                )}
                <ApSelect
                  label={c("Fixture operation outcome", "样例操作结果")}
                  value={state.receipt}
                  disabled={busy}
                  onChange={(v) =>
                    patch({ receipt: v as BatchState["receipt"] })
                  }
                  options={[
                    { value: "confirmed", label: c("Confirmed", "已确认") },
                    { value: "rejected", label: c("Rejected", "已拒绝") },
                    { value: "unknown", label: c("Unknown", "未知") },
                  ]}
                />
                {operationPanel}
                <DataTable
                  rows={job.shards}
                  getRowId={(s) => s.id}
                  getRowLabel={(s) => `${c("Shard", "分片")} ${s.number}`}
                  caption={c("Processing shards", "处理分片")}
                  activeRowId={state.selectedShardId}
                  onActivateRow={(s) =>
                    patch({ selectedShardId: s.id, outputShard: s.id })
                  }
                  columns={[
                    {
                      id: "shard",
                      header: c("Shard", "分片"),
                      primary: true,
                      cell: (s) => `${c("Shard", "分片")} ${s.number}`,
                    },
                    {
                      id: "status",
                      header: c("Status", "状态"),
                      cell: (s) => stageName(s.stage),
                    },
                    {
                      id: "counts",
                      header: c("Done / total", "完成 / 总量"),
                      cell: (s) =>
                        `${num(s.done)} / ${s.total === null ? "—" : num(s.total)}`,
                    },
                    {
                      id: "failed",
                      header: c("Failed", "失败"),
                      cell: (s) => s.failed,
                    },
                    {
                      id: "attempt",
                      header: c("Attempt", "尝试"),
                      cell: (s) => s.attempt,
                    },
                  ]}
                />
                <h3>{c("Output samples", "输出样例")}</h3>
                <p>
                  {c(
                    "Representative results, not the full request collection. Export includes only the filtered samples below.",
                    "代表性结果，非完整请求集合。导出只包含下方筛选后的样例。",
                  )}
                </p>
                <div className={styles.outputFilters}>
                  <ApSelect
                    label={c("Output status", "输出状态")}
                    value={state.outputStatus}
                    onChange={(v) => patch({ outputStatus: v, outputId: null })}
                    options={[
                      { value: "all", label: c("All outputs", "所有输出") },
                      {
                        value: "success",
                        label: c("Successful outputs", "成功输出"),
                      },
                      {
                        value: "error",
                        label: c("Failed outputs", "失败输出"),
                      },
                    ]}
                  />
                  <ApSelect
                    label={c("Output shard", "输出分片")}
                    value={state.outputShard}
                    onChange={(v) => patch({ outputShard: v, outputId: null })}
                    options={[
                      { value: "all", label: c("All shards", "所有分片") },
                      ...job.shards.map((s) => ({
                        value: s.id,
                        label: `${c("Shard", "分片")} ${s.number}`,
                      })),
                    ]}
                  />
                  <Input
                    aria-label={c("Search outputs", "搜索输出")}
                    value={state.outputSearch}
                    onChange={(e) =>
                      patch({ outputSearch: e.target.value, outputId: null })
                    }
                  />
                  <Button
                    variant="outline"
                    disabled={!outputs.length}
                    onClick={exportOutputs}
                  >
                    <Download size={14} />
                    {c("Export outputs", "导出输出")} ({outputs.length})
                  </Button>
                </div>
                {state.notice === "exported" && (
                  <p role="status">
                    {c(
                      "Filtered fixture samples exported as JSONL.",
                      "已将筛选的样例导出为 JSONL。",
                    )}
                  </p>
                )}
                <DataTable
                  rows={outputs}
                  getRowId={(o) => o.id}
                  getRowLabel={(o) => o.requestId}
                  caption={c("Filtered output samples", "筛选输出样例")}
                  onActivateRow={(o) => patch({ outputId: o.id })}
                  activeRowId={preview?.id}
                  columns={[
                    {
                      id: "request",
                      header: c("Request", "请求"),
                      primary: true,
                      cell: (o) => o.requestId,
                    },
                    {
                      id: "status",
                      header: c("Result", "结果"),
                      cell: (o) =>
                        `${o.status === "success" ? c("Success", "成功") : c("Error", "错误")}${o.late ? ` · ${c("Late arrival", "迟到结果")}` : ""}`,
                    },
                    {
                      id: "attempt",
                      header: c("Attempt", "尝试"),
                      cell: (o) => o.attempt,
                    },
                  ]}
                  data={{
                    emptyTitle: c("No matching outputs", "没有匹配输出"),
                    emptyDescription: c(
                      "Adjust output filters. Existing results are retained.",
                      "调整输出筛选；现有结果仍保留。",
                    ),
                  }}
                />
                {preview && (
                  <CodePreview
                    identity={preview.id}
                    code={preview.text}
                    ariaLabel={c("Output preview", "输出预览")}
                    language="javascript"
                  />
                )}
                <h3>{c("Batch events", "批任务事件")}</h3>
                <ActivityTimeline
                  compact
                  revision={job.version}
                  events={job.events.map((e) => ({
                    id: e.id,
                    time: time(e.time),
                    type: "batch",
                    action: e.action[locale],
                    status: e.status,
                    target: e.shardId ?? job.id,
                  }))}
                />
              </div>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
      <Dialog
        open={active && state.createOpen}
        onOpenChange={(open) => patch({ createOpen: open })}
      >
        <DialogContent className={styles.createDialog}>
          <DialogTitle>{c("Create a batch job", "创建批任务")}</DialogTitle>
          <DialogDescription>
            {c(
              "Add a scripted local fixture workload to the processing queue.",
              "将本地脚本样例工作负载加入处理队列。",
            )}
          </DialogDescription>
          <form
            className={styles.createForm}
            onSubmit={(e) => {
              e.preventDefault()
              if (!readonly) set((s) => startBatchOperation(s, "create", "new"))
            }}
          >
            <label htmlFor={nameFieldId}>{c("Batch name", "批任务名称")}</label>
            <Input
              id={nameFieldId}
              autoFocus
              aria-invalid={!state.draftName.trim()}
              aria-describedby={
                !state.draftName.trim() ? `${nameFieldId}-error` : undefined
              }
              value={state.draftName}
              disabled={busy || readonly}
              onChange={(e) => patch({ draftName: e.target.value })}
            />
            {!state.draftName.trim() && (
              <p id={`${nameFieldId}-error`} role="alert">
                {c("A batch name is required.", "必须填写批任务名称。")}
              </p>
            )}
            {operationPanel}
            <div className={styles.detailActions}>
              <Button
                variant="outline"
                type="button"
                onClick={() => patch({ createOpen: false })}
              >
                {c("Cancel", "取消")}
              </Button>
              <Button
                className={styles.primary}
                type="submit"
                disabled={readonly || busy || !state.draftName.trim()}
              >
                {c("Create batch", "创建批任务")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}
