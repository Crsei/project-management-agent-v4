import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import type { ExecutionSelection } from "@agent-workspace/contracts/chat";
import type { ProviderSkillsSnapshot } from "@agent-workspace/contracts/provider";
import type { PmProviderHostService } from "./t3code/contract.ts";
import type { PmProviderApplication } from "./t3code/application.ts";
import { openAgentWorkspace } from "../agent-workspaces.ts";
import { closeStore } from "../durable/store.ts";
import { ensureThread } from "../durable/threads.ts";
import { bindPmProviderApplicationAccess } from "./t3code/application-access.ts";
import { invalidateProviderSkillsSnapshots, makePmProviderManagement } from "./t3code/management.ts";
import { getStoredInstance, updateProviderInstance } from "./instances.ts";
import { providerRoutes } from "./routes.ts";

test("Skills resolve registered directories without PM and isolate native inventories by workspace and provider revision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-provider-skills-"));
  const oldDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
  const oldAllowed = process.env.AGENT_WORKSPACE_ALLOWED_ROOTS;
  const originalFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = JSON.stringify([directory]);
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("PM is unavailable."); };
  const selections = new Map<string, ExecutionSelection>();
  for (const name of ["one", "two"]) {
    const cwd = path.join(directory, name);
    await mkdir(cwd);
    const workspace = openAgentWorkspace({ path: cwd });
    selections.set(name, { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision });
  }
  let scans = 0;
  let cacheInvalidations = 0;
  let duringScan: (() => void | Promise<void>) | undefined;
  let fail = false;
  const host = {
    acquire: (context: { instanceId: string; revision: number; cwd: string }) => Effect.succeed({
      assertCurrent: Effect.suspend(() => getStoredInstance(context.instanceId)?.revision === context.revision
        ? Effect.void : Effect.fail(Object.assign(new Error("configuration changed"), { status: 409, code: "session_mismatch" }))),
      instance: {
        invalidateCaches: Effect.sync(() => { cacheInvalidations++; }),
        snapshotForCwd: (cwd: string) => Effect.tryPromise({
          try: async () => {
            assert.ok([path.join(directory, "one"), path.join(directory, "two")].includes(cwd), "Native discovery receives only a server-resolved directory.");
            assert.equal(cwd, context.cwd);
            scans++;
            await duringScan?.();
            if (fail) throw new Error("native scan failed");
            return {
              status: "ready", skills: [{ name: path.basename(cwd), path: "native:virtual", enabled: false, userInvocable: false }],
              slashCommands: [{ name: "native", input: { hint: "args" } }], slashCommandsPending: false,
            };
          },
          catch: error => error,
        }),
      },
    }),
  } as unknown as PmProviderHostService;
  const management = makePmProviderManagement(host);
  const release = bindPmProviderApplicationAccess(() => ({ management } as PmProviderApplication));
  const request = (body: object) => providerRoutes.request("/providers/codex/skills/refresh", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const call = (name: string, fresh = false) => request({ executionSelection: selections.get(name), fresh });
  try {
    updateProviderInstance("codex", { enabled: true });
    const first = await call("one");
    assert.equal(first.status, 200);
    const a: ProviderSkillsSnapshot = await first.json();
    assert.equal(a.cwd, path.join(directory, "one"));
    assert.deepEqual(a.skills[0], { name: "one", path: "native:virtual", enabled: false, userInvocable: false });
    assert.equal(a.commands[0]?.input?.hint, "args");
    await call("one");
    assert.equal(scans, 1);
    const second = await call("two");
    const b: ProviderSkillsSnapshot = await second.json();
    assert.equal(b.cwd, path.join(directory, "two"));
    assert.equal(b.skills[0]?.name, "two");
    assert.equal(scans, 2);
    const revisionBeforeMutation = getStoredInstance("codex")!.revision;
    const changed = invalidateProviderSkillsSnapshots(["codex"], "install_skill_unified");
    const refreshedOne: ProviderSkillsSnapshot = await (await call("one")).json();
    const refreshedTwo: ProviderSkillsSnapshot = await (await call("two")).json();
    assert.equal(scans, 4, "both directory inventories must be invalidated");
    assert.deepEqual(refreshedOne.nativeConfiguration, changed);
    assert.deepEqual(refreshedTwo.nativeConfiguration, changed);
    assert.equal(changed.reloadRequired, true);
    assert.equal(changed.liveExecutionsPreserved, true);
    assert.equal(getStoredInstance("codex")!.revision, revisionBeforeMutation, "a skill mutation is not an account/config reset");
    assert.ok(cacheInvalidations >= 2, "each changed workspace refresh must invalidate source discovery caches");
    duringScan = () => { invalidateProviderSkillsSnapshots(["codex"], "toggle_skill_app"); };
    assert.equal((await call("one", true)).status, 409, "a scan crossing a configuration mutation cannot publish an old inventory");
    duringScan = undefined;
    await call("one");
    fail = true;
    const failure: ProviderSkillsSnapshot = await (await call("one", true)).json();
    assert.equal(failure.error?.code, "discovery_failed");
    assert.equal(failure.skills[0]?.name, "one");
    fail = false;
    const current = getStoredInstance("codex")!;
    updateProviderInstance("codex", { label: "Changed" }, current.revision);
    const newSnapshot: ProviderSkillsSnapshot = await (await call("one")).json();
    assert.notEqual(newSnapshot.revision, a.revision);
    assert.equal(scans, 8);

    duringScan = () => {
      const provider = getStoredInstance("codex")!;
      updateProviderInstance("codex", { label: "Changed during scan" }, provider.revision);
    };
    assert.equal((await call("one", true)).status, 409, "provider authority is checked again after native discovery");
    duringScan = undefined;

    ensureThread("skills-session", undefined, selections.get("two"));
    const sessionSnapshot: ProviderSkillsSnapshot = await (await request({ threadId: "skills-session" })).json();
    assert.equal(sessionSnapshot.cwd, path.join(directory, "two"));
    assert.equal((await request({ threadId: "skills-session", executionSelection: selections.get("one") })).status, 409);
    ensureThread("chat-only");
    assert.equal((await request({ threadId: "chat-only" })).status, 412);
    assert.equal((await request({})).status, 412);
    assert.equal((await request({ executionSelection: selections.get("one"), cwd: "/arbitrary" })).status, 400);

    const beforeMissing = scans;
    await rename(path.join(directory, "one"), path.join(directory, "original-one"));
    assert.equal((await call("one")).status, 412, "a cached inventory cannot bypass live directory identity");
    assert.equal(scans, beforeMissing);
    duringScan = async () => {
      await rename(path.join(directory, "two"), path.join(directory, "original-two"));
      await mkdir(path.join(directory, "two"));
    };
    assert.equal((await call("two", true)).status, 412, "a replacement directory cannot publish an inventory from its old identity");
    assert.equal(networkCalls, 0);
  } finally {
    release();
    await management.shutdown();
    closeStore();
    globalThis.fetch = originalFetch;
    if (oldDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldDirectory;
    if (oldAllowed === undefined) delete process.env.AGENT_WORKSPACE_ALLOWED_ROOTS; else process.env.AGENT_WORKSPACE_ALLOWED_ROOTS = oldAllowed;
    await rm(directory, { recursive: true, force: true });
  }
});
