import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "../instances.ts";
import { beginProviderExecution, beginProviderHostMutation, registerProviderResourceBindings, requireAccountIdle } from "../auth.ts";
import type { PmProviderHostService } from "./contract.ts";
import type { ProviderAuthSessionInvalidationRequest } from "../../../../../../vendor/t3code/apps/server/src/provider/ProviderAuthService.ts";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId, ProviderSetupError, ServerProvider } from "@t3tools/contracts";
import { makePmProviderAuthSessionInvalidation, projectProviderAuthInteraction, projectProviderAuthMethods, projectProviderSnapshot } from "./management.ts";

test("source readiness, unknown auth, custom models and update requirements remain distinct", () => {
  const source = Schema.decodeUnknownSync(ServerProvider)({
    instanceId: "open-code-account", driver: "opencode", enabled: true, installed: true, version: "2.0.18", status: "ready",
    auth: { status: "unknown" }, checkedAt: "2026-10-30T00:00:00.000Z",
    models: [{ slug: "provider/model", name: "Native model", shortName: "Native", badge: "new", subProvider: "Provider",
      isCustom: false, capabilities: { optionDescriptors: [{ id: "plan", label: "Plan", type: "boolean", currentValue: false }] } }],
    updateRequiredModels: [{ slug: "new-model", name: "Needs update", minVersion: "2.0.20" }],
  });
  const status = projectProviderSnapshot(source);
  assert.equal(status.installation.status, "installed");
  assert.equal(status.authentication, "unknown");
  assert.equal(status.nativeSessionReady, true);
  assert.equal(status.canLogout, false);
  assert.equal(status.models[0]?.id, "provider/model");
  assert.equal(status.models[0]?.shortName, "Native");
  assert.equal(status.models[0]?.badge, "new");
  assert.equal(status.models[0]?.subProvider, "Provider");
  assert.equal(status.models[0]?.capabilities?.optionDescriptors?.[0]?.id, "plan");
  assert.deepEqual(status.updateRequiredModels, [{ id: "new-model", label: "Needs update", minVersion: "2.0.20" }]);
  assert.equal(status.capabilities, undefined);
  const codex = projectProviderSnapshot({ ...source, driver: ProviderDriverKind.make("codex") });
  assert.equal(codex.requiresOpenaiAuth, false);
  const unknown = projectProviderSnapshot({ ...source, availability: "unavailable", installed: false });
  assert.equal(unknown.installation.status, "unknown");
  assert.equal(unknown.authentication, "unknown");
  assert.equal(unknown.nativeSessionReady, false);
  assert.equal(projectProviderSnapshot({ ...source, status: "error", auth: { status: "authenticated" } }).nativeSessionReady, false);
});

test("source authentication interaction IDs and secret fields round-trip without invented account identity", () => {
  assert.deepEqual(projectProviderAuthInteraction({ type: "deviceCode", id: "device", url: "https://provider.invalid/login", userCode: "TEST-ONLY" }),
    { type: "device-code", id: "device", url: "https://provider.invalid/login", userCode: "TEST-ONLY" });
  const credentials = { type: "credentials" as const, id: "native-fields", fields: [{ name: "token", label: "API token", secret: true }] };
  assert.deepEqual(projectProviderAuthInteraction(credentials), credentials);
  assert.deepEqual(projectProviderAuthMethods([{ id: "native", name: "Native sign in", description: null, type: "agent" }]),
    [{ id: "native", name: "Native sign in", type: "browser" }]);
});

async function withPrivateAccounts(use: (owner: string, peer: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-auth-session-port-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  try {
    for (const id of ["port-owner", "port-peer"]) createProviderInstance({
      instanceId: id, driver: "opencode",
      environment: [{ name: "HOME", value: path.join(root, id, "native-home"), sensitive: false }],
    });
    registerProviderResourceBindings("port-owner", ["credential:provider:shared-session-owner"]);
    registerProviderResourceBindings("port-peer", ["credential:provider:shared-session-owner"]);
    await use("port-owner", "port-peer");
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
function invalidationRequest(owner: string, target = owner): ProviderAuthSessionInvalidationRequest {
  return {
    requestingInstanceId: ProviderInstanceId.make(owner), instanceId: ProviderInstanceId.make(target),
    credentialBinding: { owner: "provider", key: "shared-session-owner" },
    isCurrent: Effect.succeed(true),
  };
}
test("the real PM auth port requires account exclusion, advances peer revisions and propagates drain failure", async () =>
  withPrivateAccounts(async (owner, peer) => {
    const invalidated: string[] = [];
    let failDrain = false;
    const host: PmProviderHostService = {
      acquire: () => Effect.die("This port must not acquire a second provider instance."),
      invalidate: id => Effect.suspend(() => {
        invalidated.push(id);
        return failDrain ? Effect.fail(Object.assign(new Error("private drain diagnostics"), { code: "cleanup_failed", status: 500 })) : Effect.void;
      }),
      shutdown: Effect.die("This port must not shut down the application host."),
    };
    const port = makePmProviderAuthSessionInvalidation(host);
    const previousPeer = getStoredInstance(peer)!.revision;
    await assert.rejects(Effect.runPromise(port.invalidateSessions(invalidationRequest(owner))), ProviderSetupError);
    assert.deepEqual(invalidated, []);
    const releaseExecution = beginProviderExecution(peer);
    try { assert.throws(() => beginProviderHostMutation(owner, false), { status: 409 }); }
    finally { releaseExecution(); }
    const release = beginProviderHostMutation(owner, false);
    try {
      await Effect.runPromise(port.invalidateSessions(invalidationRequest(owner)));
      const peerRevision = getStoredInstance(peer)!.revision;
      assert.ok(peerRevision > previousPeer);
      await Effect.runPromise(port.invalidateSessions(invalidationRequest(owner, peer)));
      assert.equal(getStoredInstance(peer)!.revision, peerRevision);
      assert.deepEqual(invalidated, [owner, peer]);
      failDrain = true;
      await assert.rejects(Effect.runPromise(port.invalidateSessions(invalidationRequest(owner))), error =>
        error instanceof ProviderSetupError && error.operation === "stopSessions" && !error.message.includes("private drain diagnostics"));
    } finally { release(); }
    requireAccountIdle(owner);
    requireAccountIdle(peer);
  }),
);
test("the real PM auth port does not close a peer rebound while its source ownership check awaited", async () =>
  withPrivateAccounts(async (owner, peer) => {
    const invalidated: string[] = [];
    const host: PmProviderHostService = {
      acquire: () => Effect.die("Unexpected acquisition by session invalidation."),
      invalidate: id => Effect.sync(() => { invalidated.push(id); }),
      shutdown: Effect.die("Unexpected shutdown by session invalidation."),
    };
    const port = makePmProviderAuthSessionInvalidation(host);
    const release = beginProviderHostMutation(owner, false);
    try {
      let checks = 0;
      await Effect.runPromise(port.invalidateSessions({
        ...invalidationRequest(owner, peer),
        isCurrent: Effect.sync(() => {
          if (++checks === 2) {
            const current = getStoredInstance(peer)!;
            updateProviderInstance(peer, { environment: [{ name: "HOME", value: path.join(current.stateDirectory, "replacement-native-home"), sensitive: false }] }, current.revision);
          }
          return true;
        }),
      }));
      assert.deepEqual(invalidated, []);
      assert.throws(() => beginProviderExecution(peer), (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 409);
      await assert.rejects(Effect.runPromise(port.invalidateSessions({
        ...invalidationRequest(owner), isCurrent: Effect.succeed(false),
      })), ProviderSetupError);
    } finally { release(); }
  }),
);
