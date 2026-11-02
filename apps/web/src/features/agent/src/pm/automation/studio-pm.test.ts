import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { automationCatalog, automationCatalogById, automationTemplateMaturity, automationTemplateRecommended } from "../../../../../../../../packages/contracts/src/automation-catalog.ts";
import { pmAutomationTemplateIds, type PmAutomationCandidate, type PmAutomationCandidatePreview, type PmAutomationSourceRef, type PmAutomationTask } from "../../../../../../../../packages/contracts/src/automation-pm.ts";
import { StudioApiError } from "../../../../../../../../packages/contracts/src/automation-studio-client.ts";
import { studioConfigSchema, studioNativeTemplateRequiresProvider, type StudioCapabilities } from "../../../../../../../../packages/contracts/src/automation-studio.ts";
import { filterStudioTemplates } from "./studio-template-catalog.ts";
import { emptyStudioConfig, normalizeStudioTemplateValues, studioPmArguments, templateDefaults } from "./studio-setup.ts";
import { studioPrerequisites } from "./studio-setup-dependencies.ts";
import { normalizePmCandidate, pmCandidateWithBefore, pmEvidenceUrl, pmPlanSelectionIssue, pmPreviewMatches, pmReviewDefiniteRejection, pmReviewDraftKey, pmReviewJournalKey, readPmReviewPending, rebasePmCandidate, recordPmReviewPending, redactPmReviewDrafts, settlePmReviewPending, type PmReviewPending } from "./studio-pm-review.ts";

const source: PmAutomationSourceRef = { refId: "task:TASK-001:r1", kind: "task", id: "TASK-001", revision: "r1", actorId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", projectId: "PRJ-001", label: "Original task", url: "/pm/workspace/tasks/TASK-001", updatedAt: "2026-10-01T00:00:00.000Z" };
const task: PmAutomationTask = { id: "TASK-001", sourceRefId: source.refId, revision: "r1", projectId: "PRJ-001", title: "Original title", description: "Original scope", status: "custom-open", statusCategory: "unstarted", archived: false, acceptanceCriteria: ["Real criterion"], labels: [], assigneeIds: [], dependsOn: [], relatedTaskIds: [], goalIds: [], allowedPaths: [], milestoneId: null, createdAt: null, updatedAt: null, lastActivityAt: null, progressNote: "" };
const candidate: PmAutomationCandidate = { id: "proposal-1", kind: "task-update", title: "Review requirement", rationale: "Scope is incomplete", sourceRefs: [source], evidence: [{ sourceRefId: source.refId, quote: "Original scope" }], status: "pending", revision: 1, taskId: "TASK-001", expectedRevision: "r1", before: { description: "Original scope" }, after: { description: "Reviewed scope" } };
const preview: PmAutomationCandidatePreview = { candidate, currentSources: [source], currentTask: task, canApply: true, conflicts: [], previewToken: "exact-preview", selectedItemIds: [] };
const blankFilters = { query: "", source: "", category: "", integration: "", trigger: "" };
function installStorage(t: TestContext) {
  const entries = new Map<string, string>(); const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else Reflect.deleteProperty(globalThis, "sessionStorage"); }); return entries;
}

test("all native PM scenarios are browsable alongside the pinned source, with independent source/category/manual filters", () => {
  const pm = filterStudioTemplates(automationCatalog, { ...blankFilters, source: "pm", trigger: "manual" });
  assert.deepEqual(new Set(pm.map(template => template.id)), new Set(pmAutomationTemplateIds));
  assert.equal(filterStudioTemplates(automationCatalog, { ...blankFilters, source: "openhands" }).length, 23);
  assert.equal(new Set(pm.map(template => template.category)).size, 4);
  assert.equal(filterStudioTemplates(automationCatalog, { ...blankFilters, source: "pm", category: "knowledge/changes", query: "15" })[0]?.id, "pm-requirement-change-impact");
  assert.deepEqual(pm.filter(automationTemplateRecommended).map(template => template.scenario), ["02", "03", "19"]);
  assert.ok(pm.every(template => automationTemplateMaturity(template) === "stable"));
  assert.equal(filterStudioTemplates(automationCatalog, { ...blankFilters, source: "pm", integration: "github" }).length, 0, "PM provenance is not an integration requirement");
});

