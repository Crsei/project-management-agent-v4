import type { ApOperationResult, ApScenario } from "../model.ts"
import { apModels } from "../fixtures/models.ts"
import {
  copyDataset,
  createEvaluationFixtures,
  type EvaluationDataset,
  type EvaluationExample,
  type EvaluationGrader,
  type EvaluationProvider,
  type EvaluationResult,
  type EvaluationRun,
  type EvaluationStatus,
} from "./fixtures.ts"

export type RunOutcome =
  "confirmed" | "partial" | "failed" | "rejected" | "unknown"
export type EvaluationPayload = {
  name: string
  dataset: EvaluationDataset
  provider: EvaluationProvider
  grader: EvaluationGrader
  outcome: RunOutcome
}
export type EvaluationOperation = {
  operationId: string
  status: ApOperationResult
  payload: EvaluationPayload
  result: EvaluationRun | null
}
export type EvaluationState = {
  datasets: EvaluationDataset[]
  runs: EvaluationRun[]
  providers: EvaluationProvider[]
  tab: string
  search: string
  status: string
  provider: string
  selectedId: string | null
  resultFilter: string
  compareId: string
  recovered: boolean
  notice: string
  sequence: number
  outcome: RunOutcome
  error: string
  operation: EvaluationOperation | null
  createOpen: boolean
  datasetId: string | null
  runDraft: {
    name: string
    datasetId: string
    providerId: string
    grader: EvaluationGrader
  }
  datasetDraft: { name: string; description: string }
  exampleDraft: EvaluationExample
  providerDraft: EvaluationProvider | null
  providerOpen: boolean
  datasetCreateOpen: boolean
  exampleOpen: boolean
  editingExampleId: string | null
  importOpen: boolean
  importDraft: string
}
export function createEvaluationState(scenario: ApScenario): EvaluationState {
  const fixture = createEvaluationFixtures(scenario)
  return {
    ...fixture,
    tab: "evaluations",
    search: "",
    status: "all",
    provider: "all",
    selectedId: fixture.runs[0]?.evaluationId ?? null,
    resultFilter: "all",
    compareId: "",
    recovered: false,
    notice: "",
    sequence: 100,
    outcome: "confirmed",
    error: "",
    operation: null,
    createOpen: false,
    datasetId: null,
    runDraft: {
      name: "",
      datasetId: fixture.datasets[0]?.datasetId ?? "",
      providerId: "openai",
      grader: "contains",
    },
    datasetDraft: { name: "", description: "" },
    exampleDraft: { exampleId: "", input: "", expected: "", candidate: "" },
    providerDraft: null,
    providerOpen: false,
    datasetCreateOpen: false,
    exampleOpen: false,
    editingExampleId: null,
    importOpen: false,
    importDraft: "",
  }
}
export function gradeDataset(
  dataset: EvaluationDataset,
  grader: EvaluationGrader,
): EvaluationResult[] {
  return dataset.examples.map((example) => ({
    ...example,
    passed:
      example.candidate === null
        ? null
        : grader === "contains"
          ? example.candidate
              .toLocaleLowerCase("en")
              .includes(example.expected.toLocaleLowerCase("en"))
          : example.candidate.trim().toLocaleLowerCase("en") ===
            example.expected.trim().toLocaleLowerCase("en"),
  }))
}
export function evaluationMetrics(run: EvaluationRun) {
  if (run.results === null)
    return {
      total: run.dataset.examples.length,
      scored: null,
      passed: null,
      failed: null,
      ungraded: null,
      percent: null,
    }
  const scored = run.results.filter((r) => r.passed !== null).length,
    passed = run.results.filter((r) => r.passed === true).length
  return {
    total: run.dataset.examples.length,
    scored,
    passed,
    failed: scored - passed,
    ungraded: run.dataset.examples.length - scored,
    percent: scored === 0 ? null : Math.round((passed / scored) * 100),
  }
}
export function evaluationCompatibility(
  a: EvaluationRun,
  b: EvaluationRun,
):
  | "compatible"
  | "dataset"
  | "version"
  | "configuration"
  | "coverage"
  | "unavailable" {
  if (a.dataset.datasetId !== b.dataset.datasetId) return "dataset"
  if (
    a.dataset.version !== b.dataset.version ||
    a.dataset.examples.map((e) => e.exampleId).join("|") !==
      b.dataset.examples.map((e) => e.exampleId).join("|")
  )
    return "version"
  if (a.configVersion !== b.configVersion || a.grader !== b.grader)
    return "configuration"
  if (!a.results || !b.results) return "unavailable"
  if (
    a.results.map((r) => (r.passed === null ? "?" : r.exampleId)).join("|") !==
    b.results.map((r) => (r.passed === null ? "?" : r.exampleId)).join("|")
  )
    return "coverage"
  return "compatible"
}
export function filteredEvaluations(state: EvaluationState): EvaluationRun[] {
  const q = state.search.trim().toLocaleLowerCase("en")
  return state.runs.filter(
    (run) =>
      (state.status === "all" || run.status === state.status) &&
      (state.provider === "all" || run.providerId === state.provider) &&
      (!q ||
        [run.name, run.evaluationId, run.dataset.name, run.modelLabel].some(
          (s) => s.toLocaleLowerCase("en").includes(q),
        )),
  )
}
export function startEvaluation(
  state: EvaluationState,
  canWrite: boolean,
): EvaluationState {
  if (
    !canWrite ||
    state.operation?.status === "pending" ||
    state.operation?.status === "unknown"
  )
    return state
  const draft = state.runDraft,
    dataset = state.datasets.find((d) => d.datasetId === draft.datasetId),
    provider = state.providers.find((p) => p.providerId === draft.providerId)
  if (!draft.name.trim()) return { ...state, error: "name" }
  if (!dataset || dataset.examples.length === 0)
    return { ...state, error: "empty-dataset" }
  if (
    !provider?.enabled ||
    !provider.modelId ||
    !apModels.some(
      (m) =>
        m.modelId === provider.modelId &&
        m.providerId === provider.providerId &&
        m.modality === "text" &&
        m.status === "available",
    )
  )
    return { ...state, error: "provider-incompatible" }
  const payload: EvaluationPayload = {
    name: draft.name.trim(),
    dataset: copyDataset(dataset),
    provider: { ...provider },
    grader: draft.grader,
    outcome: state.outcome,
  }
  return {
    ...state,
    sequence: state.sequence + 1,
    error: "",
    operation: {
      operationId: "eval-operation-" + (state.sequence + 1),
      status: "pending",
      payload,
      result: null,
    },
  }
}
function createRun(operation: EvaluationOperation): EvaluationRun {
  const { payload } = operation
  let results: EvaluationResult[] | null = gradeDataset(
    payload.dataset,
    payload.grader,
  )
  let status: EvaluationStatus = "completed"
  if (payload.outcome === "failed") {
    results = null
    status = "failed"
  }
  if (payload.outcome === "partial") {
    results = results!.map((r, i) =>
      i === results!.length - 1 ? { ...r, passed: null } : r,
    )
    status = "partial"
  }
  if (results?.some((r) => r.passed === null)) status = "partial"
  return {
    evaluationId: "eval_" + operation.operationId.split("-").at(-1),
    name: payload.name,
    dataset: copyDataset(payload.dataset),
    providerId: payload.provider.providerId,
    modelId: payload.provider.modelId,
    modelLabel: payload.provider.modelLabel,
    grader: payload.grader,
    configVersion:
      payload.grader === "contains" ? "contains-expected-v1" : "exact-match-v1",
    status,
    results,
    createdAt: "2026-10-13T12:00:00Z",
    failure:
      status === "failed"
        ? "Local grading interrupted. No scores are available."
        : null,
  }
}
export function settleEvaluation(state: EvaluationState): EvaluationState {
  const op = state.operation
  if (op?.status !== "pending") return state
  if (op.payload.outcome === "rejected")
    return {
      ...state,
      operation: { ...op, status: "rejected" },
      error: "rejected",
    }
  if (op.payload.outcome === "unknown")
    return {
      ...state,
      operation: { ...op, status: "unknown" },
      error: "unknown",
    }
  const result = createRun(op)
  return {
    ...state,
    operation: { ...op, status: "confirmed", result },
    runs: [result, ...state.runs],
    selectedId: result.evaluationId,
    tab: "evaluations",
    createOpen: false,
    notice: "created",
    error: "",
    compareId: "",
  }
}
export function checkEvaluation(state: EvaluationState): EvaluationState {
  const op = state.operation
  if (op?.status !== "unknown") return state
  const result = createRun(op)
  return {
    ...state,
    operation: { ...op, status: "confirmed", result },
    runs: state.runs.some((r) => r.evaluationId === result.evaluationId)
      ? state.runs
      : [result, ...state.runs],
    selectedId: result.evaluationId,
    createOpen: false,
    tab: "evaluations",
    error: "",
    notice: "checked",
  }
}
export function replaceDatasetExamples(
  state: EvaluationState,
  examples: EvaluationExample[],
  canWrite: boolean,
): EvaluationState {
  if (!canWrite) return state
  return {
    ...state,
    datasets: state.datasets.map((d) =>
      d.datasetId === state.datasetId
        ? {
            ...d,
            version: d.version + 1,
            examples: examples.map((e) => ({ ...e })),
          }
        : d,
    ),
    notice: "versioned",
    error: "",
  }
}
export function saveExample(
  state: EvaluationState,
  canWrite: boolean,
): EvaluationState {
  if (!canWrite) return state
  const draft = state.exampleDraft,
    dataset = state.datasets.find((d) => d.datasetId === state.datasetId)
  if (!dataset || !draft.input.trim() || !draft.expected.trim())
    return { ...state, error: "example-required" }
  const example = {
    ...draft,
    exampleId: state.editingExampleId ?? "example-" + (state.sequence + 1),
  }
  const examples = state.editingExampleId
    ? dataset.examples.map((e) =>
        e.exampleId === state.editingExampleId ? example : e,
      )
    : [...dataset.examples, example]
  return {
    ...replaceDatasetExamples(state, examples, canWrite),
    sequence: state.sequence + 1,
    exampleOpen: false,
    editingExampleId: null,
    exampleDraft: { exampleId: "", input: "", expected: "", candidate: "" },
  }
}
export function importExamples(
  state: EvaluationState,
  canWrite: boolean,
): EvaluationState {
  if (!canWrite) return state
  try {
    const lines = state.importDraft.trim().split(/\r?\n/).filter(Boolean)
    if (lines.length === 0 || lines.length > 500)
      return { ...state, error: "import-invalid" }
    const parsed: EvaluationExample[] = lines.map((line, i) => {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== "object")
        throw new Error("Invalid example")
      const item = value as Record<string, unknown>
      if (
        typeof item.input !== "string" ||
        !item.input.trim() ||
        typeof item.expected !== "string" ||
        !item.expected.trim() ||
        (typeof item.candidate !== "string" && item.candidate !== null)
      )
        throw new Error("Invalid example")
      return {
        exampleId: "import-" + state.sequence + "-" + i,
        input: item.input,
        expected: item.expected,
        candidate: item.candidate,
      }
    })
    const dataset = state.datasets.find((d) => d.datasetId === state.datasetId)
    if (!dataset) return state
    return {
      ...replaceDatasetExamples(
        state,
        [...dataset.examples, ...parsed],
        canWrite,
      ),
      sequence: state.sequence + 1,
      importOpen: false,
      importDraft: "",
    }
  } catch {
    return { ...state, error: "import-invalid" }
  }
}
export function exportEvaluation(run: EvaluationRun) {
  return JSON.stringify(
    {
      source: "fixture",
      schemaVersion: 1,
      evaluationId: run.evaluationId,
      datasetId: run.dataset.datasetId,
      datasetVersion: run.dataset.version,
      modelId: run.modelId,
      historicalModelLabel: run.modelLabel,
      configVersion: run.configVersion,
      metric: "pass-rate",
      denominator: "scored-examples",
      coverage: evaluationMetrics(run),
      status: run.status,
      results: run.results,
    },
    null,
    2,
  )
}
