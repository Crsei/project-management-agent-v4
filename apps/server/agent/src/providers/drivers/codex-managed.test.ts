import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProviderInstanceId } from "@t3tools/contracts";
import { migrateCodexManagedState } from "../t3code/families/codex-persistence.ts";
import { createProviderInstance, getStoredInstance, migrateProviderStartupState, providerContext, updateProviderInstance } from "../instances.ts";
import { closeStore } from "../../durable/store.ts";
import { makePmProviderPlatformLayer } from "../t3code/host-runtime.ts";
import { makePmProviderUpstreamServicesLayer } from "../t3code/host.ts";
import { makeCodexChatGptAuth } from "../../../../../../vendor/t3code/apps/server/src/provider/CodexChatGptAuth.ts";
import { makePmProviderCredentials } from "../t3code/credentials.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-source-account-"));
  const previousData = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
  const instance = createProviderInstance({ instanceId: "controlled-managed", driver: "codex", config: { setupMode: "managed" } });
  const context = providerContext(instance, root);
  const privateDirectory = path.join(context.stateDirectory, ".managed-codex");
  await mkdir(privateDirectory, { mode: 0o700 });
  const runtimeManifest = path.join(privateDirectory, "runtime", "package.json");
  const nativeHistory = path.join(context.homeDirectory, "sessions", "rollout-original.jsonl");
  await mkdir(path.dirname(runtimeManifest), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(nativeHistory), { recursive: true, mode: 0o700 });
  await writeFile(runtimeManifest, '{"name":"codex","version":"0.105.0-fixture"}\n', { mode: 0o600 });
  await writeFile(nativeHistory, '{"type":"session_meta","payload":{"id":"original-native-session"}}\n', { mode: 0o600 });
  const credentials = { hostId: "urn:uuid:11111111-1111-4111-8111-111111111111", activeClientId: "oaiapp_one", profiles: ["one", "two"].map(name => ({
    clientId: `oaiapp_${name}`, subject: `subject-${name}`, email: `${name}@example.invalid`, redirectUri: "http://127.0.0.1:1455/auth/callback",
    accessToken: `controlled-token-${name}`, refreshToken: null, idToken: null, expiresAt: Date.now() + 3600000, earliestRefreshAt: null,
    scopes: ["chatgpt.tokens.use.direct"],
  })) };
  const file = path.join(privateDirectory, "credentials.json");
  await writeFile(file, JSON.stringify(credentials), { mode: 0o600 });
  const services = makePmProviderUpstreamServicesLayer(context).pipe(Layer.provideMerge(makePmProviderPlatformLayer(context)));
  return { context, file, credentials, services, runtimeManifest, nativeHistory, close: async () => { closeStore();
    if (previousData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previousData;
    await rm(root, { recursive: true, force: true }); },
  };
}

test("one-time application-owned account conversion preserves profiles, identity and subsequent source profile selection", async () => {
  const f = await fixture();
  try {
    await migrateCodexManagedState(f.context);
    let stopCount = 0;
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* makeCodexChatGptAuth({ instanceId: ProviderInstanceId.make(f.context.instanceId) });
      const before = yield* auth.profiles;
      const first = yield* auth.read;
      yield* auth.selectProfile("oaiapp_two", Effect.sync(() => { stopCount++; }));
      return { before, first, after: yield* auth.profiles };
    })).pipe(Effect.provide(f.services)));
    assert.equal(result.before.find(profile => profile.id === "oaiapp_one")?.active, true);
    assert.equal(result.after.find(profile => profile.id === "oaiapp_two")?.active, true);
    assert.equal(stopCount, 1); assert.doesNotMatch(JSON.stringify(result.after), /controlled-token/);
    await migrateCodexManagedState(f.context);
    const after = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const auth = yield* makeCodexChatGptAuth({ instanceId: ProviderInstanceId.make(f.context.instanceId) });
      return yield* auth.profiles;
    })).pipe(Effect.provide(f.services)));
    assert.equal(after.find(profile => profile.id === "oaiapp_two")?.active, true, "the old account snapshot must never be replayed per request");
    assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), f.credentials, "migration preserves the application-owned rollback input");
  } finally { await f.close(); }
});

