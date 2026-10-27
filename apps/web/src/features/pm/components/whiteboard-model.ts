export type CanvasPoint = { x: number; y: number }
export type CanvasShape = {
  id: string
  kind: "note" | "rectangle" | "ellipse" | "draw"
  x: number
  y: number
  width: number
  height: number
  text: string
  color: string
  points: CanvasPoint[]
}
export type CanvasView = { x: number; y: number; zoom: number }
export type CanvasDocument = { version: 1; shapes: CanvasShape[]; view: CanvasView }
export const canvasColors = ["#fef08a", "#bfdbfe", "#bbf7d0", "#fecdd3", "#e9d5ff", "#e5e7eb"] as const
export const initialView: CanvasView = { x: 0, y: 0, zoom: 1 }
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000

/** Accept only this canvas schema; imported strings are rendered as text, never HTML. */
export function parseCanvas(raw: string): CanvasDocument {
  if (raw.length > 5_000_000) throw new Error("Canvas exceeds 5 MB / 画布超过 5 MB")
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object") throw new Error("Invalid canvas / 无效画布")
  const doc = value as Record<string, unknown>
  if (doc.version !== 1 || !Array.isArray(doc.shapes) || doc.shapes.length > 2000 || !doc.view || typeof doc.view !== "object") throw new Error("Unsupported canvas format / 不支持的画布格式")
  const view = doc.view as Record<string, unknown>
  if (!finite(view.x) || !finite(view.y) || !finite(view.zoom) || view.zoom < 0.2 || view.zoom > 4) throw new Error("Invalid viewport / 无效视口")
  const ids = new Set<string>()
  const shapes = doc.shapes.map((entry: unknown): CanvasShape => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid shape / 无效图形")
    const shape = entry as Record<string, unknown>
    if (typeof shape.id !== "string" || !shape.id || shape.id.length > 200 || ids.has(shape.id) || !["note", "rectangle", "ellipse", "draw"].includes(String(shape.kind)) || !finite(shape.x) || !finite(shape.y) || !finite(shape.width) || !finite(shape.height) || shape.width < 1 || shape.height < 1 || typeof shape.text !== "string" || shape.text.length > 10000 || typeof shape.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(shape.color) || !Array.isArray(shape.points) || shape.points.length > 10000) throw new Error("Invalid shape fields / 无效图形字段")
    ids.add(shape.id)
    const points = shape.points.map((entry: unknown): CanvasPoint => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid stroke / 无效笔画")
      const point = entry as Record<string, unknown>
      if (!finite(point.x) || !finite(point.y)) throw new Error("Invalid stroke coordinates / 无效笔画坐标")
      return { x: point.x, y: point.y }
    })
    if (shape.kind === "draw" && points.length < 2) throw new Error("A stroke needs two points / 笔画至少需要两个点")
    return { id: shape.id, kind: shape.kind as CanvasShape["kind"], x: shape.x, y: shape.y, width: shape.width, height: shape.height, text: shape.text, color: shape.color, points }
  })
  return { version: 1, shapes, view: { x: view.x, y: view.y, zoom: view.zoom } }
}

export type CanvasHistory = { past: CanvasShape[][]; present: CanvasShape[]; future: CanvasShape[][] }
export type CanvasAction = { type: "commit"; shapes: CanvasShape[] } | { type: "undo" | "redo" }
export function canvasReducer(state: CanvasHistory, action: CanvasAction): CanvasHistory {
  if (action.type === "commit") return { past: [...state.past.slice(-99), state.present], present: action.shapes, future: [] }
  if (action.type === "undo" && state.past.length) return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1]!, future: [state.present, ...state.future] }
  if (action.type === "redo" && state.future.length) return { past: [...state.past, state.present], present: state.future[0]!, future: state.future.slice(1) }
  return state
}

export function newCanvasShape(kind: CanvasShape["kind"], x: number, y: number, color: string, text = ""): CanvasShape {
  return { id: crypto.randomUUID(), kind, x, y, width: 180, height: 120, color, text, points: kind === "draw" ? [{ x: 0, y: 0 }, { x: 180, y: 120 }] : [] }
}

export function wrapCanvasText(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor((width - 20) / 8))
  return text.split("\n").flatMap(line => {
    const chars = Array.from(line)
    if (!chars.length) return [""]
    const lines: string[] = []
    for (let offset = 0; offset < chars.length; offset += columns) lines.push(chars.slice(offset, offset + columns).join(""))
    return lines
  })
}
