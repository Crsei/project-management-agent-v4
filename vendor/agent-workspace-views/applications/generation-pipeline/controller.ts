import { applyCanvasCommand } from "@easyuse-ui/ui/lib/canvas-commands"
import {
  parseCanvasDocument,
  validateCanvasDocument,
} from "@easyuse-ui/ui/lib/canvas-validation"
import type {
  CanvasCommand,
  CanvasDocument,
  CanvasSelection,
} from "@easyuse-ui/ui/lib/canvas-model"
import type { Copy } from "../../model"
import { createPipeline, definitionsByLocale } from "./fixtures.ts"

const definitions = definitionsByLocale.en

export type DemoRun = {
  id: number
  revision: number
  order: string[]
  index: number
  status: "running" | "paused" | "completed" | "failed" | "cancelled"
  outcome: "known" | "unknown"
  finished: string[]
}
export type PipelineState = {
  document: CanvasDocument
  past: CanvasDocument[]
  future: CanvasDocument[]
  saved: CanvasDocument | null
  selection: CanvasSelection
  inspectorId: string | null
  readState: "ready" | "loading" | "error"
  run: DemoRun | null
  runSequence: number
  feedback: Copy | null
}
export function createPipelineState(scenario: string): PipelineState {
  const document = createPipeline(scenario)
  const run: DemoRun | null = ["running", "failed", "unknown"].includes(
    scenario,
  )
    ? {
        id: 1,
        revision: document.revision,
        order: document.nodes.map((node) => node.id),
        index: 1,
        status:
          scenario === "failed"
            ? "failed"
            : scenario === "unknown"
              ? "paused"
              : "running",
        outcome: scenario === "unknown" ? "unknown" : "known",
        finished: ["source"],
      }
    : null
  return {
    document,
    past: [],
    future: [],
    saved: document,
    selection: { nodeIds: [], edgeIds: [] },
    inspectorId: null,
    readState:
      scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "error"
          : "ready",
    run,
    runSequence: run ? 1 : 0,
    feedback: null,
  }
}
export function changePipeline(
  state: PipelineState,
  command: CanvasCommand,
  readOnly = false,
): PipelineState {
  if (state.run?.outcome === "unknown")
    return {
      ...state,
      feedback: {
        "zh-CN": "结果未知。先查询本地演示快照，再修改流程。",
        en: "The outcome is unknown. Query the local demo snapshot before editing.",
      },
    }
  const result = applyCanvasCommand(state.document, command, definitions, {
    readOnly,
  })
  if (!result.ok)
    return {
      ...state,
      feedback: { "zh-CN": result.message, en: result.message },
    }
  return {
    ...state,
    document: result.document,
    past: [...state.past.slice(-49), state.document],
    future: [],
    run: null,
    selection:
      command.type === "move" || command.type === "configure"
        ? state.selection
        : result.selection,
    feedback: null,
  }
}
export function updateObject(
  state: PipelineState,
  id: string,
  patch: { title?: string; config?: Record<string, string | number> },
  readOnly = false,
) {
  const node = state.document.nodes.find((node) => node.id === id)
  if (!node) return state
  return changePipeline(
    state,
    {
      type: "configure",
      nodeId: id,
      title: patch.title ?? node.title,
      config: { ...node.config, ...patch.config },
    },
    readOnly,
  )
}
export function chooseTitle(
  state: PipelineState,
  index: number,
  readOnly = false,
) {
  if (!Number.isInteger(index) || index < 0 || index > 2) return state
  return updateObject(
    state,
    "titles",
    { config: { selected: index } },
    readOnly,
  )
}
export function chooseThumbnail(
  state: PipelineState,
  id: string,
  readOnly = false,
) {
  if (
    !state.document.nodes.some(
      (node) => node.id === id && node.type === "thumbnail",
    )
  )
    return state
  const document = {
    ...state.document,
    nodes: state.document.nodes.map((node) =>
      node.id === "publish"
        ? { ...node, config: { ...node.config, thumbnailId: id } }
        : node,
    ),
    edges: [
      ...state.document.edges.filter(
        (edge) =>
          !(
            edge.target === "publish" &&
            state.document.nodes.find((node) => node.id === edge.source)
              ?.type === "thumbnail"
          ),
      ),
      {
        id: `${id}-publish`,
        source: id,
        sourcePort: "out",
        target: "publish",
        targetPort: "in",
      },
    ],
  }
  return changePipeline(state, { type: "replace", document }, readOnly)
}
export function addThumbnail(state: PipelineState, readOnly = false) {
  const count = state.document.nodes.filter(
    (node) => node.type === "thumbnail",
  ).length
  const id = `thumb-${count + 1}-${state.document.revision + 1}`
  const node = {
    id,
    type: "thumbnail",
    title: `Thumbnail / ${String(count + 1).padStart(2, "0")}`,
    position: { x: 1300 + Math.max(0, count - 1) * 410, y: 345 },
    config: { color: count % 2 ? "mint" : "amber" },
  }
  const document = {
    ...state.document,
    nodes: [...state.document.nodes, node],
    edges: state.document.nodes.some((node) => node.id === "transcript")
      ? [
          ...state.document.edges,
          {
            id: `transcript-${id}`,
            source: "transcript",
            sourcePort: "out",
            target: id,
            targetPort: "in",
          },
        ]
      : state.document.edges,
  }
  return changePipeline(state, { type: "replace", document }, readOnly)
}
export function undoPipeline(
  state: PipelineState,
  readOnly = false,
): PipelineState {
  const previous = state.past.at(-1)
  if (!previous || readOnly || state.run?.outcome === "unknown") return state
  return {
    ...state,
    document: {
      ...previous,
      viewport: state.document.viewport,
      revision: state.document.revision + 1,
    },
    past: state.past.slice(0, -1),
    future: [state.document, ...state.future],
    run: null,
    feedback: null,
  }
}
export function redoPipeline(
  state: PipelineState,
  readOnly = false,
): PipelineState {
  const next = state.future[0]
  if (!next || readOnly || state.run?.outcome === "unknown") return state
  return {
    ...state,
    document: {
      ...next,
      viewport: state.document.viewport,
      revision: state.document.revision + 1,
    },
    past: [...state.past, state.document],
    future: state.future.slice(1),
    run: null,
    feedback: null,
  }
}
export function savePipeline(
  state: PipelineState,
  readOnly = false,
): PipelineState {
  if (readOnly) return state
  return {
    ...state,
    saved: structuredClone(state.document),
    feedback: {
      "zh-CN": "已保存到本页内存快照；刷新浏览器后丢失。",
      en: "Saved to this page's in-memory snapshot; lost after browser refresh.",
    },
  }
}
export function importPipeline(
  state: PipelineState,
  json: string,
  readOnly = false,
): PipelineState {
  if (readOnly) return state
  try {
    const document = parseCanvasDocument(json, definitions)
    if (
      document.nodes.some(
        (node) =>
          !definitions.some((definition) => definition.type === node.type) ||
          (node.config.image &&
            (typeof node.config.image !== "string" ||
              !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
                node.config.image,
              ))) ||
          (node.type === "titles" &&
            node.config.selected !== undefined &&
            ![0, 1, 2].includes(Number(node.config.selected))),
      )
    )
      throw new Error("Invalid media configuration")
    return changePipeline(state, { type: "replace", document }, false)
  } catch {
    return {
      ...state,
      feedback: {
        "zh-CN": "导入失败：JSON 或媒体流程结构无效。保留现有草稿。",
        en: "Import failed: invalid JSON or media graph. The existing draft was preserved.",
      },
    }
  }
}
export function startDemo(
  state: PipelineState,
  from = "source",
  readOnly = false,
): PipelineState {
  if (
    readOnly ||
    state.readState !== "ready" ||
    state.run?.outcome === "unknown" ||
    state.run?.status === "running"
  )
    return state
  const issues = validateCanvasDocument(state.document, definitions)
  if (
    issues.some((issue) => issue.severity === "error") ||
    !state.document.nodes.some((node) => node.id === from)
  )
    return {
      ...state,
      feedback: {
        "zh-CN": "先添加来源并检查流程连接，再运行本地演示。",
        en: "Add a source and check the graph connections before running the local demo.",
      },
    }
  const reachable = new Set<string>([from])
  const order = [from]
  for (let index = 0; index < order.length; index++)
    for (const edge of state.document.edges.filter(
      (edge) => edge.source === order[index],
    ))
      if (!reachable.has(edge.target)) {
        reachable.add(edge.target)
        order.push(edge.target)
      }
  return {
    ...state,
    runSequence: state.runSequence + 1,
    run: {
      id: state.runSequence + 1,
      revision: state.document.revision,
      order,
      index: 0,
      status: "running",
      outcome: "known",
      finished: [],
    },
    feedback: null,
  }
}
export function advanceDemo(state: PipelineState): PipelineState {
  const run = state.run
  if (
    !run ||
    run.status !== "running" ||
    run.outcome === "unknown" ||
    run.revision !== state.document.revision
  )
    return state
  const index = run.index + 1
  return {
    ...state,
    run: {
      ...run,
      index,
      finished: [...run.finished, run.order[run.index]],
      status: index >= run.order.length ? "completed" : "running",
    },
  }
}
export function queryDemo(state: PipelineState): PipelineState {
  if (state.run?.outcome !== "unknown") return state
  return {
    ...state,
    run: { ...state.run, status: "paused", outcome: "known" },
    feedback: {
      "zh-CN": "本地演示快照确认：已暂停，未发布或调用外部服务。可继续或取消。",
      en: "The local snapshot confirms a paused demo. Nothing was published or sent to a service. Resume or cancel.",
    },
  }
}