test("managed account conversion refuses unsafe ownership, symlinks and malformed profiles without importing a native Home", async () => {
  const f = await fixture();
  try {
    await chmod(f.file, 0o644);
    await assert.rejects(migrateCodexManagedState(f.context), /unsafe/);
    await chmod(f.file, 0o600);
    await rm(f.file);
    await symlink(path.join(f.context.stateDirectory, "not-a-credential"), f.file);
    await assert.rejects(migrateCodexManagedState(f.context), /unsafe/);
  } finally { await f.close(); }
});

test("late destination divergence rejects before publishing any earlier namespace and releases the converter lock", async () => {
  const f = await fixture();
  try {
    const credentials = makePmProviderCredentials();
    const host = await Effect.runPromise(credentials("codex-chatgpt-host", f.context.instanceId));
    const divergent = new TextEncoder().encode(JSON.stringify({ hostId: "urn:uuid:22222222-2222-4222-8222-222222222222" }));
    await Effect.runPromise(host.set(divergent));
    const original = await readFile(f.file, "utf8");
    await assert.rejects(migrateProviderStartupState(), /already differs/);
    for (const namespace of ["codex-chatgpt", "codex-chatgpt-registration"]) {
      const destination = await Effect.runPromise(credentials(namespace, f.context.instanceId));
      assert.equal(Option.isNone(await Effect.runPromise(destination.get)), true, "preflight must not partially publish another namespace");
    }
    assert.deepEqual([...Option.getOrThrow(await Effect.runPromise(host.get))], [...divergent]);
    assert.equal(await readFile(f.file, "utf8"), original);
    const directory = path.dirname(f.file);
    assert.equal((await readdir(directory)).includes("credentials.lock"), false);
    await assert.rejects(readFile(path.join(directory, "source-auth-migration-v1.json")), { code: "ENOENT" });
    assert.equal(getStoredInstance(f.context.instanceId)!.revision, f.context.revision);
    await Effect.runPromise(host.remove);
    await migrateProviderStartupState();
    assert.equal(getStoredInstance(f.context.instanceId)!.revision, f.context.revision);
    assert.equal((await readdir(directory)).some(name => name.startsWith(".source-migration-") || name === "credentials.lock"), false);
  } finally { await f.close(); }
});

test("restart converges from an interrupted matching namespace and never replays legacy state after the marker", async () => {
  const f = await fixture();
  try {
    const credentials = makePmProviderCredentials();
    const sessions = f.credentials.profiles.map(profile => ({ clientId: profile.clientId, subject: profile.subject,
      email: profile.email, accessToken: profile.accessToken, refreshToken: profile.refreshToken, expiresAt: profile.expiresAt,
      earliestRefreshAt: profile.earliestRefreshAt, scopes: profile.scopes }));
    const destination = await Effect.runPromise(credentials("codex-chatgpt", f.context.instanceId));
    const partial = new TextEncoder().encode(JSON.stringify({ activeClientId: f.credentials.activeClientId, sessions }));
    await Effect.runPromise(destination.set(partial));
    const original = await readFile(f.file, "utf8");
    await migrateProviderStartupState();
    assert.deepEqual([...Option.getOrThrow(await Effect.runPromise(destination.get))], [...partial]);
    for (const namespace of ["codex-chatgpt-registration", "codex-chatgpt-host"]) {
      const completed = await Effect.runPromise(credentials(namespace, f.context.instanceId));
      assert.equal(Option.isSome(await Effect.runPromise(completed.get)), true);
    }
    closeStore();
    const changed = new TextEncoder().encode(JSON.stringify({ activeClientId: "oaiapp_two", sessions }));
    await Effect.runPromise(destination.set(changed));
    await migrateProviderStartupState();
    assert.deepEqual([...Option.getOrThrow(await Effect.runPromise(destination.get))], [...changed]);
    assert.equal(await readFile(f.file, "utf8"), original);
    const current = getStoredInstance(f.context.instanceId)!;
    assert.equal(current.revision, f.context.revision);
    assert.equal(current.homeDirectory, f.context.homeDirectory);
    assert.equal(current.stateDirectory, f.context.stateDirectory);
    assert.equal(await readFile(f.runtimeManifest, "utf8"), '{"name":"codex","version":"0.105.0-fixture"}\n');
    assert.equal(await readFile(f.nativeHistory, "utf8"), '{"type":"session_meta","payload":{"id":"original-native-session"}}\n');
    const updated = updateProviderInstance(current.instanceId, {}, current.revision);
    assert.ok(updated.revision > current.revision);
  } finally { await f.close(); }
});
