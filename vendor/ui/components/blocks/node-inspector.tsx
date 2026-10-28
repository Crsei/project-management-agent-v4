"use client"
import { uiMessage, resolveUiText, type UiText } from "../../lib/i18n-core"
import { UiError } from "../../lib/i18n-core"
import { useI18n } from "../../lib/i18n-provider"

import { useId, useRef, useState } from "react"
import { CanvasConfigEditor } from "./canvas-config-editor"
import { isCanvasStructuredField } from "../../lib/canvas-config"
import { Inspector } from "./inspector"
import { VariablePicker } from "./variable-picker"
import { Input } from "../ui/input"
import { Button } from "../ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog"
import {
  describeValidateCanvasConfig,
  describeValidateCanvasVariable,
  parseCanvasDocument,
} from "../../lib/canvas-validation"
import type {
  CanvasField,
  CanvasCommand,
  CanvasDocument,
  CanvasNodeDefinition,
  CanvasNodeRecord,
  CanvasValue,
  CanvasVariable,
  CanvasIssue,
  CanvasCatalogs,
} from "../../lib/canvas-model"
import styles from "./canvas-controls.module.css"

export type CanvasInspectorDraft = {
  source: string
  title: string
  values: Record<string, string>
  bindings: Record<string, CanvasVariable>
  errors: Record<string, UiText>
}
export type NodeInspectorProps = {
  document: CanvasDocument
  definitions: CanvasNodeDefinition[]
  nodeId?: string
  onCommand?: (command: CanvasCommand) => void
  readOnly?: boolean
  issues?: CanvasIssue[]
  catalogs?: CanvasCatalogs
  draftStore?: Record<string, CanvasInspectorDraft>
  onDraftStoreChange?: (drafts: Record<string, CanvasInspectorDraft>) => void
}
function makeDraft(
  node: CanvasNodeRecord,
  definition: CanvasNodeDefinition,
): CanvasInspectorDraft {
  return {
    source: JSON.stringify([node.title, node.config, node.bindings]),
    title: node.title,
    values: Object.fromEntries(
      (definition.fields ?? []).map((field) => [
        field.key,
        isCanvasStructuredField(field.kind)
          ? JSON.stringify(node.config[field.key] ?? null, null, 2)
          : String(node.config[field.key] ?? ""),
      ]),
    ),
    bindings: structuredClone(node.bindings ?? {}),
    errors: {},
  }
}
/** Drafts are keyed by stable object ID and the controlled configuration snapshot. */
export function NodeInspector({
  document,
  definitions,
  nodeId,
  onCommand,
  readOnly,
  issues = [],
  catalogs,
  draftStore,
  onDraftStoreChange,
}: NodeInspectorProps) {
  const { t, resolve, locale } = useI18n()

  const [localDrafts, setLocalDrafts] = useState<
    Record<string, CanvasInspectorDraft>
  >({})
  const drafts = draftStore ?? localDrafts
  function setDrafts(next: Record<string, CanvasInspectorDraft>) {
    if (onDraftStoreChange) onDraftStoreChange(next)
    else setLocalDrafts(next)
  }
  const [variableField, setVariableField] = useState<string>()
  const formRef = useRef<HTMLFormElement>(null)
  const prefix = useId()
  const node = document.nodes.find((item) => item.id === nodeId)
  const definition = definitions.find((item) => item.type === node?.type)
  const object = node
    ? {
        id: node.id,
        title: node.title,
        kind: definition?.label ?? t("nodeInspector.unknownNode"),
        metadata: [
          {
            label: t("nodeInspector.nodeId"),
            value: node.id,
            copyValue: node.id,
          },
          { label: t("nodeInspector.nodeType"), value: node.type },
          {
            label: t("nodeInspector.position"),
            value: `${node.position.x}, ${node.position.y}`,
          },
        ],
      }
    : null
  if (!node || !definition)
    return (
      <Inspector
        object={object}
        emptyDescription={t(
          "nodeInspector.selectANodeToEditItsConfigurationSelect",
        )}
      >
        {node && (
          <p className={styles.muted}>
            {t(
              "nodeInspector.theNodeDefinitionIsMissingOriginalConfigurationAnd",
            )}
          </p>
        )}
      </Inspector>
    )
  const fresh = makeDraft(node, definition)
  const draft =
    drafts[node.id]?.source === fresh.source ? drafts[node.id] : fresh
  const locked = readOnly || !onCommand
  function update(change: Partial<CanvasInspectorDraft>) {
    setDrafts({ ...drafts, [node!.id]: { ...draft, ...change } })
  }
  function apply() {
    const errors: Record<string, UiText> = {}
    const config = structuredClone(node!.config)
    for (const field of definition!.fields ?? []) {
      if (draft.bindings[field.key]) continue
      const value = draft.values[field.key] ?? ""
      try {
        config[field.key] = isCanvasStructuredField(field.kind)
          ? (JSON.parse(value) as CanvasValue)
          : field.kind === "number"
            ? value.trim()
              ? Number(value)
              : null
            : value
      } catch {
        errors[field.key] = t("common.valueIsNotValidJson", {
          value0: field.labelI18n ?? field.label,
        })
      }
    }
    const candidate = {
      ...node!,
      title: draft.title,
      config,
      bindings: draft.bindings,
    }
    if (!draft.title.trim())
      errors.title = uiMessage("nodeInspector.nodeNameCannotBeEmpty")
    Object.assign(errors, describeValidateCanvasConfig(candidate, definition!))
    for (const field of definition!.fields ?? [])
      if (
        field.catalog &&
        !draft.bindings[field.key] &&
        !catalogs?.[field.catalog]?.some(
          (entry) => entry.id === config[field.key] && entry.available,
        )
      )
        errors[field.key] = t(
          "common.theValueReferenceIsUnavailableSelectItAgain",
          { value0: field.labelI18n ?? field.label },
        )
    for (const [field, reference] of Object.entries(draft.bindings)) {
      const error = describeValidateCanvasVariable(
        document,
        definitions,
        candidate,
        field,
        reference,
      )
      if (error) errors[field] = error
    }
    update({ errors })
    if (Object.keys(errors).length) {
      requestAnimationFrame(() =>
        formRef.current
          ?.querySelector<HTMLElement>("[aria-invalid=true]")
          ?.focus(),
      )
      return
    }
    if (!locked) {
      try {
        parseCanvasDocument(
          JSON.stringify({
            ...document,
            nodes: document.nodes.map((item) =>
              item.id === candidate.id ? candidate : item,
            ),
          }),
          definitions,
          undefined,
          { allowInvalidBindings: true },
        )
      } catch (error) {
        update({
          errors: {
            ...errors,
            custom:
              error instanceof UiError
                ? error.messageI18n
                : error instanceof Error
                  ? error.message
                  : uiMessage(
                      "nodeInspector.configurationCouldNotBeWrittenToTheDocument",
                    ),
          },
        })
        return
      }
      onCommand?.({
        type: "configure",
        nodeId: node!.id,
        title: draft.title.trim(),
        config,
        bindings: draft.bindings,
      })
      const next = { ...drafts }
      delete next[node!.id]
      setDrafts(next)
    }
  }
  const advanced = (field: CanvasField) =>
    !field.required && ["json", "code", "schema"].includes(field.kind)
  const fields = definition.fields ?? []
  const renderField = (field: CanvasField) => {
    const id = `${prefix}-${field.key}`
    const reference = draft.bindings[field.key]
    const inputProps = {
      id,
      disabled: locked || !!reference,
      value: draft.values[field.key] ?? "",
      "aria-invalid": !!draft.errors[field.key],
      "aria-describedby": draft.errors[field.key] ? `${id}-error` : undefined,
      onChange: (event: { target: { value: string } }) =>
        update({
          values: { ...draft.values, [field.key]: event.target.value },
        }),
    }
    return (
      <div key={field.key} className={styles.field}>
        <label htmlFor={id}>
          {resolve(field.labelI18n, field.label)}
          {field.required ? " *" : ""}
        </label>
        {field.catalog ? (
          <select {...inputProps}>
            <option value="">
              {t("nodeInspector.select")}
              {resolve(field.labelI18n, field.label)}
            </option>
            {draft.values[field.key] &&
              !catalogs?.[field.catalog]?.some(
                (entry) => entry.id === draft.values[field.key],
              ) && (
                <option value={draft.values[field.key]}>
                  {t("nodeInspector.currentReferenceUnavailable")}
                </option>
              )}
            {catalogs?.[field.catalog]?.map((entry) => (
              <option
                key={entry.id}
                value={entry.id}
                disabled={!entry.available}
              >
                {entry.name}
                {entry.available ? "" : t("nodeInspector.unavailable")}
              </option>
            ))}
          </select>
        ) : isCanvasStructuredField(field.kind) ||
          field.kind === "expression" ||
          field.kind === "code" ? (
          <CanvasConfigEditor
            kind={field.kind}
            id={id}
            label={resolve(field.labelI18n, field.label)}
            value={inputProps.value}
            disabled={inputProps.disabled}
            invalid={inputProps["aria-invalid"]}
            describedBy={inputProps["aria-describedby"]}
            onChange={(value) => inputProps.onChange({ target: { value } })}
          />
        ) : field.kind === "textarea" ? (
          <textarea
            {...inputProps}
            rows={isCanvasStructuredField(field.kind) ? 5 : 3}
            spellCheck={false}
          />
        ) : field.kind === "select" ? (
          <select {...inputProps}>
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {resolve(option.labelI18n, option.label)}
              </option>
            ))}
          </select>
        ) : (
          <Input
            {...inputProps}
            type={field.kind === "number" ? "number" : "text"}
            step={field.kind === "number" ? "any" : undefined}
            min={field.min}
            max={field.max}
          />
        )}
        {reference && (
          <p className={styles.muted}>
            {t("nodeInspector.reference")}
            {document.nodes.find((item) => item.id === reference.nodeId)
              ?.title ?? t("nodeInspector.sourceDeleted")}{" "}
            / {reference.portId}
            {reference.path.length ? `.${reference.path.join(".")}` : ""} ·{" "}
            {reference.type}
          </p>
        )}
        {draft.errors[field.key] && (
          <span id={`${id}-error`} className={styles.error}>
            {resolveUiText(locale, draft.errors[field.key])}
          </span>
        )}
        {field.variableType && (
          <div className={styles.actions}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => setVariableField(field.key)}
            >
              {t("nodeInspector.select")}
              {resolve(field.labelI18n, field.label)}
              {t("nodeInspector.variables")}
            </Button>
            {reference && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  const bindings = { ...draft.bindings }
                  delete bindings[field.key]
                  update({ bindings })
                }}
              >
                {t("nodeInspector.removeBinding")}
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }
  return (
    <Inspector object={object}>
      <form
        ref={formRef}
        noValidate
        className={styles.form}
        aria-label={t("nodeInspector.nodeConfiguration")}
        onSubmit={(event) => {
          event.preventDefault()
          apply()
        }}
      >
        <label className={styles.field} htmlFor={`${prefix}-title`}>
          {t("nodeInspector.nodeName")}
          <Input
            id={`${prefix}-title`}
            disabled={locked}
            value={draft.title}
            aria-invalid={!!draft.errors.title}
            aria-describedby={
              draft.errors.title ? `${prefix}-title-error` : undefined
            }
            onChange={(event) => update({ title: event.target.value })}
          />
          {draft.errors.title && (
            <span id={`${prefix}-title-error`} className={styles.error}>
              {resolveUiText(locale, draft.errors.title)}
            </span>
          )}
        </label>
        {fields.filter((field) => !advanced(field)).map(renderField)}
        {fields.some(advanced) && (
          <details
            key={node.id}
            open={
              fields.some(
                (field) => advanced(field) && !!draft.errors[field.key],
              ) || undefined
            }
          >
            <summary>{t("nodeInspector.advancedConfiguration")}</summary>
            <div className={styles.form}>
              {fields.filter(advanced).map(renderField)}
            </div>
          </details>
        )}
        {Object.entries(draft.errors)
          .filter(([key]) => key.startsWith("custom"))
          .map(([key, message]) => (
            <p key={key} className={styles.error}>
              {resolveUiText(locale, message)}
            </p>
          ))}
        <div className={styles.actions}>
          <Button type="submit" disabled={locked}>
            {t("nodeInspector.applyConfiguration")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => {
              const next = { ...drafts }
              delete next[node.id]
              setDrafts(next)
            }}
          >
            {t("nodeInspector.discardChanges")}
          </Button>
        </div>
        <p className={styles.muted}>
          {t("nodeInspector.fieldEditsStayInTheCurrentObjectDraft")}
        </p>
        {issues
          .filter((issue) => issue.nodeId === node.id)
          .map((issue, index) => (
            <p key={index} className={styles.error}>
              {resolve(issue.messageI18n, issue.message)}
            </p>
          ))}
      </form>
      <Dialog
        open={!!variableField}
        onOpenChange={(open) => {
          if (!open) setVariableField(undefined)
        }}
      >
        <DialogContent className={styles.dialog}>
          <DialogTitle>{t("nodeInspector.selectUpstreamVariable")}</DialogTitle>
          <DialogDescription>
            {t(
              "nodeInspector.onlyCompatibleOutputsReachableUpstreamAreShownReferences",
            )}
          </DialogDescription>
          {variableField && (
            <VariablePicker
              document={document}
              definitions={definitions}
              targetId={node.id}
              expectedType={
                definition.fields?.find((field) => field.key === variableField)
                  ?.variableType
              }
              readOnly={locked}
              onInsert={(reference) => {
                update({
                  bindings: { ...draft.bindings, [variableField]: reference },
                })
                setVariableField(undefined)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Inspector>
  )
}
