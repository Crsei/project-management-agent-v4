import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import type { ProviderSkillsSnapshot } from "@agent-workspace/contracts/provider";
import type { PmProviderHostService } from "./t3code/contract.ts";
import type { PmProviderApplication } from "./t3code/application.ts";
import { bindPmProviderApplicationAccess } from "./t3code/application-access.ts";
import { invalidateProviderSkillsSnapshots, makePmProviderManagement } from "./t3code/management.ts";
import { getStoredInstance, updateProviderInstance } from "./instances.ts";
import { providerRoutes } from "./routes.ts";

const actorId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "workspace";

test("skills route uses PM scope and instance revision, retaining native states without cross-project cache leakage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scoped-provider-skills-"));
  const oldRoot = process.env.AGENT_WORKSPACE_DATA_DIR;
  const originalFetch = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  let scans = 0;
  let cacheInvalidations = 0;
  let duringScan: (() => void) | undefined;
  let fail = false;
  let deny = false;
  globalThis.fetch = async (_input, init) => {
    if (deny) return new Response(null, { status: 403 });
    const scope = JSON.parse(String(init?.body)) as { workspaceId: string; projectId: string | null };
    return Response.json({ actorId, scope, workspaceName: "Workspace", projectName: scope.projectId, path: path.join(root, scope.projectId ?? "workspace") });
  };
  const host = {
    acquire: (context: { instanceId: string; revision: number; cwd: string }) => Effect.succeed({
      assertCurrent: Effect.suspend(() => getStoredInstance(context.instanceId)?.revision === context.revision
        ? Effect.void : Effect.fail(Object.assign(new Error("configuration changed"), { status: 409, code: "session_mismatch" }))),
      instance: {
        invalidateCaches: Effect.sync(() => { cacheInvalidations++; }),
        snapshotForCwd: (cwd: string) => Effect.suspend(() => {
          scans++;
          duringScan?.();
          return fail ? Effect.fail(new Error("native scan failed")) : Effect.succeed({
            status: "ready", skills: [{ name: path.basename(cwd), path: "native:virtual", enabled: false, userInvocable: false }],
            slashCommands: [{ name: "native", input: { hint: "args" } }], slashCommandsPending: false,
          });
        }),
      },
    }),
  } as unknown as PmProviderHostService;
  const management = makePmProviderManagement(host);
  const release = bindPmProviderApplicationAccess(() => ({ management } as PmProviderApplication));
  const call = (projectId: string, fresh = false) => providerRoutes.request("/providers/codex/skills/refresh", {
    method: "POST", headers: { "content-type": "application/json", cookie: "pm=session" },
    body: JSON.stringify({ scope: { workspaceId, projectId }, fresh }),
  });
  try {
    const first = await call("one");
    assert.equal(first.status, 200);
    const a: ProviderSkillsSnapshot = await first.json();
    assert.equal(a.cwd, path.join(root, "one"));
    assert.deepEqual(a.skills[0], { name: "one", path: "native:virtual", enabled: false, userInvocable: false });
    assert.equal(a.commands[0]?.input?.hint, "args");
    await call("one");
    assert.equal(scans, 1);
    const second = await call("two");
    const b: ProviderSkillsSnapshot = await second.json();
    assert.equal(b.skills[0]?.name, "two");
    assert.equal(scans, 2);
    const revisionBeforeMutation = getStoredInstance("codex")!.revision;
    const changed = invalidateProviderSkillsSnapshots(["codex"], "install_skill_unified");
    const refreshedOne: ProviderSkillsSnapshot = await (await call("one")).json();
    const refreshedTwo: ProviderSkillsSnapshot = await (await call("two")).json();
    assert.equal(scans, 4, "both scoped/cwd snapshots must be invalidated");
    assert.deepEqual(refreshedOne.nativeConfiguration, changed);
    assert.deepEqual(refreshedTwo.nativeConfiguration, changed);
    assert.equal(changed.reloadRequired, true);
    assert.equal(changed.liveExecutionsPreserved, true);
    assert.equal(getStoredInstance("codex")!.revision, revisionBeforeMutation, "a skill mutation is not an account/config reset");
    assert.ok(cacheInvalidations >= 2, "each changed scope refresh must invalidate source discovery caches");
    duringScan = () => { invalidateProviderSkillsSnapshots(["codex"], "toggle_skill_app"); };
    const superseded = await call("one", true);
    assert.equal(superseded.status, 409, "a scan crossing a configuration mutation cannot publish an old inventory");
    duringScan = undefined;
    await call("one");
    fail = true;
    const failed = await call("one", true);
    const failure: ProviderSkillsSnapshot = await failed.json();
    assert.equal(failure.error?.code, "discovery_failed");
    assert.equal(failure.skills[0]?.name, "one");
    fail = false;
    const current = getStoredInstance("codex")!;
    updateProviderInstance("codex", { label: "Changed" }, current.revision);
    const revised = await call("one");
    const newSnapshot: ProviderSkillsSnapshot = await revised.json();
    assert.notEqual(newSnapshot.revision, a.revision);
    assert.equal(scans, 8);
    deny = true;
    assert.equal((await call("one")).status, 403);
    const invalid = await providerRoutes.request("/providers/codex/skills/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { workspaceId, projectId: "one" }, cwd: "/arbitrary" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    release();
    await management.shutdown();
    globalThis.fetch = originalFetch;
    if (oldRoot === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
});
