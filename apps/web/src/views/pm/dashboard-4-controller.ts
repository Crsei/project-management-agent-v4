import type {
  CanvasDocument,
  CanvasEdgeRecord,
  CanvasIssue,
  CanvasNodeDefinition,
  CanvasNodeRecord,
  CanvasSelection,
} from "@/lib/canvas-model"
import { usePmScenarioState } from "./shared"
import type { ProjectCardRecord } from "./project-list-1-fixtures"
import {
  dashboardDependencies,
  dashboardDependencyProjectIds,
  type DashboardDependencyEdge,
} from "./dashboards-fixtures"
import { type DependencyGraphIssue } from "./dashboards-views"
import { projectHealthBand, type ProjectHealthBand } from "./project-health"

export type Dashboard4Risk = "all" | ProjectHealthBand
export type Dashboard4Viewport = { x: number; y: number; zoom: number }
export type Dashboard4State = {
  risk: Dashboard4Risk
  selection: CanvasSelection
  activeProjectId: string | null
  viewport: Dashboard4Viewport | null
}
// Presentation-only placement measured from the reference; dependency facts stay in stored edges.
const dependencyPositions: Readonly<Record<string, { x: number; y: number }>> = {
  "project-rev-241": { x: 86, y: 72 },
  "project-mob-092": { x: 46, y: 250 },
  "project-onb-118": { x: 410, y: 232 },
  "project-kb-057": { x: 730, y: 72 },
  "project-rtl-062": { x: 790, y: 250 },
  "project-clm-084": { x: 120, y: 420 },
  "project-sla-203": { x: 665, y: 400 },
}
export function createDashboard4State(): Dashboard4State {
  return {
    risk: "all",
    selection: { nodeIds: [], edgeIds: [] },
    activeProjectId: null,
    viewport: null,
  }
}
export function useDashboard4State() {
  return usePmScenarioState("pm-dashboard-4-state", createDashboard4State)
}
export type DependencyAnalysis = {
  /** Projects that have a dependency record and exist in the project domain. */
  nodeIds: string[]
  /** Edges with both endpoints present, excluding self loops and cycles. */
  chainEdges: DashboardDependencyEdge[]
  cycleEdges: DashboardDependencyEdge[]
  cycleNodeIds: string[]
  selfLoopEdges: DashboardDependencyEdge[]
  danglingEdges: {
    edge: DashboardDependencyEdge
    missingIds: string[]
  }[]
  issues: DependencyGraphIssue[]
  criticalPath: { projectId: string; via: string }[]
  excludedFromCriticalPath: number
}
function reachable(
  adjacency: Map<string, string[]>,
  from: string,
  target: string,
) {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === target && id !== from) return true
    for (const next of adjacency.get(id) ?? [])
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
  }
  return false
}
/**
 * Dependencies come only from stored edge records. Self loops, cycles and
 * dangling ids stay visible; the critical path never derives from positions.
 */
