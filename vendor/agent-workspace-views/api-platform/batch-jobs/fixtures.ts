import { apScope, type ApCopy, type ApScenario } from "../model.ts"

export type BatchStage =
  | "queued"
  | "running"
  | "completed"
  | "partial-failure"
  | "failed"
  | "cancelling"
  | "cancelled"
export type ShardStage =
  "queued" | "processing" | "retrying" | "completed" | "failed" | "cancelled"
export type BatchInterval = {
  id: string
  from: number
  to: number
  stage: ShardStage
  attempt: number
}
export type BatchShard = {
  id: string
  number: number
  total: number | null
  done: number
  failed: number
  attempt: number
  stage: ShardStage
  intervals: BatchInterval[]
}
export type BatchOutput = {
  id: string
  requestId: string
  batchId: string
  shardId: string
  attempt: number
  status: "success" | "error"
  text: string
  arrivedAt: string
  late: boolean
}
export type BatchEvent = {
  id: string
  time: string
  action: ApCopy
  shardId?: string
  status: string
}
export type BatchJob = {
  id: string
  name: ApCopy
  workload: ApCopy
  modelId: string
  scope: typeof apScope
  createdAt: string
  startedAt: string | null
  stage: BatchStage
  shards: BatchShard[]
  outputs: BatchOutput[]
  events: BatchEvent[]
  version: number
}
export const batchFixtureRevision = "batch-jobs-2026-09-13-v2"
export const batchWindow = {
  from: "2026-09-13T08:00:00Z",
  to: "2026-09-13T14:00:00Z",
  timeZone: "UTC",
} as const
const copy = (en: string, zh: string): ApCopy => ({ en, "zh-CN": zh })
/** Interval positions measured from the reference six-hour processing window. */
const segments: readonly (readonly [number, number, ShardStage])[][] = [
  [
    [2, 15, "processing"],
    [20, 13, "processing"],
    [36, 18, "processing"],
    [58, 30, "processing"],
  ],
  [
    [5, 18, "processing"],
    [26, 14, "processing"],
    [43, 12, "retrying"],
    [58, 26, "processing"],
    [88, 9, "processing"],
  ],
  [
    [1, 21, "processing"],
    [25, 8, "queued"],
    [36, 17, "processing"],
    [57, 9, "failed"],
    [69, 25, "processing"],
  ],
  [
    [4, 10, "processing"],
    [17, 18, "processing"],
    [38, 22, "processing"],
    [64, 6, "retrying"],
    [73, 24, "processing"],
  ],
]
function shards(
  batchId: string,
  total: number,
  kind: "running" | "partial" | "complete" | "failed",
): BatchShard[] {
  return [0, 1, 2, 3].map((n) => {
    const id = `${batchId}-shard-${n + 1}`
    const failed =
      kind === "partial" ? 5 : kind === "running" && n === 2 ? 12 : 0
    const done =
      kind === "complete"
        ? total
        : kind === "partial"
          ? total - failed
          : kind === "running"
            ? Math.floor(total * (0.78 - n * 0.03)) - failed
            : 0
    const stage: ShardStage =
      kind === "failed"
        ? n === 0
          ? "failed"
          : "queued"
        : kind === "running"
          ? n === 1
            ? "retrying"
            : n === 2
              ? "failed"
              : "processing"
          : failed
            ? "failed"
            : "completed"
    const intervals: BatchInterval[] =
      kind === "failed"
        ? [
            {
              id: `${id}-interval-0`,
              from: 14.4,
              to: 50.4,
              stage: "failed",
              attempt: 1,
            },
          ]
        : segments[n].map(([left, width, stage], i) => ({
            id: `${id}-interval-${i}`,
            from: (left / 100) * 360,
            to: ((left + width) / 100) * 360,
            stage: kind === "running" ? stage : "processing",
            attempt: stage === "retrying" ? 2 : 1,
          }))
    return {
      id,
      number: n + 1,
      total,
      done,
      failed,
      attempt: stage === "retrying" ? 2 : 1,
      stage,
      intervals,
    }
  })
}
export function createBatchJob(
  id: string,
  name: ApCopy,
  workload: ApCopy,
  total: number,
  kind: "running" | "partial" | "complete" | "failed",
): BatchJob {
  const shardList = shards(id, total / 4, kind)
  const outputs: BatchOutput[] =
    kind === "failed"
      ? []
      : shardList.flatMap((shard, n) => [
          {
            id: `${id}-output-${n}`,
            requestId: `${id}-req-${n + 1}`,
            batchId: id,
            shardId: shard.id,
            attempt: 1,
            status: "success" as const,
            text:
              n % 2
                ? '{"tags":["product","support"],"confidence":0.94}'
                : '{"category":"feedback","sentiment":"positive"}',
            arrivedAt: "2026-09-13T09:58:00Z",
            late: false,
          },
          ...(shard.failed
            ? [
                {
                  id: `${id}-error-${n}`,
                  requestId: `${id}-req-error-${n + 1}`,
                  batchId: id,
                  shardId: shard.id,
                  attempt: 1,
                  status: "error" as const,
                  text: '{"error":"rate_limit_exceeded","retryable":true}',
                  arrivedAt: "2026-09-13T09:59:00Z",
                  late: false,
                },
              ]
            : []),
        ])
  return {
    id,
    name,
    workload,
    modelId: "openai/gpt-6-astra",
    scope: apScope,
    createdAt: "2026-09-13T08:16:00Z",
    startedAt: "2026-09-13T08:18:00Z",
    stage:
      kind === "partial"
        ? "partial-failure"
        : kind === "complete"
          ? "completed"
          : kind,
    shards: shardList,
    outputs,
    events: [
      {
        id: `${id}-created`,
        time: "2026-09-13T08:16:00Z",
        action: copy("Batch created", "批任务已创建"),
        status: "completed",
      },
      {
        id: `${id}-started`,
        time: "2026-09-13T08:18:00Z",
        action: copy(
          kind === "failed"
            ? "Input validation failed"
            : "Shard processing started",
          kind === "failed" ? "输入校验失败" : "开始处理分片",
        ),
        status: kind === "failed" ? "failed" : "running",
      },
    ],
    version: 1,
  }
}
export function createBatchFixtures(scenario: ApScenario): BatchJob[] {
  if (scenario === "empty") return []
  const jobs = [
    createBatchJob(
      "batch_demo_8a2f",
      copy("Feedback classification", "反馈分类"),
      copy("Customer intelligence", "客户洞察"),
      12000,
      "running",
    ),
    createBatchJob(
      "batch_demo_4c9e",
      copy("September product summaries", "九月产品摘要"),
      copy("Catalog enrichment", "目录丰富"),
      2500,
      "partial",
    ),
    createBatchJob(
      "batch_demo_6d1b",
      copy("Knowledge base tags", "知识库标签"),
      copy("Catalog enrichment", "目录丰富"),
      840,
      "complete",
    ),
    createBatchJob(
      "batch_demo_7f3a",
      copy("Legacy import validation", "旧版导入校验"),
      copy("Data migration", "数据迁移"),
      400,
      "failed",
    ),
  ]
  if (scenario === "missing-data") jobs[0].shards[0].total = null
  if (scenario === "long-content") {
    jobs[0].name = copy(
      "Feedback classification — multilingual customer intelligence and extended regional taxonomy reconciliation",
      "反馈分类 — 多语言客户洞察、扩展区域分类体系与跨项目迁移核对长名称",
    )
    jobs[0].outputs[0].text = JSON.stringify({
      response: "Detailed local fixture output. ".repeat(250),
    })
    for (let i = 0; i < 12; i++)
      jobs.push(
        createBatchJob(
          `batch_long_${i}`,
          copy(`Archive enrichment ${i + 1}`, `归档丰富 ${i + 1}`),
          copy("Catalog enrichment", "目录丰富"),
          400,
          "complete",
        ),
      )
  }
  return jobs
}