test("native setup freezes schema-valid exact scope/version and does not turn empty selectors into project scope", () => {
  const template = automationCatalogById.get("pm-stalled-tasks")!;
  const args = studioPmArguments({ ...templateDefaults(template), taskIds: ["TASK-001"], statusIds: ["custom-open"] });
  const config = { ...emptyStudioConfig("PRJ-001"), name: template.name, templateId: template.id, templateVersion: template.version!, templateInputs: args, action: { kind: "template" as const, templateId: "pm-stalled-tasks" as const, arguments: args, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 600 } };
  const restored = studioConfigSchema.parse(JSON.parse(JSON.stringify(config)));
  assert.deepEqual(restored.templateInputs, args); assert.deepEqual(restored.action.kind === "template" && restored.action.arguments, args);
  assert.throws(() => studioPmArguments({ taskIds: [] }));
  assert.throws(() => studioPmArguments({ statusIds: [] }));
  assert.deepEqual(studioPmArguments({}), {});
  assert.equal(templateDefaults(automationCatalogById.get("pm-project-stagnation")).lookbackDays, 14);
  assert.equal(studioNativeTemplateRequiresProvider("pm-stalled-tasks"), false);
  assert.equal(studioNativeTemplateRequiresProvider("pm-requirement-review"), true);
});

test("PM-only readiness requires the real native handler, not invented connector tags", () => {
  const template = automationCatalogById.get("pm-stalled-tasks")!;
  const action = { kind: "template" as const, templateId: "pm-stalled-tasks" as const, arguments: {}, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 600 };
  const capabilities: StudioCapabilities = { canWrite: true, actions: [], providers: [], repositories: [], plugins: [], scheduler: { authority: "worker", ready: true, reason: null }, features: [{ id: "template:pm-stalled-tasks", available: true, reason: null }] };
  assert.deepEqual(studioPrerequisites(template, [], capabilities, action).map(item => [item.id, item.available]), [["template:pm-stalled-tasks", true]]);
  assert.equal(studioPrerequisites(template, [], null, action)[0]?.available, false);
});

test("selective publication rejects empty subsets and missing dependencies without silently adding items", () => {
  const taskDraft = { title: "Reachable task", description: "Explicit work", acceptanceCriteria: [], labels: [], dependsOn: [], relatedTaskIds: [], milestoneId: null };
  const plan: PmAutomationCandidate = { id: "plan", kind: "plan", title: "Plan", rationale: "Downstream work", sourceRefs: [source], evidence: [], revision: 1, status: "pending", plan: { title: "Plan", description: "", tasks: [{ ...taskDraft, localId: "existing", existingTaskId: "TASK-001", dependsOnLocalIds: [] }, { ...taskDraft, localId: "next", dependsOnLocalIds: ["existing"] }, { ...taskDraft, localId: "independent", dependsOnLocalIds: [] }] } };
  const selected = ["next"];
  assert.match(pmPlanSelectionIssue(plan, [])!, /empty selection/);
  assert.match(pmPlanSelectionIssue(plan, selected)!, /existing/); assert.deepEqual(selected, ["next"]);
  assert.equal(pmPlanSelectionIssue(plan, ["existing", "next"]), null);
  assert.equal(pmPlanSelectionIssue(plan, ["independent"]), null);
  assert.match(pmPlanSelectionIssue(plan, ["unknown"])!, /invalid/);
  const planPreview = { ...preview, candidate: plan, selectedItemIds: ["independent"] };
  assert.equal(pmPreviewMatches(planPreview, plan, ["independent"]), true);
  assert.equal(pmPreviewMatches(planPreview, plan, ["existing", "next"]), false);
});

