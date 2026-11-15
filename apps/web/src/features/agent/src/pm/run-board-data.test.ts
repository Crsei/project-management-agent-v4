import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createWorkspaceClient } from "@agent-workspace/client-runtime";
import type { AgentWorkspace, ExecutionEnvironment, RemoteThread, ThreadSidebar } from "@agent-workspace/contracts/chat";
import { createRunBoardAccessScope, createRunBoardData, createRunBoardExecutionData, createRunBoardHistoryData, type RunBoardHistory } from "./run-board-data.ts";

const workspace: AgentWorkspace = { id: "folder", name: "Folder", path: "/allowed/folder", revision: 1, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", archivedAt: null, status: "available" };

function thread(id = "session", status: ThreadSidebar["activity"]["status"] = "running", generationId = "generation"): RemoteThread {
  return {
    remoteId: id, title: id, status: "regular", revision: 1, lifecycleRevision: 1,
    sidebar: { revision: 1, pinnedAt: null, settledAt: null, snoozedAt: null, snoozedUntil: null, autoSettle: false, lastVisitedAt: null, unread: false, section: "active", running: true, activity: { status, generationId }, canSnooze: false },
    createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
    settings: { providerInstanceId: "provider", model: "model", systemPrompt: "", temperature: 1 },
  };
}

function history(id: string): RunBoardHistory {
  return { headId: id, messages: [{ id, parent_id: null, format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: `private ${id}` }], metadata: { pmVisibility: "redacted" } } }], latestGeneration: null };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function readResponse(path: string, threads: RemoteThread[]) {
  if (path === "/api/chat/threads") return json({ threads });
  if (path === "/api/agent-workspaces") return json({ workspaces: [workspace] });
  if (path === "/api/providers") return json({ providers: [], drivers: [] });
  throw new Error(`Unexpected read: ${path}`);
}

function transport(handle: (path: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const requests: { path: string; init: RequestInit | undefined }[] = [];
  const client = createWorkspaceClient({ fetch: async (input, init) => {
    const path = String(input);
    requests.push({ path, init });
    return handle(path, init);
  } });
  return { client, requests };
}

test("construction performs no requests; one refresh shares reads and excludes archived sessions", async () => {
  const list = deferred<Response>();
  const io = transport(path => path === "/api/chat/threads" ? list.promise : readResponse(path, []));
  const store = createRunBoardData(io.client, createRunBoardAccessScope(), () => "observed-at");
  assert.equal(io.requests.length, 0);
  const dispose = store.start();
  const first = store.refresh();
  assert.equal(first, store.refresh());
  await nextTurn();
  assert.equal(io.requests.length, 3);
  list.resolve(json({ threads: [thread(), { ...thread("archived"), status: "archived" }] }));
  await first;
  assert.deepEqual(store.getSnapshot().threads.map(item => item.remoteId), ["session"]);
  assert.equal(store.getSnapshot().loadedAt, "observed-at");
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().metadataError, null);
  assert.ok(io.requests.every(request => request.init?.cache === "no-store" && !request.init.method));
  dispose();
});

test("transient list errors retain a dated stale snapshot and metadata errors remain independent", async () => {
  let mode: "ok" | "list-fails" | "metadata-fails" = "ok";
  let timestamp = 0;
  const io = transport(path => {
    if (mode === "list-fails" && path === "/api/chat/threads") throw new TypeError("offline");
    if (mode === "metadata-fails" && path === "/api/agent-workspaces") return json({ error: "folder unavailable" }, 503);
    return readResponse(path, [thread(mode)]);
  });
  const store = createRunBoardData(io.client, createRunBoardAccessScope(), () => `snapshot-${++timestamp}`);
  const dispose = store.start();
  await store.refresh();
  mode = "list-fails";
  await store.refresh();
  assert.equal(store.getSnapshot().threads[0]?.remoteId, "ok");
  assert.equal(store.getSnapshot().loadedAt, "snapshot-1");
  assert.match(store.getSnapshot().error || "", /offline/);
  assert.equal(store.getSnapshot().metadataError, null);
  mode = "metadata-fails";
  await store.refresh();
  assert.equal(store.getSnapshot().threads[0]?.remoteId, "metadata-fails");
  assert.equal(store.getSnapshot().loadedAt, "snapshot-2");
  assert.equal(store.getSnapshot().error, null);
  assert.match(store.getSnapshot().metadataError || "", /folder unavailable/);
  assert.deepEqual(store.getSnapshot().workspaces, [workspace]);
  dispose();
});

