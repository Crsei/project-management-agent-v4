"use client"
import { Input } from "../ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select"
import { Segmented, SegmentedItem } from "../ui/segmented"
import { FilterToolbar } from "./filter-toolbar"
import { useI18n } from "../../lib/i18n-provider"
import type {
  AgentRunSnapshot,
  AgentBoardViewState,
} from "../../lib/agent-board-model"
import styles from "./agent-board.module.css"
export type AgentBoardToolbarProps = {
  records: readonly AgentRunSnapshot[]
  hasDependencies?: boolean
  viewState: AgentBoardViewState
  onViewChange: (view: AgentBoardViewState) => void
}
export function AgentBoardToolbar({
  records,
  viewState,
  onViewChange,
  hasDependencies,
}: AgentBoardToolbarProps) {
  const { t } = useI18n()
  const fields = [
    {
      key: "agentId",
      label: t("agentBoard.agent"),
      entries: records.map((run) => [run.agentId, run.agentName]),
    },
    {
      key: "model",
      label: t("agentBoard.model"),
      entries: records
        .filter((run) => run.model)
        .map((run) => [run.model!, run.model!]),
    },
    {
      key: "status",
      label: t("agentBoard.status"),
      entries: records.map((run) => [run.runtimeStatus, run.runtimeStatus]),
    },
    {
      key: "workItemId",
      label: t("agentBoard.task"),
      entries: records
        .filter((run) => run.workItemRef)
        .map((run) => [run.workItemRef!.id, run.workItemRef!.title]),
    },
    ...(viewState.view === "inbox"
      ? [
          {
            key: "inboxKind",
            label: t("agentBoard.inbox"),
            entries: [
              "approval",
              "input",
              "failure",
              "unknown",
              "disconnect",
            ].map((kind) => [kind, t(`agentBoard.${kind as "approval"}`)]),
          },
        ]
      : []),
  ]
  return (
    <div className={styles.toolbar}>
      <Segmented
        aria-label={t("agentBoard.title")}
        value={viewState.view}
        onValueChange={(view) =>
          onViewChange({
            ...viewState,
            view: view as AgentBoardViewState["view"],
          })
        }
      >
        {(
          [
            "board",
            "list",
            "inbox",
            "insights",
            ...(hasDependencies ? ["dependencies" as const] : []),
          ] as const
        ).map((view) => (
          <SegmentedItem key={view} value={view}>
            {t(`agentBoard.${view}`)}
          </SegmentedItem>
        ))}
      </Segmented>
      <FilterToolbar
        label={t("agentBoard.title")}
        search={
          <Input
            className={styles.search}
            aria-label={t("agentBoard.search")}
            placeholder={t("agentBoard.search")}
            value={viewState.query}
            onChange={(event) =>
              onViewChange({ ...viewState, query: event.target.value })
            }
          />
        }
        filters={fields.map((field) => {
          const key = field.key as "agentId"
          const entries = [
            ...new Map(
              field.entries.map(([id, label]) => [id, label]),
            ).entries(),
          ]
          if (viewState[key] && !entries.some(([id]) => id === viewState[key]))
            entries.push([viewState[key], viewState[key]])
          return (
            <Select
              key={field.key}
              value={viewState[key]}
              items={Object.fromEntries([
                ["", t("agentBoard.all")],
                ...entries,
              ])}
              onValueChange={(value) =>
                onViewChange({ ...viewState, [field.key]: value ?? "" })
              }
            >
              <SelectTrigger aria-label={field.label}>
                <span className={styles.filterLabel}>{field.label}:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t("agentBoard.all")}</SelectItem>
                {entries.map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        })}
      />
    </div>
  )
}
