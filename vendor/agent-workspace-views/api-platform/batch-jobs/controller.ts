import type { ApLocale, ApOperationResult, ApScenario } from "../model.ts"
import {
  createBatchFixtures,
  createBatchJob,
  type BatchInterval,
  type BatchJob,
  type BatchOutput,
  type BatchShard,
  type BatchStage,
} from "./fixtures.ts"

/** Recorded terminal/older-attempt bands are history, not future playback. */
export function batchIntervalEnd(
  job: BatchJob,
  shard: BatchShard,
  interval: BatchInterval,
  tick: number,
) {
  const activeJob =
    job.stage === "queued" ||
    job.stage === "running" ||
    job.stage === "cancelling"
  const activeShard =
    shard.stage === "queued" ||
    shard.stage === "processing" ||
    shard.stage === "retrying"
  const retainedHistory =
    !activeJob ||
    !activeShard ||
    interval.attempt < shard.attempt ||
    (interval.stage !== "queued" && interval.stage !== "processing")
  return retainedHistory ? interval.to : Math.min(interval.to, 120 + tick * 10)
}

export type BatchView = "batches" | "timeline" | "failed" | "outputs"
export type BatchOperation = {
  id: string
  kind: "cancel" | "retry" | "create"
  batchId: string
  shardId: string | null
  result: ApOperationResult
  payload: {
    batchId: string
    shardId: string | null
    version: number
    name?: string
  }
  originalStage: BatchStage
  resolution: "confirmed" | "rejected" | "unknown"
}
export type BatchState = {
  jobs: BatchJob[]
  view: BatchView
  search: string
  status: string
  expanded: string[]
  collapsed: string[]
  selectedId: string | null
  selectedShardId: string | null
  outputStatus: string
  outputShard: string
  outputSearch: string
  outputId: string | null
  paused: boolean
  tick: number
  sequence: number
  recovered: boolean
  operation: BatchOperation | null
  receipt: "confirmed" | "rejected" | "unknown"
  draftName: string
  createOpen: boolean
  notice: string
}
export function createBatchState(scenario: ApScenario): BatchState {
  return {
    jobs: createBatchFixtures(scenario),
    view: "timeline",
    search: "",
    status: "all",
    expanded: [],
    collapsed: [],
    selectedId: null,
    selectedShardId: null,
    outputStatus: "all",
    outputShard: "all",
    outputSearch: "",
    outputId: null,
    paused: false,
    tick: 0,
    sequence: 0,
    recovered: false,
    operation: null,
    receipt: "confirmed",
    draftName: "Customer feedback review",
    createOpen: false,
    notice: "",
  }
}
export function batchCounts(job: BatchJob) {
  const total = job.shards.every((s) => s.total !== null)
    ? job.shards.reduce((n, s) => n + s.total!, 0)
    : null
  const done = job.shards.reduce((n, s) => n + s.done, 0),
    failed = job.shards.reduce((n, s) => n + s.failed, 0)
  return {
    total,
    done,
    failed,
    percent:
      total !== null && total > 0
        ? Math.min(100, Math.round(((done + failed) / total) * 100))
        : null,
  }
}
export function batchRows(state: BatchState, locale: ApLocale) {
  const query = state.search.trim().toLowerCase()
  return state.jobs.filter(
    (job) =>
      (!query ||
        `${job.id} ${job.name[locale]} ${job.workload[locale]} ${job.modelId}`
          .toLowerCase()
          .includes(query)) &&
      (state.status === "all" ||
        (state.status === "completed" &&
          ["completed", "partial-failure"].includes(job.stage)) ||
        (state.status === "failed" &&
          ["failed", "partial-failure"].includes(job.stage)) ||
        state.status === job.stage),
  )
}
export function batchOutputs(state: BatchState, job: BatchJob) {
  const search = state.outputSearch.trim().toLowerCase()
  return job.outputs.filter(
    (o) =>
      (state.outputStatus === "all" || o.status === state.outputStatus) &&
      (state.outputShard === "all" || o.shardId === state.outputShard) &&
      (!search || `${o.requestId} ${o.text}`.toLowerCase().includes(search)),
  )
}
const timeFor = (sequence: number) =>
  new Date(Date.parse("2026-09-13T10:00:00Z") + sequence * 60000).toISOString()
