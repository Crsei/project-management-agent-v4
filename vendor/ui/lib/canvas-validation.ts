import {
  uiMessage,
  uiTextFields,
  uiTextError,
  resolveUiText,
  defaultLocale,
  type UiText,
} from "./i18n-core.ts"
import { describeCanvasFieldProblem } from "./canvas-config.ts"
import {
  canvasLimits,
  type CanvasConnectionPolicy,
  type CanvasDocument,
  type CanvasEdgeRecord,
  type CanvasIssue,
  type CanvasNodeDefinition,
  type CanvasNodeRecord,
  type CanvasVariable,
} from "./canvas-model.ts"
import { redact } from "./redact.ts"

export function upstreamCanvasNodes(
  document: CanvasDocument,
  targetId: string,
): Set<string> {
  const seen = new Set<string>()
  const pending = [targetId]
  while (pending.length) {
    const id = pending.pop()!
    for (const edge of document.edges)
      if (edge.target === id && !seen.has(edge.source)) {
        seen.add(edge.source)
        pending.push(edge.source)
      }
  }
  seen.delete(targetId)
  return seen
}

export function describeValidateCanvasConnection(
  document: CanvasDocument,
  definitions: CanvasNodeDefinition[],
  edge: CanvasEdgeRecord,
  ignoreId?: string,
  policy?: CanvasConnectionPolicy,
): UiText | undefined {
  const source = document.nodes.find((node) => node.id === edge.source)
  const target = document.nodes.find((node) => node.id === edge.target)
  if (!source || !target)
    return uiMessage("canvasValidation.theConnectionReferencesAMissingNode")
  if (source.id === target.id)
    return uiMessage("canvasValidation.nodesCannotConnectToThemselves")
  const other = document.edges.filter((item) => item.id !== ignoreId)
  if (
    other.some(
      (item) =>
        item.source === edge.source &&
        item.sourcePort === edge.sourcePort &&
        item.target === edge.target &&
        item.targetPort === edge.targetPort,
    )
  )
    return uiMessage("canvasValidation.thesePortsAreAlreadyConnected")
  if (
    upstreamCanvasNodes({ ...document, edges: other }, source.id).has(target.id)
  )
    return uiMessage(
      "canvasValidation.thisConnectionWouldCreateACycleTheCanvas",
    )
  const sourceDefinition = definitions.find((item) => item.type === source.type)
  const targetDefinition = definitions.find((item) => item.type === target.type)
  const output = sourceDefinition?.ports.find(
    (port) => port.id === edge.sourcePort,
  )
  const input = targetDefinition?.ports.find(
    (port) => port.id === edge.targetPort,
  )
  if ((sourceDefinition && !output) || (targetDefinition && !input))
    return uiMessage("canvasValidation.theConnectionReferencesAMissingPort")
  if (
    (output && output.direction !== "output") ||
    (input && input.direction !== "input")
  )
    return uiMessage("canvasValidation.connectionDirectionMustBeOutputInput")
  if (!output || !input)
    return uiMessage(
      "canvasValidation.unknownNodeDefinitionItsConnectionsCannotBeEdited",
    )
  try {
    if (!(policy ? policy(output, input) : output.type === input.type))
      return uiMessage("common.incompatiblePortTypesValueValue", {
        value0: output.type,
        value1: input.type,
      })
  } catch {
    return uiMessage(
      "canvasValidation.theConnectionPolicyCouldNotCompleteValidation",
    )
  }
  if (
    output.maxConnections !== undefined &&
    other.filter(
      (item) => item.source === source.id && item.sourcePort === output.id,
    ).length >= output.maxConnections
  )
    return uiMessage("canvasValidation.theSourcePortReachedItsConnectionLimit")
  if (
    input.maxConnections !== undefined &&
    other.filter(
      (item) => item.target === target.id && item.targetPort === input.id,
    ).length >= input.maxConnections
  )
    return uiMessage("canvasValidation.theTargetPortReachedItsConnectionLimit")
}

export function describeValidateCanvasVariable(
  document: CanvasDocument,
  definitions: CanvasNodeDefinition[],
  target: CanvasNodeRecord,
  field: string,
  reference: CanvasVariable,
): UiText | undefined {
  const source = document.nodes.find((node) => node.id === reference.nodeId)
  if (!source)
    return uiMessage("canvasValidation.theVariableSourceNodeNoLongerExists")
  const port = definitions
    .find((item) => item.type === source.type)
    ?.ports.find(
      (item) => item.id === reference.portId && item.direction === "output",
    )
  if (!port)
    return uiMessage("canvasValidation.theSourceOutputPortIsMissingOrIts")
  if (port.type !== reference.type)
    return uiMessage(
      "canvasValidation.theVariableSourceTypeChangedSelectItAgain",
    )
  const targetField = definitions
    .find((item) => item.type === target.type)
    ?.fields?.find((item) => item.key === field)
  if (!targetField?.variableType)
    return uiMessage(
      "canvasValidation.thisConfigurationFieldDoesNotAcceptVariables",
    )
  const expected = targetField.variableType
  if (expected && expected !== reference.type)
    return uiMessage("common.theFieldRequiresValueButTheVariableIs", {
      value0: expected,
      value1: reference.type,
    })
  if (!upstreamCanvasNodes(document, target.id).has(source.id))
    return uiMessage(
      "canvasValidation.theVariableSourceIsNotReachableUpstreamOf",
    )
}

