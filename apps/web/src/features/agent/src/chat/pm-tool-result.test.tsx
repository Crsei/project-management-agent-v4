import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n-provider";
import { agentChatToolResultSchema } from "../../../../../../../packages/agent-contracts/src/pm-tool-result";
import { PmToolCard, type PmToolRecord } from "./pm-tool-card";
import { PmToolResultContent } from "./pm-tool-result-content";
import { PmResultData, PmUnsupportedResult, pmObjectHref } from "./pm-tool-result-ui";
import { collaborationResultFixtures, fixtureAutomationConfig, fixtureWorkspaceId, planningRecordFixtures, pmToolFixtureRecord, pmToolResultFixtures } from "./pm-tool-result.fixtures";

function card(record: PmToolRecord) {
  return renderToStaticMarkup(<I18nProvider locale="en"><PmToolCard record={record} onUpdate={() => {}} /></I18nProvider>);
}
function content(result: Parameters<typeof PmToolResultContent>[0]["result"]) {
  return renderToStaticMarkup(<I18nProvider locale="en"><PmToolResultContent result={result} workspaceId={fixtureWorkspaceId} /></I18nProvider>);
}

test("every strict content discriminator parses and renders through the actual card", () => {
  for (const [kind, result] of Object.entries(pmToolResultFixtures)) {
    assert.equal(agentChatToolResultSchema.parse(result).kind, kind);
    const html = card(pmToolFixtureRecord(result));
    assert.ok(html.includes("pm-tool-card"), kind);
    assert.ok(!html.includes("This result matched no objects"), kind);
    assert.ok(!html.includes("This result type cannot be displayed"), kind);
    assert.ok(!html.includes("undefined"), kind);
  }
});

test("collaboration subtypes and independent planning records retain typed content", () => {
  for (const result of collaborationResultFixtures) {
    assert.equal(agentChatToolResultSchema.parse(result).kind, "collaboration");
    assert.ok(!content(result).includes("This result type cannot be displayed"), result.result.type);
  }
  for (const record of planningRecordFixtures) {
    const result = { ...pmToolResultFixtures.planning_records, records: [record] };
    assert.equal(agentChatToolResultSchema.parse(result).kind, "planning_records");
    const html = content(result);
    assert.ok(html.includes(record.resource), record.resource);
    assert.ok(!html.includes("This result type cannot be displayed"), record.resource);
  }
});

test("empty structured results show their actual state, not no matched objects", () => {
  const configuration = content(pmToolResultFixtures.configuration);
  assert.match(configuration, /Workspace protocol configuration/);
  assert.match(configuration, /absent/);
  assert.doesNotMatch(configuration, /This page contains no entries/);
  assert.match(content(pmToolResultFixtures.migration), /This plan contains no file changes/);
  assert.match(content(pmToolResultFixtures.dashboard_timer), /There is no active server timer/);
  assert.doesNotMatch(content(pmToolResultFixtures.dashboard_timer), /This page contains no entries/);
  assert.match(content(pmToolResultFixtures.dashboard_receipt), /Original business command result/);
  assert.doesNotMatch(content(pmToolResultFixtures.dashboard_receipt), /This page contains no entries/);
  assert.match(content(pmToolResultFixtures["artifact-copy-origin"]), /absent or redacted/);
  assert.match(content(pmToolResultFixtures["external-files"]), /source scan is incomplete/);
  assert.match(content(pmToolResultFixtures.dashboard_sprint_metrics), /History could not be read/);
});

test("redacted and unavailable records gate all business content including stale payloads", () => {
  const record = pmToolFixtureRecord(pmToolResultFixtures.task);
  for (const visibility of ["redacted", "unavailable"] as const) {
    const html = card({ ...record, visibility });
    assert.ok(html.includes(visibility));
    assert.doesNotMatch(html, /Visible fixture entity|TASK-001|revision|pm_read|Completed/);
    assert.doesNotMatch(html, /Reconcile original operation|Approve and run/);
  }
});

test("unknown, confirmed-without-payload, and empty read states remain distinct", () => {
  const unknown = card(pmToolFixtureRecord(pmToolResultFixtures["external-file-operation"], { name: "pm_move_external_file", status: "unknown" }));
  assert.match(unknown, /Needs verification/);
  assert.match(unknown, /Reconcile original operation/);
  assert.doesNotMatch(unknown, /<span>Completed<\/span>/);
  const noPayload = card(pmToolFixtureRecord(pmToolResultFixtures.task, { result: null }));
  assert.match(noPayload, /confirmed successful; its business payload has not been retrieved/);
  assert.doesNotMatch(noPayload, /This page contains no entries/);
  assert.match(content(pmToolResultFixtures.query), /This page contains no entries/);
  const unsupported = renderToStaticMarkup(<I18nProvider locale="en"><PmUnsupportedResult /></I18nProvider>);
  assert.match(unsupported, /does not establish business success or absence of data/);
});