function event(
  job: BatchJob,
  sequence: number,
  en: string,
  zh: string,
  status = "running",
  shardId?: string,
) {
  return {
    ...job,
    version: job.version + 1,
    events: [
      ...job.events,
      {
        id: `${job.id}-event-${sequence}`,
        time: timeFor(sequence),
        action: { en, "zh-CN": zh },
        status,
        shardId,
      },
    ],
  }
}
export function advanceBatch(state: BatchState): BatchState {
  if (
    state.paused ||
    !state.jobs.some((job) => ["running", "queued"].includes(job.stage)) ||
    (state.operation && ["pending", "unknown"].includes(state.operation.result))
  )
    return state
  const sequence = state.sequence + 1
  return {
    ...state,
    sequence,
    tick: state.tick + 1,
    jobs: state.jobs.map((job) => {
      if (!["running", "queued"].includes(job.stage)) return job
      const shards = job.shards.map((s) => {
        if (s.total === null || s.stage === "failed" || s.stage === "cancelled")
          return s
        const done = Math.min(
          s.total - s.failed,
          s.done + Math.max(1, Math.floor(s.total / 10)),
        )
        return {
          ...s,
          done,
          stage:
            done + s.failed === s.total
              ? ("completed" as const)
              : ("processing" as const),
        }
      })
      const newlyCompleted = shards.filter(
        (s) =>
          s.stage === "completed" &&
          job.shards.find((previous) => previous.id === s.id)?.stage !==
            "completed",
      )
      const outputs = [
        ...job.outputs,
        ...newlyCompleted.map((s) => ({
          id: `${s.id}-attempt-${s.attempt}-result`,
          batchId: job.id,
          shardId: s.id,
          requestId: `${s.id}-completed-request`,
          attempt: s.attempt,
          status: "success" as const,
          text: JSON.stringify({
            result: "Fixture shard processing completed",
            attempt: s.attempt,
          }),
          arrivedAt: timeFor(sequence),
          late: false,
        })),
      ]
      const settled = shards.every(
        (s) =>
          s.total !== null &&
          (s.done + s.failed >= s.total || s.stage === "failed"),
      )
      return event(
        {
          ...job,
          shards,
          outputs,
          stage: settled
            ? shards.some((s) => s.failed || s.stage === "failed")
              ? "partial-failure"
              : "completed"
            : "running",
        },
        sequence,
        "Fixture processing advanced",
        "显式推进了样例处理",
        settled ? "completed" : "running",
      )
    }),
  }
}
export function startBatchOperation(
  state: BatchState,
  kind: BatchOperation["kind"],
  batchId: string,
  shardId: string | null = null,
): BatchState {
  if (
    state.operation &&
    ["pending", "unknown"].includes(state.operation.result)
  )
    return state
  const job = state.jobs.find((j) => j.id === batchId)
  if (kind !== "create" && !job) return state
  if (kind === "cancel" && !["running", "queued"].includes(job!.stage))
    return state
  if (
    kind === "retry" &&
    !job!.shards.some(
      (s) =>
        (!shardId || s.id === shardId) &&
        (s.failed > 0 || s.stage === "failed"),
    )
  )
    return state
  if (kind === "create" && !state.draftName.trim()) return state
  const sequence = state.sequence + 1
  const operation: BatchOperation = {
    id: `batch-operation-${sequence}`,
    kind,
    batchId: kind === "create" ? `batch_local_${sequence}` : batchId,
    shardId,
    result: "pending",
    payload: {
      batchId,
      shardId,
      version: job?.version ?? 0,
      ...(kind === "create" ? { name: state.draftName.trim() } : {}),
    },
    originalStage: job?.stage ?? "queued",
    resolution: state.receipt,
  }
  return {
    ...state,
    sequence,
    operation,
    jobs: state.jobs.map((j) =>
      j.id !== batchId
        ? j
        : event(
            { ...j, stage: kind === "cancel" ? "cancelling" : j.stage },
            sequence,
            kind === "cancel"
              ? "Cancellation requested; awaiting receipt"
              : "Retry requested; awaiting receipt",
            kind === "cancel" ? "已请求取消，等待回执" : "已请求重试，等待回执",
            "waiting",
            shardId ?? undefined,
          ),
    ),
  }
}
export function resolveBatchOperation(
  state: BatchState,
  querying = false,
): BatchState {
  const operation = state.operation
  if (
    !operation ||
    (querying ? operation.result !== "unknown" : operation.result !== "pending")
  )
    return state
  const resolution = querying ? "confirmed" : operation.resolution
  const sequence = state.sequence + 1
  if (resolution === "unknown")
    return {
      ...state,
      sequence,
      operation: { ...operation, result: "unknown" },
      notice: "unknown",
    }
  if (resolution === "rejected")
    return {
      ...state,
      sequence,
      operation: { ...operation, result: "rejected" },
      notice: "rejected",
      jobs: state.jobs.map((j) =>
        j.id === operation.batchId
          ? event(
              { ...j, stage: operation.originalStage },
              sequence,
              "Operation rejected; original data retained",
              "操作被拒绝，保留原始数据",
              "failed",
            )
          : j,
      ),
    }
  if (operation.kind === "create") {
    const job = createBatchJob(
      operation.batchId,
      { en: operation.payload.name!, "zh-CN": operation.payload.name! },
      { en: "Scripted workload", "zh-CN": "脚本工作负载" },
      400,
      "failed",
    )
    job.stage = "queued"
    job.startedAt = null
    job.createdAt = timeFor(sequence)
    job.events = [
      {
        id: `${job.id}-created`,
        time: job.createdAt,
        action: {
          en: "Local batch created and queued",
          "zh-CN": "本地批任务已创建并排队",
        },
        status: "queued",
      },
    ]
    job.shards = job.shards.map((s) => ({
      ...s,
      stage: "queued",
      intervals: [],
    }))
    return {
      ...state,
      sequence,
      operation: { ...operation, result: "confirmed" },
      jobs: [...state.jobs, job],
      createOpen: false,
      view: "batches",
      status: "all",
      expanded: [...state.expanded, job.id],
      notice: "confirmed",
    }
  }
  return {
    ...state,
    sequence,
    operation: { ...operation, result: "confirmed" },
    notice: "confirmed",
    jobs: state.jobs.map((j) => {
      if (j.id !== operation.batchId) return j
      if (operation.kind === "cancel")
        return event(
          {
            ...j,
            stage: "cancelled",
            shards: j.shards.map((s) =>
              ["completed", "failed"].includes(s.stage)
                ? s
                : { ...s, stage: "cancelled" },
            ),
          },
          sequence,
          "Cancellation confirmed; existing outputs retained",
          "已确认取消，保留已有输出",
          "cancelled",
        )
      return event(
        {
          ...j,
          stage: "running",
          shards: j.shards.map((s) =>
            (!operation.shardId || s.id === operation.shardId) &&
            (s.failed > 0 || s.stage === "failed")
              ? {
                  ...s,
                  failed: 0,
                  attempt: s.attempt + 1,
                  stage: "retrying",
                  intervals: [
                    ...s.intervals,
                    {
                      id: `${s.id}-retry-${sequence}`,
                      from: 120 + state.tick * 10,
                      to: 135 + state.tick * 10,
                      stage: "retrying",
                      attempt: s.attempt + 1,
                    },
                  ],
                }
              : s,
          ),
        },
        sequence,
        "Failed shard retry confirmed; new attempt queued",
        "失败分片重试已确认，新的尝试已排队",
        "queued",
        operation.shardId ?? undefined,
      )
    }),
  }
}
/** Late results are deduplicated by stable result ID; they never revive a cancelled batch. */
export function deliverLateBatchOutput(
  state: BatchState,
  batchId: string,
): BatchState {
  const job = state.jobs.find((j) => j.id === batchId)
  if (!job || job.outputs.some((o) => o.id === `${batchId}-late-output`))
    return state
  const sequence = state.sequence + 1
  const output: BatchOutput = {
    id: `${batchId}-late-output`,
    batchId,
    shardId: job.shards[0].id,
    requestId: `${batchId}-in-flight-request`,
    attempt: 1,
    status: "success",
    text: '{"result":"Completed before cancellation; delivered later"}',
    arrivedAt: timeFor(sequence),
    late: true,
  }
  return {
    ...state,
    sequence,
    jobs: state.jobs.map((j) =>
      j.id === batchId
        ? event(
            { ...j, outputs: [...j.outputs, output] },
            sequence,
            "Late output received; batch state unchanged",
            "收到迟到结果，批任务状态不变",
            "completed",
          )
        : j,
    ),
  }
}
export function batchOutputJson(
  job: BatchJob,
  outputs: readonly BatchOutput[],
) {
  return (
    outputs
      .map((o) =>
        JSON.stringify({
          source: "fixture",
          batchId: job.id,
          modelId: job.modelId,
          scope: job.scope,
          requestId: o.requestId,
          shardId: o.shardId,
          attempt: o.attempt,
          status: o.status,
          arrivedAt: o.arrivedAt,
          late: o.late,
          output: JSON.parse(o.text),
        }),
      )
      .join("\n") + (outputs.length ? "\n" : "")
  )
}
