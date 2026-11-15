import assert from "node:assert/strict";
import test from "node:test";
import type { AcceptedChatContext, ChatContextInput } from "@agent-workspace/contracts/message-context";
import { beginMessageContextEdit, bindMessageContextThread, captureMessageContext, consumeMessageContext, endMessageContextEdit, getMessageContextItems, hasMessageContextDraft, prepareMessageContextDraftSubmission, prepareMessageContextEditSubmission, setEditedContextReferences, setMessageContextBlocker, setMessageContextItems, takeMessageContextSubmission } from "./message-context-store.ts";
import { consumePmReferences, getPmReferences, setPmReferences } from "../pm/pm-chat-bridge.ts";

const input = (contextId: string, comment?: string): ChatContextInput => ({ contextId, kind: "response", source: { type: "response", threadId: "source-thread", messageId: "source-message", generationId: "source-generation", contentDigest: "a".repeat(64) }, selectedText: "half a line 👩🏽‍💻", ...(comment ? { comment } : {}) });
const accepted = (value: ChatContextInput): AcceptedChatContext => ({ contextId: value.contextId, kind: value.kind, input: value, source: value.source, text: "half a line 👩🏽‍💻", digest: "b".repeat(64), inputDigest: "c".repeat(64), truncated: false, acceptedAt: "2026-11-15T12:00:00.000Z", provenance: "server-verified", visibility: "available" });

test("late acceptance consumes exactly captured selections and preserves later edits/additions", () => {
  const owner = "snapshot-owner";
  setMessageContextItems(owner, [{ input: input("old") }, { input: input("edited", "before") }]);
  const snapshot = captureMessageContext(owner, false);
  setMessageContextItems(owner, [{ input: input("old") }, { input: input("edited", "after") }, { input: input("new") }]);
  consumeMessageContext(snapshot);
  assert.deepEqual(getMessageContextItems(owner).map(item => [item.input.contextId, item.input.comment]), [["edited", "after"], ["new", undefined]]);
  assert.equal(snapshot.items[1]!.input.comment, "before", "a later mutation cannot rewrite the sent payload");
});

test("removing and undo-restoring the same context is a new selection, not the old submission", () => {
  const owner = "undo-owner";
  const item = { input: input("stable-id"), accepted: accepted(input("stable-id")) };
  setMessageContextItems(owner, [item]);
  const snapshot = captureMessageContext(owner, false);
  setMessageContextItems(owner, []);
  setMessageContextItems(owner, [item]);
  consumeMessageContext(snapshot);
  assert.deepEqual(getMessageContextItems(owner).map(({ input, accepted }) => ({ input, accepted })), [item]);
});

test("local to remote identity aliases the same draft without copying another session", () => {
  setMessageContextItems("local-owner", [{ input: input("local-context") }]);
  setMessageContextItems("other-owner", [{ input: input("other-context") }]);
  bindMessageContextThread("local-owner", "remote-owner");
  assert.equal(captureMessageContext("remote-owner", false).items[0]!.input.contextId, "local-context");
  consumeMessageContext(captureMessageContext("remote-owner", false));
  assert.equal(getMessageContextItems("local-owner").length, 0);
  assert.equal(getMessageContextItems("other-owner").length, 1);
});

test("explicit edit freezes original PM/context payload before SDK teardown and leaves the new draft alone", () => {
  const thread = "edit-thread";
  setMessageContextItems(thread, [{ input: input("unsent-new-draft") }]);
  const owner = beginMessageContextEdit(thread, "original-input", [accepted(input("original-response"))]);
  const references = [{ workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "PRJ-001", kind: "issue" as const, id: "TASK-001", title: "Task", revision: "fixed-revision", availability: "unverified" as const }];
  setEditedContextReferences(owner, references);
  prepareMessageContextEditSubmission(thread);
  endMessageContextEdit(thread, owner);
  const sent = takeMessageContextSubmission(thread);
  assert.equal(sent.items[0]!.input.contextId, "original-response");
  assert.equal(sent.pmReferences?.[0]?.revision, "fixed-revision");
  consumeMessageContext(sent);
  assert.equal(getMessageContextItems(thread)[0]!.input.contextId, "unsent-new-draft");
  assert.equal(takeMessageContextSubmission(thread).items[0]!.input.contextId, "unsent-new-draft", "a prepared edit is not reused for a later send");
});

test("unavailable historical contexts are rejected instead of silently omitted during edit", () => {
  const hidden: AcceptedChatContext = { contextId: "hidden", kind: "response", source: { type: "unavailable" }, text: "", digest: "a".repeat(64), inputDigest: "b".repeat(64), truncated: false, acceptedAt: "2026-11-15T12:00:00.000Z", provenance: "server-verified", visibility: "unavailable", reason: "Source unavailable" };
  assert.throws(() => beginMessageContextEdit("unavailable-thread", "input", [hidden]), /Unavailable context/);
});

test("pending/missing attachment payload protects an otherwise empty draft", () => {
  setMessageContextBlocker("attachment-owner", "attachment:real-file", "Restoring attachment bytes");
  assert.equal(hasMessageContextDraft("attachment-owner"), true);
  setMessageContextBlocker("attachment-owner", "attachment:real-file", undefined);
  assert.equal(hasMessageContextDraft("attachment-owner"), false);
});

test("send captures PM/context/attachment identities before native attachment preparation awaits", () => {
  const thread = "preparation-thread";
  const original = input("sent-native");
  const sentPm = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "PRJ-001", kind: "issue" as const, id: "TASK-001", revision: "r1" };
  const laterPm = { ...sentPm, id: "TASK-002" };
  setMessageContextItems(thread, [{ input: original }]);
  setPmReferences(thread, [sentPm]);
  prepareMessageContextDraftSubmission(thread, [{ id: "real-image", name: "capture.png", type: "image", status: { type: "complete" }, content: [{ type: "image", image: "data:image/png;base64,AAAA" }] }]);
  setMessageContextItems(thread, [{ input: original }, { input: input("new-native") }]);
  setPmReferences(thread, [sentPm, laterPm]);
  const captured = takeMessageContextSubmission(thread);
  assert.deepEqual(captured.items.map(item => item.input.contextId), ["sent-native"]);
  assert.deepEqual(captured.pmDraft?.references, [sentPm]);
  assert.equal(captured.attachments?.[0]?.id, "real-image");
  consumeMessageContext(captured);
  consumePmReferences(captured.pmDraft!);
  assert.deepEqual(getMessageContextItems(thread).map(item => item.input.contextId), ["new-native"]);
  assert.deepEqual(getPmReferences(thread), [laterPm]);
});
