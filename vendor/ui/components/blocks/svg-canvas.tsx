"use client"
import {
  createElement,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react"
import { useSvgI18n as useI18n } from "../../lib/i18n-svg"
import {
  editableSvgIds,
  findSvgNode,
  uniqueSvgId,
  topSvgSelection,
  svgReactAttribute,
  svgScopedValue,
  type SvgDocument,
  type SvgNode,
  type SvgTool,
  type EditCommand,
} from "../../lib/svg-workbench-model"
import styles from "./svg-workbench.module.css"

const NodeView = memo(function NodeView({
  node,
  prefix,
}: {
  node: SvgNode
  prefix: string
}): ReactNode {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs).map(([key, value]) => [
      svgReactAttribute(key),
      svgScopedValue(key, value, (id) => `${prefix}-${id}`),
    ]),
  )
  return createElement(
    node.tag,
    { ...attrs, id: `${prefix}-${node.id}`, "data-svg-node": node.id },
    node.text,
    node.children.map((n) => <NodeView key={n.id} node={n} prefix={prefix} />),
  )
})
export function SvgArtwork({
  document,
  prefix,
  className,
}: {
  document: SvgDocument
  prefix: string
  className?: string
}) {
  const uniquePrefix = `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  return (
    <svg
      className={className}
      viewBox={document.viewBox.join(" ")}
      {...Object.fromEntries(
        Object.entries(document.attrs).map(([key, value]) => [
          svgReactAttribute(key),
          svgScopedValue(key, value, (id) => `${uniquePrefix}-${id}`),
        ]),
      )}
      aria-hidden="true"
    >
      {document.nodes.map((n) => (
        <NodeView key={n.id} node={n} prefix={uniquePrefix} />
      ))}
    </svg>
  )
}
export type SvgCanvasProps = {
  document: SvgDocument
  selectedIds: string[]
  onSelectionChange: (ids: string[]) => void
  onCommand: (command: EditCommand) => void
  tool: SvgTool
  zoom: number
  onZoomChange: (value: number) => void
  grid?: boolean
  background?: "transparent" | "light" | "dark"
  pan?: { x: number; y: number }
  onPanChange?: (value: { x: number; y: number }) => void
}
type Drag = {
  pointerId: number
  revision: number
  start: DOMPoint
  client: DOMPoint
  ids: string[]
  elements: {
    id: string
    element: SVGGraphicsElement
    inverse: DOMMatrix
    original: string
  }[]
  latest: DOMPoint
  tool: SvgTool
}
export function SvgCanvas({
  document,
  selectedIds,
  onSelectionChange,
  onCommand,
  tool,
  zoom,
  onZoomChange,
  grid = true,
  background = "transparent",
  pan: controlledPan,
  onPanChange,
}: SvgCanvasProps) {
  const { t } = useI18n(),
    root = useRef<SVGSVGElement>(null),
    container = useRef<HTMLDivElement>(null),
    overlay = useRef<SVGGElement>(null),
    drawing = useRef<SVGGElement>(null)
  const drag = useRef<Drag | null>(null),
    frame = useRef(0),
    pointList = useRef<DOMPoint[]>([]),
    sequence = useRef(0)
  const [localPan, setLocalPan] = useState({ x: 0, y: 0 }),
    [fit, setFit] = useState(12)
  const pan = controlledPan ?? localPan
  const setPan = (value: { x: number; y: number }) => {
    if (!controlledPan) setLocalPan(value)
    onPanChange?.(value)
  }
  const editable = editableSvgIds(document),
    prefix = `editor-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const selected = topSvgSelection(document, selectedIds)
  const element = (id: string) =>
    root.current?.querySelector<SVGGraphicsElement>(
      `[data-svg-node="${CSS.escape(id)}"]`,
    )
  const point = (x: number, y: number) =>
    new DOMPoint(x, y).matrixTransform(root.current!.getScreenCTM()!.inverse())
  const svgElement = (tag: string, attrs: Record<string, string>) => {
    const n = globalThis.document.createElementNS(
      "http://www.w3.org/2000/svg",
      tag,
    )
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    return n
  }
  function selectionBoxes() {
    const group = overlay.current,
      matrix = root.current?.getScreenCTM()?.inverse()
    if (!group || !matrix) return
    group.replaceChildren()
    for (const id of selected) {
      const n = element(id)
      if (!n || n.getAttribute("display") === "none") continue
      const bounds = n.getBoundingClientRect(),
        a = new DOMPoint(bounds.left, bounds.top).matrixTransform(matrix),
        b = new DOMPoint(bounds.right, bounds.bottom).matrixTransform(matrix)
      group.append(
        svgElement("rect", {
          x: String(a.x),
          y: String(a.y),
          width: String(Math.max(0, b.x - a.x)),
          height: String(Math.max(0, b.y - a.y)),
          fill: "none",
          stroke: "var(--primary)",
          "stroke-width": "1",
          "vector-effect": "non-scaling-stroke",
          "data-selection-box": id,
        }),
      )
    }
  }
  useLayoutEffect(() => {
    selectionBoxes()
  })
  useEffect(() => {
    const node = container.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setFit(
        Math.max(
          0.000001,
          Math.min(
            (r.width - 64) / document.width,
            (r.height - 64) / document.height,
          ),
        ),
      )
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [document.width, document.height])
  function restoreDrag() {
    const d = drag.current
    if (d)
      for (const n of d.elements)
        n.element.setAttribute("transform", n.original)
    drag.current = null
    cancelAnimationFrame(frame.current)
    drawing.current?.replaceChildren()
    selectionBoxes()
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  useEffect(() => {
    if (drag.current) {
      const d = drag.current
      for (const n of d.elements)
        n.element.setAttribute(
          "transform",
          findSvgNode(document, n.id)?.attrs.transform ?? "",
        )
      drag.current = null
      cancelAnimationFrame(frame.current)
    }
    pointList.current = []
    drawing.current?.replaceChildren()
  }, [document, tool])
  function geometry(
    kind: SvgTool,
    a: DOMPoint,
    b: DOMPoint,
  ): Record<string, string> {
    const x = Math.min(a.x, b.x),
      y = Math.min(a.y, b.y),
      w = Math.abs(b.x - a.x),
      h = Math.abs(b.y - a.y)
    if (kind === "rect")
      return { x: String(x), y: String(y), width: String(w), height: String(h) }
    if (kind === "circle")
      return {
        cx: String(a.x),
        cy: String(a.y),
        r: String(Math.hypot(b.x - a.x, b.y - a.y)),
      }
    if (kind === "ellipse")
      return {
        cx: String(x + w / 2),
        cy: String(y + h / 2),
        rx: String(w / 2),
        ry: String(h / 2),
      }
    return {
      x1: String(a.x),
      y1: String(a.y),
      x2: String(b.x),
      y2: String(b.y),
    }
  }
  function addNode(tag: SvgNode["tag"], attrs: Record<string, string>) {
    const id = uniqueSvgId(
      document,
      `draw-${document.revision}-${++sequence.current}`,
    )
    onCommand({
      type: "add",
      nodes: [
        {
          id,
          tag,
          attrs: {
            ...attrs,
            fill: tag === "line" || tag === "polyline" ? "none" : "none",
            stroke: "currentColor",
            "stroke-width": String(Math.max(0.1, document.viewBox[2] / 24)),
          },
          children: [],
        },
      ],
    })
    onSelectionChange([id])
  }
  function finishPoints() {
    const points = pointList.current
    if (points.length >= (tool === "polygon" ? 3 : 2))
      addNode(tool === "polygon" ? "polygon" : "polyline", {
        points: points.map((p) => `${p.x},${p.y}`).join(" "),
      })
    pointList.current = []
    drawing.current?.replaceChildren()
  }
  function pointerDown(e: PointerEvent<SVGSVGElement>) {
    if ((e.button !== 0 && e.button !== 1) || !root.current?.getScreenCTM())
      return
    root.current.focus()
    const start = point(e.clientX, e.clientY)
    if (tool === "polygon" || tool === "polyline") {
      pointList.current.push(start)
      drawing.current?.replaceChildren(
        svgElement("polyline", {
          points: pointList.current.map((p) => `${p.x},${p.y}`).join(" "),
          fill: "none",
          stroke: "var(--primary)",
          "stroke-width": "1",
          "vector-effect": "non-scaling-stroke",
        }),
      )
      return
    }
    const target = (e.target as Element).closest<SVGGraphicsElement>(
      "[data-svg-node]",
    )
    const id = target?.getAttribute("data-svg-node")
    let ids = selected
    if (tool === "select") {
      if (!id) {
        onSelectionChange([])
        return
      }
      if (e.shiftKey) {
        onSelectionChange(
          selectedIds.includes(id)
            ? selectedIds.filter((n) => n !== id)
            : [...selectedIds, id],
        )
        return
      }
      if (!selectedIds.includes(id)) {
        ids = [id]
        onSelectionChange(ids)
      }
      ids = ids.filter((n) => editable.has(n))
    }
    const elements = ids.flatMap((id) => {
      const n = element(id),
        parent = n?.parentElement as SVGGraphicsElement | undefined
      const ctm = parent?.getScreenCTM?.()
      return n && ctm
        ? [
            {
              id,
              element: n,
              inverse: ctm.inverse(),
              original: n.getAttribute("transform") ?? "",
            },
          ]
        : []
    })
    drag.current = {
      pointerId: e.pointerId,
      revision: document.revision,
      start,
      client: new DOMPoint(e.clientX, e.clientY),
      ids,
      elements,
      latest: new DOMPoint(e.clientX, e.clientY),
      tool: e.button === 1 ? "pan" : tool,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  function preview() {
    const d = drag.current
    if (!d) return
    if (d.tool === "select") {
      for (const n of d.elements) {
        const a = d.client.matrixTransform(n.inverse),
          b = d.latest.matrixTransform(n.inverse)
        n.element.setAttribute(
          "transform",
          `translate(${b.x - a.x} ${b.y - a.y}) ${n.original}`,
        )
      }
      selectionBoxes()
    } else if (d.tool === "pan") {
      const dx = d.latest.x - d.client.x,
        dy = d.latest.y - d.client.y
      root.current!.style.translate = `${pan.x + dx}px ${pan.y + dy}px`
    } else
      drawing.current?.replaceChildren(
        svgElement(d.tool, {
          ...geometry(d.tool, d.start, point(d.latest.x, d.latest.y)),
          fill: "none",
          stroke: "var(--primary)",
          "stroke-width": "1",
          "vector-effect": "non-scaling-stroke",
        }),
      )
  }
  function pointerUp(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    d.latest = new DOMPoint(e.clientX, e.clientY)
    preview()
    const moved =
      Math.hypot(d.latest.x - d.client.x, d.latest.y - d.client.y) > 2
    if (d.revision === document.revision && moved) {
      if (d.tool === "select") {
        const commands: Exclude<EditCommand, { type: "transaction" }>[] =
          d.elements.map((n) => {
            const a = d.client.matrixTransform(n.inverse),
              b = d.latest.matrixTransform(n.inverse)
            return {
              type: "update",
              ids: [n.id],
              attrs: {
                transform:
                  `translate(${b.x - a.x} ${b.y - a.y}) ${n.original}`.trim(),
              },
            }
          })
        restoreDrag()
        onCommand({ type: "transaction", commands })
      } else if (d.tool === "pan")
        setPan({
          x: pan.x + d.latest.x - d.client.x,
          y: pan.y + d.latest.y - d.client.y,
        })
      else
        addNode(
          d.tool as SvgNode["tag"],
          geometry(d.tool, d.start, point(e.clientX, e.clientY)),
        )
    }
    restoreDrag()
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId)
  }
  return (
    <div
      ref={container}
      className={styles.viewport}
      data-background={background}
      data-grid={grid}
    >
      <svg
        ref={root}
        role="group"
        aria-label={t("svg.canvas")}
        aria-describedby={`${prefix}-help`}
        tabIndex={0}
        className={styles.artboard}
        viewBox={document.viewBox.join(" ")}
        style={{
          width: document.width * fit * zoom,
          height: document.height * fit * zoom,
          translate: `${pan.x}px ${pan.y}px`,
        }}
        {...Object.fromEntries(
          Object.entries(document.attrs)
            .filter(
              ([key]) =>
                ![
                  "role",
                  "aria-label",
                  "aria-labelledby",
                  "aria-describedby",
                  "focusable",
                ].includes(key),
            )
            .map(([k, v]) => [
              svgReactAttribute(k),
              v.replace(
                /url\(#([\w.-]+)\)/g,
                (_, id: string) => `url(#${prefix}-${id})`,
              ),
            ]),
        )}
        onPointerDown={pointerDown}
        onPointerMove={(e) => {
          if (!drag.current) return
          drag.current.latest = new DOMPoint(e.clientX, e.clientY)
          cancelAnimationFrame(frame.current)
          frame.current = requestAnimationFrame(preview)
        }}
        onPointerUp={pointerUp}
        onPointerCancel={restoreDrag}
        onLostPointerCapture={() => {
          if (drag.current) restoreDrag()
        }}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            onZoomChange(
              Math.max(0.25, Math.min(8, zoom * (e.deltaY > 0 ? 0.9 : 1.1))),
            )
          }
        }}
        onDoubleClick={() => {
          if (tool === "polygon" || tool === "polyline") finishPoints()
        }}
        onKeyDown={(e) => {
          if (e.isDefaultPrevented() || e.nativeEvent.isComposing) return
          if (e.key === "Escape") {
            restoreDrag()
            pointList.current = []
            root.current!.style.translate = `${pan.x}px ${pan.y}px`
            e.preventDefault()
          } else if (e.key === "Enter" && pointList.current.length) {
            finishPoints()
            e.preventDefault()
          } else if (e.key.startsWith("Arrow") && tool === "pan") {
            setPan({
              x:
                pan.x +
                (e.key === "ArrowLeft" ? -20 : e.key === "ArrowRight" ? 20 : 0),
              y:
                pan.y +
                (e.key === "ArrowUp" ? -20 : e.key === "ArrowDown" ? 20 : 0),
            })
            e.preventDefault()
          } else if (e.key.startsWith("Arrow") && selected.length) {
            const delta = e.shiftKey ? 10 : 1,
              dx =
                e.key === "ArrowLeft"
                  ? -delta
                  : e.key === "ArrowRight"
                    ? delta
                    : 0,
              dy =
                e.key === "ArrowUp" ? -delta : e.key === "ArrowDown" ? delta : 0
            onCommand({
              type: "transform",
              ids: selected,
              transform: `translate(${dx} ${dy})`,
            })
            e.preventDefault()
          } else if (e.key === "Delete" || e.key === "Backspace") {
            onCommand({ type: "remove", ids: selected })
            e.preventDefault()
          }
        }}
      >
        {document.nodes.map((n) => (
          <NodeView key={n.id} node={n} prefix={prefix} />
        ))}
        <g ref={overlay} pointerEvents="none" />
        <g ref={drawing} pointerEvents="none" />
      </svg>
      <p id={`${prefix}-help`} className={styles.canvasHelp}>
        {t("svg.drawHint")}
      </p>
    </div>
  )
}
