import type {
  CanvasDocument,
  CanvasNodeDefinition,
  CanvasPoint,
} from "./canvas-model"

export type CanvasMeasurements = Record<
  string,
  { width: number; height: number }
>
export type CanvasLayoutResult =
  | { ok: true; positions: Record<string, CanvasPoint> }
  | { ok: false; reason: "cycle" | "subflow" | "invalid" | "groupCapacity" }
type Rect = CanvasPoint & { width: number; height: number }
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + 24 &&
  a.x + a.width + 24 > b.x &&
  a.y < b.y + b.height + 24 &&
  a.y + a.height + 24 > b.y

/** Coordinate-only, current-flow DAG layout. Frames and caller-fixed nodes stay put.
 * No routing/crossing guarantee. Yielding is intentional: callers can cancel work.
 */
export async function layoutCanvasDAG(
  document: CanvasDocument,
  definitions: readonly CanvasNodeDefinition[],
  options: {
    measurements?: CanvasMeasurements
    fixedNodeIds?: readonly string[]
    signal?: AbortSignal
  } = {},
): Promise<CanvasLayoutResult> {
  const pause = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    options.signal?.throwIfAborted()
  }
  await pause()
  if (
    document.nodes.some((node) => /^(subflow|loop|iteration):/.test(node.type))
  )
    return { ok: false, reason: "subflow" }
  const finitePoint = (point: CanvasPoint) =>
    Number.isFinite(point.x) && Number.isFinite(point.y)
  if (
    document.nodes.some((node) => !finitePoint(node.position)) ||
    document.frames.some(
      (frame) =>
        !finitePoint(frame.position) ||
        !Number.isFinite(frame.width) ||
        !Number.isFinite(frame.height) ||
        frame.width <= 0 ||
        frame.height <= 0,
    ) ||
    Object.values(options.measurements ?? {}).some(
      (size) =>
        !Number.isFinite(size.width) ||
        !Number.isFinite(size.height) ||
        size.width <= 0 ||
        size.height <= 0,
    )
  )
    return { ok: false, reason: "invalid" }
  const nodes = new Map(document.nodes.map((node) => [node.id, node]))
  const frames = new Map(document.frames.map((frame) => [frame.id, frame]))
  const types = new Map(
    definitions.map((definition) => [definition.type, definition]),
  )
  if (
    nodes.size !== document.nodes.length ||
    document.nodes.some((node) => node.parentId && !frames.has(node.parentId))
  )
    return { ok: false, reason: "invalid" }
  const incoming = new Map(document.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of document.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target))
      return { ok: false, reason: "invalid" }
    incoming.set(edge.target, incoming.get(edge.target)! + 1)
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
  }
  const queue = document.nodes
    .filter((node) => incoming.get(node.id) === 0)
    .map((node) => node.id)
  const ranks = new Map(document.nodes.map((node) => [node.id, 0]))
  for (let i = 0; i < queue.length; i++) {
    if (i % 128 === 0) await pause()
    const id = queue[i]
    for (const target of outgoing.get(id) ?? []) {
      ranks.set(target, Math.max(ranks.get(target)!, ranks.get(id)! + 1))
      incoming.set(target, incoming.get(target)! - 1)
      if (incoming.get(target) === 0) queue.push(target)
    }
  }
  if (queue.length !== nodes.size) return { ok: false, reason: "cycle" }
  const sizes = new Map(
    document.nodes.map((node) => {
      const definition = types.get(node.type)
      const ports = definition?.ports ?? []
      const minimumHeight = Math.max(
        128,
        72 +
          Math.max(
            ports.filter((port) => port.direction === "input").length,
            ports.filter((port) => port.direction === "output").length,
          ) *
            28,
      )
      const measured = options.measurements?.[node.id]
      return [
        node.id,
        {
          width: Math.max(240, measured?.width ?? 240),
          height: Math.max(minimumHeight, measured?.height ?? minimumHeight),
        },
      ] as const
    }),
  )
  const fixed = new Set(options.fixedNodeIds)
  const groups = new Map<string, string[]>()
  for (const id of queue) {
    const group = nodes.get(id)!.parentId ?? ""
    const ids = groups.get(group) ?? []
    ids.push(id)
    groups.set(group, ids)
  }
  const positions: Record<string, CanvasPoint> = {}
  const obstacles: Rect[] = [
    ...document.frames.map((frame) => ({
      ...frame.position,
      width: frame.width,
      height: frame.height,
    })),
    ...document.nodes
      .filter((node) => fixed.has(node.id) && !node.parentId)
      .map((node) => ({ ...node.position, ...sizes.get(node.id)! })),
  ]
  for (const [group, ids] of groups) {
    const frame = frames.get(group)
    const widths = new Map<number, number>()
    for (const id of ids)
      widths.set(
        ranks.get(id)!,
        Math.max(widths.get(ranks.get(id)!) ?? 0, sizes.get(id)!.width),
      )
    const columns = new Map<number, number>()
    let x = frame ? frame.position.x + 24 : 80
    for (const rank of [...widths.keys()].sort((a, b) => a - b)) {
      columns.set(rank, x)
      x += Math.ceil(widths.get(rank)! / 4) * 4 + (frame ? 32 : 96)
    }
    const rows = new Map<number, number>()
    const placed: Rect[] = frame
      ? ids
          .filter((id) => fixed.has(id))
          .map((id) => ({ ...nodes.get(id)!.position, ...sizes.get(id)! }))
      : obstacles
    for (let i = 0; i < ids.length; i++) {
      if (i % 64 === 0) await pause()
      const id = ids[i],
        node = nodes.get(id)!,
        size = sizes.get(id)!,
        rank = ranks.get(id)!
      if (fixed.has(id)) {
        positions[id] = { ...node.position }
        continue
      }
      const point = {
        x: columns.get(rank)!,
        y: rows.get(rank) ?? (frame ? frame.position.y + 48 : 80),
      }
      let hit: Rect | undefined
      while (
        (hit = placed.find((rect) => overlap({ ...point, ...size }, rect)))
      )
        point.y = Math.ceil((hit.y + hit.height + 48) / 4) * 4
      if (
        frame &&
        (point.x + size.width > frame.position.x + frame.width - 24 ||
          point.y + size.height > frame.position.y + frame.height - 24)
      )
        return { ok: false, reason: "groupCapacity" }
      positions[id] = point
      rows.set(rank, Math.ceil((point.y + size.height + 48) / 4) * 4)
      placed.push({ ...point, ...size })
    }
  }
  options.signal?.throwIfAborted()
  return { ok: true, positions }
}
