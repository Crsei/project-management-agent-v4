import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createWorkspaceClient } from "@agent-workspace/client-runtime";
import { captureCollaborationAuthority, collaborationJson, collaborationPath, createCollaborationLocalState, createCollaborationResource, invalidateCollaborationAccess, safeCollaborationHref, subscribeCollaborationAccess } from "./data-model.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("opening, polling and disposing collaboration resources only reads and never dispatches", async () => {
  const calls: { path: string; method: string | undefined }[] = [];
  const client = createWorkspaceClient({ fetch: async (input, init) => { calls.push({ path: String(input), method: init?.method }); return json({ runs: [] }); } });
  const resource = createCollaborationResource<{ runs: string[] }>("/api/collaboration/runs?workspaceId=scope", client);
  assert.equal(calls.length, 0);
  const stop = resource.start();
  const reading = resource.refresh();
  assert.equal(reading, resource.refresh());
  await reading;
  assert.deepEqual(resource.getSnapshot().data, { runs: [] });
  assert.ok(calls.every(call => call.method === undefined || call.method === "GET"));
  stop();
  const count = calls.length;
  await resource.refresh();
  assert.equal(calls.length, count);
});

test("offline refresh retains a dated stale snapshot and exposes an error rather than empty success", async () => {
  let offline = false;
  const client = createWorkspaceClient({ fetch: async () => { if (offline) throw new TypeError("offline"); return json({ runs: ["real-id"] }); } });
  const resource = createCollaborationResource<{ runs: string[] }>("/runs", client);
  const stop = resource.start();
  await resource.refresh();
  const loadedAt = resource.getSnapshot().loadedAt;
  offline = true;
  await resource.refresh();
  assert.deepEqual(resource.getSnapshot().data, { runs: ["real-id"] });
  assert.equal(resource.getSnapshot().loadedAt, loadedAt);
  assert.match(resource.getSnapshot().error ?? "", /offline/);
  stop();
});

for (const status of [401, 403]) test(`HTTP ${status} clears every collaboration projection and rejects late sensitive reads`, async () => {
  const late = Promise.withResolvers<Response>();
  let deny = false;
  let slow = false;
  const client = createWorkspaceClient({ fetch: async input => {
    if (deny && String(input) === "/inbox") return json({ error: "access changed" }, status);
    if (slow && String(input) === "/detail") return late.promise;
    return json({ private: String(input) });
  } });
  const detail = createCollaborationResource<{ private: string }>("/detail", client);
  const inbox = createCollaborationResource<{ private: string }>("/inbox", client);
  const stopDetail = detail.start(), stopInbox = inbox.start();
  await Promise.all([detail.refresh(), inbox.refresh()]);
  assert.ok(detail.getSnapshot().data);
  slow = true;
  const waiting = detail.refresh();
  await nextTurn();
  deny = true;
  await inbox.refresh();
  assert.equal(detail.getSnapshot().data, null);
  assert.equal(inbox.getSnapshot().data, null);
  assert.equal(detail.getSnapshot().loadedAt, null);
  assert.equal(detail.getSnapshot().accessDenied, true);
  assert.equal(inbox.getSnapshot().accessDenied, true);
  late.resolve(json({ private: "must not reappear" }));
  await waiting;
  assert.equal(detail.getSnapshot().data, null);
  stopDetail(); stopInbox();
});

for (const status of [401, 403]) test(`HTTP ${status} also erases copied Issue/configuration drafts and confirmation, without losing original operation identity`, async () => {
  const selection = createCollaborationLocalState<{ id: string; title: string; revision: string } | null>({ id: "TASK-private", title: "Restricted Issue", revision: "original-revision" }, null);
  const confirmation = createCollaborationLocalState(true, false);
  const draft = createCollaborationLocalState({ name: "Private Agent", instructions: "Restricted source text" }, { name: "", instructions: "" });
  const stopSelection = selection.subscribe(() => {});
  const stopConfirmation = confirmation.subscribe(() => {});
  const stopDraft = draft.subscribe(() => {});
  const operation = { requestId: "original-request", accepted: false };
  const late = Promise.withResolvers<Response>();
  const client = createWorkspaceClient({ fetch: async input => String(input) === "/original-request" ? late.promise : json({ error: "access changed" }, status) });
  const waiting = collaborationJson<{ id: string; title: string; revision: string }>("/original-request", { method: "POST" }, client).then(result => {
    selection.set(result);
    confirmation.set(true);
    operation.accepted = true;
  });
  const discarded = assert.rejects(waiting, /old response was discarded/);
  try {
    await assert.rejects(collaborationJson("/inbox", undefined, client));
    assert.equal(selection.getSnapshot(), null);
    assert.equal(confirmation.getSnapshot(), false);
    assert.deepEqual(draft.getSnapshot(), { name: "", instructions: "" });
    late.resolve(json({ id: "TASK-private", title: "Late private Issue", revision: "late-revision" }));
    await discarded;
    assert.equal(selection.getSnapshot(), null);
    assert.equal(confirmation.getSnapshot(), false);
    assert.deepEqual(operation, { requestId: "original-request", accepted: false });
  } finally { stopSelection(); stopConfirmation(); stopDraft(); }
});

