"use client"
import { useState } from "react"
import { Inspector } from "./inspector"
import { AgentRow } from "./agent-row"
import { SessionRow } from "./session-row"
import { RunStageSummary } from "./run-stage-summary"
import { ApprovalRequestPanel } from "./approval-request-panel"
import { ArtifactList, ReviewSummary } from "./artifact-list"
import { ExecutionTraceTree } from "./execution-trace-tree"
import { AgentRelationshipList } from "./agent-relationship-list"
import { ActivityTimeline, type ActivityEvent } from "./activity-timeline"
import { Segmented, SegmentedItem } from "../ui/segmented"
import { useI18n } from "../../lib/i18n-provider"
import { safeArtifactHref } from "../../lib/agent-board-view"
import type {
  AgentRunSnapshot,
  ArtifactRecord,
  AttentionRecord,
  TraceStep,
  RunRelationship,
  AttentionAction,
} from "../../lib/agent-board-model"
import styles from "./agent-board.module.css"
export type AgentRunDetailSnapshot = {
  run: AgentRunSnapshot
  attention: readonly AttentionRecord[]
  artifacts: readonly ArtifactRecord[]
  steps: readonly TraceStep[]
  relationships: readonly RunRelationship[]
  events: ActivityEvent[]
}
export type AgentRunInspectorProps = {
  snapshot: AgentRunDetailSnapshot
  drafts?: Record<string, string>
  onDraftChange?: (id: string, value: string) => void
  onAction?: (
    request: AttentionRecord,
    action: AttentionAction | "reconcile",
  ) => Promise<void>
  canReconcile?: boolean
  onOpen?: (runId: string) => void
}
export function AgentRunInspector({
  snapshot,
  drafts = {},
  onDraftChange,
  onAction,
  canReconcile,
  onOpen,
}: AgentRunInspectorProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState("overview")
  const [step, setStep] = useState<string>()
  const [expanded, setExpanded] = useState<string[]>([])
  const { run } = snapshot
  return (
    <div data-agent-inspector={run.runId}>
      <Segmented
        aria-label={t("agentBoard.overview")}
        value={tab}
        onValueChange={(value) => setTab(String(value))}
      >
        {(["overview", "execution", "artifacts"] as const).map((id) => (
          <SegmentedItem key={id} value={id}>
            {t(`agentBoard.${id}`)}
          </SegmentedItem>
        ))}
      </Segmented>
      <Inspector
        object={{
          id: run.runId,
          title: run.title,
          kind: "Run",
          status: run.runtimeStatus,
          metadata: [
            { label: "Run ID", value: run.runId },
            { label: "Revision", value: run.revision },
            { label: "Source", value: run.source },
            { label: t("agentBoard.updated"), value: run.updatedAt },
            { label: t("agentBoard.queueTime"), value: run.queuedAt },
          ],
        }}
        state={run.completeness === "partial" ? "partial" : "success"}
      >
        {tab === "overview" && (
          <>
            <AgentRow
              agent={{
                id: run.agentId,
                name: run.agentName,
                model: run.model,
                status: run.agentStatus ?? "unknown",
              }}
            />
            <RunStageSummary stage={run.stage} status={run.runtimeStatus} />
            {run.sessionId && (
              <SessionRow
                session={{
                  id: run.sessionId,
                  title: run.sessionTitle ?? run.sessionId,
                  status: run.runtimeStatus,
                  updatedAt: run.updatedAt,
                }}
                action={undefined}
              />
            )}
            <div className={styles.actions}>
              {safeArtifactHref(run.sessionHref) && (
                <a href={safeArtifactHref(run.sessionHref)}>
                  {run.sessionTitle ?? run.sessionId}
                </a>
              )}
              {safeArtifactHref(run.workItemRef?.href) && (
                <a href={safeArtifactHref(run.workItemRef?.href)}>
                  {run.workItemRef?.title}
                </a>
              )}
            </div>
            <ReviewSummary review={run.review} />
            {snapshot.attention
              .filter((item) => item.runId === run.runId)
              .map((request) => (
                <ApprovalRequestPanel
                  key={`${request.attentionId}:${request.revision}`}
                  request={request}
                  draft={drafts[request.attentionId]}
                  onDraftChange={
                    onDraftChange
                      ? (value) => onDraftChange(request.attentionId, value)
                      : undefined
                  }
                  onAction={
                    onAction ? (action) => onAction(request, action) : undefined
                  }
                  canReconcile={canReconcile}
                />
              ))}
            <AgentRelationshipList
              records={snapshot.relationships}
              runId={run.runId}
              onOpen={onOpen}
            />
          </>
        )}
        {tab === "execution" && (
          <>
            <ExecutionTraceTree
              steps={snapshot.steps}
              selectedStepId={step}
              onSelect={setStep}
              expandedIds={expanded}
              onExpandedChange={setExpanded}
            />
            <ActivityTimeline
              events={snapshot.events}
              revision={run.revision}
              compact
            />
          </>
        )}
        {tab === "artifacts" && (
          <ArtifactList
            records={snapshot.artifacts.filter(
              (item) => item.runId === run.runId,
            )}
          />
        )}
      </Inspector>
    </div>
  )
}
