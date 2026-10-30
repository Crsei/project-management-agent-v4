import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderAuthState } from "@agent-workspace/contracts/provider";
import { codexAdapter } from "./drivers/codex.ts";
import type { ProviderDriverAuthOptions } from "./driver-adapter.ts";
import { createProviderInstance, getStoredInstance, updateProviderInstance } from "./instances.ts";
import { beginProviderAccountOperation, beginProviderExecution, beginProviderHostMutation, beginProviderMaintenance, beginProviderStatus, cancelProviderAuth, getAuthState, invalidateProviderResourcePeers, logoutProvider, registerProviderResourceBindings, requireAccountIdle, resetAuthState, startProviderAuth, subscribeAuth, writeAuthInput } from "./auth.ts";
import { providerRoutes } from "./routes.ts";
import { resolveProviderRuntime, runNativeRuntime } from "./runtime.ts";

async function isolated(run: (state: { authenticated: boolean }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "native-auth-"));
  const previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
  const original = { check: codexAdapter.check, authenticate: codexAdapter.authenticate, logout: codexAdapter.logout, run: codexAdapter.run };
  const state = { authenticated: false };
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  codexAdapter.check = async () => ({
    installation: { status: "installed" }, authentication: state.authenticated ? "authenticated" : "unauthenticated",
    nativeSessionReady: state.authenticated,
    models: [], canLogout: state.authenticated,
    methods: [{ id: "native-key", name: "Native account", type: "credentials", fields: [{ name: "token", label: "Token", secret: true }] }],
  });
  try { await run(state); }
  finally {
    const auth = await getAuthState("codex");
    if (auth.flowId && ["starting", "waiting", "verifying"].includes(auth.phase)) await cancelProviderAuth("codex", auth.flowId);
    resetAuthState("codex"); Object.assign(codexAdapter, original);
    if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}
async function finish(): Promise<ProviderAuthState> {
  for await (const state of subscribeAuth("codex")) {
    if (["succeeded", "failed", "cancelled"].includes(state.phase)) return state;
  }
  throw new Error("Authentication stream ended without a terminal state.");
}

test("native credential input invalidates account revision and never appears in public auth output", async () => {
  await isolated(async state => {
    const secret = "fixture-native-credential-never-public";
    const ready = Promise.withResolvers<void>();
    codexAdapter.authenticate = async (_context, options) => {
      options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id: "native-key", fields: [{ name: "token", label: "Token", secret: true }] } });
      const pending = options.readInput(); ready.resolve();
      const values = JSON.parse(await pending) as { token: string };
      if (values.token !== secret) throw new Error("Native account rejected the credential.");
      options.onUpdate({ output: `native log: ${values.token}`, interaction: { type: "terminal", id: "log", output: `native terminal: ${values.token}` } });
      state.authenticated = true;
    };
    const revision = getStoredInstance("codex")!.revision;
    const started = await startProviderAuth("codex", { methodId: "native-key" });
    assert.ok(getStoredInstance("codex")!.revision > revision);
    await ready.promise;
    await assert.rejects(startProviderAuth("codex", { values: { token: secret } }), { status: 409 });
    const response = await providerRoutes.request("http://localhost/providers/codex/auth/input", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flowId: started.flowId, input: JSON.stringify({ token: secret }) }),
    });
    assert.equal(response.status, 200);
    const result = await finish();
    assert.equal(result.phase, "succeeded");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.match(result.output, /\[redacted\]/);
    const iterator = subscribeAuth("codex");
    assert.equal((await iterator.next()).value?.phase, "succeeded");
    assert.equal((await iterator.next()).done, true);
    assert.equal(started.flowId, result.flowId);
  });
});

test("authentication failures redact submitted native secrets instead of publishing provider errors", async () => {
  await isolated(async () => {
    const secret = "private-native-error-token";
    codexAdapter.authenticate = async (_context, options) => { throw new Error(`Native rejected ${options.values?.token}`); };
    await startProviderAuth("codex", { methodId: "native-key", values: { token: secret } });
    const result = await finish();
    assert.equal(result.phase, "failed");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.match(result.message!, /\[redacted\]/);
  });
});

test("cancellation waits for native process settlement and prevents overlapping account mutation", async () => {
  await isolated(async () => {
    const ready = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    codexAdapter.authenticate = async (_context, options) => {
      options.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      options.onUpdate({ phase: "waiting" }); ready.resolve();
      await aborted.promise; await release.promise; options.signal.throwIfAborted();
    };
    const started = await startProviderAuth("codex", { methodId: "native-key" });
    await ready.promise;
    let settled = false;
    const cancelling = cancelProviderAuth("codex", started.flowId!).then(value => { settled = true; return value; });
    await aborted.promise;
    try {
      assert.equal(settled, false);
      await assert.rejects(startProviderAuth("codex", { methodId: "native-key" }), { status: 409 });
    } finally { release.resolve(); }
    assert.equal((await cancelling).phase, "cancelled");
  });
});

