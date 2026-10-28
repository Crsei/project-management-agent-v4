import { SaxesParser } from "saxes"
import {
  blankSvgDocument,
  SVG_LIMITS,
  flattenSvgNodes,
  type SvgDocument,
  type SvgNode,
  type SvgTag,
  type SvgDiagnostic,
} from "./svg-workbench-model"

const svgNamespace = "http://www.w3.org/2000/svg"
const tags = new Set<SvgTag>([
  "g",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "use",
  "title",
  "desc",
])
const common = [
  "id",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "clip-rule",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "display",
  "vector-effect",
  "color",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "focusable",
]
const geometry: Record<string, string[]> = {
  svg: ["width", "height", "viewBox", "preserveAspectRatio"],
  g: [],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  path: ["d", "pathLength"],
  defs: [],
  linearGradient: [
    "x1",
    "y1",
    "x2",
    "y2",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "href",
  ],
  radialGradient: [
    "cx",
    "cy",
    "r",
    "fx",
    "fy",
    "fr",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "href",
  ],
  stop: ["offset", "stop-color", "stop-opacity"],
  use: ["href", "x", "y", "width", "height"],
  title: [],
  desc: [],
}
const paints = new Set(["fill", "stroke", "color", "stop-color"])
const numeric = new Set([
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "stroke-width",
  "stroke-miterlimit",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "stop-opacity",
  "pathLength",
  "offset",
])
const numberPattern = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?"
const numberRegex = new RegExp(`^${numberPattern}%?$`)
function validPath(value: string): boolean {
  if (!value.trim()) return true
  const number = new RegExp(numberPattern, "y"),
    arities: Record<string, number> = {
      M: 2,
      L: 2,
      H: 1,
      V: 1,
      C: 6,
      S: 4,
      Q: 4,
      T: 2,
      A: 7,
      Z: 0,
    }
  let at = 0,
    command = "",
    first = true
  const separators = () => {
    while (at < value.length && /[\s,]/.test(value[at])) at++
  }
  while (at < value.length) {
    separators()
    if (at === value.length) break
    if (/[a-zA-Z]/.test(value[at])) {
      command = value[at++]
      if (!Object.hasOwn(arities, command.toUpperCase())) return false
      if (first && command.toUpperCase() !== "M") return false
      first = false
      if (command.toUpperCase() === "Z") {
        command = ""
        continue
      }
    }
    if (!command) return false
    const upper = command.toUpperCase()
    for (let parameter = 0; parameter < arities[upper]; parameter++) {
      separators()
      if (upper === "A" && (parameter === 3 || parameter === 4)) {
        if (value[at] !== "0" && value[at] !== "1") return false
        at++
        continue
      }
      number.lastIndex = at
      const token = number.exec(value)
      if (
        !token ||
        !Number.isFinite(Number(token[0])) ||
        Math.abs(Number(token[0])) > 1000000 ||
        (upper === "A" && parameter < 2 && Number(token[0]) < 0)
      )
        return false
      at = number.lastIndex
    }
    if (upper === "M") command = command === "M" ? "L" : "l"
  }
  return !first
}
const enums: Record<string, string[]> = {
  "stroke-linecap": ["butt", "round", "square"],
  "stroke-linejoin": ["miter", "round", "bevel"],
  "fill-rule": ["nonzero", "evenodd"],
  "clip-rule": ["nonzero", "evenodd"],
  display: ["none", "inline"],
  "vector-effect": ["none", "non-scaling-stroke"],
  gradientUnits: ["objectBoundingBox", "userSpaceOnUse"],
  spreadMethod: ["pad", "reflect", "repeat"],
  role: ["img", "presentation"],
  focusable: ["true", "false"],
}
export function svgAttributeDiagnostic(
  tag: string,
  key: string,
  value: string,
): SvgDiagnostic | undefined {
  const fail = (code: SvgDiagnostic["code"] = "geometry"): SvgDiagnostic => ({
    code,
    detail: `${tag}.${key}: ${value.slice(0, 120)}`,
  })
  if (
    key.startsWith("on") ||
    (/(?:javascript:|data:|https?:|file:|\\)/i.test(value) &&
      key !== "aria-label")
  )
    return fail("unsafe")
  if (
    ![...common, ...(geometry[tag] ?? [])].includes(key) ||
    (tag === "svg" && key === "id")
  )
    return fail("unsupported")
  if (value.length > SVG_LIMITS.path) return fail("capacity")
  if (
    paints.has(key) &&
    !/^(?:none|currentColor|transparent|[a-zA-Z]{1,24}|#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s+-]+\)|url\(#[\w.-]+\))$/.test(
      value,
    )
  )
    return fail("unsafe")
  if (numeric.has(key)) {
    if (
      !numberRegex.test(value) ||
      !Number.isFinite(parseFloat(value)) ||
      Math.abs(parseFloat(value)) > 1000000
    )
      return fail()
    if (
      [
        "r",
        "rx",
        "ry",
        "width",
        "height",
        "stroke-width",
        "pathLength",
      ].includes(key) &&
      parseFloat(value) < 0
    )
      return fail()
    if (
      ["opacity", "fill-opacity", "stroke-opacity", "stop-opacity"].includes(
        key,
      ) &&
      (value.endsWith("%") || Number(value) < 0 || Number(value) > 1)
    )
      return fail()
  }
  if (enums[key] && !enums[key].includes(value)) return fail()
  if (key === "id" && !/^[a-zA-Z_][\w.-]{0,127}$/.test(value))
    return fail("reference")
  if (["href"].includes(key) && !/^#[a-zA-Z_][\w.-]{0,127}$/.test(value))
    return fail("unsafe")
  if (key === "d" && !validPath(value)) return fail()
  if (key === "points") {
    const parts = value
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
    if (parts.length > SVG_LIMITS.points * 2) return fail("capacity")
    if (
      parts.length % 2 ||
      parts.some(
        (n) =>
          !numberRegex.test(n) ||
          n.endsWith("%") ||
          !Number.isFinite(Number(n)) ||
          Math.abs(Number(n)) > 1000000,
      )
    )
      return fail()
  }
  if (["transform", "gradientTransform"].includes(key)) {
    const functions = [
      ...value.matchAll(
        /(matrix|translate|scale|rotate|skewX|skewY)\(([^()]*)\)/g,
      ),
    ]
    if (
      value
        .replace(/(matrix|translate|scale|rotate|skewX|skewY)\([^()]*\)/g, "")
        .trim() ||
      functions.length > 64
    )
      return fail()
    for (const [, name, body] of functions) {
      const numbers = body.trim().split(/[\s,]+/)
      const counts: Record<string, number[]> = {
        matrix: [6],
        translate: [1, 2],
        scale: [1, 2],
        rotate: [1, 3],
        skewX: [1],
        skewY: [1],
      }
      if (
        !counts[name].includes(numbers.length) ||
        numbers.some(
          (n) =>
            !numberRegex.test(n) ||
            n.endsWith("%") ||
            !Number.isFinite(Number(n)) ||
            Math.abs(Number(n)) > 1000000,
        )
      )
        return fail()
    }
  }
  if (key === "viewBox") {
    const values = value
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (
      values.length !== 4 ||
      values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1000000) ||
      values[2] <= 0 ||
      values[3] <= 0
    )
      return fail()
  }
  if (
    key === "preserveAspectRatio" &&
    !/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(
      value,
    )
  )
    return fail()
  return undefined
}
export type SvgParseResult = {
  document?: SvgDocument
  diagnostics: SvgDiagnostic[]
}
export function parseSvg(
  text: string,
  documentId = "svg-document",
  timeBudgetMs: number = SVG_LIMITS.timeoutMs,
): SvgParseResult {
  const diagnostics: SvgDiagnostic[] = [],
    started = performance.now()
  const error = (code: SvgDiagnostic["code"], detail: string) => {
    if (diagnostics.length < 20) diagnostics.push({ code, detail })
  }
  if (new TextEncoder().encode(text).length > SVG_LIMITS.bytes)
    return { diagnostics: [{ code: "capacity", detail: "1 MiB" }] }
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text))
    return {
      diagnostics: [
        { code: "unsafe", detail: "DOCTYPE / ENTITY / processing instruction" },
      ],
    }
  const parser = new SaxesParser({ xmlns: true }),
    stack: SvgNode[] = [],
    ids = new Set<string>(),
    document = blankSvgDocument(documentId)
  let count = 0,
    rootSeen = false
  parser.on("error", (e) => {
    throw e
  })
  parser.on("opentag", (tag) => {
    if (performance.now() - started > timeBudgetMs)
      throw new Error("SVG_TIMEOUT")
    if (++count > SVG_LIMITS.nodes || stack.length > SVG_LIMITS.depth)
      throw new Error("SVG_CAPACITY")
    const name = tag.local
    if (tag.prefix || (tag.uri && tag.uri !== svgNamespace))
      error("unsafe", tag.name)
    if (!rootSeen) {
      rootSeen = true
      if (name !== "svg") error("unsupported", "root must be svg")
    } else if (!tags.has(name as SvgTag)) error("unsupported", name)
    const attrs: Record<string, string> = Object.create(null)
    for (const attr of Object.values(tag.attributes)) {
      if (
        (attr.name === "xmlns" && attr.value === svgNamespace) ||
        (attr.name === "xmlns:xlink" &&
          attr.value === "http://www.w3.org/1999/xlink")
      )
        continue
      const key = attr.name === "xlink:href" ? "href" : attr.name
      const diagnostic = svgAttributeDiagnostic(name, key, attr.value.trim())
      if (diagnostic) error(diagnostic.code, diagnostic.detail)
      else attrs[key] = attr.value.trim()
    }
    const node: SvgNode = {
      tag: name as SvgTag,
      id: attrs.id ?? "",
      attrs,
      children: [],
    }
    if (node.id) {
      if (ids.has(node.id)) error("reference", `duplicate ID: ${node.id}`)
      ids.add(node.id)
      delete attrs.id
    }
    if (stack.length) {
      const parent = stack.at(-1)!
      if (
        [
          "title",
          "desc",
          "path",
          "rect",
          "circle",
          "ellipse",
          "line",
          "polyline",
          "polygon",
          "stop",
          "use",
        ].includes(parent.tag)
      )
        error("unsupported", `${parent.tag} > ${name}`)
      parent.children.push(node)
    }
    stack.push(node)
  })
  parser.on("text", (value) => {
    if (!value.trim()) return
    const n = stack.at(-1)
    if (n && ["title", "desc"].includes(n.tag)) n.text = (n.text ?? "") + value
    else error("unsupported", "text outside title / desc")
  })
  parser.on("cdata", (value) => {
    const n = stack.at(-1)
    if (n && ["title", "desc"].includes(n.tag)) n.text = (n.text ?? "") + value
    else error("unsupported", "CDATA")
  })
  parser.on("closetag", () => {
    const n = stack.pop()!
    if (stack.length === 0) {
      document.attrs = n.attrs
      document.nodes = n.children
    }
  })
  try {
    parser.write(text).close()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    error(
      detail === "SVG_TIMEOUT"
        ? "timeout"
        : detail === "SVG_CAPACITY"
          ? "capacity"
          : "xml",
      detail.slice(0, 200),
    )
  }
  if (!rootSeen) error("xml", "empty SVG")
  const size = (value: string | undefined, fallback: number) =>
    value && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0
      ? Number(value)
      : fallback
  const viewBox = document.attrs.viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number) as SvgDocument["viewBox"] | undefined
  document.width = size(document.attrs.width, viewBox?.[2] ?? 24)
  document.height = size(document.attrs.height, viewBox?.[3] ?? 24)
  if (
    [document.attrs.width, document.attrs.height].some(
      (v) => v !== undefined && (!/^\d+(?:\.\d+)?$/.test(v) || Number(v) <= 0),
    )
  )
    error("geometry", "root width / height must be positive unitless numbers")
  document.viewBox = viewBox ?? [0, 0, document.width, document.height]
  delete document.attrs.viewBox
  delete document.attrs.width
  delete document.attrs.height
  let generated = 0
  for (const n of flattenSvgNodes(document.nodes)) {
    if (!n.id) {
      do {
        n.id = `svg-n${++generated}`
      } while (ids.has(n.id))
      ids.add(n.id)
    }
  }
  const byId = new Map(flattenSvgNodes(document.nodes).map((n) => [n.id, n]))
  // Every local reference must exist and its expansion must be acyclic and bounded.
  const references = (n: SvgNode) =>
    Object.entries(n.attrs).flatMap(([key, value]) =>
      key === "href"
        ? [value.slice(1)]
        : /^url\(#[\w.-]+\)$/.test(value)
          ? [value.slice(5, -1)]
          : ["aria-labelledby", "aria-describedby"].includes(key)
            ? value.split(/\s+/)
            : [],
    )
  let expansions = 0
  function check(n: SvgNode, ancestors: Set<string>, depth: number) {
    if (++expansions > SVG_LIMITS.nodes * 4 || depth > SVG_LIMITS.depth) {
      error("capacity", "reference expansion")
      return
    }
    if (ancestors.has(n.id)) {
      error("reference", `cycle: ${n.id}`)
      return
    }
    const path = new Set([...ancestors, n.id])
    for (const id of references(n)) {
      const target = byId.get(id)
      if (!target) error("reference", `missing ID: ${id}`)
      else check(target, path, depth + 1)
    }
    n.children.forEach((child) => check(child, path, depth + 1))
  }
  document.nodes.forEach((n) => check(n, new Set(), 0))
  for (const [key, value] of Object.entries(document.attrs))
    for (const id of key === "aria-labelledby" || key === "aria-describedby"
      ? value.split(/\s+/)
      : /^url\(#[\w.-]+\)$/.test(value)
        ? [value.slice(5, -1)]
        : [])
      if (!byId.has(id)) error("reference", `${key}: missing ID: ${id}`)
  return diagnostics.length ? { diagnostics } : { document, diagnostics }
}
