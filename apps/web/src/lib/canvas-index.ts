import type {
  CanvasDocument,
  CanvasNodeDefinition,
  CanvasIssue,
  CanvasPortDefinition,
} from "./canvas-model"

/** Input identity, rather than revision, is the cache boundary at the caller. */
export function buildCanvasIndexes(
  document: Pick<CanvasDocument, "nodes" | "frames" | "edges">,
  definitions: readonly CanvasNodeDefinition[],
  issues: readonly CanvasIssue[],
) {
  const nodeById = new Map<string, CanvasDocument["nodes"][number]>()
  const frameById = new Map<string, CanvasDocument["frames"][number]>()
  const definitionByType = new Map<string, CanvasNodeDefinition>()
  const issuesByNodeId = new Map<string, CanvasIssue[]>()
  const edgesByNodeId = new Map<string, CanvasDocument["edges"]>()
  const ports = new Map<string, Map<string, CanvasPortDefinition>>()
  // Keep Array.find's first match, including malformed duplicate IDs/types.
  for (const node of document.nodes)
    if (!nodeById.has(node.id)) nodeById.set(node.id, node)
  for (const frame of document.frames)
    if (!frameById.has(frame.id)) frameById.set(frame.id, frame)
  for (const definition of definitions)
    if (!definitionByType.has(definition.type))
      definitionByType.set(definition.type, definition)
  for (const issue of issues) {
    if (!issue.nodeId) continue
    const group = issuesByNodeId.get(issue.nodeId) ?? []
    group.push(issue)
    issuesByNodeId.set(issue.nodeId, group)
  }
  function add(
    id: string,
    edge: CanvasDocument["edges"][number],
    portId: string,
    direction: "input" | "output",
  ) {
    const edges = edgesByNodeId.get(id) ?? []
    edges.push(edge)
    edgesByNodeId.set(id, edges)
    const group = ports.get(id) ?? new Map<string, CanvasPortDefinition>()
    // First position, latest payload; same-port input/output remains compatible.
    group.set(portId, { id: portId, label: portId, direction, type: "string" })
    ports.set(id, group)
  }
  for (const edge of document.edges) {
    add(edge.source, edge, edge.sourcePort, "output")
    // The original source-first expression represented self loops as output.
    if (edge.target !== edge.source)
      add(edge.target, edge, edge.targetPort, "input")
  }
  const fallbackPortsByNodeId = new Map(
    [...ports].map(([id, values]) => [id, [...values.values()]]),
  )
  return {
    nodeById,
    frameById,
    definitionByType,
    issuesByNodeId,
    edgesByNodeId,
    fallbackPortsByNodeId,
  }
}
