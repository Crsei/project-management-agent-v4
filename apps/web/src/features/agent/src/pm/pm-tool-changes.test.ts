import assert from "node:assert/strict";
import test from "node:test";
import type { PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { isPmToolBusinessWrite, pmToolChanges } from "./pm-tool-changes.ts";
import { pmToolFixtureRecord, pmToolResultFixtures } from "../chat/pm-tool-result.fixtures.ts";

const base: PmToolCallRecord = {
  operationId: "operation-1", name: "pm_update_task", status: "succeeded",
  threadId: "thread-1", messageId: "message-1", generationId: "generation-1", workspaceId: "workspace-1",
  target: { workspaceId: "workspace-1", projectId: "PRJ-001" },
  createdAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z", error: null,
  result: {
    kind: "task", nextCursor: null, truncated: false, sources: [],
    items: [{ id: "TASK-001", projectId: "PRJ-001", entity: "work_item", title: "Updated task", revision: "revision-2", version: 2, status: null }],
    receipt: { kind: "core", operationId: "operation-1", commandId: "command-1", action: "update", targetId: "TASK-001", revision: "revision-2" },
  },
};

test("sidebar uses persisted write results and never projects reads as changes", () => {
  const [change] = pmToolChanges([base, { ...base, operationId: "read-1", name: "pm_read" }]);
  assert.equal(change.id, "operation-1");
  assert.equal(change.state, "applied");
  assert.equal(change.targetId, "TASK-001");
  assert.equal(change.targetTitle, "Updated task");
  assert.equal(change.commandId, "command-1");
  assert.equal(pmToolChanges([{ ...base, name: "pm_read" }]).length, 0);
});

test("unknown and failed writes retain their actual state without invented targets", () => {
  const changes = pmToolChanges([
    { ...base, operationId: "unknown", status: "unknown", result: null, finishedAt: null },
    { ...base, operationId: "failed", status: "failed", result: null, error: { code: "revision_conflict", message: "Conflict" } },
  ]);
  assert.deepEqual(changes.map(change => change.state), ["unknown", "failed"]);
  assert.equal(changes[0].targetId, null);
  assert.equal(changes[1].error?.code, "revision_conflict");
});


test("workspace discovery never becomes a business write or a session target", () => {
  const discovery: PmToolCallRecord = { ...base, name: "pm_list_workspaces", workspaceId: null, target: undefined, result: { kind: "workspaces", items: [{ id: "workspace-2", name: "Other PM workspace", projects: [{ id: "PRJ-002", name: "Other project" }] }], sources: [], truncated: false, nextCursor: null } };
  assert.deepEqual(pmToolChanges([discovery]), []);
  assert.equal(discovery.workspaceId, null);
  assert.equal(discovery.target, undefined);
});

test("brief and knowledge reads never become business writes", () => {
  const reads: PmToolCallRecord[] = [
    { ...base, operationId: "brief-read", name: "pm_task_brief", result: null },
    { ...base, operationId: "knowledge-read", name: "pm_search_knowledge", result: null },
  ];
  assert.deepEqual(pmToolChanges(reads), []);
});

test("all finite read, preview and original-result queries stay out even when they carry receipts", () => {
  const names = [
    "pm_read_configuration", "pm_read_view", "pm_query_view", "pm_read_migration",
    "pm_read_change_detail", "pm_read_notifications", "pm_read_project_audit", "pm_read_members", "pm_read_workload",
    "pm_read_external_file", "pm_external_file_result", "pm_read_artifact_version", "pm_artifact_copy_origin",
    "pm_read_timer", "pm_read_worklogs", "pm_read_portfolio", "pm_read_sprint_metrics", "pm_read_roadmap",
    "pm_list_planning_records", "pm_automation_snapshot", "pm_automation_result", "pm_automation_query",
    "pm_automation_receipt", "pm_automation_candidate_preview", "pm_automation_import_preview", "pm_automation_git_check",
    "pm_automation_git_reconcile", "pm_read_integration_receipt", "pm_read_integration_operation", "pm_read_webhook_delivery",
  ];
  for (const name of names) {
    assert.equal(isPmToolBusinessWrite(name), false, name);
    assert.deepEqual(pmToolChanges([{ ...base, name }]), [], name);
  }
  assert.equal(isPmToolBusinessWrite("toString"), false);
  assert.equal(isPmToolBusinessWrite("pm_update_unregistered_resource"), false);
});

test("native entity lifecycle and typed fields preserve actual kinds without assuming every entity is a task", () => {
  for (const [name, kind] of [["pm_archive_entity", "archive"], ["pm_delete_entity", "delete"], ["pm_transition_entity", "status"], ["pm_create_entity", "create"], ["pm_save_entity_source", "update"]] as const) {
    const [change] = pmToolChanges([pmToolFixtureRecord(pmToolResultFixtures.goal, { name })]);
    assert.equal(change.kind, kind);
    assert.equal(change.targetId, "GOAL-001");
    assert.equal(change.targetTitle, "Visible fixture entity");
    assert.equal(change.projectId, "PRJ-001");
    assert.doesNotMatch(change.summary, /Task Done/);
  }
  const [deleted] = pmToolChanges([pmToolFixtureRecord(pmToolResultFixtures.lifecycle, { name: "pm_delete_task" })]);
  assert.equal(deleted.kind, "delete");
  assert.equal(deleted.targetTitle, null);
  assert.equal(deleted.commandId, pmToolResultFixtures.lifecycle.receipt.commandId);
});

test("all seven write families use original receipts without fake entity fields", () => {
  const calls = [
    pmToolFixtureRecord(pmToolResultFixtures.collaboration, { name: "pm_acknowledge_changes" }),
    pmToolFixtureRecord(pmToolResultFixtures.administration_command, { name: "pm_set_member_capacity" }),
    pmToolFixtureRecord(pmToolResultFixtures["artifact-mutation"], { name: "pm_register_artifact" }),
    pmToolFixtureRecord(pmToolResultFixtures.dashboard_receipt, { name: "pm_complete_private_note" }),
    pmToolFixtureRecord(pmToolResultFixtures.planning_record_receipt, { name: "pm_submit_work_item_result" }),
    pmToolFixtureRecord(pmToolResultFixtures.automation_deleted, { name: "pm_automation_remove" }),
    pmToolFixtureRecord(pmToolResultFixtures.webhook_action, { name: "pm_reconcile_webhook_delivery" }),
  ];
  const changes = pmToolChanges(calls);
  assert.equal(changes.length, calls.length);
  assert.ok(changes.every(change => change.state === "applied"));
  assert.ok(changes.every(change => change.targetTitle === null));
  assert.ok(changes.every(change => change.projectId === "PRJ-001"));
  assert.doesNotMatch(changes.find(change => change.summary.includes("pm_complete_private_note"))!.summary, /Task Done|任务完成/);
});

test("nested unresolved, rejected, queued and conflicting outcomes do not become applied", () => {
  const unknownFile = pmToolResultFixtures["external-file-operation"];
  const calls = [
    pmToolFixtureRecord(unknownFile, { name: "pm_move_external_file" }),
    pmToolFixtureRecord({ ...unknownFile, items: unknownFile.items.map(item => ({ ...item, status: "not_applied" as const })) }, { name: "pm_save_external_file" }),
    pmToolFixtureRecord(pmToolResultFixtures.automation_execution, { name: "pm_automation_run" }),
    pmToolFixtureRecord({ ...pmToolResultFixtures.automation_execution, execution: { ...pmToolResultFixtures.automation_execution.execution, status: "queued" } }, { name: "pm_automation_test" }),
    pmToolFixtureRecord({ ...pmToolResultFixtures.automation_execution, execution: { ...pmToolResultFixtures.automation_execution.execution, status: "cancel_requested" } }, { name: "pm_automation_cancel" }),
    pmToolFixtureRecord(pmToolResultFixtures.automation_import_receipt, { name: "pm_automation_import" }),
    pmToolFixtureRecord(pmToolResultFixtures.automation_review_receipt, { name: "pm_automation_candidate_apply" }),
    pmToolFixtureRecord({ ...pmToolResultFixtures.automation_review_receipt, original: { ...pmToolResultFixtures.automation_review_receipt.original, result: { ...pmToolResultFixtures.automation_review_receipt.original.result, status: "conflict" } } }, { name: "pm_automation_candidate_apply" }),
    pmToolFixtureRecord(pmToolResultFixtures.automation_git_operation, { name: "pm_automation_git_sync" }),
    pmToolFixtureRecord(pmToolResultFixtures.integration_receipt, { name: "pm_verify_integration" }),
  ];
  assert.deepEqual(pmToolChanges(calls).map(change => change.state), ["unknown", "failed", "unknown", "queued", "running", "queued", "unknown", "conflict", "unknown", "failed"]);
});

test("migration plans distinguish preview, in-flight application and exact restoration", () => {
  const migration = pmToolResultFixtures.migration;
  const changes = pmToolChanges([
    pmToolFixtureRecord(migration, { name: "pm_preview_migration" }),
    pmToolFixtureRecord({ ...migration, migration: { ...migration.migration, status: "applying" } }, { name: "pm_apply_migration" }),
    pmToolFixtureRecord({ ...migration, migration: { ...migration.migration, status: "restored" } }, { name: "pm_restore_migration" }),
  ]);
  assert.deepEqual(changes.map(change => change.state), ["proposed", "running", "reverted"]);
});

test("visibility and original operation status override any stale succeeded payload", () => {
  assert.deepEqual(pmToolChanges([{ ...base, visibility: "redacted" }, { ...base, visibility: "unavailable" }]), []);
  const [unknown] = pmToolChanges([{ ...base, status: "unknown" }]);
  assert.equal(unknown.state, "unknown");
  const [confirmed] = pmToolChanges([{ ...base, result: null }]);
  assert.equal(confirmed.state, "applied");
  assert.equal(confirmed.targetId, null);
});