test("a late old-authority denial cannot erase newly authorized local drafts", async () => {
  const late = Promise.withResolvers<Response>();
  const client = createWorkspaceClient({ fetch: async () => late.promise });
  const previous = collaborationJson("/previous-authority", undefined, client);
  const rejected = assert.rejects(previous);
  invalidateCollaborationAccess();
  const draft = createCollaborationLocalState("Current authorized draft", "");
  const stop = draft.subscribe(() => {});
  try {
    late.resolve(json({ error: "old request denied" }, 403));
    await rejected;
    assert.equal(draft.getSnapshot(), "Current authorized draft");
  } finally { stop(); }
});

test("transient non-auth failures preserve authorized local selection, drafts and confirmation", async () => {
  const selection = createCollaborationLocalState({ taskId: "TASK-authorized", confirmed: true, draft: "Unsaved authorized goal" }, { taskId: "", confirmed: false, draft: "" });
  const stop = selection.subscribe(() => {});
  let invalidations = 0;
  const unsubscribe = subscribeCollaborationAccess(() => { invalidations++; });
  const currentAuthority = captureCollaborationAuthority();
  const client = createWorkspaceClient({ fetch: async () => { throw new TypeError("offline"); } });
  try {
    await assert.rejects(collaborationJson("/inbox", undefined, client), /offline/);
    assert.deepEqual(selection.getSnapshot(), { taskId: "TASK-authorized", confirmed: true, draft: "Unsaved authorized goal" });
    assert.equal(currentAuthority(), true);
    assert.equal(invalidations, 0);
  } finally { stop(); unsubscribe(); }
});

test("a local copy mounted during an authority change cannot expose its pre-subscription snapshot", () => {
  const selection = createCollaborationLocalState({ title: "Old restricted title" }, { title: "" });
  invalidateCollaborationAccess();
  assert.deepEqual(selection.getSnapshot(), { title: "" });
  const stop = selection.subscribe(() => {});
  try {
    selection.set({ title: "New authorized selection" });
    invalidateCollaborationAccess();
    assert.deepEqual(selection.getSnapshot(), { title: "" });
  } finally { stop(); }
});

for (const status of [401, 403]) test(`PM transport HTTP ${status} invalidates the same resource and local selection authority`, async () => {
  const selection = createCollaborationLocalState("Restricted PM Issue", "");
  const unsubscribe = selection.subscribe(() => {});
  const client = { async json<T>(): Promise<T> { throw Object.assign(new Error("PM access changed"), { status }); } };
  const resource = createCollaborationResource("/pm-issues", client);
  const stop = resource.start();
  try {
    await resource.refresh();
    assert.equal(selection.getSnapshot(), "");
    assert.equal(resource.getSnapshot().data, null);
    assert.equal(resource.getSnapshot().accessDenied, true);
  } finally { stop(); unsubscribe(); }
});

for (const status of [401, 403]) test(`HTTP ${status} denial clears only after a fresh authorized read succeeds`, async () => {
  let denied = true;
  const authorized = Promise.withResolvers<Response>();
  const client = createWorkspaceClient({ fetch: async () => denied ? json({ error: "not authorized" }, status) : authorized.promise });
  const resource = createCollaborationResource<{ workspaces: string[] }>("/workspaces", client);
  const stop = resource.start();
  try {
    await resource.refresh();
    assert.equal(resource.getSnapshot().accessDenied, true);
    assert.equal(resource.getSnapshot().data, null);
    denied = false;
    const reading = resource.refresh();
    assert.equal(resource.getSnapshot().accessDenied, true);
    assert.equal(resource.getSnapshot().data, null);
    authorized.resolve(json({ workspaces: ["currently-authorized"] }));
    await reading;
    assert.equal(resource.getSnapshot().accessDenied, false);
    assert.equal(resource.getSnapshot().error, null);
    assert.deepEqual(resource.getSnapshot().data, { workspaces: ["currently-authorized"] });
  } finally { stop(); }
});

test("scope URLs remain explicit and source links cannot escape to arbitrary origins", () => {
  assert.equal(collaborationPath("runs", ""), null);
  assert.equal(collaborationPath("runs", "workspace", { taskId: "TASK-001" }), "/api/collaboration/runs?workspaceId=workspace&taskId=TASK-001");
  assert.equal(safeCollaborationHref("//host/private"), null);
  assert.equal(safeCollaborationHref("javascript:alert(1)"), null);
  assert.equal(safeCollaborationHref("/agent/\\host"), null);
  assert.equal(safeCollaborationHref("/agent/workspace?thread=real-id"), "/agent/workspace?thread=real-id");
  assert.equal(safeCollaborationHref("/pm/workspace/issues"), "/pm/workspace/issues");
});
