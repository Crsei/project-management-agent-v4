"use client"
import { useMemo } from "react"
import { WorkflowCanvas } from "./workflow-canvas"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import { useI18n } from "../../lib/i18n-provider"
import { prepareAgentDependencies } from "../../lib/agent-board-p2"
import type {
  AgentRunDependency,
  AgentRunSnapshot,
} from "../../lib/agent-board-model"
import type { CanvasDocument, CanvasNodeDefinition } from "../../lib/canvas-model"
import styles from "./agent-board-p2.module.css"
export type AgentDependencyGraphProps = {
  records: readonly AgentRunSnapshot[]
  dependencies: readonly AgentRunDependency[]
  selectedRunId?: string | null
  scopeRunIds?: readonly string[]
  onOpen?: (runId: string) => void
  maxNodes?: number
  data?: Omit<DataRegionProps, "children" | "hasContent">
}
/** Canvas is only a read-only renderer. No Canvas execution snapshot or command is created. */
export function AgentDependencyGraph({
  records,
  dependencies,
  selectedRunId,
  scopeRunIds,
  onOpen,
  maxNodes,
  data,
}: AgentDependencyGraphProps) {
  const { t } = useI18n()
  const model = useMemo(
    () =>
      prepareAgentDependencies(records, dependencies, scopeRunIds, maxNodes),
    [records, dependencies, scopeRunIds, maxNodes],
  )
  const definitions: CanvasNodeDefinition[] = useMemo(
    () => [
      {
        type: "agent-run-reference",
        label: t("agentBoardP2.runReference"),
        category: "Agent",
        defaults: {},
        ports: [
          {
            id: "prerequisite",
            label: t("agentBoardP2.prerequisite"),
            direction: "input",
            type: "object",
          },
          {
            id: "dependent",
            label: t("agentBoardP2.dependent"),
            direction: "output",
            type: "object",
          },
        ],
        summary: (node) => String(node.config.summary ?? node.id),
      },
    ],
    [t],
  )
  const document: CanvasDocument = useMemo(
    () => ({
      schemaVersion: 1,
      id: "agent-dependencies",
      revision: 0,
      frames: [],
      notes: [],
      nodes: model.visible.map((run) => ({
        id: run.runId,
        type: "agent-run-reference",
        title: run.title,
        position: model.positions.get(run.runId)!,
        config: { summary: `${run.runId} · ${run.runtimeStatus}` },
      })),
      edges: model.drawable.map((edge) => ({
        id: edge.dependencyId,
        source: edge.prerequisiteRunId,
        sourcePort: "dependent",
        target: edge.dependentRunId,
        targetPort: "prerequisite",
        label: `${edge.label} · ${t(`agentBoardP2.${edge.state}`)}`,
      })),
    }),
    [model, t],
  )
  const open = (id: string) => {
    if (model.byId.has(id)) onOpen?.(id)
  }
  return (
    <section className={styles.section} data-agent-dependencies>
      <h2 className={styles.heading}>{t("agentBoard.dependencies")}</h2>
      <p className={styles.meta}>
        {t("agentBoardP2.dependencyScope", {
          runs: model.visible.length,
          edges: model.relevant.length,
        })}
      </p>
      <p className={styles.meta}>{t("agentBoardP2.readOnlyGraph")}</p>
      {model.missing.length > 0 && (
        <p className={styles.warning} role="status">
          {t("agentBoardP2.missingEndpoints", { count: model.missing.length })}
        </p>
      )}
      {model.outsideScope.length > 0 && (
        <p className={styles.warning}>
          {t("agentBoardP2.outsideScope", { count: model.outsideScope.length })}
        </p>
      )}
      {model.omitted > 0 && (
        <p className={styles.warning}>
          {t("agentBoardP2.graphLimit", { count: model.omitted })}
        </p>
      )}
      {model.unresolved.size > 0 && (
        <p className={styles.warning} role="status">
          {t("agentBoardP2.unsortedDependencies")}
        </p>
      )}
      <DataRegion
        {...data}
        state={data?.state ?? (model.relevant.length ? "success" : "empty")}
        hasContent={model.relevant.length > 0}
        emptyTitle={t("agentBoardP2.noDependencies")}
      >
        <div className={styles.graph}>
          <WorkflowCanvas
            document={document}
            definitions={definitions}
            readOnly
            selection={{
              nodeIds: selectedRunId ? [selectedRunId] : [],
              edgeIds: [],
            }}
            onSelectionChange={(selection) => {
              if (selection.nodeIds[0]) open(selection.nodeIds[0])
            }}
            onOpenNode={open}
            executionVisuals={{ edgeEffect: "none", paused: true }}
          />
        </div>
        <ol
          className={styles.links}
          aria-label={t("agentBoardP2.dependencyAlternative")}
        >
          {model.relevant.map((edge) => (
            <li
              className={styles.dependency}
              key={edge.dependencyId}
              data-dependency-id={edge.dependencyId}
            >
              {([edge.prerequisiteRunId, edge.dependentRunId] as const).map(
                (id, index) => (
                  <span key={index}>
                    {index === 1 && " → "}
                    {onOpen && model.byId.has(id) ? (
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => open(id)}
                      >
                        {model.byId.get(id)!.title} · {id}
                      </button>
                    ) : (
                      <span>
                        {model.byId.get(id)?.title ??
                          t("agentBoardP2.missingRun")}{" "}
                        · {id}
                      </span>
                    )}
                    {model.byId.has(id) && (
                      <>
                        {" "}
                        <RuntimeStatusBadge
                          status={model.byId.get(id)!.runtimeStatus}
                        />
                      </>
                    )}
                  </span>
                ),
              )}
              <p>
                {edge.label} · {t(`agentBoardP2.${edge.state}`)} · rev{" "}
                {edge.revision}
              </p>
            </li>
          ))}
        </ol>
      </DataRegion>
    </section>
  )
}
