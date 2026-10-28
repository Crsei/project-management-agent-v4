"use client"
import { useState, lazy, Suspense } from "react"
const WorkflowCanvas = lazy(() =>
  import("../workflow-canvas").then((m) => ({
    default: m.WorkflowCanvas,
  })),
)
import { DataTable } from "../data-table"
import { Button } from "../../ui/button"
import {
  dependencyCycles,
  type WorkDependency,
} from "../../../lib/analytics-dependency-model"
import {
  analyticsEntityKey,
  type AnalyticsEntityRef,
} from "../../../lib/analytics-model"
import type {
  CanvasSelection,
  CanvasDocument,
  CanvasNodeDefinition,
} from "../../../lib/canvas-model"
import { useI18n } from "../../../lib/i18n-provider"
export function WorkDependencyView({
  dependencies,
  onOpenEntity,
}: {
  dependencies: readonly WorkDependency[]
  onOpenEntity?: (ref: AnalyticsEntityRef) => void
}) {
  const { t } = useI18n(),
    [selection, setSelection] = useState<CanvasSelection>({
      nodeIds: [],
      edgeIds: [],
    }),
    [graph, setGraph] = useState(false),
    cycles = dependencyCycles(dependencies),
    refs = [
      ...new Map(
        dependencies
          .flatMap((d) => [d.from, d.to])
          .map((r) => [analyticsEntityKey(r), r]),
      ).values(),
    ]
  const definitions: CanvasNodeDefinition[] = [
    {
      type: "work",
      label: t("analytics.source"),
      category: "work",
      defaults: {},
      ports: [
        { id: "in", label: "in", direction: "input", type: "object" },
        { id: "out", label: "out", direction: "output", type: "object" },
      ],
    },
  ]
  const doc: CanvasDocument = {
    schemaVersion: 1,
    id: "analytics-dependencies",
    revision: 0,
    frames: [],
    notes: [],
    nodes: refs.map((r, i) => ({
      id: analyticsEntityKey(r),
      type: "work",
      title: r.entityId,
      position: { x: (i % 3) * 260, y: Math.floor(i / 3) * 160 },
      config: {},
    })),
    edges: dependencies.map((d) => ({
      id: d.id,
      source: analyticsEntityKey(d.from),
      sourcePort: "out",
      target: analyticsEntityKey(d.to),
      targetPort: "in",
    })),
  }
  return (
    <section>
      <h2>{t("analytics.dependencies")}</h2>
      <p>
        {t("analytics.dependencyDefinition")} · {t("analytics.cycles")}:{" "}
        {cycles.length}
      </p>
      <Button
        variant="secondary"
        disabled={refs.length > 200}
        onClick={() => setGraph(!graph)}
      >
        {t(graph ? "analytics.table" : "analytics.dependencyGraph")}
      </Button>
      {refs.length > 200 && <p>{t("analytics.graphBound")}</p>}
      {graph && (
        <div style={{ height: 400 }}>
          <Suspense fallback={<p>{t("analytics.pending")}</p>}>
            <WorkflowCanvas
              document={doc}
              definitions={definitions}
              selection={selection}
              onSelectionChange={setSelection}
              readOnly
              onOpenNode={(node) => {
                const ref = refs.find((r) => analyticsEntityKey(r) === node)
                if (ref) onOpenEntity?.(ref)
              }}
            />
          </Suspense>
        </div>
      )}
      <DataTable
        caption={t("analytics.dependencies")}
        rows={dependencies}
        getRowId={(d) => d.id}
        getRowLabel={(d) => `${d.from.entityId} → ${d.to.entityId}`}
        columns={[
          {
            id: "from",
            header: t("analytics.source"),
            cell: (d) => (
              <Button
                variant="ghost"
                disabled={!onOpenEntity}
                onClick={() => onOpenEntity?.(d.from)}
              >
                {d.from.entityId}
              </Button>
            ),
          },
          {
            id: "to",
            header: t("analytics.target"),
            cell: (d) => (
              <Button
                variant="ghost"
                disabled={!onOpenEntity}
                onClick={() => onOpenEntity?.(d.to)}
              >
                {d.to.entityId}
              </Button>
            ),
          },
          {
            id: "state",
            header: t("analytics.businessDependency"),
            cell: (d) => t(`analytics.dependency.${d.state}`),
          },
          {
            id: "evidence",
            header: t("analytics.evidence"),
            cell: (d) => d.evidence,
          },
        ]}
      />
    </section>
  )
}
