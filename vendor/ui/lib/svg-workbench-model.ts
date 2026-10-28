/** Portable SVG V1 document. Editors and services keep their own state. */
export const SVG_LIMITS = {
  bytes: 1024 * 1024,
  nodes: 2000,
  depth: 32,
  path: 65536,
  points: 10000,
  timeoutMs: 5000,
} as const
export type SvgTag =
  | "g"
  | "rect"
  | "circle"
  | "ellipse"
  | "line"
  | "polyline"
  | "polygon"
  | "path"
  | "defs"
  | "linearGradient"
  | "radialGradient"
  | "stop"
  | "use"
  | "title"
  | "desc"
export type IconSource = {
  collection: string
  iconName: string
  style: string
  repository: string
  commit: string
  assetPath: string
  licenseRef: string
  license: string
  modified: boolean
  assetSha256?: string
  licenseText?: string
  notice?: string
  usage?: { package: string; version: string; component: string }
}
export type SvgNode = {
  id: string
  tag: SvgTag
  attrs: Record<string, string>
  children: SvgNode[]
  text?: string
  locked?: boolean
  sourceIds?: string[]
}
export type SvgDocument = {
  schemaVersion: 1
  documentId: string
  revision: number
  width: number
  height: number
  viewBox: [number, number, number, number]
  attrs: Record<string, string>
  nodes: SvgNode[]
  sources: IconSource[]
}
export type SvgTool =
  | "select"
  | "pan"
  | "rect"
  | "circle"
  | "ellipse"
  | "line"
  | "polyline"
  | "polygon"
export type SvgEditorState = {
  selectedIds: string[]
  tool: SvgTool
  zoom: number
  pan: { x: number; y: number }
}
export type SvgDiagnostic = {
  code:
    | "xml"
    | "unsupported"
    | "unsafe"
    | "capacity"
    | "reference"
    | "geometry"
    | "timeout"
  detail: string
}
export type SourceDraft = {
  text: string
  baseRevision: number
  dirty: boolean
  diagnostics: SvgDiagnostic[]
}
export type EditCommand =
  | {
      type: "transaction"
      commands: Exclude<EditCommand, { type: "transaction" }>[]
    }
  | { type: "add"; nodes: SvgNode[]; sources?: IconSource[] }
  | {
      type: "update"
      ids: string[]
      attrs?: Record<string, string>
      locked?: boolean
    }
  | { type: "remove"; ids: string[] }
  | { type: "reorder"; id: string; direction: -1 | 1 }
  | {
      type: "move"
      sourceId: string
      targetId: string
      position: "before" | "after" | "inside"
    }
  | { type: "group"; ids: string[]; id: string }
  | { type: "ungroup"; id: string }
  | { type: "transform"; ids: string[]; transform: string }
  | { type: "replace"; document: SvgDocument }
  | {
      type: "canvas"
      width: number
      height: number
      viewBox: SvgDocument["viewBox"]
    }

