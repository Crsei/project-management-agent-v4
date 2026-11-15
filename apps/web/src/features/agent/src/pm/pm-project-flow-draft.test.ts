import assert from "node:assert/strict";
import test from "node:test";
import { appendProjectFlowDraft, projectFlowFileReference, projectFlowReferenceAdditions, selectedProjectFlowTask, type ProjectFlowScope, type ProjectFlowTaskSelection } from "./pm-project-flow-draft.ts";
import type { FileRecord } from "@pm-schema";
import type { PmReference } from "./pm-types.ts";

const scope: ProjectFlowScope = { threadId: "chat-a", workspaceId: "workspace-a", projectId: "PRJ-010" };
const task: PmReference = { workspaceId: scope.workspaceId, projectId: scope.projectId, id: "TASK-010", kind: "issue", title: "Current task", revision: "rev-a", availability: "unverified" };
const selection: ProjectFlowTaskSelection = { ...scope, id: task.id, revision: task.revision };
const project: PmReference = { ...task, id: scope.projectId, kind: "project", title: "Project" };

test("execution requires an explicit selection even with one referenced task", () => {
  assert.equal(selectedProjectFlowTask(scope, null, [task]), null);
  assert.equal(selectedProjectFlowTask(scope, selection, [task]), task);
});

test("task identity cannot cross a project, workspace, Session or revision boundary", () => {
  assert.equal(selectedProjectFlowTask({ ...scope, threadId: "chat-b" }, selection, [task]), null);
  assert.equal(selectedProjectFlowTask({ ...scope, workspaceId: "workspace-b" }, selection, [task]), null);
  assert.equal(selectedProjectFlowTask({ ...scope, projectId: "PRJ-020" }, selection, [task]), null);
  assert.equal(selectedProjectFlowTask(scope, selection, [{ ...task, projectId: "PRJ-020" }]), null);
  assert.equal(selectedProjectFlowTask(scope, selection, [{ ...task, revision: "rev-b" }]), null);
  assert.equal(selectedProjectFlowTask(scope, selection, []), null);
  assert.equal(selectedProjectFlowTask(scope, selection, [{ ...task, kind: "document" }]), null);
});

test("unavailable, changed and deleted references cannot become execution selections", () => {
  for (const availability of ["forbidden", "stale", "deleted"] as const) {
    assert.equal(selectedProjectFlowTask(scope, selection, [{ ...task, availability }]), null);
  }
});

test("adding required project references preserves other draft selections without truncation", () => {
  const other: PmReference = { ...task, workspaceId: "workspace-b", projectId: "PRJ-020" };
  const references = [other, task];
  const before = structuredClone(references);
  assert.deepEqual(projectFlowReferenceAdditions(references, [project, task], 3), { additions: [project], error: null });
  assert.deepEqual(references, before);
  assert.deepEqual(projectFlowReferenceAdditions(references, [project, task], 2), { additions: [], error: "limit" });
  assert.deepEqual(references, before);
});

test("project references work for empty boards and do not duplicate exact identities", () => {
  assert.deepEqual(projectFlowReferenceAdditions([], [project], 20), { additions: [project], error: null });
  assert.deepEqual(projectFlowReferenceAdditions([project], [project, project], 1), { additions: [], error: null });
});

test("preparation never silently refreshes or replaces stale draft references", () => {
  const oldProject = { ...project, revision: "old" };
  assert.deepEqual(projectFlowReferenceAdditions([oldProject], [project], 20), { additions: [], error: "stale" });
  assert.equal(oldProject.revision, "old");
  assert.deepEqual(projectFlowReferenceAdditions([{ ...project, availability: "forbidden" }], [project], 20), { additions: [], error: "stale" });
});

test("phase preparation appends to current text without trimming or replacing it", () => {
  assert.equal(appendProjectFlowDraft("", "draft"), "draft");
  assert.equal(appendProjectFlowDraft("  unfinished\n", "draft"), "  unfinished\n\n\ndraft");
  assert.equal(appendProjectFlowDraft(" ", "draft"), " \n\ndraft");
});

test("native file revision is required; stale or mismatched sources never prepare project/task references", () => {
  const file: FileRecord = { id: scope.projectId, path: "project.md", raw: "# Project", revision: "a".repeat(64),
    entity: { schema: "pm/v1", id: scope.projectId, entity: "project", title: "Project", body: "# Project", blocked_by: [], related_to: [], labels: [], links: [], checklist: [], views: [] } };
  assert.equal(projectFlowFileReference(file, scope, "project", scope.projectId)?.revision, file.revision);
  for (const invalid of [{ ...file, stale: true }, { ...file, error: "FILE_UNREADABLE" },
    { ...file, diagnostics: [{ code: "FILE_UNREADABLE", severity: "error" as const, path: file.path, message: "Unreadable" }] },
    { ...file, revision: "" }, { ...file, id: "PRJ-020" }, { ...file, entity: { ...file.entity, id: "PRJ-020" } }]) {
    assert.equal(projectFlowFileReference(invalid, scope, "project", scope.projectId), null);
  }
  const taskFile: FileRecord = { ...file, id: task.id, entity: { ...file.entity, id: task.id, entity: "work_item", project: scope.projectId } };
  assert.equal(projectFlowFileReference(taskFile, scope, "issue", task.id)?.revision, file.revision);
  assert.equal(projectFlowFileReference({ ...taskFile, entity: { ...taskFile.entity, project: "PRJ-020" } }, scope, "issue", task.id), null);
  assert.equal(projectFlowFileReference({ id: file.id, path: file.path, raw: file.raw, revision: file.revision, readOnly: true, diagnostics: [] }, scope, "project", scope.projectId), null);
});