export function analyzeDependencies(
  projects: readonly ProjectCardRecord[],
): DependencyAnalysis {
  const present = new Set(
    projects
      .filter((project) => dashboardDependencyProjectIds.includes(project.id))
      .map((project) => project.id),
  )
  const nodeIds = dashboardDependencyProjectIds.filter((id) => present.has(id))
  const danglingEdges: DependencyAnalysis["danglingEdges"] = []
  const selfLoopEdges: DashboardDependencyEdge[] = []
  const candidates: DashboardDependencyEdge[] = []
  for (const edge of dashboardDependencies) {
    const missingIds = [edge.source, edge.target].filter(
      (id) => !present.has(id),
    )
    if (missingIds.length) danglingEdges.push({ edge, missingIds })
    else if (edge.source === edge.target) selfLoopEdges.push(edge)
    else candidates.push(edge)
  }
  const adjacency = new Map<string, string[]>()
  for (const edge of candidates) {
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge.target,
    ])
  }
  const cycleEdges = candidates.filter((edge) =>
    reachable(adjacency, edge.target, edge.source),
  )
  const cycleEdgeIds = new Set(cycleEdges.map((edge) => edge.id))
  const cycleNodeIds = [
    ...new Set(cycleEdges.flatMap((edge) => [edge.source, edge.target])),
  ]
  const chainEdges = candidates.filter((edge) => !cycleEdgeIds.has(edge.id))
  const chainAdjacency = new Map<
    string,
    { id: string; target: string; label: string }[]
  >()
  for (const edge of chainEdges)
    chainAdjacency.set(edge.source, [
      ...(chainAdjacency.get(edge.source) ?? []),
      { id: edge.id, target: edge.target, label: edge.label },
    ])
  const best = new Map<string, { path: string[]; via: string[] }>()
  function longestFrom(id: string): { path: string[]; via: string[] } {
    const cached = best.get(id)
    if (cached) return cached
    let winner: { path: string[]; via: string[] } = { path: [id], via: [] }
    for (const edge of chainAdjacency.get(id) ?? []) {
      const tail = longestFrom(edge.target)
      const candidate = {
        path: [id, ...tail.path],
        via: [edge.label, ...tail.via],
      }
      if (candidate.path.length > winner.path.length) winner = candidate
    }
    best.set(id, winner)
    return winner
  }
  let critical: { path: string[]; via: string[] } = { path: [], via: [] }
  for (const id of nodeIds) {
    const candidate = longestFrom(id)
    if (candidate.path.length > critical.path.length) critical = candidate
  }
  const issues: DependencyGraphIssue[] = [
    ...danglingEdges.map(({ edge, missingIds }) => ({
      id: `dangling-${edge.id}`,
      code: "dangling" as const,
      severity: "error" as const,
      message: `${edge.id}: ${edge.source} → ${edge.target} (${edge.label}) references missing ${missingIds.join(", ")}`,
    })),
    ...cycleEdges.map((edge) => ({
      id: `cycle-${edge.id}`,
      code: "cycle" as const,
      severity: "warning" as const,
      message: `${edge.id}: ${edge.source} → ${edge.target} (${edge.label}) closes a dependency cycle`,
    })),
    ...selfLoopEdges.map((edge) => ({
      id: `self-${edge.id}`,
      code: "self-loop" as const,
      severity: "error" as const,
      message: `${edge.id}: ${edge.source} depends on itself (${edge.label})`,
    })),
  ]
  return {
    nodeIds,
    chainEdges,
    cycleEdges,
    cycleNodeIds,
    selfLoopEdges,
    danglingEdges,
    issues,
    criticalPath: critical.path.map((projectId, index) => ({
      projectId,
      // via is the label of the chain edge INTO this step; step 0 has none.
      via: index === 0 ? "" : (critical.via[index - 1] ?? ""),
    })),
    excludedFromCriticalPath:
      cycleEdges.length + selfLoopEdges.length + danglingEdges.length,
  }
}
/** Nodes carry a precomputed bilingual title/summary; positions are presentation only. */
export function dependencyDocument(
  scopeNodeIds: readonly string[],
  analysis: DependencyAnalysis,
  meta: Readonly<Record<string, { title: string; summary: string }>>,
  viewport: Dashboard4Viewport | null,
): CanvasDocument {
  const scope = new Set(scopeNodeIds)
  const nodes: CanvasNodeRecord[] = scopeNodeIds.map((id) => ({
    id,
    type: "project-dependency",
    title: meta[id]?.title ?? id,
    position: dependencyPositions[id] ?? { x: 24, y: 400 },
    config: { summary: meta[id]?.summary ?? id },
  }))
  const edges: CanvasEdgeRecord[] = [
    ...analysis.chainEdges,
    ...analysis.cycleEdges,
    ...analysis.selfLoopEdges,
  ]
    .filter((edge) => scope.has(edge.source) && scope.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourcePort: "blocks",
      target: edge.target,
      targetPort: "depends-on",
      label: edge.label,
    }))
  return {
    schemaVersion: 1,
    id: "pm-dashboard-4-dependencies",
    revision: 0,
    nodes,
    edges,
    frames: [],
    notes: [],
    ...(viewport ? { viewport } : {}),
  }
}
/** Engine issues for node badges; dangling edges have no renderable node target. */
export function dependencyCanvasIssues(
  analysis: DependencyAnalysis,
  scope: ReadonlySet<string>,
): CanvasIssue[] {
  const canvasIssues: CanvasIssue[] = []
  for (const issue of analysis.issues) {
    const edgeId = issue.id.replace(/^(dangling|cycle|self)-/, "")
    const edge = dashboardDependencies.find((item) => item.id === edgeId)
    if (!edge) continue
    const attach =
      issue.code === "dangling"
        ? scope.has(edge.source)
          ? edge.source
          : undefined
        : edge.source
    canvasIssues.push({
      code: issue.code,
      message: issue.message,
      ...(attach ? { nodeId: attach } : {}),
      edgeId: edge.id,
      severity: issue.severity,
    })
  }
  return canvasIssues
}
export function dependencyDefinitions(labels: {
  definition: string
  dependsOn: string
  blocks: string
}): CanvasNodeDefinition[] {
  return [
    {
      type: "project-dependency",
      label: labels.definition,
      category: "Portfolio",
      defaults: {},
      ports: [
        {
          id: "depends-on",
          label: labels.dependsOn,
          direction: "input",
          type: "object",
        },
        {
          id: "blocks",
          label: labels.blocks,
          direction: "output",
          type: "object",
        },
      ],
      summary: (node) => String(node.config.summary ?? node.id),
    },
  ]
}
export function riskCounts(projects: readonly ProjectCardRecord[]) {
  const counts: Record<ProjectHealthBand, number> = {
    "on-track": 0,
    "at-risk": 0,
    "off-track": 0,
    unknown: 0,
  }
  for (const project of projects) counts[projectHealthBand(project.health)] += 1
  return counts
}