for (const status of [401, 403]) {
  test(`HTTP ${status} from metadata immediately erases board and selected history; late reads cannot restore it`, async () => {
    const access = createRunBoardAccessScope();
    const list = deferred<Response>();
    const providers = deferred<Response>();
    let denied = false;
    const io = transport(path => {
      if (path.includes("/history?")) return json(history("sensitive"));
      if (denied && path === "/api/chat/threads") return list.promise;
      if (denied && path === "/api/providers") return providers.promise;
      if (denied && path === "/api/agent-workspaces") return json({ error: "authorization lost" }, status);
      return readResponse(path, [thread()]);
    });
    const store = createRunBoardData(io.client, access);
    const selected = createRunBoardHistoryData("session", io.client, access);
    const dispose = store.start();
    const disposeSelected = selected.start();
    await Promise.all([store.refresh(), selected.refresh()]);
    assert.equal(selected.getSnapshot().data?.messages[0]?.id, "sensitive");
    denied = true;
    const refreshing = store.refresh();
    await nextTurn();
    assert.deepEqual(store.getSnapshot().threads, []);
    assert.deepEqual(store.getSnapshot().workspaces, []);
    assert.deepEqual(store.getSnapshot().providers, []);
    assert.equal(store.getSnapshot().loadedAt, null);
    assert.equal(selected.getSnapshot().data, null);
    assert.match(selected.getSnapshot().error || "", new RegExp(`HTTP ${status}`));
    assert.equal(io.requests.findLast(request => request.path === "/api/chat/threads")?.init?.signal?.aborted, true);
    list.resolve(json({ threads: [thread("must-not-return")] }));
    providers.resolve(json({ providers: [], drivers: [] }));
    await refreshing;
    assert.deepEqual(store.getSnapshot().threads, []);
    await assert.rejects(store.stop("session", "generation"), /停止目标不可用/);
    assert.ok(io.requests.every(request => request.init?.method !== "POST"));
    disposeSelected();
    dispose();
  });
}

test("a disposed read and its late authorization failure cannot replace a newer mount snapshot", async () => {
  const oldList = deferred<Response>();
  const oldMetadata = deferred<Response>();
  let old = true;
  const io = transport(path => {
    if (old && path === "/api/chat/threads") return oldList.promise;
    if (old && path === "/api/agent-workspaces") return oldMetadata.promise;
    return readResponse(path, [thread("current")]);
  });
  const store = createRunBoardData(io.client, createRunBoardAccessScope());
  const disposeOld = store.start();
  const oldRead = store.refresh();
  await nextTurn();
  disposeOld();
  assert.equal(io.requests[0]?.init?.signal?.aborted, true);
  old = false;
  const dispose = store.start();
  await store.refresh();
  oldMetadata.resolve(json({ error: "old denied request" }, 401));
  oldList.resolve(json({ threads: [thread("old")] }));
  await oldRead;
  assert.equal(store.getSnapshot().threads[0]?.remoteId, "current");
  assert.equal(store.getSnapshot().error, null);
  dispose();
});

test("history only reads a selection and late prior-selection content never enters the next selection", async () => {
  const oldRead = deferred<Response>();
  const io = transport(path => path.includes("/old/") ? oldRead.promise : json(history("current")));
  const access = createRunBoardAccessScope();
  const noSelection = createRunBoardHistoryData(null, io.client, access);
  const disposeNone = noSelection.start();
  await noSelection.refresh();
  assert.equal(io.requests.length, 0);
  disposeNone();
  const prior = createRunBoardHistoryData("old", io.client, access);
  const disposePrior = prior.start();
  const pendingPrior = prior.refresh();
  disposePrior();
  const current = createRunBoardHistoryData("current", io.client, access);
  assert.equal(current.getSnapshot().data, null);
  const disposeCurrent = current.start();
  await current.refresh();
  oldRead.resolve(json(history("old-private")));
  await pendingPrior;
  assert.equal(prior.getSnapshot().data, null);
  assert.equal(current.getSnapshot().data?.messages[0]?.id, "current");
  assert.equal(io.requests[0]?.init?.signal?.aborted, true);
  assert.ok(io.requests.every(request => request.path.endsWith("/history?format=ai-sdk/v6") && !request.init?.method));
  disposeCurrent();
});

