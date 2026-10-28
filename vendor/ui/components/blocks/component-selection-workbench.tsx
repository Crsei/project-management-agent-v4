"use client"

import { useId, type ReactNode } from "react"
import { useI18n } from "../../lib/i18n-provider"
import {
  setSelectionDecision,
  unresolvedSelectionGroups,
  selectionTextLimit,
  type ComponentSelectionDraft,
  type SelectionCandidate,
  type SelectionDecision,
  type SelectionGroup,
  type SelectionTemplate,
  type SelectionText,
} from "../../lib/component-selection-model"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Textarea } from "../ui/textarea"
import { Field } from "../ui/field"
import { NativeSelect } from "../ui/native-select"
import { Item } from "../ui/item"
import { DataRegion } from "../ui/data-region"
import styles from "./component-selection-workbench.module.css"

export type ComponentSelectionWorkbenchProps = {
  template: SelectionTemplate
  value: ComponentSelectionDraft
  onChange: (value: ComponentSelectionDraft) => void
  renderPreview: (
    candidate: SelectionCandidate,
    group: SelectionGroup,
  ) => ReactNode
  handoff: string
  actions?: ReactNode
  specification?: ReactNode
  feedback?: ReactNode
  error?: ReactNode
  busy?: boolean
  onCopy?: () => void
  onExport?: (format: "markdown" | "json") => void
  className?: string
}
const decisions: SelectionDecision[] = [
  "undecided",
  "preferred",
  "alternative",
  "rejected",
]

