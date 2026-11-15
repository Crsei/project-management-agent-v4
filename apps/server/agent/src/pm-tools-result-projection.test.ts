import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { agentChatToolResultSchema, type AgentChatToolResult } from "@agent-workspace/contracts/pm-tool-result";
import { pmChangeSetSchema } from "@agent-workspace/contracts/pm-changes";
import { pmToolCallRecordSchema, pmToolReconcileResultSchema, type PmToolCallRecord } from "@agent-workspace/contracts/pm-tools";
import { projectPmToolChange } from "./pm-tools.ts";
import { pmOutcomeFromToolOutput, projectPmNativeOutcome } from "./pm-outcomes.ts";

const workspaceId = randomUUID(), actorId = randomUUID(), resourceId = randomUUID();
const projectId = "PRJ-001", revision = "a".repeat(64);
const fields = { nextCursor: null, truncated: false, sources: [] };
function record(name: string, result: AgentChatToolResult): PmToolCallRecord {
  return pmToolCallRecordSchema.parse({
    operationId: result.receipt?.operationId ?? randomUUID(), name, target: { workspaceId, projectId }, workspaceId, actorId,
    threadId: "resource-result", messageId: "message", generationId: "generation", status: "succeeded", result, error: null,
    certainty: { dispatch: "possibly_sent", evidence: "pm_result" }, createdAt: "2026-11-13T00:00:00.000Z", finishedAt: "2026-11-13T00:00:01.000Z",
  });
}
function receipt(targetId: string, action: string) {
  return { kind: "application" as const, operationId: randomUUID(), commandId: randomUUID(), action, targetId, revision };
}

test("native resource writes never impersonate core entity items, including results with no items property", () => {
  const cases = [
    { name: "pm_save_view", result: { kind: "views", items: [{ id: "overview", name: "Personal view", layout: "table", revision }], ...fields, receipt: receipt("overview", "SaveView") } },
    { name: "pm_apply_migration", result: { kind: "migration", items: [{ path: "cycle/CYC-001.md", beforeRevision: revision, afterRevision: "b".repeat(64) }], migration: { id: "mig-original", revision, kind: "transform", status: "applied", totalFiles: 1, diagnostics: [] }, ...fields, receipt: receipt("mig-original", "ApplyMigration") } },
    { name: "pm_start_timer", result: { kind: "dashboard_receipt", action: "StartTimer", ...fields, receipt: receipt(resourceId, "StartTimer") } },
    { name: "pm_rename_artifact", result: { kind: "artifacts", items: [{ id: resourceId, workspaceId, projectId, version: 2, title: "Not a core entity title", artifactKind: "attachment", hiddenAt: null, hiddenBy: null, versionRefs: [], totalVersions: 0, latestVersionId: randomUUID() }], ...fields, receipt: receipt(resourceId, "RenameArtifact") } },
    { name: "pm_copy_artifact_version", result: { kind: "artifact-mutation", artifacts: [], versions: [], ...fields, receipt: receipt(resourceId, "CopyArtifactVersion") } },
  ];
  for (const entry of cases) {
    const result = agentChatToolResultSchema.parse(entry.result);
    const call = record(entry.name, result);
    const change = pmChangeSetSchema.parse(projectPmToolChange(call));
    assert.equal(change.state, "applied");
    assert.equal(change.targetId, result.receipt!.targetId);
    assert.equal(change.targetTitle, null, `${result.kind} does not supply a core entity title`);
    assert.equal(change.projectId, projectId);
    assert.equal(change.commandId, result.receipt!.commandId);
    assert.equal(change.receiptId, call.operationId);
    assert.equal("revision" in change, false, "native revisions are not unrelated change fields");
    for (const [status, state] of [["unknown", "unknown"], ["failed", "failed"], ["running", "running"], ["pending_approval", "proposed"]] as const) {
      assert.equal(projectPmToolChange({ ...call, status })!.state, state);
    }
  }
});

test("native lifecycle metadata retains actual non-task entities while read resources produce no changes", () => {
  const call = record("pm_archive_entity", agentChatToolResultSchema.parse({ kind: "lifecycle", items: [{ id: "CYC-001", entity: "cycle", title: "Iteration", projectId, revision, version: 2, status: "active" }], ...fields }));
  const change = pmChangeSetSchema.parse(projectPmToolChange(call));
  assert.equal(change.kind, "archive");
  assert.equal(change.targetId, "CYC-001");
  assert.equal(change.targetTitle, "Iteration");
  for (const name of ["pm_read_timer", "pm_read_private_notes", "pm_list_external_files", "pm_list_views"]) {
    assert.equal(projectPmToolChange({ ...call, name }), null);
  }
});

test("application receipts cross model/native envelopes without treating a transport flag as business failure", () => {
  const result = agentChatToolResultSchema.parse({ kind: "dashboard_receipt", action: "StartTimer", ...fields, receipt: receipt(resourceId, "StartTimer") });
  const call = record("pm_start_timer", result);
  const envelope = { isError: true, structuredContent: call };
  assert.equal(pmOutcomeFromToolOutput(envelope)?.status, "succeeded");
  const native = projectPmNativeOutcome({ id: "provider-tool", type: "dynamic_tool", status: "failed", output: JSON.stringify(envelope) });
  assert.equal(native.status, "completed");
  const proof = pmToolReconcileResultSchema.parse({ operationId: call.operationId, actorId, target: call.target, requestHash: revision,
    status: "succeeded", evidence: "application_receipt", commandIds: [result.receipt!.commandId] });
  assert.equal(proof.evidence, "application_receipt");
});