test("stale stop generation is refused before mutation and the board is authoritatively refreshed", async () => {
  let current = thread();
  const io = transport(path => path === "/api/chat/threads/session" ? json({ thread: current }) : readResponse(path, [current]));
  const store = createRunBoardData(io.client, createRunBoardAccessScope());
  const dispose = store.start();
  await store.refresh();
  current = thread("session", "running", "new-generation");
  await assert.rejects(store.stop("session", "generation"), /当前活动生成已改变/);
  assert.ok(io.requests.every(request => request.init?.method !== "POST"));
  assert.equal(store.getSnapshot().threads[0]?.sidebar.activity.generationId, "new-generation");
  dispose();
});

test("a stop sends one explicit generation id and rereads after any preexisting refresh", async () => {
  let current = thread();
  let holdNextList = false;
  const olderList = deferred<Response>();
  const submitted = deferred<void>();
  const io = transport((path, init) => {
    if (path === "/api/chat/threads/session") return json({ thread: current });
    if (path.endsWith("/cancel")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { generationId: "generation" });
      assert.equal(init?.signal, undefined);
      current = thread("session", "cancelled");
      submitted.resolve();
      return json({ cancelled: true });
    }
    if (holdNextList && path === "/api/chat/threads") { holdNextList = false; return olderList.promise; }
    return readResponse(path, [current]);
  });
  const store = createRunBoardData(io.client, createRunBoardAccessScope());
  const dispose = store.start();
  await store.refresh();
  holdNextList = true;
  const preexistingRead = store.refresh();
  const stopping = store.stop("session", "generation");
  await submitted.promise;
  olderList.resolve(json({ threads: [thread()] }));
  await Promise.all([preexistingRead, stopping]);
  assert.equal(store.getSnapshot().threads[0]?.sidebar.activity.status, "cancelled");
  assert.equal(io.requests.filter(request => request.init?.method === "POST").length, 1);
  assert.equal(io.requests.filter(request => request.path === "/api/chat/threads").length, 3);
  dispose();
});

test("unknown stop results are reconciled but never automatically replayed or marked idle", async () => {
  const current = thread();
  const io = transport(path => {
    if (path === "/api/chat/threads/session") return json({ thread: current });
    if (path.endsWith("/cancel")) throw new TypeError("connection lost after submission");
    return readResponse(path, [current]);
  });
  const store = createRunBoardData(io.client, createRunBoardAccessScope());
  const dispose = store.start();
  await store.refresh();
  await assert.rejects(store.stop("session", "generation"), /停止结果未确认.*connection lost.*不会自动重发/);
  await store.refresh();
  assert.equal(store.getSnapshot().threads[0]?.sidebar.activity.status, "running");
  assert.equal(io.requests.filter(request => request.init?.method === "POST").length, 1);
  dispose();
});

test("a successful cancel acknowledgement is not a terminal state when authoritative activity remains running", async () => {
  const current = thread();
  const io = transport(path => {
    if (path === "/api/chat/threads/session") return json({ thread: current });
    if (path.endsWith("/cancel")) return json({ cancelled: true });
    return readResponse(path, [current]);
  });
  const store = createRunBoardData(io.client, createRunBoardAccessScope());
  const dispose = store.start();
  await store.refresh();
  await assert.rejects(store.stop("session", "generation"), /仍报告该生成处于活动状态/);
  assert.equal(store.getSnapshot().threads[0]?.sidebar.activity.status, "running");
  dispose();
});

test("closing a board during stop preflight aborts reads and cannot submit a cancellation", async () => {
  const preflight = deferred<Response>();
  const io = transport(path => path === "/api/chat/threads/session" ? preflight.promise : readResponse(path, [thread()]));
  const store = createRunBoardData(io.client, createRunBoardAccessScope());
  const dispose = store.start();
  await store.refresh();
  const stopping = store.stop("session", "generation");
  await nextTurn();
  dispose();
  preflight.resolve(json({ thread: thread() }));
  await assert.rejects(stopping, /未提交停止请求/);
  assert.equal(io.requests.find(request => request.path === "/api/chat/threads/session")?.init?.signal?.aborted, true);
  assert.ok(io.requests.every(request => request.init?.method !== "POST"));
});

