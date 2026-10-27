import { useI18n } from "../../lib/i18n-provider"

import { Handle, Position } from "@xyflow/react"
import type { CanvasPortDefinition } from "../../lib/canvas-model"
import styles from "./canvas-node.module.css"

/** Engine adapter; render inside a React Flow custom node. Keyboard connection uses the workspace form. */
export function CanvasPort({
  port,
  readOnly = false,
  unknownType = false,
  side = port.direction === "input" ? "left" : "right",
}: {
  port: CanvasPortDefinition
  readOnly?: boolean
  unknownType?: boolean
  side?: "left" | "right"
}) {
  const { t, resolve } = useI18n()

  return (
    <div
      className={styles.port}
      data-direction={port.direction}
      role="group"
      aria-label={`${resolve(port.labelI18n, port.label)} ${port.direction === "input" ? t("common.input") : t("toolCall.output")} ${unknownType ? t("canvasPort.undefinedType") : port.type}`}
    >
      <Handle
        id={port.id}
        type={port.direction === "input" ? "target" : "source"}
        position={side === "left" ? Position.Left : Position.Right}
        isConnectable={!readOnly}
      />
      <span>{resolve(port.labelI18n, port.label)}</span>
      <code>{unknownType ? t("canvasPort.undefinedType") : port.type}</code>
    </div>
  )
}
