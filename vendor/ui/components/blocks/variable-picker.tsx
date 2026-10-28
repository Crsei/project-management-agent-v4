"use client"
import { useI18n } from "../../lib/i18n-provider"

import { useState } from "react"
import { Input } from "../ui/input"
import { Button } from "../ui/button"
import { Tree, type TreeNode } from "../ui/tree"
import { upstreamCanvasNodes } from "../../lib/canvas-validation"
import type {
  CanvasDocument,
  CanvasNodeDefinition,
  CanvasPortType,
  CanvasVariable,
} from "../../lib/canvas-model"
import styles from "./canvas-controls.module.css"

export type VariablePickerProps = {
  document: CanvasDocument
  definitions: CanvasNodeDefinition[]
  targetId: string
  expectedType?: CanvasPortType
  onInsert: (reference: CanvasVariable) => void
  readOnly?: boolean
}
export function VariablePicker({
  document,
  definitions,
  targetId,
  expectedType,
  onInsert,
  readOnly,
}: VariablePickerProps) {
  const { t, resolve } = useI18n()

  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string>()
  const [path, setPath] = useState("")
  const refs = new Map<string, CanvasVariable>()
  const upstream = upstreamCanvasNodes(document, targetId)
  const nodes: TreeNode[] = document.nodes
    .filter((node) => upstream.has(node.id))
    .flatMap((node) => {
      const ports =
        definitions
          .find((item) => item.type === node.type)
          ?.ports.filter(
            (port) =>
              port.direction === "output" &&
              (!expectedType || port.type === expectedType) &&
              `${node.title} ${resolve(port.labelI18n, port.label)} ${port.type}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
          ) ?? []
      if (!ports.length) return []
      return [
        {
          id: `node:${node.id}`,
          label: node.title,
          children: ports.map((port) => {
            const id = `port:${node.id}:${port.id}`
            refs.set(id, {
              nodeId: node.id,
              portId: port.id,
              type: port.type,
              path: [],
            })
            return {
              id,
              label: resolve(port.labelI18n, port.label),
              metadata: port.type,
            }
          }),
        },
      ]
    })
  const selected = selectedId ? refs.get(selectedId) : undefined
  return (
    <div className={styles.stack}>
      <Input
        aria-label={t("variablePicker.searchUpstreamVariables")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("variablePicker.searchSourcePortOrType")}
      />
      {nodes.length ? (
        <Tree
          key={query}
          nodes={nodes}
          label={t("variablePicker.reachableUpstreamVariables")}
          selectedId={selectedId}
          onSelect={(node) => setSelectedId(node.id)}
          defaultExpandedIds={nodes.map((node) => node.id)}
        />
      ) : (
        <p className={styles.muted}>
          {t("variablePicker.noCompatibleUpstreamOutputsConnectASourceNode")}
        </p>
      )}
      {selected && (
        <>
          <p className={styles.muted}>
            {t("variablePicker.source")}
            {
              document.nodes.find((node) => node.id === selected.nodeId)?.title
            }{" "}
            / {selected.portId} · {selected.type}
            <br />
            <code>{selected.nodeId}</code>
          </p>
          {["object", "array"].includes(selected.type) && (
            <label className={styles.field}>
              {t("variablePicker.fieldPathDotSeparatedOptional")}
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
          )}
        </>
      )}
      <Button
        disabled={readOnly || !selected}
        onClick={() => {
          if (selected && !readOnly)
            onInsert({
              ...selected,
              path: ["object", "array"].includes(selected.type)
                ? path.split(".").filter(Boolean)
                : [],
            })
        }}
      >
        {t("variablePicker.insertVariableReference")}
      </Button>
    </div>
  )
}