test("missing, incompatible or unidentified active post-stop state cannot confirm cancellation", async () => {
  for (const outcome of ["missing", "unknown", "unidentified"] as const) {
    let current = [thread()];
    const io = transport(path => {
      if (path === "/api/chat/threads/session") return json({ thread: thread() });
      if (path.endsWith("/cancel")) {
        if (outcome === "missing") current = [];
        else if (outcome === "unknown") current = [{ ...thread(), sidebar: { ...thread().sidebar, activity: { status: "future" } as unknown as ThreadSidebar["activity"] } }];
        else current = [{ ...thread(), sidebar: { ...thread().sidebar, activity: { status: "running" } } }];
        return json({ cancelled: true });
      }
      return readResponse(path, current);
    });
    const store = createRunBoardData(io.client, createRunBoardAccessScope());
    const dispose = store.start();
    await store.refresh();
    await assert.rejects(store.stop("session", "generation"), /无法确认目标会话的活动状态/);
    assert.equal(io.requests.filter(request => request.init?.method === "POST").length, 1);
    dispose();
  }
});

test("a submitted stop is never aborted or resubmitted when another click or page close races its result", async () => {
  const acknowledged = deferred<Response>();
  const submitted = deferred<void>();
  const io = transport(path => {
    if (path === "/api/chat/threads/session") return json({ thread: thread() });
    if (path.endsWith("/cancel")) { submitted.resolve(); return acknowledged.promise; }
    return readResponse(path, [thread()]);
  });
  const store = createRunBoardData(io.client, createRunBoardAccessScope());
  const dispose = store.start();
  await store.refresh();
  const stopping = store.stop("session", "generation");
  await submitted.promise;
  await assert.rejects(store.stop("session", "generation"), /不会重复提交/);
  const readsBeforeClose = io.requests.length;
  dispose();
  assert.equal(io.requests.find(request => request.init?.method === "POST")?.init?.signal, undefined);
  acknowledged.resolve(json({ cancelled: true }));
  await assert.rejects(stopping, /运行面板已关闭/);
  assert.equal(io.requests.length, readsBeforeClose);
  assert.equal(io.requests.filter(request => request.init?.method === "POST").length, 1);
});

test("selected execution stays stable during refresh but switches and failures clear its directory", async () => {
  const environment: ExecutionEnvironment = {
    version: 2, hostId: "local", agentWorkspaceId: workspace.id, agentWorkspaceName: workspace.name,
    agentWorkspaceRevision: workspace.revision, sourcePath: workspace.path, executionPath: "/owned/worktree",
    worktree: { deliveryId: "delivery", branch: "branch" }, frozen: true,
  };
  const oldRead = deferred<Response>();
  const refreshRead = deferred<Response>();
  let refreshing = false;
  const io = transport(path => {
    if (path === "/api/chat/threads/old/execution") return oldRead.promise;
    assert.equal(path, "/api/chat/threads/current%2Fid/execution");
    return refreshing ? refreshRead.promise : json({ environment });
  });
  const access = createRunBoardAccessScope();
  const noSelection = createRunBoardExecutionData(null, io.client, access);
  const disposeNone = noSelection.start();
  await noSelection.refresh();
  assert.equal(io.requests.length, 0);
  disposeNone();
  const prior = createRunBoardExecutionData("old", io.client, access);
  const disposePrior = prior.start();
  const pendingPrior = prior.refresh();
  disposePrior();
  const current = createRunBoardExecutionData("current/id", io.client, access);
  const disposeCurrent = current.start();
  await current.refresh();
  assert.deepEqual(current.getSnapshot().environment, environment);
  oldRead.resolve(json({ environment: { ...environment, executionPath: "/other/session" } }));
  await pendingPrior;
  assert.equal(prior.getSnapshot().environment, null);
  assert.deepEqual(current.getSnapshot().environment, environment);
  refreshing = true;
  const pendingRefresh = current.refresh();
  assert.deepEqual(current.getSnapshot().environment, environment);
  assert.equal(current.getSnapshot().loading, true);
  refreshRead.resolve(json({ error: "directory changed" }, 409));
  await pendingRefresh;
  assert.equal(current.getSnapshot().environment, null);
  assert.match(current.getSnapshot().error || "", /directory changed/);
  assert.ok(io.requests.every(request => request.init?.cache === "no-store" && !request.init.method));
  assert.equal(io.requests[0]?.init?.signal?.aborted, true);
  disposeCurrent();
});