test("native cursors, body offsets, source revisions and receipts remain visible", () => {
  const file = card(pmToolFixtureRecord(pmToolResultFixtures["external-file"]));
  assert.match(file, /contentOffset/);
  assert.match(file, /17/);
  assert.match(file, /Results were truncated/);
  const webhook = card(pmToolFixtureRecord(pmToolResultFixtures.webhook_delivery));
  assert.match(webhook, /Next attempt number/);
  assert.match(webhook, /Next receiver receipt cursor/);
  const overview = card(pmToolFixtureRecord(pmToolResultFixtures.webhook_overview));
  assert.match(overview, /next-target/);
  assert.match(overview, /Next cursor/);
  const receipted = card(pmToolFixtureRecord({ ...pmToolResultFixtures.dashboard_receipt, sources: [{ kind: "workflow", workspaceId: fixtureWorkspaceId, projectId: "PRJ-001", entityId: "workflow", title: "Workflow source", revision: "original-revision", truncated: true }] }));
  assert.match(receipted, /Business receipt/);
  assert.match(receipted, /commandId/);
  assert.match(receipted, /operationId/);
  assert.match(receipted, /original-revision/);
  assert.doesNotMatch(receipted, /href="[^"]*entities\/workflow/);
});

test("only real routes and exact authenticated artifact download references become links", () => {
  assert.equal(pmObjectHref(fixtureWorkspaceId, "team", "not-an-entity"), undefined);
  assert.equal(pmObjectHref(fixtureWorkspaceId, "workflow", "not-an-entity"), undefined);
  assert.equal(pmObjectHref(null, "task", "TASK-001"), undefined);
  assert.equal(pmObjectHref(fixtureWorkspaceId, "goal", "GOAL-001"), `/pm/${fixtureWorkspaceId}/entities/GOAL-001`);
  assert.match(content(pmToolResultFixtures["artifact-versions"]), /href="\/api\/v1\/workspaces\//);
  const version = pmToolResultFixtures["artifact-versions"].items[0];
  const mismatched = { ...pmToolResultFixtures["artifact-versions"], items: [{ ...version, downloadPath: "https://untrusted.invalid/content" }] };
  assert.match(content(mismatched), /Download reference does not match/);
  assert.doesNotMatch(content(mismatched), /href="https:\/\/untrusted/);
});

test("bounded typed display is text-only and explicitly marks local clipping", () => {
  const html = renderToStaticMarkup(<I18nProvider locale="en"><PmResultData value={{ body: "<script>unsafe</script>" + "x".repeat(10000), items: Array.from({ length: 1000 }, (_, index) => ({ index })) }} /></I18nProvider>);
  assert.match(html, /&lt;script&gt;unsafe/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Card display clipped/);
  assert.ok(html.length < 30000);
});

test("opaque historical selections and template/event arguments never enter generic display", () => {
  const result = { ...pmToolResultFixtures.automation_definition, definition: { ...pmToolResultFixtures.automation_definition.definition, historicalExecutionSelection: { secret: "HIDDEN-HISTORY" }, config: { ...fixtureAutomationConfig, templateInputs: { secret: "HIDDEN-INPUT" }, trigger: { kind: "event" as const, source: "fixture", key: "fixture", filter: { secret: "HIDDEN-FILTER" } } } } };
  const html = content(result);
  assert.doesNotMatch(html, /HIDDEN-HISTORY|HIDDEN-INPUT|HIDDEN-FILTER/);
  assert.match(html, /Opaque event filter is not rendered/);
});

test("finite entity field values retain false, zero, explicit null and empty arrays", () => {
  const html = content({ ...pmToolResultFixtures.task, items: [{ ...pmToolResultFixtures.task.items[0], properties: [{ field: "x-flag", value: false }, { field: "x-count", value: 0 }, { field: "x-clear", value: null }, { field: "x-labels", value: [] }] }] });
  assert.match(html, /x-flag/);
  assert.ok(html.includes("<code>false</code>"));
  assert.ok(html.includes("<code>0</code>"));
  assert.ok(html.includes("<code>null</code>"));
  assert.ok(html.includes("(empty list)"));
});

test("native planning snapshot and generated-title truncation remain explicit", () => {
  const submission = planningRecordFixtures.find(record => record.resource === "submission")!;
  const html = content({ ...pmToolResultFixtures.planning_records, records: [submission] });
  assert.match(html, /immutable submission scope snapshot is clipped/);
  const generated = content({ ...pmToolResultFixtures.planning_record_receipt, generatedTask: { id: "TASK-001", projectId: "PRJ-001", title: "Clipped fixture title", titleTruncated: true, revision: "r1", version: 1 } });
  assert.match(generated, /Task title clipped/);
});
