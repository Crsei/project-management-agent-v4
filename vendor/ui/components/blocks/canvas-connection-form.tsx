"use client"
import { useUiFeedback } from "../../lib/i18n-provider"
import { uiMessage } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"

import { useState } from "react"
import { Button } from "../ui/button"
import { NodePalette } from "./node-palette"
import {
  canvasId,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasEdgeRecord,
  type CanvasNodeDefinition,
} from "../../lib/canvas-model"
import { describeValidateCanvasConnection } from "../../lib/canvas-validation"
import styles from "./canvas-controls.module.css"

/** Internal workspace form: keyboard/touch equivalent of connecting and reconnecting handles. */
export function CanvasConnectionForm({
  document,
  definitions,
  edge,
  onCommand,
  readOnly,
}: {
  document: CanvasDocument
  definitions: CanvasNodeDefinition[]
  edge?: CanvasEdgeRecord
  onCommand: (command: CanvasCommand) => void
  readOnly: boolean
}) {
  const { t, resolve } = useI18n()

  const choices = (direction: "input" | "output") =>
    document.nodes.flatMap((node) =>
      (definitions.find((item) => item.type === node.type)?.ports ?? [])
        .filter((port) => port.direction === direction)
        .map((port) => ({
          value: `${node.id}:${port.id}`,
          label: `${node.title} / ${resolve(port.labelI18n, port.label)} (${port.type})`,
          nodeId: node.id,
          port,
        })),
    )
  const outputs = choices("output"),
    inputs = choices("input")
  const [source, setSource] = useState(
    edge ? `${edge.source}:${edge.sourcePort}` : (outputs[0]?.value ?? ""),
  )
  const [target, setTarget] = useState(
    edge ? `${edge.target}:${edge.targetPort}` : (inputs[0]?.value ?? ""),
  )
  const [error, setError] = useUiFeedback("")
  const [inserting, setInserting] = useState(false)
  const from = outputs.find((item) => item.value === source),
    to = inputs.find((item) => item.value === target)
  const newEdge =
    from && to
      ? {
          id: edge?.id ?? "pending",
          source: from.nodeId,
          sourcePort: from.port.id,
          target: to.nodeId,
          targetPort: to.port.id,
        }
      : undefined
  const reason = newEdge
    ? describeValidateCanvasConnection(document, definitions, newEdge, edge?.id)
    : uiMessage("canvasConnectionForm.selectTheSourceAndTargetPorts")
  return (
    <div className={styles.stack}>
      <label className={styles.field}>
        {t("canvasConnectionForm.sourceOutputPort")}
        <select
          aria-label={t("canvasConnectionForm.sourceOutputPort")}
          value={source}
          disabled={readOnly}
          onChange={(event) => {
            setSource(event.target.value)
            setError("")
          }}
        >
          <option value="">{t("canvasConnectionForm.selectASource")}</option>
          {outputs.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        {t("canvasConnectionForm.targetInputPort")}
        <select
          aria-label={t("canvasConnectionForm.targetInputPort")}
          value={target}
          disabled={readOnly}
          onChange={(event) => {
            setTarget(event.target.value)
            setError("")
          }}
        >
          <option value="">{t("canvasConnectionForm.selectATarget")}</option>
          {inputs.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {reason && (
        <p className={styles.muted}>
          {resolve(
            typeof reason === "object" ? reason : undefined,
            typeof reason === "string" ? reason : "",
          )}
        </p>
      )}
      <Button
        disabled={readOnly}
        onClick={() => {
          if (reason || !newEdge) {
            setError(reason ?? uiMessage("canvasConnectionForm.invalidPort"))
            return
          }
          onCommand(
            edge
              ? {
                  type: "reconnect",
                  edgeId: edge.id,
                  edge: { ...newEdge, id: edge.id },
                }
              : { type: "connect", edge: { ...newEdge, id: canvasId("edge") } },
          )
        }}
      >
        {edge
          ? t("canvasConnectionForm.applyReconnection")
          : t("canvasConnectionForm.connect")}
      </Button>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {edge && (
        <>
          <div className={styles.actions}>
            <Button
              variant="outline"
              disabled={readOnly}
              onClick={() =>
                onCommand({
                  type: "delete",
                  selection: { nodeIds: [], edgeIds: [edge.id] },
                })
              }
            >
              {t("canvasConnectionForm.disconnectEdge")}
            </Button>
            <Button
              variant="outline"
              disabled={readOnly}
              onClick={() => setInserting((value) => !value)}
            >
              {t("canvasConnectionForm.insertNodeIntoEdge")}
            </Button>
          </div>
          {inserting && (
            <NodePalette
              definitions={definitions.filter(
                (item) =>
                  item.ports.some((port) => port.direction === "input") &&
                  item.ports.some((port) => port.direction === "output"),
              )}
              readOnly={readOnly}
              onAdd={(definition) => {
                const sourceNode = document.nodes.find(
                    (node) => node.id === edge.source,
                  )!,
                  targetNode = document.nodes.find(
                    (node) => node.id === edge.target,
                  )!
                const output = definitions
                  .find((item) => item.type === sourceNode.type)
                  ?.ports.find((port) => port.id === edge.sourcePort)
                const input = definitions
                  .find((item) => item.type === targetNode.type)
                  ?.ports.find((port) => port.id === edge.targetPort)
                const inputPort = definition.ports.find(
                    (port) =>
                      port.direction === "input" && port.type === output?.type,
                  ),
                  outputPort = definition.ports.find(
                    (port) =>
                      port.direction === "output" && port.type === input?.type,
                  )
                if (!inputPort || !outputPort) {
                  setError(
                    uiMessage(
                      "canvasConnectionForm.thePortsOnEitherSideAreIncompatibleThe",
                    ),
                  )
                  return
                }
                onCommand({
                  type: "insert",
                  edgeId: edge.id,
                  inputPort: inputPort.id,
                  outputPort: outputPort.id,
                  node: {
                    id: canvasId("node"),
                    type: definition.type,
                    title: definition.label,
                    position: {
                      x: (sourceNode.position.x + targetNode.position.x) / 2,
                      y:
                        (sourceNode.position.y + targetNode.position.y) / 2 +
                        160,
                    },
                    config: structuredClone(definition.defaults),
                  },
                })
              }}
            />
          )}
        </>
      )}
    </div>
  )
}
