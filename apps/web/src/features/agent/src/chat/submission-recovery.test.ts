import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceClient } from "@agent-workspace/client-runtime";
import { createChatSubmissionRecovery } from "./submission-recovery-model.ts";

const workspaceClient = createWorkspaceClient({ basePath: "/agent" });
const { forgetChatSubmission, getPendingChatSubmission, reconcileChatSubmission, rememberChatSubmission } = createChatSubmissionRecovery({
  client: workspaceClient,
  storage: {
    getItem: key => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: key => sessionStorage.removeItem(key),
  },
});

test("lost Chat acceptance only queries its original key and unknown never permits replay", async t => {
  const entries = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "sessionStorage", original); else Reflect.deleteProperty(globalThis, "sessionStorage"); });
  const queries: { path: string; method: string | undefined }[] = [];
  let status: "accepted" | "not_accepted" | "unknown" = "unknown";
  t.mock.method(workspaceClient, "json", async <T>(path: string, init?: RequestInit): Promise<T> => { queries.push({ path, method: init?.method }); return { status, storeId: "store", restoreEpoch: 1, ...(status === "accepted" ? { generationId: "generation" } : {}) } as T; });
  rememberChatSubmission({ threadId: "session /", submissionId: "original-key", inputMessageId: "input" });
  forgetChatSubmission("session /", "not-the-key");
  assert.equal(getPendingChatSubmission("session /")?.submissionId, "original-key");
  await reconcileChatSubmission("session /");
  assert.equal(getPendingChatSubmission("session /")?.submissionId, "original-key");
  status = "accepted";
  const accepted = await reconcileChatSubmission("session /");
  assert.equal(accepted?.generationId, "generation");
  assert.equal(getPendingChatSubmission("session /"), null);
  assert.ok(queries.every(query => query.path === "/api/chat/threads/session%20%2F/submissions/original-key" && !query.method));
  rememberChatSubmission({ threadId: "not-accepted", submissionId: "key", inputMessageId: null });
  status = "not_accepted";
  await reconcileChatSubmission("not-accepted");
  assert.equal(getPendingChatSubmission("not-accepted"), null);
});
