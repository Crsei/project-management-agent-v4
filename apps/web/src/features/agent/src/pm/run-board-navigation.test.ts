import assert from "node:assert/strict";
import test from "node:test";
import type { AgentWorkspace } from "@agent-workspace/contracts/chat";
import { consumedRunBoardTerminalParams, initializedDraftChatParams, newRunBoardSelection, requestedChatThread, resolvedRunBoardChatParams, runBoardChatHref, runBoardChatIntent, runBoardNavigationKey, runBoardRouteReplacementPending, safeRunBoardReturn, type RunBoardRouteReplacement } from "./run-board-navigation.ts";

const folder: AgentWorkspace = { id: "folder-a", name: "Folder A", path: "/registered/code", revision: 3, archivedAt: null, status: "available", createdAt: "2026-11-01", updatedAt: "2026-11-01" };
const paramsOf = (href: string) => new URL(href, "https://app.invalid").searchParams;

test("existing Session ids are encoded exactly, without PM scope or path interpretation", () => {
  const threadId = "original/session?with=reserved&characters#fragment";
  const returnTo = "/agent/runs?view=sessions&sessionId=selected&q=review+changes&folder=folder-a&provider=codex&attention=1";
  const params = paramsOf(runBoardChatHref({ threadId, agentWorkspaceId: folder.id, terminal: true, returnTo }));
  assert.deepEqual(runBoardChatIntent(params), { kind: "thread", threadId, agentWorkspaceId: folder.id });
  assert.equal(params.get("runReturn"), returnTo);
  assert.equal(params.get("openTerminal"), "1");
  assert.equal(params.has("workspace"), false);
  assert.equal(params.has("project"), false);
  assert.equal(params.has("newSession"), false);
  assert.equal([...params.values()].includes(folder.path), false);
});

test("new Session hand-off overrides cached selection and uses current registered revision", () => {
  const params = paramsOf(runBoardChatHref({ agentWorkspaceId: folder.id, returnTo: "/agent/runs?view=sessions" }));
  let cachedRead = false;
  assert.equal(requestedChatThread(params, () => { cachedRead = true; return "old-other-folder"; }), undefined);
  assert.equal(cachedRead, false);
  const intent = runBoardChatIntent(params);
  assert.equal(intent.kind, "new");
  if (intent.kind !== "new") throw new Error("Expected a new Session intent");
  assert.deepEqual(newRunBoardSelection(intent, [folder]), { version: 2, agentWorkspaceId: folder.id, agentWorkspaceRevision: 3 });
  assert.equal(newRunBoardSelection(intent, [{ ...folder, status: "unavailable" }]), null);
  assert.equal(newRunBoardSelection(intent, [{ ...folder, archivedAt: "2026-11-02" }]), null);
  assert.equal(newRunBoardSelection(intent, [{ ...folder, id: "other-folder" }]), null);
});

test("chat only is explicit; an omitted folder remains a chooser intent, not a fallback", () => {
  const explicit = runBoardChatIntent(paramsOf(runBoardChatHref({ agentWorkspaceId: null, returnTo: "/agent/runs" })));
  assert.deepEqual(explicit, { kind: "new", agentWorkspaceId: null });
  if (explicit.kind !== "new") throw new Error("Expected new Session");
  assert.deepEqual(newRunBoardSelection(explicit, [folder]), { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null });
  const chooser = runBoardChatIntent(paramsOf(runBoardChatHref({ returnTo: "/agent/runs" })));
  assert.deepEqual(chooser, { kind: "new" });
  if (chooser.kind !== "new") throw new Error("Expected chooser");
  assert.equal(newRunBoardSelection(chooser, [folder]), null);
});

test("URL-pinned creation receipt survives unknown initialization and resolves to the same Session", () => {
  const pending = paramsOf(runBoardChatHref({ agentWorkspaceId: folder.id, terminal: true, returnTo: "/agent/runs?view=sessions&folder=folder-a&sessionId=previous" }));
  pending.set("thread", "original-creation-id");
  const reloaded = new URLSearchParams(pending.toString());
  assert.deepEqual(runBoardChatIntent(reloaded), { kind: "new", threadId: "original-creation-id", agentWorkspaceId: folder.id });
  assert.equal(requestedChatThread(reloaded, () => "cached-other-session"), undefined);
  const resolved = resolvedRunBoardChatParams(reloaded, "original-creation-id");
  assert.deepEqual(runBoardChatIntent(resolved), { kind: "thread", threadId: "original-creation-id", agentWorkspaceId: folder.id });
  assert.equal(requestedChatThread(resolved, () => "cached-other-session"), "original-creation-id");
  assert.equal(resolved.get("runReturn"), pending.get("runReturn"));
  assert.equal(resolved.has("newSession"), false);
  assert.equal(resolved.get("openTerminal"), "1");
  const consumed = consumedRunBoardTerminalParams(resolved);
  assert.equal(consumed.has("openTerminal"), false);
  assert.equal(runBoardNavigationKey(consumed), runBoardNavigationKey(resolved));
  assert.equal(consumed.get("thread"), "original-creation-id");
  assert.equal(consumed.get("runReturn"), pending.get("runReturn"));
  assert.equal(consumedRunBoardTerminalParams(consumed).toString(), consumed.toString());
});