export function describeValidateCanvasConfig(
  node: CanvasNodeRecord,
  definition: CanvasNodeDefinition,
): Record<string, UiText> {
  const errors: Record<string, UiText> = {}
  for (const field of definition.fields ?? []) {
    if (node.bindings?.[field.key]) continue
    const value = node.config[field.key]
    if (value === undefined || value === "" || value === null) {
      if (field.required)
        errors[field.key] = uiMessage("common.valueCannotBeEmpty", {
          value0: field.labelI18n ?? field.label,
        })
      continue
    }
    const structuredProblem = describeCanvasFieldProblem(
      field.kind,
      node.config[field.key],
    )
    if (structuredProblem)
      errors[field.key] = uiMessage("canvas.problemContext", {
        context: field.labelI18n ?? field.label,
        problem: structuredProblem,
      })
    if (
      field.kind === "number" &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max))
    )
      errors[field.key] = uiMessage("common.valueRequiresAValidNumberValue", {
        value0: field.labelI18n ?? field.label,
        value1:
          field.min !== undefined || field.max !== undefined
            ? uiMessage("canvas.numberRange", {
                min: field.min ?? uiMessage("canvas.unbounded"),
                max: field.max ?? uiMessage("canvas.unbounded"),
              })
            : "",
      })
    if (
      ["text", "textarea", "select", "code", "expression"].includes(
        field.kind,
      ) &&
      typeof value !== "string"
    )
      errors[field.key] = uiMessage("common.valueRequiresText", {
        value0: field.labelI18n ?? field.label,
      })
    if (
      field.kind === "select" &&
      !field.options?.some((option) => option.value === value)
    )
      errors[field.key] = uiMessage("common.valueIsOutsideTheAllowedOptions", {
        value0: field.labelI18n ?? field.label,
      })
  }
  try {
    for (const [index, message] of (
      definition.validate?.(node) ?? []
    ).entries())
      errors[`custom-${index}`] = message
  } catch {
    errors.custom = uiMessage(
      "canvasValidation.theNodeValidatorCouldNotCompleteValidation",
    )
  }
  return errors
}

export function validateCanvasDocument(
  document: CanvasDocument,
  definitions: CanvasNodeDefinition[],
  policy?: CanvasConnectionPolicy,
): CanvasIssue[] {
  const issues: CanvasIssue[] = []
  for (const node of document.nodes) {
    const definition = definitions.find((item) => item.type === node.type)
    if (!definition) {
      issues.push({
        code: "unknown-type",
        severity: "warning",
        nodeId: node.id,
        ...uiTextFields(
          uiMessage("common.valueUnknownNodeTypeValueOriginalDataPreserved", {
            value0: node.title,
            value1: node.type,
          }),
        ),
      })
      continue
    }
    for (const message of Object.values(
      describeValidateCanvasConfig(node, definition),
    ))
      issues.push({
        code: "config",
        severity: "warning",
        nodeId: node.id,
        ...uiTextFields(message),
      })
    for (const port of definition.ports.filter(
      (item) => item.direction === "input" && item.required,
    ))
      if (
        !document.edges.some(
          (edge) => edge.target === node.id && edge.targetPort === port.id,
        )
      )
        issues.push({
          code: "required-port",
          severity: "warning",
          nodeId: node.id,
          portId: port.id,
          ...uiTextFields(
            uiMessage("common.valueRequiredInputValueIsNotConnected", {
              value0: node.title,
              value1: port.labelI18n ?? port.label,
            }),
          ),
        })
    for (const [field, reference] of Object.entries(node.bindings ?? {})) {
      const message = describeValidateCanvasVariable(
        document,
        definitions,
        node,
        field,
        reference,
      )
      if (message)
        issues.push({
          code: "variable",
          severity: "error",
          nodeId: node.id,
          ...uiTextFields(
            uiMessage("canvas.problemContext", {
              context: `${node.title} / ${field}`,
              problem: message,
            }),
          ),
        })
    }
  }
  for (const edge of document.edges) {
    const message = describeValidateCanvasConnection(
      document,
      definitions,
      edge,
      edge.id,
      policy,
    )
    if (message)
      issues.push({
        code:
          typeof message !== "string" &&
          message.key ===
            "canvasValidation.unknownNodeDefinitionItsConnectionsCannotBeEdited"
            ? "unknown-port"
            : "connection",
        severity:
          typeof message !== "string" &&
          message.key ===
            "canvasValidation.unknownNodeDefinitionItsConnectionsCannotBeEdited"
            ? "warning"
            : "error",
        edgeId: edge.id,
        nodeId: edge.target,
        ...uiTextFields(message),
      })
  }
  return issues
}