test("a preview authorizes only its exact candidate revision and inputs", () => {
  assert.equal(pmPreviewMatches(preview, candidate, []), true);
  assert.equal(pmPreviewMatches(preview, { ...candidate, title: "Edited after preview" }, []), false);
  assert.equal(pmPreviewMatches({ ...preview, canApply: false }, candidate, []), false);
  assert.equal(pmPreviewMatches({ ...preview, previewToken: null }, candidate, []), false);
});

test("explicit source rebase preserves original quotes while deriving actual before/current revision", () => {
  const now = { ...task, revision: "r2", description: "Changed by another person", sourceRefId: "task:TASK-001:r2" };
  const currentSource = { ...source, revision: "r2", refId: now.sourceRefId };
  const rebased = rebasePmCandidate(candidate, { ...preview, currentSources: [currentSource], currentTask: now, canApply: false, conflicts: ["Source changed"], previewToken: null });
  assert.deepEqual(rebased.sourceRefs, candidate.sourceRefs); assert.deepEqual(rebased.evidence, candidate.evidence); assert.deepEqual(rebased.reviewSources, [currentSource]);
  assert.equal("expectedRevision" in rebased && rebased.expectedRevision, "r2");
  assert.deepEqual(rebased.kind === "task-update" && rebased.before, { description: "Changed by another person" });
  assert.deepEqual(candidate.kind === "task-update" && candidate.before, { description: "Original scope" });
  assert.throws(() => rebasePmCandidate(candidate, { ...preview, currentSources: [] }), /not every original source/i);
  assert.throws(() => rebasePmCandidate(candidate, { ...preview, currentTask: null }), /unavailable/);
  const added = pmCandidateWithBefore({ ...candidate, after: { description: "Revised", title: "New title" } }, task);
  assert.deepEqual(added.kind === "task-update" && added.before, { description: "Original scope", title: "Original title" });
});

test("unknown review writes survive reload and cannot be replaced with a fresh request ID", t => {
  installStorage(t); const key = pmReviewJournalKey("actor", "workspace");
  const pending: PmReviewPending = { version: 1, requestId: "original-request", executionId: "execution", projectId: "PRJ-001", candidateId: "candidate", expectedRevision: 1, kind: "apply" };
  recordPmReviewPending(key, pending); assert.deepEqual(readPmReviewPending(key), pending);
  assert.equal(readPmReviewPending(pmReviewJournalKey("other-actor", "workspace")), null);
  assert.throws(() => recordPmReviewPending(key, { ...pending, requestId: "fresh-key" }), /original/);
  assert.throws(() => settlePmReviewPending(key, "fresh-key"), /different/);
  assert.equal(pmReviewDefiniteRejection(new StudioApiError(409, "version_conflict", "Conflict")), true);
  assert.equal(pmReviewDefiniteRejection(new StudioApiError(502, "bad_gateway", "Unknown")), false);
  assert.equal(pmReviewDefiniteRejection(new StudioApiError(200, "invalid_response", "Lost body")), false);
  assert.equal(pmReviewDefiniteRejection(new TypeError("Connection dropped")), false);
  settlePmReviewPending(key, pending.requestId); assert.equal(readPmReviewPending(key), null);
});

test("authorization changes erase private candidate drafts but retain uncertain receipt identity", t => {
  const entries = installStorage(t); const key = pmReviewJournalKey("actor", "workspace");
  const pending: PmReviewPending = { version: 1, requestId: "unknown", executionId: "execution", projectId: "PRJ-001", candidateId: "candidate", expectedRevision: 2, kind: "apply" };
  recordPmReviewPending(key, pending);
  entries.set(pmReviewDraftKey("actor", "workspace", 1, "execution", "candidate"), "private old text");
  entries.set(pmReviewDraftKey("actor", "workspace", 2, "execution", "candidate"), "private current text");
  redactPmReviewDrafts("actor", "workspace", 2); assert.equal([...entries.values()].includes("private old text"), false); assert.equal([...entries.values()].includes("private current text"), true);
  redactPmReviewDrafts("actor", "workspace"); assert.equal([...entries.values()].some(value => value.includes("private")), false); assert.deepEqual(readPmReviewPending(key), pending);
});