export function blankSvgDocument(documentId = "svg-document"): SvgDocument {
  return {
    schemaVersion: 1,
    documentId,
    revision: 0,
    width: 24,
    height: 24,
    viewBox: [0, 0, 24, 24],
    attrs: {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
    nodes: [],
    sources: [],
  }
}
export function flattenSvgNodes(nodes: readonly SvgNode[]): SvgNode[] {
  return nodes.flatMap((n) => [n, ...flattenSvgNodes(n.children)])
}
export function findSvgNode(document: SvgDocument, id: string) {
  return flattenSvgNodes(document.nodes).find((n) => n.id === id)
}
export function editableSvgIds(document: SvgDocument): Set<string> {
  const ids = new Set<string>()
  function visit(nodes: SvgNode[], blocked: boolean) {
    for (const n of nodes) {
      const locked =
        blocked ||
        Boolean(n.locked) ||
        [
          "defs",
          "title",
          "desc",
          "linearGradient",
          "radialGradient",
          "stop",
        ].includes(n.tag)
      if (!locked) ids.add(n.id)
      visit(n.children, locked)
    }
  }
  visit(document.nodes, false)
  return ids
}
export function topSvgSelection(
  document: SvgDocument,
  ids: string[],
): string[] {
  const selected = new Set(ids),
    result: string[] = []
  function visit(nodes: SvgNode[], selectedParent: boolean) {
    for (const n of nodes) {
      if (selected.has(n.id) && !selectedParent) result.push(n.id)
      visit(n.children, selectedParent || selected.has(n.id))
    }
  }
  visit(document.nodes, false)
  return result
}
export function applySvgCommand(
  document: SvgDocument,
  command: EditCommand,
): SvgDocument {
  if (command.type === "transaction") {
    const result = command.commands.reduce(applySvgCommand, document)
    return result === document
      ? document
      : { ...result, revision: document.revision + 1 }
  }
  const next = structuredClone(document),
    editable = editableSvgIds(document)
  const valid = (ids: string[]) =>
    topSvgSelection(document, ids).filter((id) => editable.has(id))
  let changed = false
  const walk = (
    nodes: SvgNode[],
    update: (node: SvgNode, siblings: SvgNode[], index: number) => void,
  ) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      walk(n.children, update)
      update(n, nodes, i)
    }
  }
  if (command.type === "replace")
    return {
      ...structuredClone(command.document),
      documentId: document.documentId,
      revision: document.revision + 1,
    }
  if (command.type === "canvas") {
    Object.assign(next, command)
    delete (next as unknown as Record<string, unknown>).type
    changed = true
  }
  if (command.type === "add") {
    const ids = new Set(flattenSvgNodes(next.nodes).map((n) => n.id))
    if (
      flattenSvgNodes(command.nodes).some((n) => ids.has(n.id)) ||
      ids.size + flattenSvgNodes(command.nodes).length > SVG_LIMITS.nodes
    )
      return document
    next.nodes.push(...structuredClone(command.nodes))
    next.sources = [
      ...next.sources,
      ...(command.sources ?? []).filter(
        (s) => !next.sources.some((old) => sourceKey(old) === sourceKey(s)),
      ),
    ]
    changed = command.nodes.length > 0
  }
  if (
    command.type === "update" ||
    command.type === "transform" ||
    command.type === "remove"
  ) {
    const ids = new Set(
      command.type === "update" && command.locked !== undefined
        ? command.ids
        : valid(command.ids),
    )
    walk(next.nodes, (n, siblings, index) => {
      if (!ids.has(n.id)) return
      if (command.type === "remove") siblings.splice(index, 1)
      else if (command.type === "transform")
        n.attrs.transform =
          `${command.transform} ${n.attrs.transform ?? ""}`.trim()
      else {
        if (command.attrs && !editable.has(n.id)) return
        Object.assign(n.attrs, command.attrs)
        if (command.locked !== undefined) n.locked = command.locked
      }
      changed = true
    })
  }
  if (command.type === "reorder" && editable.has(command.id))
    walk(next.nodes, (n, siblings, index) => {
      if (changed || n.id !== command.id) return
      const target = index + command.direction
      if (target >= 0 && target < siblings.length) {
        ;[siblings[index], siblings[target]] = [
          siblings[target],
          siblings[index],
        ]
        changed = true
      }
    })
  if (
    command.type === "move" &&
    editable.has(command.sourceId) &&
    editable.has(command.targetId)
  ) {
    const source = findSvgNode(next, command.sourceId),
      target = findSvgNode(next, command.targetId)
    // Cross-parent moves require matrix conversion; keep reordering within a parent.
    walk(next.nodes, (n, siblings) => {
      if (
        n.id !== command.sourceId ||
        !source ||
        !target ||
        !siblings.includes(target) ||
        command.position === "inside"
      )
        return
      siblings.splice(siblings.indexOf(source), 1)
      siblings.splice(
        siblings.indexOf(target) + (command.position === "after" ? 1 : 0),
        0,
        source,
      )
      changed = true
    })
  }
  if (command.type === "group") {
    const ids = valid(command.ids),
      selected = new Set(ids)
    const group = (nodes: SvgNode[]) => {
      const members = nodes.filter((n) => selected.has(n.id))
      if (
        members.length === ids.length &&
        members.length > 1 &&
        !findSvgNode(next, command.id)
      ) {
        const index = nodes.indexOf(members[0])
        nodes.splice(
          0,
          nodes.length,
          ...nodes.filter((n) => !selected.has(n.id)),
        )
        nodes.splice(index, 0, {
          id: command.id,
          tag: "g",
          attrs: {},
          children: members,
        })
        changed = true
        return
      }
      nodes.forEach((n) => group(n.children))
    }
    group(next.nodes)
  }
  if (command.type === "ungroup" && editable.has(command.id))
    walk(next.nodes, (n, siblings, index) => {
      if (n.id !== command.id || n.tag !== "g") return
      // Preserve presentation inheritance and transform order when dissolving a group.
      const children = n.children.map((child) => ({
        ...child,
        attrs: {
          ...n.attrs,
          ...child.attrs,
          ...(n.attrs.transform
            ? {
                transform:
                  `${n.attrs.transform} ${child.attrs.transform ?? ""}`.trim(),
              }
            : {}),
        },
      }))
      if (n.attrs.opacity && Number(n.attrs.opacity) !== 1) return // group compositing cannot be distributed losslessly
      siblings.splice(index, 1, ...children)
      changed = true
    })
  if (!changed) return document
  if (
    command.type !== "add" &&
    !(
      command.type === "update" &&
      command.locked !== undefined &&
      !command.attrs
    )
  )
    next.sources = next.sources.map((s) => ({ ...s, modified: true }))
  // A composition is no longer reproducible by one original library import.
  if (command.type === "add" && document.nodes.length)
    next.sources = next.sources.map((s) => ({ ...s, modified: true }))
  next.revision = document.revision + 1
  return next
}
export function sourceKey(s: IconSource) {
  return `${s.collection}:${s.commit}:${s.assetPath}`
}
export function uniqueSvgId(document: SvgDocument, base: string): string {
  const ids = flattenSvgNodes(document.nodes).map((node) => node.id)
  let value = base,
    suffix = 0
  while (ids.some((id) => id === value || id.startsWith(`${value}-`)))
    value = `${base}-${++suffix}`
  return value
}
/** Rewrite references by attribute semantics; a paint color is not an ID reference. */
export function svgScopedValue(
  key: string,
  value: string,
  id: (value: string) => string,
): string {
  if (key === "href") return `#${id(value.slice(1))}`
  if (key === "aria-labelledby" || key === "aria-describedby")
    return value.trim().split(/\s+/).map(id).join(" ")
  return value.replace(
    /url\(#([\w.-]+)\)/g,
    (_, target: string) => `url(#${id(target)})`,
  )
}
export function svgPaintValue(
  document: SvgDocument,
  id: string,
  key: string,
): string {
  const defaults: Record<string, string> = {
    fill: "black",
    stroke: "none",
    "stroke-width": "1",
    opacity: "1",
  }
  const walk = (nodes: SvgNode[], inherited: string): string | undefined => {
    for (const node of nodes) {
      const value = node.attrs[key] ?? (key === "opacity" ? "1" : inherited)
      if (node.id === id) return value
      const found = walk(node.children, value)
      if (found !== undefined) return found
    }
  }
  return walk(document.nodes, document.attrs[key] ?? defaults[key] ?? "") ?? ""
}
export function copySvgNodes(document: SvgDocument, prefix: string): SvgNode[] {
  const map = new Map(
    flattenSvgNodes(document.nodes).map((n) => [n.id, `${prefix}-${n.id}`]),
  )
  const copy = (n: SvgNode): SvgNode => ({
    ...structuredClone(n),
    id: map.get(n.id)!,
    attrs: Object.fromEntries(
      Object.entries(n.attrs).map(([key, value]) => [
        key,
        svgScopedValue(key, value, (id) => map.get(id) ?? id),
      ]),
    ),
    sourceIds: document.sources.map(sourceKey),
    children: n.children.map(copy),
  })
  // Keep root presentation on the inserted copy, not on the surrounding document.
  return [
    {
      id: `${prefix}-root`,
      tag: "g",
      attrs: Object.fromEntries(
        Object.entries({
          fill: "black",
          stroke: "none",
          ...document.attrs,
        }).map(([key, value]) => [
          key,
          svgScopedValue(key, value, (id) => map.get(id) ?? id),
        ]),
      ),
      children: document.nodes.map(copy),
      sourceIds: document.sources.map(sourceKey),
    },
  ]
}
export const svgReactAttribute = (key: string): string =>
  key.startsWith("aria-")
    ? key
    : ({ "xlink:href": "href", "xml:space": "xmlSpace" }[key] ??
      key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()))
const xmlEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/>/g, "&gt;")
export function serializeSvg(document: SvgDocument): string {
  const attrs = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
      .join("")
  const node = (n: SvgNode): string =>
    `<${n.tag}${attrs({ id: n.id, ...n.attrs })}>${xmlEscape(n.text ?? "")}${n.children.map(node).join("")}</${n.tag}>`
  const notice = document.sources.length
    ? `<!-- ${JSON.stringify(document.sources).replace(/-{2,}/g, (run) => run.split("").join(" "))} -->\n`
    : ""
  return (
    notice +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${document.width}" height="${document.height}" viewBox="${document.viewBox.join(" ")}"${attrs(document.attrs)}>${document.nodes.map(node).join("")}</svg>`
  )
}
/** Structured code generation for the validated V1 AST, not a text replacement converter. */
export function svgToTsx(document: SvgDocument): string {
  const provenance = JSON.stringify(document.sources).replace(/\*\//g, "* /")
  // useId prevents references from colliding when consumers mount several copies.
  const dynamicProps = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([k, v]) => {
        let expression = JSON.stringify(v)
        if (k === "id") expression = `prefix + ${JSON.stringify(`-${v}`)}`
        else if (k === "href")
          expression = `"#" + prefix + ${JSON.stringify(`-${v.slice(1)}`)}`
        else if (k === "aria-labelledby" || k === "aria-describedby")
          expression = v
            .trim()
            .split(/\s+/)
            .map((id) => `prefix + ${JSON.stringify(`-${id}`)}`)
            .join(' + " " + ')
        else if (/^url\(#[\w.-]+\)$/.test(v))
          expression = `"url(#" + prefix + ${JSON.stringify(`-${v.slice(5, -1)})`)}`
        return ` ${svgReactAttribute(k)}={${expression}}`
      })
      .join("")
  const scopedNode = (n: SvgNode): string =>
    `<${n.tag}${dynamicProps({ id: n.id, ...n.attrs })}>${n.text ? `{${JSON.stringify(n.text)}}` : ""}${n.children.map(scopedNode).join("")}</${n.tag}>`
  return `import { useId, type SVGProps } from "react";\n/** Sources: ${provenance} */\nexport default function SvgArtwork(props: SVGProps<SVGSVGElement>) {\n  const prefix = useId().replace(/:/g, "");\n  return <svg xmlns="http://www.w3.org/2000/svg" width={${document.width}} height={${document.height}} viewBox={${JSON.stringify(document.viewBox.join(" "))}}${dynamicProps(document.attrs)} {...props}>${document.nodes.map(scopedNode).join("")}</svg>;\n}\n`
}
export function originalIconUsage(document: SvgDocument): string | undefined {
  const source = document.sources.length === 1 ? document.sources[0] : undefined
  if (!source?.usage || source.modified) return undefined
  const u = source.usage
  return `// Verified against ${u.package}@${u.version}\nimport { ${u.component} } from ${JSON.stringify(u.package)};\n<${u.component} size={${document.width}} />;`
}
