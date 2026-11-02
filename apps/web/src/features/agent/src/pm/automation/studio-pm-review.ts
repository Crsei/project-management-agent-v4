import { StudioApiError } from "../../../../../../../../packages/contracts/src/automation-studio-client.ts";
import type { PmAutomationCandidate, PmAutomationCandidatePreview, PmAutomationTask } from "../../../../../../../../packages/contracts/src/automation-pm.ts";

export type PmReviewPending = {
  version: 1;
  requestId: string;
  executionId: string;
  projectId: string;
  candidateId: string;
  expectedRevision: number;
  kind: "edit" | "preview" | "apply" | "ignore";
  membershipVersion?: number;
  applyInput?: { previewToken: string; selectedItemIds?: string[] };
};

/** One unresolved review write per actor/workspace; switching executions cannot hide it. */
export function pmReviewJournalKey(actorId: string, workspaceId: string): string {
  return `pm.automation-pm.review.v1:${actorId}:${workspaceId}`;
}
export function readPmReviewPending(key: string): PmReviewPending | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as PmReviewPending;
  if (value.version !== 1 || !["edit", "preview", "apply", "ignore"].includes(value.kind) || !value.requestId || !value.executionId || !value.projectId || !value.candidateId || !Number.isInteger(value.expectedRevision) || value.expectedRevision < 1) throw new Error("Invalid PM review recovery journal; reconcile before writing");
  if (value.applyInput && (value.kind !== "apply" || typeof value.applyInput.previewToken !== "string" || !value.applyInput.previewToken || (value.applyInput.selectedItemIds !== undefined && (!Array.isArray(value.applyInput.selectedItemIds) || !value.applyInput.selectedItemIds.every(id => typeof id === "string"))))) throw new Error("Invalid frozen application input; reconcile the original receipt");
  return value;
}
export function recordPmReviewPending(key: string, pending: PmReviewPending): void {
  const original = readPmReviewPending(key);
  if (original && JSON.stringify(original) !== JSON.stringify(pending)) throw new Error("The original PM review request and frozen inputs must be reconciled first");
  sessionStorage.setItem(key, JSON.stringify(pending));
}
export function settlePmReviewPending(key: string, requestId: string): void {
  const original = readPmReviewPending(key);
  if (original && original.requestId !== requestId) throw new Error("Cannot settle a different PM review request");
  sessionStorage.removeItem(key);
}
/** Transport/server ambiguity is not a definite rejection and must retain the original request identity. */
export function pmReviewDefiniteRejection(cause: unknown): boolean {
  return cause instanceof StudioApiError && cause.code !== "invalid_response" && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status);
}
export function pmReviewDraftKey(actorId: string, workspaceId: string, membershipVersion: number, executionId: string, candidateId: string): string {
  return `pm.automation-pm.draft.v1:${actorId}:${workspaceId}:${membershipVersion}:${executionId}:${candidateId}`;
}
/** Private candidate text is erased on access changes; the separate uncertain request identity remains. */
export function redactPmReviewDrafts(actorId: string, workspaceId: string, membershipVersion = -1): void {
  const prefix = `pm.automation-pm.draft.v1:${actorId}:${workspaceId}:`;
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(prefix) && !key.startsWith(`${prefix}${membershipVersion}:`)) sessionStorage.removeItem(key);
  }
  const journalKey = pmReviewJournalKey(actorId, workspaceId);
  const pending = readPmReviewPending(journalKey);
  if (pending?.applyInput && pending.membershipVersion !== membershipVersion) {
    const identity = { ...pending }; delete identity.applyInput;
    sessionStorage.setItem(journalKey, JSON.stringify(identity));
  }
}

export function pmEvidenceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : null; } catch { return null; }
}

export function pmPlanSelectionIssue(candidate: PmAutomationCandidate, selected: readonly string[]): string | null {
  if (candidate.kind !== "plan") return null;
  if (!selected.length) return "Select at least one plan item; an empty selection never publishes the whole plan.";
  const byId = new Map(candidate.plan.tasks.map(task => [task.localId, task]));
  const chosen = new Set(selected);
  if (chosen.size !== selected.length || selected.some(id => !byId.has(id))) return "The selected plan item IDs are invalid.";
  for (const id of selected) for (const dependency of byId.get(id)!.dependsOnLocalIds) if (!chosen.has(dependency)) return `Selected item ${id} requires prerequisite ${dependency}. Select it explicitly; prerequisites are never silently published.`;
  return null;
}