test("config changes abort old native auth without allowing a replacement before termination", async () => {
  await isolated(async () => {
    const ready = Promise.withResolvers<ProviderDriverAuthOptions>();
    const release = Promise.withResolvers<void>();
    codexAdapter.authenticate = async (_context, options) => { ready.resolve(options); await release.promise; options.signal.throwIfAborted(); };
    await startProviderAuth("codex", { methodId: "native-key" });
    const options = await ready.promise;
    updateProviderInstance("codex", { label: "Changed account config" }, getStoredInstance("codex")!.revision);
    resetAuthState("codex");
    try {
      assert.equal(options.signal.aborted, true);
      await assert.rejects(startProviderAuth("codex", { methodId: "native-key" }), { status: 409 });
    } finally { release.resolve(); }
    // Await native settlement through the terminal stream rather than a timing delay.
    const ended = await finish();
    assert.equal(ended.phase, "failed");
  });
});

test("unknown native authentication methods do not mutate the instance revision", async () => {
  await isolated(async () => {
    const revision = getStoredInstance("codex")!.revision;
    await assert.rejects(startProviderAuth("codex", { methodId: "invented-api-provider" }), { status: 400 });
    assert.equal(getStoredInstance("codex")!.revision, revision);
  });
});

test("empty terminal input is a real Enter submission, not a missing field", async () => {
  await isolated(async state => {
    const ready = Promise.withResolvers<void>();
    codexAdapter.authenticate = async (_context, options) => {
      options.onUpdate({ phase: "waiting", interaction: { type: "terminal", id: "native-terminal", output: "Press Enter" } });
      const input = options.readInput(); ready.resolve();
      if (await input !== "") throw new Error("Native terminal did not accept this input.");
      state.authenticated = true;
    };
    const started = await startProviderAuth("codex", { methodId: "native-key" }); await ready.promise;
    const response = await providerRoutes.request("http://localhost/providers/codex/auth/input", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flowId: started.flowId, input: "" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await finish()).phase, "succeeded");
    assert.throws(() => writeAuthInput("codex", started.flowId!, "stale input"), { status: 409 });
  });
});

test("a stale credential form cannot enter the replacement native login flow", async () => {
  await isolated(async state => {
    let ready = Promise.withResolvers<void>();
    codexAdapter.authenticate = async (_context, options) => {
      options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id: "native-key", fields: [{ name: "token", label: "Token", secret: true }] } });
      const pending = options.readInput(); ready.resolve();
      const values = JSON.parse(await pending) as { token: string };
      if (values.token !== "current-account") throw new Error("Wrong native account credential.");
      state.authenticated = true;
    };
    const old = await startProviderAuth("codex", { methodId: "native-key" }); await ready.promise;
    await cancelProviderAuth("codex", old.flowId!);
    ready = Promise.withResolvers<void>();
    const current = await startProviderAuth("codex", { methodId: "native-key" }); await ready.promise;
    assert.throws(() => writeAuthInput("codex", old.flowId!, JSON.stringify({ token: "stale-account" })), { status: 404 });
    await assert.rejects(startProviderAuth("codex", { methodId: "native-key", values: { token: "stale-account" } }), { status: 409 });
    assert.equal((await getAuthState("codex")).flowId, current.flowId);
    writeAuthInput("codex", current.flowId!, JSON.stringify({ token: "current-account" }));
    assert.equal((await finish()).phase, "succeeded");
  });
});

test("account switching cannot admit native sessions under the transitional revision", async () => {
  await isolated(async state => {
    state.authenticated = true;
    updateProviderInstance("codex", { customModels: [{ id: "fixture-native", label: "Fixture" }] }, getStoredInstance("codex")!.revision);
    const oldRuntime = await resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture-native" });
    const ready = Promise.withResolvers<void>();
    codexAdapter.authenticate = async (_context, options) => {
      options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id: "account", fields: [{ name: "token", label: "Token", secret: true }] } });
      const pending = options.readInput(); ready.resolve(); await pending;
    };
    const started = await startProviderAuth("codex", { methodId: "native-key" }); await ready.promise;
    await assert.rejects(resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture-native" }), { code: "provider_busy" });
    await assert.rejects(runNativeRuntime(oldRuntime, { prompt: "Must not execute as another account." }), { code: "session_mismatch" });
    writeAuthInput("codex", started.flowId!, JSON.stringify({ token: "replacement-account" }));
    assert.equal((await finish()).phase, "succeeded");
    const current = await resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture-native" });
    assert.notEqual(current.instanceRevision, oldRuntime.instanceRevision);
  });
});