test("untrusted source URLs never become script or protocol-relative links", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,bad", "//outside.example/path", "/\\outside.example/path"]) assert.equal(pmEvidenceUrl(value), null);
  assert.equal(pmEvidenceUrl("/pm/projects/PRJ-001/tasks/TASK-001"), "/pm/projects/PRJ-001/tasks/TASK-001");
  assert.equal(pmEvidenceUrl("https://example.test/repo/pull/1"), "https://example.test/repo/pull/1");
});

test("line-list editing retains a trailing newline until save, then normalizes without widening empty scope", () => {
  const template = automationCatalogById.get("pm-stalled-tasks")!;
  const editing = { taskIds: [" TASK-001 ", ""], labels: ["backend", ""] };
  const saved = normalizeStudioTemplateValues(template, editing);
  assert.deepEqual(editing.taskIds, [" TASK-001 ", ""], "typing state is not mutated");
  assert.deepEqual(studioPmArguments(saved), { taskIds: ["TASK-001"], labels: ["backend"] });
  assert.throws(() => studioPmArguments(normalizeStudioTemplateValues(template, { taskIds: ["", " "] })), "blank explicit selectors must not disappear");
  const draft = { ...candidate, after: { acceptanceCriteria: [" criterion ", ""], labels: [" backend ", ""] } };
  const normalized = normalizePmCandidate(draft);
  assert.deepEqual(normalized.kind === "task-update" && normalized.after, { acceptanceCriteria: ["criterion"], labels: ["backend"] });
  assert.deepEqual(draft.after.acceptanceCriteria, [" criterion ", ""]);
  assert.deepEqual(normalized.sourceRefs, candidate.sourceRefs); assert.deepEqual(normalized.evidence, candidate.evidence);
});

test("the frozen original application input survives receipt-only recovery and cannot be changed under the same ID", t => {
  installStorage(t); const key = pmReviewJournalKey("actor", "workspace");
  const pending: PmReviewPending = { version: 1, requestId: "approved-original", executionId: "execution", projectId: "PRJ-001", candidateId: "plan", expectedRevision: 4, kind: "apply", membershipVersion: 2, applyInput: { previewToken: "exact-token", selectedItemIds: ["first", "next"] } };
  recordPmReviewPending(key, pending);
  assert.deepEqual(readPmReviewPending(key)?.applyInput, pending.applyInput);
  assert.throws(() => recordPmReviewPending(key, { ...pending, applyInput: { previewToken: "new-token", selectedItemIds: ["other"] } }), /original/);
  redactPmReviewDrafts("actor", "workspace", 2); assert.deepEqual(readPmReviewPending(key)?.applyInput, pending.applyInput);
  redactPmReviewDrafts("actor", "workspace", 3);
  const identity = readPmReviewPending(key);
  assert.equal(identity?.requestId, pending.requestId); assert.equal(identity?.expectedRevision, 4);
  assert.equal(identity?.applyInput, undefined, "authorization changes permit receipt reads only, never continuation of private frozen input");
});

test("the project digest leaves its UTC-day default unset and preserves explicit custom lookback", () => {
  const template = automationCatalogById.get("pm-project-digest")!;
  const defaults = templateDefaults(template);
  assert.equal(Object.hasOwn(defaults, "lookbackDays"), false);
  const absent = studioPmArguments(normalizeStudioTemplateValues(template, defaults));
  assert.equal(absent.lookbackDays, undefined);
  const custom = studioPmArguments(normalizeStudioTemplateValues(template, { ...defaults, lookbackDays: 3 }));
  assert.equal(custom.lookbackDays, 3);
});