test("conflicting or incomplete explicit targets never resume cached Sessions", () => {
  for (const value of ["newSession=1&agentWorkspaceId=missing", "newSession=0", "agentWorkspaceId=missing", "thread=", "openTerminal=1"]) {
    assert.equal(requestedChatThread(new URLSearchParams(value), () => "cached-other-folder"), undefined, value);
  }
  for (const value of ["newSession=0", "newSession=1&agentWorkspaceId=folder-a&chatOnly=1", "newSession=1&chatOnly=0", "thread=a&thread=b", "thread=a&openTerminal=0", "agentWorkspaceId=folder-a", "thread=a&openTerminal=1&openTerminal=1"]) {
    assert.deepEqual(runBoardChatIntent(new URLSearchParams(value)), { kind: "invalid" }, value);
  }
  assert.equal(requestedChatThread(new URLSearchParams("thread=exact-session"), () => "cached"), "exact-session");
  assert.equal(requestedChatThread(new URLSearchParams(), () => "cached"), "cached");
});

test("safe board return retains both board variants and rejects hostile or unrelated targets", () => {
  const valid = ["/agent/runs", "/agent/runs?view=sessions&q=needs+review&folder=folder-a&sessionId=selected&provider=codex&attention=1", "/agent/runs?view=business&workspaceId=w&projectId=p&taskId=t&runId=r&q=output&status=failed&definitionId=agent-v3"];
  for (const value of valid) assert.equal(safeRunBoardReturn(value), value);
  for (const value of [null, "https://evil.invalid/agent/runs", "//evil.invalid/agent/runs", "/agent/runs/../workspace", "/agent/runs-other", "/pm/w", "/agent/runs#external", "/agent/runs?returnTo=https://evil.invalid", "/agent/runs?q=x\\evil", "/agent/runs?q=%5cevil", "/agent/runs?q=%0aevil", "/agent/runs?view=automations", "/agent/runs?attention=0", "/agent/runs?runId=a&runId=b", "/agent/runs?q=%", "/agent/runs?__proto__=x"]) {
    assert.equal(safeRunBoardReturn(value), null, String(value));
  }
  assert.equal(paramsOf(runBoardChatHref({ threadId: "session", returnTo: "//evil.invalid" })).get("runReturn"), "/agent/runs");
});

test("consumed new-Session receipt cannot initialize again while Router still renders its old URL", () => {
  const original = paramsOf(runBoardChatHref({ agentWorkspaceId: folder.id, returnTo: "/agent/runs?view=sessions&folder=folder-a", terminal: true }));
  const pinned = new URLSearchParams(original);
  pinned.set("thread", "original-creation-id");
  const resolved = resolvedRunBoardChatParams(pinned, "original-creation-id");
  let replacement: RunBoardRouteReplacement | undefined;
  let initializations = 0;
  const render = (params: URLSearchParams) => {
    if (runBoardRouteReplacementPending(replacement, runBoardNavigationKey(params))) return;
    replacement = undefined;
    if (runBoardChatIntent(params).kind === "new") initializations++;
  };
  render(original);
  replacement = { fromKeys: [runBoardNavigationKey(original), runBoardNavigationKey(pinned)], toKey: runBoardNavigationKey(resolved) };
  render(original);
  render(pinned);
  render(pinned);
  assert.equal(initializations, 1);
  render(resolved);
  assert.equal(replacement, undefined);
  assert.equal(initializations, 1);
  assert.equal(resolved.get("thread"), "original-creation-id");
  assert.equal(resolved.get("openTerminal"), "1");
  render(paramsOf(runBoardChatHref({ agentWorkspaceId: "another-registered-folder", returnTo: "/agent/runs" })));
  assert.equal(initializations, 2);
});

test("explicit terminal hand-off cannot be overwritten by an old or missing active Session", () => {
  const params = paramsOf(runBoardChatHref({ threadId: "requested-session", agentWorkspaceId: folder.id, terminal: true, returnTo: "/agent/runs?view=sessions&sessionId=requested-session" }));
  const original = params.toString();
  for (const remoteId of [undefined, "old-other-folder-session", "requested-session"]) {
    assert.equal(initializedDraftChatParams(params, remoteId, true), null);
    assert.equal(initializedDraftChatParams(params, remoteId, false), null);
  }
  assert.equal(params.toString(), original);
  assert.equal(params.get("agentWorkspaceId"), folder.id);
  assert.equal(params.get("openTerminal"), "1");
  const consumed = consumedRunBoardTerminalParams(params);
  assert.equal(consumed.get("thread"), "requested-session");
  assert.equal(consumed.get("agentWorkspaceId"), folder.id);
  assert.equal(consumed.has("openTerminal"), false);
  assert.equal(initializedDraftChatParams(consumed, "old-other-folder-session", true), null);
});

test("only a newly initialized unaddressed draft may publish its registered remote id", () => {
  const params = new URLSearchParams({ runReturn: "/agent/runs?view=sessions&folder=folder-a", returnTo: "/pm/workspace/home", workspace: "pm-reference-workspace" });
  assert.equal(initializedDraftChatParams(params, "cached-history", false), null);
  assert.equal(initializedDraftChatParams(params, undefined, true), null);
  const promoted = initializedDraftChatParams(params, "created-session", true);
  assert.equal(promoted?.get("thread"), "created-session");
  assert.equal(promoted?.get("runReturn"), params.get("runReturn"));
  assert.equal(promoted?.get("returnTo"), params.get("returnTo"));
  assert.equal(promoted?.get("workspace"), params.get("workspace"));
  for (const intent of ["newSession=1", "agentWorkspaceId=missing", "chatOnly=1", "openTerminal=1", "thread="]) {
    assert.equal(initializedDraftChatParams(new URLSearchParams(intent), "cached-history", true), null, intent);
  }
});