/** Any edit or different publication subset invalidates an earlier confirmation preview. */
export function pmPreviewMatches(preview: PmAutomationCandidatePreview | null, candidate: PmAutomationCandidate, selected: readonly string[]): boolean {
  return !!preview?.canApply && !!preview.previewToken && JSON.stringify(preview.candidate) === JSON.stringify(candidate)
    && (candidate.kind !== "plan" || preview.selectedItemIds.length === selected.length && preview.selectedItemIds.every(id => selected.includes(id)));
}

/** User-triggered rebase updates review inputs only; historical source refs and quoted evidence never change. */
export function rebasePmCandidate(candidate: PmAutomationCandidate, preview: PmAutomationCandidatePreview): PmAutomationCandidate {
  if (candidate.id !== preview.candidate.id || candidate.kind !== preview.candidate.kind) throw new Error("The preview belongs to a different candidate");
  const originals = candidate.reviewSources ?? candidate.sourceRefs;
  if (originals.some(source => !preview.currentSources.some(current => current.id === source.id && current.kind === source.kind && current.actorId === source.actorId && current.workspaceId === source.workspaceId && current.projectId === source.projectId))) throw new Error("Not every original source is currently authorized; the proposal cannot be rebased");
  const next = { ...candidate, reviewSources: preview.currentSources };
  if (!("taskId" in next)) return next;
  const task = preview.currentTask;
  if (!task || task.id !== next.taskId) throw new Error("The current target task is unavailable; no revision is adopted");
  if (next.kind === "task-update") {
    const before = Object.fromEntries((Object.keys(next.after) as (keyof typeof next.after)[]).map(key => [key, task[key]])) as typeof next.before;
    return { ...next, expectedRevision: task.revision, before };
  }
  if (next.kind === "task-relation") return { ...next, expectedRevision: task.revision, before: next.relation === "related" ? task.relatedTaskIds : task.dependsOn };
  if (next.kind === "task-status") return { ...next, expectedRevision: task.revision, before: task.status };
  return { ...next, expectedRevision: task.revision };
}

/** Added fields also need an honest before value from the same frozen/rebased task revision. */
export function pmCandidateWithBefore(candidate: PmAutomationCandidate, task: PmAutomationTask | undefined): PmAutomationCandidate {
  if (candidate.kind !== "task-update" || !task || task.id !== candidate.taskId || task.revision !== candidate.expectedRevision) return candidate;
  return { ...candidate, before: Object.fromEntries((Object.keys(candidate.after) as (keyof typeof candidate.after)[]).map(key => [key, task[key]])) as typeof candidate.before };
}

/** Normalize user-entered line lists only at save, so typing a trailing newline never loses the next entry. */
export function normalizePmCandidate(candidate: PmAutomationCandidate): PmAutomationCandidate {
  const clean = (items: string[]) => items.map(item => item.trim()).filter(Boolean);
  function taskLists(task: Extract<PmAutomationCandidate, { kind: "create-task" }>["task"]) {
    const next = { ...task };
    for (const field of ["acceptanceCriteria", "labels", "dependsOn", "relatedTaskIds"] as const) next[field] = clean(task[field]);
    return next;
  }
  if (candidate.kind === "create-task") return { ...candidate, task: taskLists(candidate.task) };
  if (candidate.kind === "plan") return { ...candidate, plan: { ...candidate.plan, tasks: candidate.plan.tasks.map(task => ({ ...task, ...taskLists(task), dependsOnLocalIds: clean(task.dependsOnLocalIds) })) } };
  if (candidate.kind === "create-document") return { ...candidate, document: { ...candidate.document, taskIds: clean(candidate.document.taskIds) } };
  if (candidate.kind === "task-relation") return { ...candidate, after: clean(candidate.after) };
  if (candidate.kind === "task-update") {
    const after = { ...candidate.after };
    for (const field of ["acceptanceCriteria", "labels", "assigneeIds"] as const) { const items = after[field]; if (items) after[field] = clean(items); }
    return { ...candidate, after };
  }
  return candidate;
}