function object(value: unknown, name: UiText): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw uiTextError(uiMessage("common.valueMustBeAnObject", { value0: name }))
  return value as Record<string, unknown>
}
function text(value: unknown, name: UiText, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw uiTextError(
      uiMessage("common.valueRequiresNonemptyTextUpToValueCharacters", {
        value0: name,
        value1: max,
      }),
    )
  return value
}
function id(value: unknown, name: UiText): string {
  const result = text(value, name, 128)
  if (!/^[\w][\w-]*$/.test(result))
    throw uiTextError(
      uiMessage("common.valueSupportsOnlyLettersNumbersUnderscoresAndHyphens", {
        value0: name,
      }),
    )
  return result
}
function number(
  value: unknown,
  name: UiText,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw uiTextError(
      uiMessage("common.valueIsOutsideTheValidRange", { value0: name }),
    )
  return value
}
function point(value: unknown, name: UiText) {
  const p = object(value, name)
  number(p.x, uiMessage("canvas.propertyPath", { name, path: "x" }), -1e6, 1e6)
  number(p.y, uiMessage("canvas.propertyPath", { name, path: "y" }), -1e6, 1e6)
}
function keys(value: Record<string, unknown>, allowed: string[], name: UiText) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw uiTextError(
        uiMessage("common.valueDoesNotSupportFieldValuePutExtension", {
          value0: name,
          value1: key,
        }),
      )
}
function safeValue(value: unknown, depth = 0) {
  if (depth > 20)
    throw uiTextError(uiMessage("canvasValidation.jsonNestingExceeds20Levels"))
  if (typeof value === "number" && !Number.isFinite(value))
    throw uiTextError(
      uiMessage("canvasValidation.jsonContainsANonfiniteNumber"),
    )
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw uiTextError(
          uiMessage("canvasValidation.jsonContainsAnUnsafeField"),
        )
      safeValue(child, depth + 1)
    }
}
/** Checks an untrusted JSON payload before it can reach the engine or replace a draft. */
export function parseCanvasDocument(
  json: string,
  definitions: CanvasNodeDefinition[],
  policy?: CanvasConnectionPolicy,
  options?: { allowInvalidBindings?: boolean },
): CanvasDocument {
  if (new TextEncoder().encode(json).byteLength > canvasLimits.bytes)
    throw uiTextError(uiMessage("canvasWorkspace.fileExceedsThe512kibLimit"))
  const raw: unknown = JSON.parse(json)
  safeValue(raw)
  const doc = object(raw, uiMessage("canvasParser.graphDocument"))
  keys(
    doc,
    [
      "schemaVersion",
      "id",
      "revision",
      "nodes",
      "edges",
      "frames",
      "notes",
      "viewport",
    ],
    uiMessage("canvasParser.graphDocument"),
  )
  if (doc.schemaVersion !== 1)
    throw uiTextError(
      uiMessage(
        "canvasValidation.incompatibleSchemaversionOnlyVersion1IsSupported",
      ),
    )
  id(doc.id, uiMessage("canvasParser.documentID"))
  number(doc.revision, "revision", 0, Number.MAX_SAFE_INTEGER)
  if (!Number.isInteger(doc.revision))
    throw uiTextError(uiMessage("canvasValidation.revisionMustBeAnInteger"))
  for (const [key, max] of [
    ["nodes", canvasLimits.nodes],
    ["edges", canvasLimits.edges],
    ["frames", canvasLimits.annotations],
    ["notes", canvasLimits.annotations],
  ] as const)
    if (!Array.isArray(doc[key]) || (doc[key] as unknown[]).length > max)
      throw uiTextError(
        uiMessage("common.valueMustBeAnArrayWithAtMost", {
          value0: key,
          value1: max,
        }),
      )
  const seen = new Set<string>()
  const records = (key: "nodes" | "edges" | "frames" | "notes") =>
    (doc[key] as unknown[]).map((value, index) => {
      const record = object(value, `${key}[${index}]`)
      const valueId = id(record.id, `${key} ID`)
      if (seen.has(valueId))
        throw uiTextError(
          uiMessage("common.duplicateIdValue", { value0: valueId }),
        )
      seen.add(valueId)
      return record
    })
  const nodes = records("nodes"),
    edges = records("edges"),
    frames = records("frames"),
    notes = records("notes")
  for (const node of nodes) {
    keys(
      node,
      ["id", "type", "title", "position", "config", "bindings", "parentId"],
      uiMessage("canvasParser.node"),
    )
    text(node.type, uiMessage("canvasParser.nodeType"))
    text(node.title, uiMessage("canvasParser.nodeTitle"))
    point(node.position, uiMessage("canvasParser.nodePosition"))
    object(node.config, uiMessage("canvasParser.nodeConfig"))
    if (
      node.parentId !== undefined &&
      !frames.some((frame) => frame.id === node.parentId)
    )
      throw uiTextError(
        uiMessage("common.nodeValueReferencesAMissingFrame", {
          value0: String(node.id),
        }),
      )
    if (node.bindings !== undefined)
      for (const value of Object.values(
        object(node.bindings, uiMessage("canvasParser.variableReference")),
      )) {
        const ref = object(value, uiMessage("canvasParser.variable"))
        keys(
          ref,
          ["nodeId", "portId", "path", "type"],
          uiMessage("canvasParser.variable"),
        )
        id(ref.nodeId, uiMessage("canvasParser.variableSourceID"))
        id(ref.portId, uiMessage("canvasParser.variablePortID"))
        text(ref.type, uiMessage("canvasParser.variableType"))
        if (
          ![
            "string",
            "number",
            "boolean",
            "object",
            "array",
            "message",
            "tool",
            "model",
          ].includes(ref.type as string)
        )
          throw uiTextError(uiMessage("canvasValidation.invalidVariableType"))
        if (
          !Array.isArray(ref.path) ||
          !ref.path.every(
            (value) => typeof value === "string" && value.length <= 200,
          )
        )
          throw uiTextError(
            uiMessage("canvasValidation.variablePathMustBeATextArray"),
          )
      }
  }
  for (const edge of edges) {
    keys(
      edge,
      ["id", "source", "sourcePort", "target", "targetPort", "label"],
      uiMessage("canvasParser.edge"),
    )
    for (const key of ["source", "sourcePort", "target", "targetPort"])
      id(edge[key], key)
    if (edge.label !== undefined)
      text(edge.label, uiMessage("canvasParser.edgeLabel"))
  }
  for (const frame of frames) {
    keys(frame, ["id", "title", "position", "width", "height"], "Frame")
    text(frame.title, uiMessage("canvasParser.frameTitle"))
    point(frame.position, uiMessage("canvasParser.framePosition"))
    number(frame.width, uiMessage("canvasParser.frameWidth"), 240, 10000)
    number(frame.height, uiMessage("canvasParser.frameHeight"), 120, 10000)
  }
  for (const note of notes) {
    keys(note, ["id", "text", "position"], "Note")
    text(note.text, uiMessage("canvasParser.noteBody"), 4000)
    point(note.position, uiMessage("canvasParser.notePosition"))
  }
  if (doc.viewport !== undefined) {
    const viewport = object(doc.viewport, "viewport")
    point(viewport, "viewport")
    number(viewport.zoom, "zoom", 0.25, 2)
  }
  const document = raw as CanvasDocument
  const errors = validateCanvasDocument(document, definitions, policy).filter(
    (issue) =>
      issue.severity === "error" &&
      !(options?.allowInvalidBindings && issue.code === "variable"),
  )
  if (errors.length)
    throw uiTextError(errors[0].messageI18n ?? errors[0].message)
  return document
}

export function exportCanvasDocument(document: CanvasDocument): string {
  // Only the versioned graph schema is exported; execution snapshots are a separate prop.
  return redact({
    schemaVersion: document.schemaVersion,
    id: document.id,
    revision: document.revision,
    nodes: document.nodes.map(
      ({ id, type, title, position, config, bindings, parentId }) => ({
        id,
        type,
        title,
        position,
        config,
        bindings,
        parentId,
      }),
    ),
    edges: document.edges,
    frames: document.frames,
    notes: document.notes,
    viewport: document.viewport,
  })
}

export function validateCanvasConnection(
  ...args: Parameters<typeof describeValidateCanvasConnection>
) {
  const value = describeValidateCanvasConnection(...args)
  return value === undefined ? undefined : resolveUiText(defaultLocale, value)
}
export function validateCanvasVariable(
  ...args: Parameters<typeof describeValidateCanvasVariable>
) {
  const value = describeValidateCanvasVariable(...args)
  return value === undefined ? undefined : resolveUiText(defaultLocale, value)
}
export function validateCanvasConfig(
  ...args: Parameters<typeof describeValidateCanvasConfig>
) {
  const value = describeValidateCanvasConfig(...args)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveUiText(defaultLocale, item),
    ]),
  )
}