/** Controlled composition: previews, persistence, import and execution stay with the host. */
export function ComponentSelectionWorkbench({
  template,
  value,
  onChange,
  renderPreview,
  handoff,
  actions,
  specification,
  feedback,
  error,
  busy,
  onCopy,
  onExport,
  className,
}: ComponentSelectionWorkbenchProps) {
  const { locale, t } = useI18n()
  const id = useId()
  const label = (text: SelectionText) =>
    typeof text === "string" ? text : text[locale]
  const unresolved = unresolvedSelectionGroups(value)
  const patchGroup = (groupId: string, patch: { requirement: string }) =>
    onChange({
      ...value,
      groups: value.groups.map((group) =>
        group.id === groupId ? { ...group, ...patch } : group,
      ),
    })
  const patchNote = (groupId: string, candidateId: string, note: string) =>
    onChange({
      ...value,
      groups: value.groups.map((group) =>
        group.id !== groupId
          ? group
          : {
              ...group,
              candidates: group.candidates.map((candidate) =>
                candidate.id === candidateId
                  ? { ...candidate, note }
                  : candidate,
              ),
            },
      ),
    })
  return (
    <div
      className={[styles.root, className].filter(Boolean).join(" ")}
      data-component-selection
    >
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>COMPONENT SELECTION</p>
          <h1>{t("selection.title")}</h1>
          <p>{t("selection.description")}</p>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      {specification && (
        <details className={styles.specification}>
          <summary>{t("selection.templateInfo")}</summary>
          {specification}
        </details>
      )}
      <section className={styles.project} aria-label={t("selection.project")}>
        <Field label={t("selection.projectName")}>
          {(props) => (
            <Input
              {...props}
              value={value.projectName}
              maxLength={160}
              placeholder={t("selection.projectPlaceholder")}
              onChange={(event) =>
                onChange({ ...value, projectName: event.target.value })
              }
            />
          )}
        </Field>
        <Field label={t("selection.goal")}>
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={value.goal}
              maxLength={selectionTextLimit}
              onChange={(event) =>
                onChange({ ...value, goal: event.target.value })
              }
            />
          )}
        </Field>
        <Field label={t("selection.constraints")}>
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={value.constraints}
              maxLength={selectionTextLimit}
              placeholder={t("selection.constraintsPlaceholder")}
              onChange={(event) =>
                onChange({ ...value, constraints: event.target.value })
              }
            />
          )}
        </Field>
      </section>
      <p className={styles.feedback} role="status">
        {feedback}
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.layout}>
        <div className={styles.groups}>
          <DataRegion
            state={template.groups.length ? "success" : "empty"}
            emptyTitle={t("selection.noGroups")}
            emptyDescription={t("selection.noGroupsDescription")}
          >
            {template.groups.map((group) => {
              const selected = value.groups.find((item) => item.id === group.id)
              if (!selected) return null
              return (
                <section
                  key={group.id}
                  className={styles.group}
                  aria-labelledby={`${id}-${group.id}`}
                  data-selection-group={group.id}
                >
                  <header className={styles.groupHeader}>
                    <h2 id={`${id}-${group.id}`}>{label(group.title)}</h2>
                    <p>{label(group.purpose)}</p>
                    <Field label={t("selection.requirement")}>
                      {(props) => (
                        <Textarea
                          {...props}
                          rows={2}
                          value={selected.requirement}
                          maxLength={selectionTextLimit}
                          placeholder={t("selection.requirementPlaceholder")}
                          onChange={(event) =>
                            patchGroup(group.id, {
                              requirement: event.target.value,
                            })
                          }
                        />
                      )}
                    </Field>
                  </header>
                  <div className={styles.candidates}>
                    {group.candidates.map((candidate) => {
                      const choice = selected.candidates.find(
                        (item) => item.id === candidate.id,
                      )
                      if (!choice) return null
                      return (
                        <article
                          key={candidate.id}
                          className={styles.candidate}
                          data-candidate={candidate.id}
                          data-decision={choice.decision}
                          aria-labelledby={`${id}-${group.id}-${candidate.id}`}
                        >
                          <div className={styles.candidateHeader}>
                            <h3 id={`${id}-${group.id}-${candidate.id}`}>
                              {candidate.name}
                            </h3>
                            <span className={styles.decision}>
                              {t(`selection.${choice.decision}`)}
                            </span>
                          </div>
                          <p className={styles.description}>
                            {label(candidate.description)}
                          </p>
                          <div
                            className={styles.preview}
                            role="region"
                            aria-label={t("selection.previewName", {
                              name: candidate.name,
                            })}
                          >
                            {renderPreview(candidate, group)}
                          </div>
                          <div className={styles.candidateBody}>
                            <dl className={styles.metadata}>
                              <div>
                                <dt>{t("selection.suitableFor")}</dt>
                                <dd>{label(candidate.suitableFor)}</dd>
                              </div>
                              <div>
                                <dt>{t("selection.limitation")}</dt>
                                <dd>{label(candidate.limitation)}</dd>
                              </div>
                              <div>
                                <dt>{t("selection.source")}</dt>
                                <dd>
                                  <code>{candidate.source}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>{t("selection.origin")}</dt>
                                <dd>
                                  {candidate.origin} · {candidate.version} ·{" "}
                                  {candidate.license}
                                </dd>
                              </div>
                            </dl>
                            <Field
                              label={t("selection.decisionName", {
                                name: candidate.name,
                              })}
                              description={t("selection.decisionHint")}
                            >
                              {(props) => (
                                <NativeSelect
                                  {...props}
                                  value={choice.decision}
                                  onChange={(event) =>
                                    onChange(
                                      setSelectionDecision(
                                        value,
                                        group.id,
                                        candidate.id,
                                        event.target.value as SelectionDecision,
                                      ),
                                    )
                                  }
                                >
                                  {decisions.map((decision) => (
                                    <option key={decision} value={decision}>
                                      {t(`selection.${decision}`)}
                                    </option>
                                  ))}
                                </NativeSelect>
                              )}
                            </Field>
                            <Field
                              label={t("selection.noteName", {
                                name: candidate.name,
                              })}
                            >
                              {(props) => (
                                <Textarea
                                  {...props}
                                  value={choice.note}
                                  maxLength={selectionTextLimit}
                                  rows={3}
                                  placeholder={t("selection.notePlaceholder")}
                                  onChange={(event) =>
                                    patchNote(
                                      group.id,
                                      candidate.id,
                                      event.target.value,
                                    )
                                  }
                                />
                              )}
                            </Field>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </DataRegion>
        </div>
        <aside className={styles.summary} aria-labelledby={`${id}-summary`}>
          <h2 id={`${id}-summary`}>{t("selection.handoff")}</h2>
          <p>
            {t("selection.resolvedCount", {
              resolved: value.groups.length - unresolved.length,
              total: value.groups.length,
            })}
          </p>
          {!value.projectName.trim() && (
            <p className={styles.attention}>{t("selection.missingProject")}</p>
          )}
          {!value.goal.trim() && (
            <p className={styles.attention}>{t("selection.missingGoal")}</p>
          )}
          <ul className={styles.summaryList}>
            {template.groups.map((group) => {
              const selected = value.groups.find((item) => item.id === group.id)
              const preferred = selected?.candidates.find(
                (item) => item.decision === "preferred",
              )
              const alternatives = group.candidates.filter((candidate) =>
                selected?.candidates.some(
                  (item) =>
                    item.id === candidate.id && item.decision === "alternative",
                ),
              )
              return (
                <li key={group.id}>
                  <Item
                    title={label(group.title)}
                    description={
                      preferred
                        ? group.candidates.find(
                            (item) => item.id === preferred.id,
                          )?.name
                        : t("selection.unresolved")
                    }
                  />
                  {alternatives.length > 0 && (
                    <p className={styles.alternatives}>
                      {t("selection.alternatives")}:{" "}
                      {alternatives
                        .map((candidate) => candidate.name)
                        .join(", ")}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          <p>
            {t(
              unresolved.length
                ? "selection.pendingHint"
                : "selection.readyHint",
            )}
          </p>
          <div className={styles.exportActions}>
            {onExport && (
              <>
                <Button disabled={busy} onClick={() => onExport("markdown")}>
                  {t("selection.exportMarkdown")}
                </Button>
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() => onExport("json")}
                >
                  {t("selection.exportJson")}
                </Button>
              </>
            )}
            {onCopy && (
              <Button disabled={busy} variant="ghost" onClick={onCopy}>
                {t("selection.copy")}
              </Button>
            )}
          </div>
          <details className={styles.handoffText}>
            <summary>{t("selection.viewHandoff")}</summary>
            <Field label={t("selection.handoffText")}>
              {(props) => (
                <Textarea {...props} readOnly value={handoff} rows={16} />
              )}
            </Field>
          </details>
          <p className={styles.boundary}>{t("selection.boundary")}</p>
        </aside>
      </div>
    </div>
  )
}