test("logout excludes login and native admission until its credential mutation settles", async () => {
  await isolated(async state => {
    state.authenticated = true;
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    codexAdapter.logout = async () => { entered.resolve(); await release.promise; state.authenticated = false; };
    const logout = logoutProvider("codex"); await entered.promise;
    try {
      await assert.rejects(startProviderAuth("codex", { methodId: "native-key" }), { status: 409 });
      await assert.rejects(resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture-native" }), { code: "provider_busy" });
    } finally { release.resolve(); }
    assert.equal((await logout).ok, true);
    assert.equal((await getAuthState("codex")).phase, "idle");
  });
});

test("parallel native turns retain the account until every execution has settled", async () => {
  await isolated(async state => {
    state.authenticated = true;
    updateProviderInstance("codex", { customModels: [{ id: "fixture-native", label: "Fixture" }] }, getStoredInstance("codex")!.revision);
    const runtime = await resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture-native" });
    const entered = Promise.withResolvers<void>();
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]; let count = 0;
    codexAdapter.run = async () => {
      const gate = gates[count++]!; if (count === 2) entered.resolve();
      await gate.promise; return { text: "native operation settled" };
    };
    codexAdapter.logout = async () => { state.authenticated = false; };
    const first = runNativeRuntime(runtime, { prompt: "first" });
    let second: Promise<unknown> | undefined;
    try {
      const parallelRuntime = await resolveProviderRuntime({ providerInstanceId: "codex", modelName: "fixture-native" });
      second = runNativeRuntime(parallelRuntime, { prompt: "second" });
      await entered.promise;
      await assert.rejects(startProviderAuth("codex", { methodId: "native-key" }), { status: 409 });
      gates[0]!.resolve(); await first;
      await assert.rejects(logoutProvider("codex"), { status: 409 });
    } finally { for (const gate of gates) gate.resolve(); await Promise.all([first, second]); }
    assert.equal((await logoutProvider("codex")).ok, true);
  });
});

test("read reservations are counted and idempotent across overlapping probes", async () => isolated(async () => {
  const one = beginProviderStatus("codex");
  const two = beginProviderStatus("codex");
  one(); one();
  assert.throws(() => requireAccountIdle("codex"), { status: 409 });
  two();
  const execution = beginProviderExecution("codex");
  execution(); execution();
  const account = beginProviderAccountOperation("codex");
  account();
  const later = beginProviderAccountOperation("codex");
  account();
  assert.throws(() => beginProviderExecution("codex"), { status: 409 });
  later();
}));

test("original credential bindings and installation lock keys exclude sibling instances", async () => isolated(async () => {
  createProviderInstance({ instanceId: "codex-secondary", driver: "codex", config: { homePath: join(tmpdir(), "separate-native-account") } });
  registerProviderResourceBindings("codex", ["credential:t3:shared-app-binding", "maintenance:shared-installer"]);
  registerProviderResourceBindings("codex-secondary", ["credential:t3:shared-app-binding", "maintenance:shared-installer"]);
  const execution = beginProviderExecution("codex-secondary");
  assert.throws(() => beginProviderAccountOperation("codex"), { status: 409 });
  assert.throws(() => beginProviderMaintenance("codex"), { status: 409 });
  execution();
  const maintenance = beginProviderMaintenance("codex");
  assert.throws(() => beginProviderExecution("codex-secondary"), { status: 409 });
  maintenance(); maintenance();
  requireAccountIdle("codex-secondary");
}));

test("source mutations share local exclusion and invalidate sibling account revisions before native writes", async () => isolated(async () => {
  createProviderInstance({ instanceId: "codex-bound-peer", driver: "codex", config: { homePath: join(tmpdir(), "bound-peer-native-home") } });
  registerProviderResourceBindings("codex", ["credential:t3:original-binding"]);
  registerProviderResourceBindings("codex-bound-peer", ["credential:t3:original-binding"]);
  const revision = getStoredInstance("codex-bound-peer")!.revision;
  const release = beginProviderHostMutation("codex", false);
  try {
    assert.throws(() => beginProviderHostMutation("codex", false), { status: 409 });
    assert.throws(() => beginProviderExecution("codex-bound-peer"), { status: 409 });
    invalidateProviderResourcePeers("codex");
    assert.ok(getStoredInstance("codex-bound-peer")!.revision > revision);
    assert.equal(getStoredInstance("codex-bound-peer")!.observations, undefined);
  } finally { release(); release(); }
  requireAccountIdle("codex-bound-peer");
}));
