import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { canvasColors, canvasReducer, initialView, newCanvasShape, parseCanvas, wrapCanvasText, type CanvasDocument, type CanvasPoint, type CanvasShape, type CanvasView } from "./whiteboard-model"

type Props = { storageKey: string }
type Tool = "select" | "pan" | CanvasShape["kind"]
type Gesture = { type: "move" | "create" | "pan"; start: CanvasPoint; shape?: CanvasShape; view: CanvasView; latest?: CanvasShape; pointerId: number }
const field = "min-h-9 w-full rounded-control border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"

function loadCanvas(key: string): { document: CanvasDocument; error: string } {
  try {
    const raw = localStorage.getItem(key)
    return { document: raw ? parseCanvas(raw) : { version: 1, shapes: [], view: initialView }, error: "" }
  } catch (error) {
    return { document: { version: 1, shapes: [], view: initialView }, error: error instanceof Error ? error.message : String(error) }
  }
}

/** A key change remounts all drafts/history before reading the next actor/project canvas. */
export function ServiceWhiteboard({ storageKey }: Props) {
  return <LocalCanvas key={storageKey} storageKey={storageKey} />
}

function LocalCanvas({ storageKey }: Props) {
  const { locale } = useI18n()
  const en = locale === "en"
  const id = useId()
  const key = `pm:whiteboard:v1:${storageKey}`
  const [initial] = useState(() => loadCanvas(key))
  const [history, dispatch] = useReducer(canvasReducer, { past: [], present: initial.document.shapes, future: [] })
  const [view, setView] = useState(initial.document.view)
  const [tool, setTool] = useState<Tool>("select")
  const [color, setColor] = useState<string>(canvasColors[0])
  const [selectedId, setSelectedId] = useState("")
  const [preview, setPreview] = useState<CanvasShape | null>(null)
  const [storageBlocked, setStorageBlocked] = useState(Boolean(initial.error))
  const [storageError, setStorageError] = useState(initial.error)
  const [importError, setImportError] = useState("")
  const [imported, setImported] = useState<CanvasDocument | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveAttempt, setSaveAttempt] = useState(0)
  const svg = useRef<SVGSVGElement>(null)
  const textField = useRef<HTMLTextAreaElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const shapes = history.present
  const selected = shapes.find(shape => shape.id === selectedId)
  const displayed = preview ? (shapes.some(shape => shape.id === preview.id) ? shapes.map(shape => shape.id === preview.id ? preview : shape) : [...shapes, preview]) : shapes
  const names: Record<Tool, string> = { select: en ? "Select / move" : "选择 / 移动", pan: en ? "Pan" : "平移", note: en ? "Note" : "便签", rectangle: en ? "Rectangle" : "矩形", ellipse: en ? "Ellipse" : "椭圆", draw: en ? "Freehand" : "自由绘制" }

  useEffect(() => {
    setSaved(false)
    if (storageBlocked) return
    try {
      const raw = JSON.stringify({ version: 1, shapes, view } satisfies CanvasDocument)
      if (raw.length > 5_000_000) throw new Error(en ? "Canvas exceeds 5 MB. Remove objects or export a backup." : "画布超过 5 MB。请减少对象或导出备份。")
      localStorage.setItem(key, raw)
      setStorageError("")
      setSaved(true)
    } catch (error) { setStorageError(error instanceof Error ? error.message : String(error)) }
  }, [key, shapes, view, storageBlocked, saveAttempt, en])

  function commit(next: CanvasShape[]) { dispatch({ type: "commit", shapes: next }) }
  function updateSelected(patch: Partial<CanvasShape>) {
    if (!selected) return
    commit(shapes.map(shape => shape.id === selected.id ? { ...shape, ...patch } : shape))
  }
  function removeSelected() { if (selected) { commit(shapes.filter(shape => shape.id !== selected.id)); setSelectedId("") } }
  function add(kind: CanvasShape["kind"]) {
    if (shapes.length >= 2000) return
    const shape = newCanvasShape(kind, (500 - view.x) / view.zoom - 90, (300 - view.y) / view.zoom - 60, color, kind === "note" ? (en ? "New note" : "新便签") : "")
    commit([...shapes, shape]); setSelectedId(shape.id); setTool("select")
  }
  function svgPoint(event: PointerEvent<SVGSVGElement>): CanvasPoint {
    const matrix = svg.current?.getScreenCTM()
    if (!matrix) return { x: 0, y: 0 }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }
  function world(point: CanvasPoint): CanvasPoint { return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom } }
  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || gesture.current) return
    event.preventDefault()
    svg.current?.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = svgPoint(event)
    const targetId = (event.target as Element).closest("[data-shape-id]")?.getAttribute("data-shape-id")
    const target = shapes.find(shape => shape.id === targetId)
    if (tool === "pan") {
      gesture.current = { type: "pan", start: point, view, pointerId: event.pointerId }
    } else if (tool === "select") {
      setSelectedId(target?.id ?? "")
      if (target) gesture.current = { type: "move", start: world(point), shape: target, view, pointerId: event.pointerId }
    } else if (shapes.length < 2000) {
      const position = world(point)
      const shape = newCanvasShape(tool, position.x, position.y, color, tool === "note" ? (en ? "New note" : "新便签") : "")
      if (tool === "draw") shape.points = [{ x: 0, y: 0 }]
      gesture.current = { type: "create", start: position, shape, latest: shape, view, pointerId: event.pointerId }
      setPreview(shape); setSelectedId(shape.id)
    }
  }
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    const point = svgPoint(event)
    if (current.type === "pan") {
      setView({ ...current.view, x: current.view.x + point.x - current.start.x, y: current.view.y + point.y - current.start.y })
      return
    }
    const position = { x: (point.x - current.view.x) / current.view.zoom, y: (point.y - current.view.y) / current.view.zoom }
    const original = current.shape!
    let next: CanvasShape
    if (current.type === "move") next = { ...original, x: original.x + position.x - current.start.x, y: original.y + position.y - current.start.y }
    else if (original.kind === "draw") {
      const points = current.latest?.points ?? original.points
      const last = points[points.length - 1]!
      const nextPoint = { x: position.x - original.x, y: position.y - original.y }
      if (points.length >= 10000 || Math.hypot(nextPoint.x - last.x, nextPoint.y - last.y) < 2 / view.zoom) return
      next = { ...original, points: [...points, nextPoint] }
    } else {
      const dx = position.x - current.start.x
      const dy = position.y - current.start.y
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      next = { ...original, x: Math.min(current.start.x, position.x), y: Math.min(current.start.y, position.y), width: Math.max(20, Math.abs(dx)), height: Math.max(20, Math.abs(dy)) }
    }
    current.latest = next; setPreview(next)
  }
  function pointerEnd(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!cancelled && current.latest) {
      let next = current.latest
      if (next.kind === "draw") {
        const points = next.points.length < 2 ? [...next.points, { x: 1, y: 1 }] : next.points
        const xs = points.map(point => point.x), ys = points.map(point => point.y)
        const minX = Math.min(...xs), minY = Math.min(...ys)
        next = { ...next, x: next.x + minX, y: next.y + minY, width: Math.max(1, Math.max(...xs) - minX), height: Math.max(1, Math.max(...ys) - minY), points: points.map(point => ({ x: point.x - minX, y: point.y - minY })) }
      }
      commit(current.type === "create" ? [...shapes, next] : shapes.map(shape => shape.id === next.id ? next : shape))
      if (current.type === "create" && next.kind === "note") setTool("select")
    }
    if (cancelled && current.type === "pan") setView(current.view)
    gesture.current = null; setPreview(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function zoom(next: number) {
    const clamped = Math.max(0.2, Math.min(4, next))
    setView(previous => ({ zoom: clamped, x: 500 - (500 - previous.x) * clamped / previous.zoom, y: 300 - (300 - previous.y) * clamped / previous.zoom }))
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.closest("input, textarea, select, [contenteditable='true']")) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); dispatch({ type: event.shiftKey ? "redo" : "undo" }); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); dispatch({ type: "redo" }); return }
    if (target.closest("button")) return
    if (event.key === "Escape") { gesture.current = null; setPreview(null); setSelectedId(""); setTool("select") }
    if (selected && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); removeSelected() }
    if (selected && event.key === "Enter") { event.preventDefault(); textField.current?.focus() }
    if (selected && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      updateSelected({ x: selected.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), y: selected.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) })
    }
  }
  function exportCanvas() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, shapes, view } satisfies CanvasDocument, null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url; link.download = "personal-canvas.json"; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function importCanvas(file: File) {
    setImportError(""); setImported(null)
    try {
      if (file.size > 5_000_000) throw new Error(en ? "File exceeds 5 MB." : "文件超过 5 MB。")
      setImported(parseCanvas(await file.text()))
    } catch (error) { setImportError(error instanceof Error ? error.message : String(error)) }
  }

  return <section className="space-y-3" aria-label={en ? "Personal local canvas" : "个人本地画布"} onKeyDown={keyDown}>
    <div className="space-y-1">
      <h2 className="font-medium">{en ? "Personal local canvas" : "个人本地画布"}</h2>
      <p className="text-sm text-muted-foreground">{en ? "Saved only in this browser for this account and project, not on the server or shared with collaborators. Clearing browser data removes it. Export a JSON backup." : "仅保存在此浏览器的当前账号和项目下，不会上传服务端或与协作者共享。清理浏览器数据会删除画布，请导出 JSON 备份。"}</p>
      <p role="status" className="text-xs text-muted-foreground">{saved ? (en ? "Saved locally" : "已保存到本地") : (en ? "Not saved locally" : "尚未保存到本地")} · {shapes.length} {en ? "objects" : "个对象"}</p>
    </div>
    {storageError && <div role="alert" className="space-y-2 rounded-control border border-destructive p-3 text-sm"><p>{en ? "Local storage failed. Your changes are not durably saved; export to keep them." : "本地存储失败。更改尚未持久保存，请导出备份。"} {storageError}</p>{storageBlocked ? <><p>{en ? "Existing unreadable data has not been overwritten. Export the original before explicitly replacing it." : "已有的无法读取的数据未被覆盖。请先导出原始数据，再明确选择替换。"}</p><Button variant="outline" onClick={() => {
      try { const raw = localStorage.getItem(key); if (raw !== null) { const url = URL.createObjectURL(new Blob([raw], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "canvas-recovery.json"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) } }
      catch (error) { setStorageError(error instanceof Error ? error.message : String(error)) }
    }}>{en ? "Export original data" : "导出原始数据"}</Button><Button variant="outline" onClick={() => setStorageBlocked(false)}>{en ? "Replace unreadable local data with this canvas" : "以当前画布替换无法读取的本地数据"}</Button></> : <Button variant="outline" onClick={() => setSaveAttempt(value => value + 1)}>{en ? "Retry local save" : "重试本地保存"}</Button>}</div>}
    <div role="group" aria-label={en ? "Canvas tools" : "画布工具"} className="flex flex-wrap gap-2">
      {(Object.keys(names) as Tool[]).map(value => <Button key={value} variant="outline" aria-pressed={tool === value} onClick={() => setTool(value)}>{names[value]}</Button>)}
      <label className="flex items-center gap-2 text-sm">{en ? "New object color" : "新对象颜色"}<input type="color" value={color} onChange={event => setColor(event.target.value)} className="h-9 w-10" /></label>
      <Button variant="outline" disabled={!history.past.length || Boolean(preview)} onClick={() => dispatch({ type: "undo" })}>{en ? "Undo" : "撤销"}</Button>
      <Button variant="outline" disabled={!history.future.length || Boolean(preview)} onClick={() => dispatch({ type: "redo" })}>{en ? "Redo" : "重做"}</Button>
    </div>
    <div role="group" aria-label={en ? "Keyboard creation and view controls" : "键盘创建与视图控制"} className="flex flex-wrap items-center gap-2">
      {(["note", "rectangle", "ellipse", "draw"] as const).map(kind => <Button key={kind} variant="ghost" disabled={shapes.length >= 2000} onClick={() => add(kind)}>{en ? "Add" : "添加"} {names[kind]}</Button>)}
      <Button variant="outline" aria-label={en ? "Zoom out" : "缩小"} disabled={view.zoom <= 0.2} onClick={() => zoom(view.zoom / 1.25)}>−</Button>
      <span className="text-sm">{Math.round(view.zoom * 100)}%</span>
      <Button variant="outline" aria-label={en ? "Zoom in" : "放大"} disabled={view.zoom >= 4} onClick={() => zoom(view.zoom * 1.25)}>+</Button>
      <Button variant="ghost" onClick={() => setView(initialView)}>{en ? "Reset view" : "重置视图"}</Button>
      {([{ label: en ? "Pan left" : "向左平移", x: 80, y: 0, symbol: "←" }, { label: en ? "Pan right" : "向右平移", x: -80, y: 0, symbol: "→" }, { label: en ? "Pan up" : "向上平移", x: 0, y: 80, symbol: "↑" }, { label: en ? "Pan down" : "向下平移", x: 0, y: -80, symbol: "↓" }]).map(direction => <Button key={direction.label} variant="ghost" aria-label={direction.label} onClick={() => setView(previous => ({ ...previous, x: previous.x + direction.x, y: previous.y + direction.y }))}>{direction.symbol}</Button>)}
    </div>
    <p id={`${id}-instructions`} className="text-xs text-muted-foreground">{en ? "Draw by dragging. Use Add buttons to create without a pointer. Tab to an object or choose it below; arrows move it (Shift: 10px), Enter edits text, Delete removes it. Ctrl/Cmd+Z undoes. Pan by dragging with Pan selected." : "拖动绘制；也可使用添加按钮通过键盘创建。Tab 聚焦对象或从下方选择，方向键移动（Shift：10px），Enter 编辑文字，Delete 删除。Ctrl/Cmd+Z 撤销。选择平移工具后拖动平移。"}</p>
    <svg ref={svg} viewBox="0 0 1000 600" role="group" aria-label={en ? "Canvas drawing area" : "画布绘图区"} aria-describedby={`${id}-instructions`} tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)} className="max-h-[640px] min-h-64 w-full touch-none rounded-panel border border-border bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring" style={{ cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair" }}>
      <defs>{displayed.map(shape => <clipPath key={shape.id} id={`${id}-clip-${shape.id}`}><rect width={shape.width - 8 > 0 ? shape.width - 8 : 1} height={Math.max(1, shape.height - 8)} x={4} y={4} /></clipPath>)}</defs>
      <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
        {displayed.map(shape => <g key={shape.id} data-shape-id={shape.id} transform={`translate(${shape.x} ${shape.y})`} role="button" tabIndex={0} aria-label={`${names[shape.kind]}: ${shape.text || shape.id}`} aria-pressed={selectedId === shape.id} onFocus={() => setSelectedId(shape.id)} onDoubleClick={() => { setSelectedId(shape.id); textField.current?.focus() }} className="outline-none focus-visible:stroke-primary">
          {shape.kind === "ellipse" ? <ellipse cx={shape.width / 2} cy={shape.height / 2} rx={shape.width / 2} ry={shape.height / 2} fill={shape.color} stroke="#475569" strokeWidth={1.5} /> : shape.kind === "draw" ? <><rect width={shape.width} height={shape.height} fill="transparent" /><polyline points={shape.points.map(point => `${point.x},${point.y}`).join(" ")} fill="none" stroke={shape.color} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" /></> : <rect width={shape.width} height={shape.height} rx={shape.kind === "note" ? 8 : 0} fill={shape.color} stroke="#475569" strokeWidth={1.5} />}
          {shape.text && <text x={10} y={25} fill="#111827" stroke="none" fontSize={14} clipPath={`url(#${id}-clip-${shape.id})`} pointerEvents="none">{wrapCanvasText(shape.text, shape.width).slice(0, Math.ceil(shape.height / 20)).map((line, index) => <tspan key={index} x={10} dy={index ? 20 : 0}>{line || " "}</tspan>)}</text>}
          {selectedId === shape.id && <rect x={-4} y={-4} width={shape.width + 8} height={shape.height + 8} fill="none" stroke="var(--primary)" strokeWidth={2 / view.zoom} strokeDasharray={`${6 / view.zoom} ${3 / view.zoom}`} pointerEvents="none" />}
        </g>)}
      </g>
    </svg>
    {shapes.length === 0 && <p className="text-sm text-muted-foreground">{en ? "Empty canvas. Add a note or draw a shape to begin." : "画布为空。添加便签或绘制图形即可开始。"}</p>}
    <div className="grid gap-3 rounded-panel border border-border p-3 md:grid-cols-2">
      <label className="space-y-1 text-sm"><span>{en ? "Selected object" : "选择对象"}</span><select className={field} value={selected?.id ?? ""} onChange={event => setSelectedId(event.target.value)}><option value="">{en ? "No selection" : "未选择"}</option>{shapes.map((shape, index) => <option key={shape.id} value={shape.id}>{index + 1}. {names[shape.kind]} {shape.text.slice(0, 70)}</option>)}</select></label>
      {selected && <>
        <label className="space-y-1 text-sm"><span>{en ? "Object text" : "对象文本"}</span><textarea ref={textField} className={`${field} min-h-20 py-2`} maxLength={10000} value={selected.text} onChange={event => updateSelected({ text: event.target.value })} /></label>
        <div className="grid grid-cols-2 gap-2">{(["x", "y", "width", "height"] as const).map(property => <label key={property} className="space-y-1 text-sm"><span>{({ x: "X", y: "Y", width: en ? "Width" : "宽度", height: en ? "Height" : "高度" })[property]}</span><input type="number" className={field} min={property === "width" || property === "height" ? 1 : -1000000} max={1000000} step="any" value={Math.round(selected[property] * 100) / 100} onChange={event => {
          if (!event.currentTarget.value || !event.currentTarget.validity.valid) return
          const value = event.currentTarget.valueAsNumber
          if (!Number.isFinite(value)) return
          const patch: Partial<CanvasShape> = { [property]: value }
          if (selected.kind === "draw" && (property === "width" || property === "height")) patch.points = selected.points.map(point => ({ x: property === "width" ? point.x * value / selected.width : point.x, y: property === "height" ? point.y * value / selected.height : point.y }))
          updateSelected(patch)
        }} /></label>)}</div>
        <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-sm">{en ? "Object color" : "对象颜色"}<input type="color" value={selected.color} onChange={event => updateSelected({ color: event.target.value })} /></label><Button variant="outline" onClick={() => { commit([...shapes.filter(shape => shape.id !== selected.id), selected]) }}>{en ? "Bring to front" : "移到最前"}</Button><Button variant="destructive" onClick={removeSelected}>{en ? "Delete object" : "删除对象"}</Button></div>
      </>}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" onClick={exportCanvas}>{en ? "Export JSON" : "导出 JSON"}</Button>
      <label className="space-y-1 text-sm"><span className="mr-2">{en ? "Import JSON" : "导入 JSON"}</span><input type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importCanvas(file); event.target.value = "" }} /></label>
      <Button variant="outline" disabled={!shapes.length} onClick={() => { commit([]); setSelectedId("") }}>{en ? "Clear canvas (undoable)" : "清空画布（可撤销）"}</Button>
    </div>
    {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
    {imported && <div className="flex flex-wrap items-center gap-3 rounded-control border border-border p-3"><p className="text-sm">{en ? `Replace this canvas with ${imported.shapes.length} imported objects? The replacement can be undone.` : `用导入的 ${imported.shapes.length} 个对象替换当前画布？替换操作可撤销。`}</p><Button onClick={() => { commit(imported.shapes); setView(imported.view); setSelectedId(""); setImported(null) }}>{en ? "Replace canvas" : "替换画布"}</Button><Button variant="outline" onClick={() => setImported(null)}>{en ? "Cancel import" : "取消导入"}</Button></div>}
  </section>
}