test("PM execution denial stays local across repeated refreshes and preserves authorized ordinary Sessions and history", async () => {
  const environment: ExecutionEnvironment = {
    version: 2, hostId: "local", agentWorkspaceId: workspace.id, agentWorkspaceName: workspace.name,
    agentWorkspaceRevision: workspace.revision, sourcePath: workspace.path, executionPath: "/owned/pm-worktree",
    worktree: { deliveryId: "delivery", branch: "branch" }, frozen: true,
  };
  const executionPath = "/api/chat/threads/pm-session/execution";
  let denied = false;
  const io = transport(path => {
    if (path === executionPath) return denied
      ? json({ error: "所选 PM 引用不可访问", code: "pm_reference_forbidden" }, 403)
      : json({ environment });
    if (path === "/api/chat/threads/ordinary/history?format=ai-sdk/v6") return json(history("ordinary-private"));
    return readResponse(path, [thread("ordinary"), thread("pm-session")]);
  });
  const access = createRunBoardAccessScope();
  const board = createRunBoardData(io.client, access);
  const ordinaryHistory = createRunBoardHistoryData("ordinary", io.client, access);
  const execution = createRunBoardExecutionData("pm-session", io.client, access);
  const disposeBoard = board.start();
  const disposeHistory = ordinaryHistory.start();
  const disposeExecution = execution.start();
  try {
    await Promise.all([board.refresh(), ordinaryHistory.refresh(), execution.refresh()]);
    assert.equal(execution.getSnapshot().environment?.executionPath, environment.executionPath);
    const authorizedBoard = board.getSnapshot();
    const authorizedHistory = ordinaryHistory.getSnapshot();
    assert.equal(authorizedHistory.data?.messages[0]?.id, "ordinary-private");
    const readsBeforeDenial = io.requests.length;
    denied = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      await execution.refresh();
      assert.equal(execution.getSnapshot().environment, null);
      assert.equal(execution.getSnapshot().loading, false);
      assert.match(execution.getSnapshot().error || "", /所选 PM 引用不可访问/);
      assert.equal(access.revision(), 0);
      assert.equal(board.getSnapshot(), authorizedBoard);
      assert.equal(ordinaryHistory.getSnapshot(), authorizedHistory);
    }
    assert.deepEqual(io.requests.slice(readsBeforeDenial).map(request => request.path), [executionPath, executionPath, executionPath]);
    await Promise.all([board.refresh(), ordinaryHistory.refresh()]);
    assert.deepEqual(board.getSnapshot().threads.map(item => item.remoteId), ["ordinary", "pm-session"]);
    assert.equal(board.getSnapshot().error, null);
    assert.equal(ordinaryHistory.getSnapshot().data?.messages[0]?.id, "ordinary-private");
    assert.equal(ordinaryHistory.getSnapshot().error, null);
  } finally {
    disposeExecution();
    disposeHistory();
    disposeBoard();
  }
});

for (const status of [401, 403]) test(`execution HTTP ${status} authorization loss clears the board, history and verified terminal directory together`, async () => {
  let denied = false;
  const environment: ExecutionEnvironment = {
    version: 2, hostId: "local", agentWorkspaceId: workspace.id, agentWorkspaceName: workspace.name,
    agentWorkspaceRevision: workspace.revision, sourcePath: workspace.path, executionPath: workspace.path,
    worktree: null, frozen: true,
  };
  const io = transport(path => {
    if (path.endsWith("/execution")) return denied ? json({ error: "authorization lost", code: status === 401 ? "access_required" : "cross_origin" }, status) : json({ environment });
    if (path.includes("/history?")) return json(history("sensitive"));
    return readResponse(path, [thread()]);
  });
  const access = createRunBoardAccessScope();
  const board = createRunBoardData(io.client, access);
  const selectedHistory = createRunBoardHistoryData("session", io.client, access);
  const execution = createRunBoardExecutionData("session", io.client, access);
  const disposeBoard = board.start();
  const disposeHistory = selectedHistory.start();
  const disposeExecution = execution.start();
  await Promise.all([board.refresh(), selectedHistory.refresh(), execution.refresh()]);
  assert.equal(execution.getSnapshot().environment?.executionPath, workspace.path);
  denied = true;
  await execution.refresh();
  assert.equal(execution.getSnapshot().environment, null);
  assert.deepEqual(board.getSnapshot().threads, []);
  assert.deepEqual(board.getSnapshot().workspaces, []);
  assert.equal(selectedHistory.getSnapshot().data, null);
  assert.match(execution.getSnapshot().error || "", new RegExp(`HTTP ${status}`));
  disposeExecution();
  disposeHistory();
  disposeBoard();
});
