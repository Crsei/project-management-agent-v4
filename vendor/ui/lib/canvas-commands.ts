import {
  uiMessage,
  uiTextFields,
  uiTextError,
  UiError,
  type UiText,
  type UiMessage,
} from "./i18n-core.ts"
import {
  canvasId,
  canvasLimits,
  emptyCanvasSelection,
  type CanvasCommand,
  type CanvasConnectionPolicy,
  type CanvasDocument,
  type CanvasFragment,
  type CanvasNodeDefinition,
  type CanvasSelection,
} from "./canvas-model.ts"
import {
  parseCanvasDocument,
  describeValidateCanvasConnection,
  describeValidateCanvasConfig,
  describeValidateCanvasVariable,
} from "./canvas-validation.ts"

export type CanvasCommandResult = {
  ok: boolean
  document: CanvasDocument
  selection: CanvasSelection
  message: string
  messageI18n?: UiMessage
}
export function copyCanvasFragment(
  document: CanvasDocument,
  nodeIds: string[],
): CanvasFragment {
  const ids = new Set(nodeIds)
  return structuredClone({
    nodes: document.nodes.filter((node) => ids.has(node.id)),
    edges: document.edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    ),
  })
}
/** No mutation, no network, no execution. A failed command always returns the original document. */
export function applyCanvasCommand(
  document: CanvasDocument,
  command: CanvasCommand,
  definitions: CanvasNodeDefinition[],
  options?: { readOnly?: boolean; policy?: CanvasConnectionPolicy },
): CanvasCommandResult {
  const fail = (message: UiText): CanvasCommandResult => ({
    ok: false,
    document,
    selection: emptyCanvasSelection,
    ...uiTextFields(message),
  })
  if (options?.readOnly)
    return fail(uiMessage("canvasCommands.theCanvasIsReadOnlyTheDocumentWas"))
  let next = structuredClone(document)
  let selection = emptyCanvasSelection
  const connect = (
    edge: CanvasDocument["edges"][number],
    ignoreId?: string,
  ) => {
    const error = describeValidateCanvasConnection(
      next,
      definitions,
      edge,
      ignoreId,
      options?.policy,
    )
    if (error) throw uiTextError(error)
  }
  const needNode = (id: string) => {
    const node = next.nodes.find((item) => item.id === id)
    if (!node)
      throw uiTextError(uiMessage("canvasCommands.theNodeNoLongerExists"))
    return node
  }
  try {
    switch (command.type) {
      case "add":
        next.nodes.push(structuredClone(command.node))
        selection = { nodeIds: [command.node.id], edgeIds: [] }
        break
      case "move":
        for (const [id, position] of Object.entries(command.positions))
          needNode(id).position = { ...position }
        break
      case "delete": {
        const ids = new Set(command.selection.nodeIds)
        next.nodes = next.nodes.filter((node) => !ids.has(node.id))
        next.edges = next.edges.filter(
          (edge) =>
            !ids.has(edge.source) &&
            !ids.has(edge.target) &&
            !command.selection.edgeIds.includes(edge.id),
        )
        break
      }
      case "configure": {
        const node = needNode(command.nodeId)
        if (!definitions.some((definition) => definition.type === node.type))
          throw uiTextError(
            uiMessage(
              "canvasCommands.unknownNodesCannotBeConfiguredOriginalDataIs",
            ),
          )
        Object.assign(node, {
          title: command.title,
          config: structuredClone(command.config),
          bindings: structuredClone(command.bindings ?? {}),
        })
        const configErrors = Object.values(
          describeValidateCanvasConfig(
            node,
            definitions.find((definition) => definition.type === node.type)!,
          ),
        )
        for (const [field, reference] of Object.entries(node.bindings ?? {})) {
          const error = describeValidateCanvasVariable(
            next,
            definitions,
            node,
            field,
            reference,
          )
          if (error) configErrors.push(error)
        }
        if (configErrors.length) throw uiTextError(configErrors[0])
        selection = { nodeIds: [node.id], edgeIds: [] }
        break
      }
      case "connect":
        connect(command.edge)
        next.edges.push(structuredClone(command.edge))
        selection = { nodeIds: [], edgeIds: [command.edge.id] }
        break
      case "reconnect": {
        const index = next.edges.findIndex((edge) => edge.id === command.edgeId)
        if (index < 0)
          throw uiTextError(uiMessage("canvasCommands.theEdgeNoLongerExists"))
        const edge = { ...command.edge, id: command.edgeId }
        connect(edge, command.edgeId)
        next.edges[index] = edge
        selection = { nodeIds: [], edgeIds: [edge.id] }
        break
      }
      case "insert": {
        const edge = next.edges.find((item) => item.id === command.edgeId)
        if (!edge)
          throw uiTextError(uiMessage("canvasCommands.theEdgeNoLongerExists"))
        next.nodes.push(structuredClone(command.node))
        next.edges = next.edges.filter((item) => item.id !== edge.id)
        const first = {
          id: canvasId("edge"),
          source: edge.source,
          sourcePort: edge.sourcePort,
          target: command.node.id,
          targetPort: command.inputPort,
          label: edge.label,
        }
        const second = {
          id: canvasId("edge"),
          source: command.node.id,
          sourcePort: command.outputPort,
          target: edge.target,
          targetPort: edge.targetPort,
        }
        connect(first)
        next.edges.push(first)
        connect(second)
        next.edges.push(second)
        selection = { nodeIds: [command.node.id], edgeIds: [] }
        break
      }
      case "paste": {
        if (!command.fragment.nodes.length)
          throw uiTextError(
            uiMessage("canvasCommands.noNodesHaveBeenCopiedYet"),
          )
        const ids = new Map(
          command.fragment.nodes.map((node) => [node.id, canvasId("node")]),
        )
        const offset = command.offset ?? { x: 40, y: 40 }
        for (const original of command.fragment.nodes) {
          const node = structuredClone(original)
          node.id = ids.get(original.id)!
          node.position = {
            x: node.position.x + offset.x,
            y: node.position.y + offset.y,
          }
          delete node.parentId
          for (const reference of Object.values(node.bindings ?? {})) {
            const remapped = ids.get(reference.nodeId)
            if (!remapped)
              throw uiTextError(
                uiMessage(
                  "canvasCommands.theCopiedContentReferencesExternalVariablesCopyThe",
                ),
              )
            reference.nodeId = remapped
          }
          next.nodes.push(node)
        }
        for (const edge of command.fragment.edges) {
          const source = ids.get(edge.source),
            target = ids.get(edge.target)
          if (!source || !target)
            throw uiTextError(
              uiMessage("canvasCommands.theCopiedContentContainsExternalEdges"),
            )
          const copied = { ...edge, id: canvasId("edge"), source, target }
          connect(copied)
          next.edges.push(copied)
        }
        selection = { nodeIds: [...ids.values()], edgeIds: [] }
        break
      }
      case "frame":
        next.frames.push(structuredClone(command.frame))
        for (const id of command.nodeIds)
          needNode(id).parentId = command.frame.id
        selection = { nodeIds: [], edgeIds: [], frameId: command.frame.id }
        break
      case "move-frame": {
        const frame = next.frames.find((item) => item.id === command.frameId)
        if (!frame)
          throw uiTextError(uiMessage("canvasCommands.theFrameNoLongerExists"))
        const dx = command.position.x - frame.position.x,
          dy = command.position.y - frame.position.y
        frame.position = { ...command.position }
        for (const node of next.nodes.filter(
          (item) => item.parentId === frame.id,
        ))
          node.position = { x: node.position.x + dx, y: node.position.y + dy }
        break
      }
      case "delete-frame":
        next.frames = next.frames.filter((item) => item.id !== command.frameId)
        for (const node of next.nodes)
          if (node.parentId === command.frameId) delete node.parentId
        break
      case "note":
        next.notes.push(structuredClone(command.note))
        selection = { nodeIds: [], edgeIds: [], noteId: command.note.id }
        break
      case "update-note": {
        const note = next.notes.find((item) => item.id === command.noteId)
        if (!note)
          throw uiTextError(uiMessage("canvasCommands.theNoteNoLongerExists"))
        note.text = command.text
        break
      }
      case "move-note": {
        const note = next.notes.find((item) => item.id === command.noteId)
        if (!note)
          throw uiTextError(uiMessage("canvasCommands.theNoteNoLongerExists"))
        note.position = { ...command.position }
        break
      }
      case "delete-note":
        next.notes = next.notes.filter((item) => item.id !== command.noteId)
        break
      case "replace":
        next = parseCanvasDocument(
          JSON.stringify(command.document),
          definitions,
          options?.policy,
        )
        break
    }
    // Missing bindings remain diagnostics after a source deletion, while structural corruption is rejected.
    next = parseCanvasDocument(
      JSON.stringify(next),
      definitions,
      options?.policy,
      { allowInvalidBindings: true },
    )
    if (JSON.stringify(next) === JSON.stringify(document))
      return fail(uiMessage("canvasCommands.theDocumentHasNotChanged"))
    next.revision = document.revision + 1
    return {
      ok: true,
      document: next,
      selection,
      ...uiTextFields(uiMessage("canvasCommands.localDraftChanged")),
    }
  } catch (error) {
    return fail(
      error instanceof UiError
        ? error.messageI18n
        : error instanceof Error
          ? error.message
          : uiMessage("canvasCommands.editDidNotCompleteTheOriginalGraphIs"),
    )
  }
}

export type CanvasHistory = {
  document: CanvasDocument
  past: CanvasDocument[]
  future: CanvasDocument[]
}
export function createCanvasHistory(document: CanvasDocument): CanvasHistory {
  return { document: structuredClone(document), past: [], future: [] }
}
export function commitCanvasHistory(
  history: CanvasHistory,
  document: CanvasDocument,
): CanvasHistory {
  return {
    document,
    past: [...history.past, history.document].slice(-canvasLimits.history),
    future: [],
  }
}
export function stepCanvasHistory(
  history: CanvasHistory,
  direction: "undo" | "redo",
): CanvasHistory {
  const source = direction === "undo" ? history.past : history.future
  const target = source.at(-1)
  if (!target) return history
  const document = {
    ...structuredClone(target),
    revision: history.document.revision + 1,
  }
  return direction === "undo"
    ? {
        document,
        past: source.slice(0, -1),
        future: [...history.future, history.document],
      }
    : {
        document,
        future: source.slice(0, -1),
        past: [...history.past, history.document].slice(-canvasLimits.history),
      }
}
