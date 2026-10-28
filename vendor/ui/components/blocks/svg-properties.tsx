"use client"
import { useState } from "react"
import { Button } from "../ui/button"
import { Field } from "../ui/field"
import { Input } from "../ui/input"
import { Textarea } from "../ui/textarea"
import { useSvgI18n as useI18n } from "../../lib/i18n-svg"
import { svgAttributeDiagnostic } from "../../lib/svg-workbench-parse"
import {
  editableSvgIds,
  findSvgNode,
  svgPaintValue,
  type SvgDocument,
  type EditCommand,
} from "../../lib/svg-workbench-model"
import styles from "./svg-workbench.module.css"
const fields: Record<string, string[]> = {
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  path: ["d"],
  use: ["x", "y", "width", "height"],
}
function AttributeField({
  tag,
  name,
  label,
  value,
  disabled,
  onCommit,
}: {
  tag: string
  name: string
  label: string
  value: string
  disabled?: boolean
  onCommit: (value: string) => void
}) {
  const { t } = useI18n()
  const [state, setState] = useState({
    base: value,
    draft: value,
    error: false,
  })
  const draft = state.base === value ? state.draft : value
  const error = state.base === value && state.error
  const setDraft = (next: string) =>
    setState({ base: value, draft: next, error: false })
  const setError = (next: boolean) =>
    setState({ base: value, draft, error: next })
  const commit = () => {
    if (draft === value) return
    const diagnostic = svgAttributeDiagnostic(tag, name, draft.trim())
    if (diagnostic) {
      setError(true)
      return
    }
    setError(false)
    onCommit(draft.trim())
  }
  return (
    <Field label={label} error={error ? t("svg.fieldInvalid") : undefined}>
      {(p) =>
        name === "d" || name === "points" ? (
          <Textarea
            {...p}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
        ) : (
          <Input
            {...p}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commit()
            }}
          />
        )
      }
    </Field>
  )
}
export type SvgPropertiesProps = {
  document: SvgDocument
  selectedIds: string[]
  onCommand: (command: EditCommand) => void
}
export function SvgProperties({
  document,
  selectedIds,
  onCommand,
}: SvgPropertiesProps) {
  const { t } = useI18n(),
    node =
      selectedIds.length === 1
        ? findSvgNode(document, selectedIds[0])
        : undefined,
    [rotation, setRotation] = useState("0"),
    [scale, setScale] = useState("1"),
    editable = editableSvgIds(document),
    locked = node ? !editable.has(node.id) : true
  return (
    <div className={styles.properties}>
      <fieldset>
        <legend>{t("svg.document")}</legend>
        <div className={styles.twoFields}>
          {(["width", "height"] as const).map((name) => (
            <AttributeField
              key={name}
              tag="svg"
              name={name}
              label={t(name === "width" ? "svg.width" : "svg.height")}
              value={String(document[name])}
              onCommit={(value) => {
                if (Number(value) > 0 && Number(value) <= 1000000)
                  onCommand({
                    type: "canvas",
                    width: document.width,
                    height: document.height,
                    viewBox: document.viewBox,
                    [name]: Number(value),
                  })
              }}
            />
          ))}
        </div>
        <AttributeField
          tag="svg"
          name="viewBox"
          label="viewBox"
          value={document.viewBox.join(" ")}
          onCommit={(value) =>
            onCommand({
              type: "canvas",
              width: document.width,
              height: document.height,
              viewBox: value
                .split(/[\s,]+/)
                .map(Number) as SvgDocument["viewBox"],
            })
          }
        />
      </fieldset>
      {!node ? (
        <p>{t("svg.noSelection")}</p>
      ) : (
        <>
          <h3>
            {node.tag} · {node.id}
          </h3>
          {locked && <p>{t("svg.lockHint")}</p>}
          <fieldset disabled={locked}>
            <legend>{t("svg.geometry")}</legend>
            <div className={styles.twoFields}>
              {(fields[node.tag] ?? []).map((name) => (
                <AttributeField
                  key={`${node.id}-${name}`}
                  tag={node.tag}
                  name={name}
                  label={
                    name === "d"
                      ? t("svg.pathData")
                      : name === "points"
                        ? t("svg.points")
                        : name
                  }
                  value={node.attrs[name] ?? "0"}
                  onCommit={(value) =>
                    onCommand({
                      type: "update",
                      ids: [node.id],
                      attrs: { [name]: value },
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <fieldset disabled={locked}>
            <legend>{t("svg.paint")}</legend>
            <div className={styles.twoFields}>
              {(["fill", "stroke", "stroke-width", "opacity"] as const).map(
                (name) => (
                  <AttributeField
                    key={`${node.id}-${name}`}
                    tag={node.tag}
                    name={name}
                    label={t(
                      name === "fill"
                        ? "svg.fill"
                        : name === "stroke"
                          ? "svg.stroke"
                          : name === "stroke-width"
                            ? "svg.strokeWidth"
                            : "svg.opacity",
                    )}
                    value={svgPaintValue(document, node.id, name)}
                    onCommit={(value) =>
                      onCommand({
                        type: "update",
                        ids: [node.id],
                        attrs: { [name]: value },
                      })
                    }
                  />
                ),
              )}
            </div>
          </fieldset>
          <fieldset disabled={locked}>
            <legend>{t("svg.transform")}</legend>
            <AttributeField
              tag={node.tag}
              name="transform"
              label="transform"
              value={node.attrs.transform ?? ""}
              onCommit={(value) =>
                onCommand({
                  type: "update",
                  ids: [node.id],
                  attrs: { transform: value },
                })
              }
            />
            <div className={styles.twoFields}>
              <Field label={t("svg.rotation")}>
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    value={rotation}
                    onChange={(e) => setRotation(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t("svg.scale")}>
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.1"
                    value={scale}
                    onChange={(e) => setScale(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Button
              variant="secondary"
              disabled={
                !Number.isFinite(Number(rotation)) ||
                !Number.isFinite(Number(scale)) ||
                Number(scale) <= 0 ||
                Number(scale) > 100
              }
              onClick={() =>
                onCommand({
                  type: "transform",
                  ids: [node.id],
                  transform: `rotate(${Number(rotation)}) scale(${Number(scale)})`,
                })
              }
            >
              {t("svg.applyTransform")}
            </Button>
          </fieldset>
        </>
      )}
      <fieldset>
        <legend>{t("svg.sources")}</legend>
        {document.sources.map((s) => (
          <dl key={`${s.collection}:${s.assetPath}`}>
            <dt>
              {s.collection}:{s.iconName}
            </dt>
            <dd>{s.modified ? t("svg.modified") : t("svg.original")}</dd>
            <dt>{t("svg.commit")}</dt>
            <dd>{s.commit}</dd>
            <dt>{t("svg.path")}</dt>
            <dd>{s.assetPath}</dd>
            <dt>{t("svg.license")}</dt>
            <dd>
              {s.license} · {s.licenseRef}
            </dd>
            <dd>{s.repository}</dd>
            {s.notice && <dd>{s.notice}</dd>}
          </dl>
        ))}
      </fieldset>
    </div>
  )
}
