import assert from "node:assert/strict";
import test from "node:test";
import type { QueuedChatMessage } from "@agent-workspace/contracts/chat";
import {
  composerOperationError, composerQueueEditCandidate, reduceComposerQueueEdit,
  resolveComposerPrimaryAction, resolveComposerSubmissionRoute,
  type ComposerPrimaryInput, type ComposerQueueEditState,
} from "./composer-actions-model.ts";

const row: QueuedChatMessage = {
  id: "queued-1", threadId: "session-1", revision: 7, status: "queued", createdAt: "2026-11-18", updatedAt: "2026-11-18",
  draft: { message: { id: "message-1", role: "user", parts: [{ type: "text", text: "  edit me  " }] } },
};
const input: ComposerPrimaryInput = {
  running: false, remoteThread: true, hasText: true, attachmentCount: 0, hasQuote: false, selectionCount: 0,
  historyBlocked: false, tooLong: false, saveError: false, saving: false, sessionDisabled: false,
  sendUnavailable: false, steer: { supported: false }, resumable: false, editingQueue: true,
};

function beginEditing(): ComposerQueueEditState {
  return reduceComposerQueueEdit({ status: "idle" }, { type: "begin", threadId: row.threadId, row });
}

test("composer queue edit accepts only a matching remote session and an editable plain-text row", () => {
  assert.deepEqual(composerQueueEditCandidate(row.threadId, { threadId: row.threadId, row }), { threadId: row.threadId, row, text: "  edit me  " });
  assert.equal(composerQueueEditCandidate(undefined, { threadId: row.threadId, row }), undefined);
  assert.equal(composerQueueEditCandidate("other", { threadId: row.threadId, row }), undefined);
  assert.equal(composerQueueEditCandidate(row.threadId, undefined), undefined);
  assert.equal(composerQueueEditCandidate(row.threadId, { threadId: row.threadId, row: { ...row, threadId: "other" } }), undefined);
  for (const status of ["dispatching", "sent", "unknown", "removed"] as const)
    assert.equal(composerQueueEditCandidate(row.threadId, { threadId: row.threadId, row: { ...row, status } }), undefined);
  assert.ok(composerQueueEditCandidate(row.threadId, { threadId: row.threadId, row: { ...row, status: "blocked" } }));
});

test("the composer revalidates queue contents instead of trusting the edit event", () => {
  const drafts: QueuedChatMessage["draft"][] = [
    null,
    { message: { id: "empty", role: "user", parts: [{ type: "text", text: " " }] } },
    { message: { id: "file", role: "user", parts: [{ type: "text", text: "text" }, { type: "file", mediaType: "text/plain", url: "data:text/plain,a" }] } },
    { message: { id: "quote", role: "user", parts: [{ type: "text", text: "text" }], metadata: { custom: { quote: { text: "quoted" } } } } },
  ];
  for (const draft of drafts)
    assert.equal(composerQueueEditCandidate(row.threadId, { threadId: row.threadId, row: { ...row, draft } }), undefined);
});

test("a failed queue update preserves the same row and original CAS revision", () => {
  const editing = beginEditing();
  const updating = reduceComposerQueueEdit(editing, { type: "save" });
  assert.equal(updating.status, "updating");
  assert.equal(reduceComposerQueueEdit(updating, { type: "begin", threadId: row.threadId, row: { ...row, revision: 99 } }), updating);
  assert.equal(reduceComposerQueueEdit(updating, { type: "cancel" }), updating);
  for (const code of ["revision_conflict", "settings_revision_conflict"]) {
    const error = composerOperationError(Object.assign(new Error("HTTP 409: conflict"), { code }));
    const failed = reduceComposerQueueEdit(updating, { type: "failed", error });
    assert.ok("row" in failed);
    assert.equal(failed.status, "editing");
    assert.equal(failed.row, row);
    assert.equal(failed.row.revision, 7);
    assert.match(failed.error!, new RegExp(code));
  }
  assert.deepEqual(reduceComposerQueueEdit(updating, { type: "saved" }), { status: "idle" });
});

test("cancel and session reset exit queue editing without a previous-draft restoration payload", () => {
  const editing = beginEditing();
  assert.deepEqual(reduceComposerQueueEdit(editing, { type: "cancel" }), { status: "idle" });
  assert.deepEqual(reduceComposerQueueEdit(reduceComposerQueueEdit(editing, { type: "save" }), { type: "reset" }), { status: "idle" });
  assert.equal(reduceComposerQueueEdit(editing, { type: "saved" }), editing);
});

test("Update queued owns the primary slot ahead of steer, queue and resume", () => {
  const action = resolveComposerPrimaryAction(input);
  assert.equal(action.kind, "update-queued");
  assert.equal(action.disabled, false);
  assert.equal(action.label.en, "Update queued");
  assert.equal(resolveComposerPrimaryAction({ ...input, running: true, steer: { supported: true } }).kind, "update-queued");
  assert.equal(resolveComposerPrimaryAction({ ...input, running: true }).kind, "update-queued");
  const empty = resolveComposerPrimaryAction({ ...input, hasText: false, resumable: true });
  assert.equal(empty.kind, "update-queued");
  assert.equal(empty.disabled, true);
});

test("queue updates cannot silently discard rich draft parts or bypass session guards", () => {
  for (const override of [
    { attachmentCount: 1 }, { hasQuote: true }, { selectionCount: 1 }, { queueUpdatePending: true },
    { tooLong: true }, { saveError: true }, { saving: true }, { historyBlocked: true },
    { draftBlocked: true }, { sessionDisabled: true }, { sendUnavailable: true }, { remoteThread: false },
  ]) {
    const action = resolveComposerPrimaryAction({ ...input, ...override });
    assert.equal(action.kind, "update-queued");
    assert.equal(action.disabled, true);
  }
});

test("keyboard and form routing preserve normal/fanout sends but never leak them during queue editing", () => {
  assert.equal(resolveComposerSubmissionRoute({ editingQueue: false, operationPending: false, fanoutActive: false }), "send");
  assert.equal(resolveComposerSubmissionRoute({ editingQueue: false, operationPending: false, fanoutActive: true }), "fanout");
  for (const fanoutActive of [false, true]) {
    assert.equal(resolveComposerSubmissionRoute({ editingQueue: true, operationPending: false, fanoutActive }), "update-queued");
    assert.equal(resolveComposerSubmissionRoute({ editingQueue: true, operationPending: true, fanoutActive }), "blocked");
    assert.equal(resolveComposerSubmissionRoute({ editingQueue: false, operationPending: true, fanoutActive }), "blocked");
  }
});
