import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentOptions, InteractionUpdate, Run, RunResult, SDKAgent, SdkLoginOptions, SendOptions, StoredSdkCredentials } from "@cursor/sdk";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { buildCursorDiscoveredModels, createCursorAdapter } from "./cursor.ts";
import { cursorCredentialPath, readCursorCredentials, saveCursorCredentials } from "./cursor-credentials.ts";
import { createCursorInvoker, CursorWorkerError } from "./cursor-process.ts";
import { cursorAbortError, CursorTransportFailure, executeCursorSdk } from "./cursor-sdk.ts";
import type { CursorEvent, CursorResult, CursorSdkModule, CursorSqliteModule } from "./cursor-sdk.ts";
import { cursorOwnedGroupMembers, waitForCursorOwnedProcesses } from "./cursor-process-tree.ts";

const credentials: StoredSdkCredentials = {
  version: 1,
  backendUrl: "https://api2.cursor.sh",
  apiKey: "private-browser-key-for-controlled-tests",
  createdAtMs: 1,
  apiKeyExpiresAtMs: 9_000_000_000_000,
  email: "controlled@example.com",
};

async function isolated(task: (context: ProviderDriverContext) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cursor-native-"));
  const home = path.join(directory, "home");
  const cwd = path.join(directory, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  const context: ProviderDriverContext = {
    instanceId: "cursor-controlled", driver: "cursor", config: {},
    homeDirectory: home, cwd, env: {}, revision: 3,
  };
  try { await task(context); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function sdkHarness(options: {
  updates?: InteractionUpdate[];
  result?: RunResult;
  wait?: () => Promise<RunResult>;
  send?: () => Promise<void>;
  catalogError?: Error;
  login?: (options: SdkLoginOptions) => Promise<void>;
  conflict?: boolean;
  dispose?: () => Promise<void>;
} = {}) {
  const observed = {
    open: undefined as AgentOptions | undefined,
    resumed: undefined as string | undefined,
    sends: 0, cancelled: 0, closed: 0, syncClosed: 0, disposed: 0,
    stateRoot: "", workspaceRef: "", userCalls: 0, modelCalls: 0,
    login: undefined as SdkLoginOptions | undefined,
    recovered: [] as string[],
  };
  const result: RunResult = options.result ?? { id: "run-controlled", status: "finished", result: "fallback" };
  let status: Run["status"] = "running";
  const run = {
    id: "run-controlled", agentId: "agent-controlled",
    get status() { return status; },
    async wait() { const value = options.wait ? await options.wait() : result; status = value.status; return value; },
    async cancel() { observed.cancelled++; status = "cancelled"; },
  } as Run;
  const agent = {
    agentId: "agent-controlled",
    async send(_message: string, sendOptions: SendOptions) {
      observed.sends++;
      if (options.conflict && observed.sends === 1) throw new Error("Agent already has active run");
      for (const update of options.updates ?? []) await sendOptions.onDelta?.({ update });
      await options.send?.();
      return run;
    },
    close() { observed.syncClosed++; },
    async [Symbol.asyncDispose]() { await options.dispose?.(); observed.closed++; },
  } as unknown as SDKAgent;
  class MemoryStore {
    private value: StoredSdkCredentials | undefined;
    async load() { return this.value; }
    async save(value: StoredSdkCredentials) { this.value = value; }
    async clear() { this.value = undefined; }
  }
  const sdk = {
    InMemoryCredentialStore: MemoryStore,
    Agent: {
      async create(open: AgentOptions) { observed.open = open; return agent; },
      async resume(id: string, open: AgentOptions) { observed.resumed = id; observed.open = open; return agent; },
      async listRuns() { return { items: [{ id: "abandoned", status: "running" }] }; },
      async cancelRun(id: string) { observed.recovered.push(id); },
    },
    Cursor: {
      async me() { observed.userCalls++; if (options.catalogError) throw options.catalogError; return { apiKeyName: "test", userEmail: "controlled@example.com" }; },
      models: { async list() { observed.modelCalls++; if (options.catalogError) throw options.catalogError; return [{ id: "live-model", displayName: "Live model" }]; } },
      auth: { async login(login: SdkLoginOptions) {
        observed.login = login;
        if (options.login) await options.login(login);
        else {
          login.onLoginUrl?.("https://cursor.com/loginDeepControl?challenge=controlled");
          await login.store?.save(credentials);
        }
        return { apiKey: credentials.apiKey, apiKeyExpiresAtMs: credentials.apiKeyExpiresAtMs };
      } },
    },
  } as unknown as CursorSdkModule;
  const sqlite = {
    SqliteLocalAgentStore: { async open(input: { stateRoot: string; workspaceRef: string }) {
      observed.stateRoot = input.stateRoot;
      observed.workspaceRef = input.workspaceRef;
      return { async dispose() { observed.disposed++; } };
    } },
  } as unknown as CursorSqliteModule;
  return { sdk, sqlite, observed };
}

const request = {
  operation: "run" as const, apiKey: "controlled-key", model: "auto", prompt: "hello",
  cwd: "/controlled/workspace", stateRoot: "/controlled/home/.cursor/sdk/state",
};

test("Cursor SDK discovers account models without a billable agent turn", async () => {
  const harness = sdkHarness();
  const result = await executeCursorSdk(harness.sdk, () => harness.sqlite,
    { operation: "check", apiKey: "controlled-key" }, new AbortController().signal, async () => undefined);
  assert.equal(result.operation, "check");
  assert.equal(harness.observed.userCalls, 1);
  assert.equal(harness.observed.modelCalls, 1);
  assert.equal(harness.observed.open, undefined);
  assert.equal(harness.observed.sends, 0);
  assert.deepEqual(buildCursorDiscoveredModels([
    { id: " live ", displayName: " Live " },
    { id: "live", displayName: "duplicate" },
    { id: "", displayName: "invalid" },
  ]), [{ id: "live", label: "Live", source: "discovered", temperature: false }]);
});

test("Cursor SDK streams early callbacks, passes native cwd/store and keeps final usage", async () => {
  const harness = sdkHarness({
    updates: [{ type: "text-delta", text: "early " }, { type: "text-delta", text: "answer" }] as InteractionUpdate[],
    result: { id: "run-controlled", status: "finished", result: "early answer",
      usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5 } },
  });
  const events: CursorEvent[] = [];
  const result = await executeCursorSdk(harness.sdk, () => harness.sqlite, request,
    new AbortController().signal, async (event) => { events.push(event); });
  assert.equal(result.operation === "run" && result.text, "early answer");
  assert.deepEqual(events.filter((event) => event.type === "text").map((event) => event.text), ["early ", "answer"]);
  assert.ok(events.some((event) => event.type === "output" && event.event.type === "item.upsert" &&
    event.event.item.type === "assistant_message" && event.event.item.text === "early answer"));
  assert.equal(harness.observed.open?.local?.cwd, request.cwd);
  assert.equal(harness.observed.open?.local?.autoReview, true);
  assert.deepEqual(harness.observed.open?.model, { id: "default" });
  assert.deepEqual(harness.observed.open?.local?.settingSources, ["project", "user", "team", "mdm", "plugins"]);
  assert.equal(harness.observed.open?.local?.sandboxOptions?.enabled, process.platform !== "win32");
  assert.equal(harness.observed.stateRoot, request.stateRoot);
  assert.equal(harness.observed.workspaceRef, request.cwd);
  assert.equal(harness.observed.closed, 1);
  assert.equal(harness.observed.disposed, 1);
  assert.equal(result.operation === "run" && result.result.usage?.outputTokens, 3);
});

test("Cursor SDK reports disjoint internal-turn usage as cumulative run snapshots", async () => {
  const harness = sdkHarness({
    updates: [
      { type: "turn-ended", usage: { inputTokens: 10, cacheReadTokens: 8, cacheWriteTokens: 2, outputTokens: 4, reasoningTokens: 3 } },
      { type: "turn-ended", usage: { inputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 1, outputTokens: 6, reasoningTokens: 2 } },
    ] as InteractionUpdate[],
    result: { id: "run-controlled", status: "finished", result: "ok", model: { id: "reported-model" },
      usage: { inputTokens: 15, cacheReadTokens: 15, cacheWriteTokens: 3, outputTokens: 10, reasoningTokens: 5, totalTokens: 43 } },
  });
  const events: CursorEvent[] = [];
  await executeCursorSdk(harness.sdk, () => harness.sqlite, request, new AbortController().signal, async (event) => { events.push(event); });
  assert.deepEqual(events.filter((event) => event.type === "usage"), [
    { type: "usage", update: { turn: { totals: { uncachedInputTokens: 10, cachedInputTokens: 8, cacheCreationTokens: 2, outputTokens: 4, reasoningTokens: 3 } }, reportedTurn: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 8, cacheCreationTokens: 2, reasoningTokens: 3 } } },
    { type: "usage", update: { turn: { totals: { uncachedInputTokens: 15, cachedInputTokens: 15, cacheCreationTokens: 3, outputTokens: 10, reasoningTokens: 5 } }, reportedTurn: { inputTokens: 15, outputTokens: 10, cachedInputTokens: 15, cacheCreationTokens: 3, reasoningTokens: 5 } } },
    { type: "usage", update: { turn: { model: "reported-model", totals: { uncachedInputTokens: 15, cachedInputTokens: 15, cacheCreationTokens: 3, outputTokens: 10, reasoningTokens: 5 } }, reportedTurn: { inputTokens: 15, outputTokens: 10, cachedInputTokens: 15, cacheCreationTokens: 3, reasoningTokens: 5 } } },
  ]);
});

test("Cursor SDK does not invent usage for missing or invalid native counts", async () => {
  for (const usage of [undefined, { inputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 2, totalTokens: 4 }]) {
    const harness = sdkHarness({ result: { id: "run-controlled", status: "finished", result: "ok", ...(usage ? { usage } : {}) } });
    const events: CursorEvent[] = [];
    await executeCursorSdk(harness.sdk, () => harness.sqlite, request, new AbortController().signal, async (event) => { events.push(event); });
    const updates = events.flatMap((event) => event.type === "usage" ? [event.update] : []);
    assert.equal(updates.some((update) => update.turn), false);
    if (usage) assert.deepEqual(updates, [{ reportedTurn: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 1, cacheCreationTokens: 0, reasoningTokens: 2 } }]);
    else assert.deepEqual(updates, []);
  }
});
test("Cursor SDK reports partial internal counters and replaces them with the native run aggregate", async () => {
  const harness = sdkHarness({
    updates: [
      { type: "turn-ended", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 } },
      { type: "turn-ended", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 2 } },
    ] as unknown as InteractionUpdate[],
    result: { id: "run-controlled", status: "finished", result: "ok",
      usage: { inputTokens: 15, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 27 } },
  });
  const events: CursorEvent[] = [];
  await executeCursorSdk(harness.sdk, () => harness.sqlite, request, new AbortController().signal, async (event) => { events.push(event); });
  assert.deepEqual(events.flatMap((event) => event.type === "usage" ? [event.update] : []), [
    { reportedTurn: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 } },
    { reportedTurn: { inputTokens: 15, outputTokens: 6, cachedInputTokens: 4 } },
    { reportedTurn: { inputTokens: 15, outputTokens: 6, cachedInputTokens: 4, cacheCreationTokens: 2 } },
  ]);
});

test("Cursor SDK rejects usage consumer failures during internal turn callbacks", async () => {
  const harness = sdkHarness({ updates: [
    { type: "turn-ended", usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } },
  ] as InteractionUpdate[] });
  const failure = new Error("usage callback failed");
  await assert.rejects(executeCursorSdk(harness.sdk, () => harness.sqlite, request, new AbortController().signal,
    async (event) => { if (event.type === "usage") throw failure; }), (error) => error === failure);
});

test("Cursor SDK refuses successful-looking partial output when terminal status is error", async () => {
  const harness = sdkHarness({
    updates: [{ type: "text-delta", text: "partial" }] as InteractionUpdate[],
    result: { id: "run-controlled", status: "error", error: { message: "native failure", code: "rate_limited" } },
  });
  await assert.rejects(executeCursorSdk(harness.sdk, () => harness.sqlite, request,
    new AbortController().signal, async () => undefined), /native failure/);
  assert.equal(harness.observed.closed, 1);
  assert.equal(harness.observed.disposed, 1);
});

test("Cursor SDK cancellation reaches a run that arrives after abort", async () => {
  const sending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const harness = sdkHarness({ send: async () => { sending.resolve(); await release.promise; } });
  const running = executeCursorSdk(harness.sdk, () => harness.sqlite, request, controller.signal, async () => undefined);
  const rejected = assert.rejects(running, (error: Error) => error.name === "AbortError");
  await sending.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.equal(harness.observed.cancelled, 1);
  assert.equal(harness.observed.closed, 1);
  assert.equal(harness.observed.disposed, 1);
});

test("Cursor SDK resumes the real agent and recovers exactly one abandoned run", async () => {
  const harness = sdkHarness({ conflict: true });
  const result = await executeCursorSdk(harness.sdk, () => harness.sqlite,
    { ...request, sessionId: "native-resume-id" }, new AbortController().signal, async () => undefined);
  assert.equal(result.operation === "run" && result.sessionId, "agent-controlled");
  assert.equal(harness.observed.resumed, "native-resume-id");
  assert.equal(harness.observed.sends, 2);
  assert.deepEqual(harness.observed.recovered, ["abandoned"]);
});

test("Cursor SDK callback failures reject rather than returning a final success", async () => {
  const harness = sdkHarness({ updates: [{ type: "text-delta", text: "answer" }] as InteractionUpdate[] });
  await assert.rejects(executeCursorSdk(harness.sdk, () => harness.sqlite, request,
    new AbortController().signal, async (event) => { if (event.type === "text") throw new Error("consumer failed"); }), /consumer failed/);
  assert.equal(harness.observed.closed, 1);
  assert.equal(harness.observed.disposed, 1);
});

test("Cursor classifies only standalone native transport dumps, including split chunks", async () => {
  const reply = new CursorTransportFailure();
  reply.push("Error: ConnectError: [un");
  reply.push("available] connection lost\n    at stream\n");
  assert.match(reply.failure!, /connection lost/);
  reply.push("Here is how to debug this error.");
  assert.equal(reply.failure, undefined);
  const harness = sdkHarness({ result: {
    id: "run-controlled", status: "finished", result: "Error: ConnectError: [unavailable] connection lost",
  } });
  await assert.rejects(executeCursorSdk(harness.sdk, () => harness.sqlite, request,
    new AbortController().signal, async () => undefined), /connection lost/);
});

test("Cursor browser login uses memory, surfaces the real URL and verifies identity/catalog", async () => {
  const harness = sdkHarness();
  const events: CursorEvent[] = [];
  const result = await executeCursorSdk(harness.sdk, () => harness.sqlite,
    { operation: "login", name: "controlled login" }, new AbortController().signal,
    async (event) => { events.push(event); });
  assert.equal(result.operation === "login" && result.credentials.apiKey, credentials.apiKey);
  assert.equal(harness.observed.login?.openBrowser, false);
  assert.equal(harness.observed.login?.apiKeyName, "controlled login");
  assert.equal(harness.observed.userCalls, 1);
  assert.equal(harness.observed.modelCalls, 1);
  assert.equal(events[0]?.type, "login-url");
  const rejected = sdkHarness({ catalogError: new Error("account rejected") });
  await assert.rejects(executeCursorSdk(rejected.sdk, () => rejected.sqlite,
    { operation: "login", name: "controlled login" }, new AbortController().signal, async () => undefined), /account rejected/);
});

test("Cursor isolated credentials keep permissions and never follow a global account symlink", async () => {
  await isolated(async (context) => {
    saveCursorCredentials(context.homeDirectory, credentials);
    assert.equal(readCursorCredentials(context.homeDirectory)?.apiKey, credentials.apiKey);
    if (process.platform !== "win32") {
      assert.equal((await stat(cursorCredentialPath(context.homeDirectory))).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(cursorCredentialPath(context.homeDirectory)))).mode & 0o777, 0o700);
    }
    const globalHome = path.join(context.cwd, "other-home");
    await mkdir(globalHome);
    const globalAuth = path.join(globalHome, "auth.json");
    await writeFile(globalAuth, JSON.stringify(credentials));
    await rm(cursorCredentialPath(context.homeDirectory));
    await symlink(globalAuth, cursorCredentialPath(context.homeDirectory));
    assert.throws(() => readCursorCredentials(context.homeDirectory));
    assert.equal(JSON.parse(await readFile(globalAuth, "utf8")).apiKey, credentials.apiKey);
    // A linked .cursor directory must be rejected before creating sdk outside home.
    await rm(path.join(context.homeDirectory, ".cursor"), { recursive: true });
    await symlink(globalHome, path.join(context.homeDirectory, ".cursor"));
    assert.throws(() => saveCursorCredentials(context.homeDirectory, credentials), /private home/);
    await assert.rejects(stat(path.join(globalHome, "sdk")), /ENOENT/);
  });
});

test("Cursor auth cancellation cannot persist a late SDK result", async () => {
  await isolated(async (context) => {
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<CursorResult>();
    const adapter = createCursorAdapter(async (_context, input) => {
      assert.equal(input.operation, "login");
      started.resolve();
      return late.promise;
    });
    const controller = new AbortController();
    const authenticating = adapter.authenticate(context, {
      methodId: "browser", signal: controller.signal, onUpdate: () => undefined, readInput: async () => "",
    });
    const rejected = assert.rejects(authenticating, (error: Error) => error.name === "AbortError");
    await started.promise;
    controller.abort();
    late.resolve({ operation: "login", credentials });
    await rejected;
    assert.equal(readCursorCredentials(context.homeDirectory), undefined);
  });
});

test("Cursor observes expired browser sign-in and environment overrides without fake ready", async () => {
  await isolated(async (context) => {
    saveCursorCredentials(context.homeDirectory, { ...credentials, apiKeyExpiresAtMs: 1 });
    const adapter = createCursorAdapter(async (_context, input) => {
      assert.equal(input.operation, "check");
      assert.equal(input.operation === "check" && input.apiKey, undefined);
      return { operation: "check", models: [] };
    });
    const status = await adapter.check(context);
    assert.equal(status.authentication, "unauthenticated");
    assert.equal(status.canLogout, true);
    assert.equal(status.methods[0]?.id, "browser");
    assert.deepEqual(status.models, []);
    const failing = createCursorAdapter(async () => { throw new CursorWorkerError({ name: "AuthenticationError", message: "rejected", status: 401, sdkLoaded: true }); });
    const rejected = await failing.check({ ...context, env: { CURSOR_API_KEY: "explicit-native-key" } });
    assert.equal(rejected.authentication, "unauthenticated");
    assert.equal(rejected.installation.status, "installed");
    assert.equal(rejected.canLogout, false);
    assert.deepEqual(rejected.methods, []);
    await assert.rejects(failing.logout({ ...context, env: { CURSOR_API_KEY: "explicit-native-key" } }), /Remove CURSOR_API_KEY/);
    const unavailable = createCursorAdapter(async () => { throw new CursorWorkerError({ name: "Error", message: "missing", dependencyMissing: true }); });
    assert.equal((await unavailable.check(context)).installation.status, "not-installed");
  });
});

test("Cursor logout drains native execution before clearing private credentials", async () => {
  await isolated(async (context) => {
    saveCursorCredentials(context.homeDirectory, credentials);
    const started = Promise.withResolvers<void>();
    let stopped = false;
    const adapter = createCursorAdapter(async (_context, input, options) => {
      assert.equal(input.operation, "run");
      const pending = Promise.withResolvers<never>();
      options!.signal!.addEventListener("abort", () => { stopped = true; pending.reject(cursorAbortError()); }, { once: true });
      started.resolve();
      return pending.promise;
    });
    const running = adapter.run(context, { model: "live", prompt: "hello" });
    const rejected = assert.rejects(running, (error: { code?: string }) => error.code === "aborted");
    await started.promise;
    await adapter.logout(context);
    await rejected;
    assert.equal(stopped, true);
    assert.equal(readCursorCredentials(context.homeDirectory), undefined);
  });
});

test("Cursor rejects foreign native session references before calling the SDK", async () => {
  await isolated(async (context) => {
    const adapter = createCursorAdapter(async () => { throw new Error("must not invoke"); });
    await assert.rejects(adapter.run(context, { model: "live", prompt: "hello", resume: {
      driver: "cursor", providerInstanceId: "other-account", sessionId: "real", cwd: context.cwd,
    } }), /does not belong/);
    await assert.rejects(adapter.run(context, { model: "live", prompt: "hello", resume: {
      driver: "cursor", providerInstanceId: context.instanceId, sessionId: "real", cwd: "/other-project",
    } }), /does not belong/);
  });
});

test("Cursor IPC isolates HOME and does not inherit server-global credentials", async () => {
  await isolated(async (context) => {
    const invoke = createCursorInvoker(new URL("./cursor-protocol-fixture.ts", import.meta.url));
    const result = await invoke({ ...context, env: { HOME: "/global-home", USERPROFILE: "/global-profile", XDG_CONFIG_HOME: "/global-config" } },
      { operation: "check", apiKey: "explicit-request-key" });
    assert.equal(result.operation, "check");
    if (result.operation !== "check") return;
    const observed = JSON.parse(result.user!.userFirstName!);
    assert.equal(observed.home, context.homeDirectory);
    assert.equal(observed.userProfile, context.homeDirectory);
    assert.equal(observed.xdgConfig, path.join(context.homeDirectory, ".config"));
    assert.equal(observed.secret, undefined);
  });
});

test("Cursor IPC forwards output items and command chunks and propagates callback failures", async () => {
  await isolated(async (context) => {
    const invoke = createCursorInvoker(new URL("./cursor-protocol-fixture.ts", import.meta.url));
    const input = { ...request, cwd: context.cwd, stateRoot: path.join(context.homeDirectory, "state") };
    const events: CursorEvent[] = [];
    await invoke(context, input, { onEvent: (event) => events.push(event) });
    assert.ok(events.some((event) => event.type === "output" && event.event.type === "item.upsert" &&
      event.event.item.type === "assistant_message" && event.event.item.text === "answer"));
    assert.ok(events.some((event) => event.type === "output" && event.event.type === "command.output" &&
      event.event.chunk === "out\n"));
    assert.deepEqual(events.find((event) => event.type === "usage"), { type: "usage", update: { turn: { totals: {
      uncachedInputTokens: 4, cachedInputTokens: 7, cacheCreationTokens: 2, outputTokens: 5, reasoningTokens: 3,
    } } } });
    await assert.rejects(invoke(context, input, { onEvent: (event) => {
      if (event.type === "output") throw new Error("output consumer failed");
    } }), /output consumer failed/);
  });
});

test("Cursor IPC rejects premature EOF, nonzero exit and wrong terminal operation", async () => {
  await isolated(async (context) => {
    const invoke = createCursorInvoker(new URL("./cursor-protocol-fixture.ts", import.meta.url));
    for (const scenario of ["premature", "nonzero", "wrong-operation"]) {
      await assert.rejects(invoke({ ...context, env: { CURSOR_TEST_SCENARIO: scenario } },
        { ...request, cwd: context.cwd, stateRoot: path.join(context.homeDirectory, "state") }));
    }
  });
});

test("Cursor IPC cancellation never returns streamed partial text as a completed turn", async () => {
  await isolated(async (context) => {
    const invoke = createCursorInvoker(new URL("./cursor-protocol-fixture.ts", import.meta.url));
    const controller = new AbortController();
    await assert.rejects(invoke({ ...context, env: { CURSOR_TEST_SCENARIO: "abort" } },
      { ...request, cwd: context.cwd, stateRoot: path.join(context.homeDirectory, "state") }, {
        signal: controller.signal,
        onEvent: (event) => { if (event.type === "text") controller.abort(); },
      }), (error: Error) => error.name === "AbortError");
  });
});

test("Cursor adapter completes browser auth, discovers models and returns real SDK identity/usage", async () => {
  await isolated(async (context) => {
    const harness = sdkHarness({ result: {
      id: "run-controlled", status: "finished", result: "native answer",
      usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 11 },
    } });
    const adapter = createCursorAdapter((_context, input, options) =>
      executeCursorSdk(harness.sdk, () => harness.sqlite, input,
        options?.signal ?? new AbortController().signal,
        async (event) => { options?.onEvent?.(event); }));
    const updates: unknown[] = [];
    await adapter.authenticate(context, {
      methodId: "browser", signal: new AbortController().signal,
      onUpdate: (update) => { updates.push(update); }, readInput: async () => "",
    });
    assert.equal(readCursorCredentials(context.homeDirectory)?.apiKey, credentials.apiKey);
    assert.ok(JSON.stringify(updates).includes("loginDeepControl"));
    assert.ok(!JSON.stringify(updates).includes(credentials.apiKey));
    const status = await adapter.check(context);
    assert.equal(status.authentication, "authenticated");
    assert.equal(status.email, "controlled@example.com");
    assert.deepEqual(status.models.map((model) => model.id), ["live-model"]);
    assert.equal(status.canLogout, true);
    const deltas: string[] = [];
    const result = await adapter.run(context, {
      model: "live-model", prompt: "hello", onText: (text) => { deltas.push(text); },
    });
    assert.equal(result.text, "native answer");
    assert.deepEqual(deltas, ["native answer"]);
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 4 });
    assert.deepEqual(result.nativeSession, {
      driver: "cursor", providerInstanceId: context.instanceId,
      sessionId: "agent-controlled", turnId: "run-controlled", modelId: "live-model",
      cwd: context.cwd, instanceRevision: context.revision,
    });
    await adapter.logout(context);
    assert.equal(readCursorCredentials(context.homeDirectory), undefined);
  });
});

test("Cursor adapter forwards IPC telemetry and preserves consumer exceptions", async () => {
  await isolated(async (context) => {
    context.env.CURSOR_API_KEY = "controlled-key";
    const adapter = createCursorAdapter(createCursorInvoker(new URL("./cursor-protocol-fixture.ts", import.meta.url)));
    const updates: unknown[] = [];
    const result = await adapter.run(context, { model: "controlled", prompt: "hello", onUsage: (update) => updates.push(update) });
    assert.equal(result.text, "answer");
    assert.deepEqual(updates, [{ turn: { totals: {
      uncachedInputTokens: 4, cachedInputTokens: 7, cacheCreationTokens: 2, outputTokens: 5, reasoningTokens: 3,
    } } }]);
    const failure = new Error("usage consumer failed");
    await assert.rejects(adapter.run(context, { model: "controlled", prompt: "hello", onUsage: () => { throw failure; } }), (error) => error === failure);
  });
});

test("Cursor browser auth refuses unsafe URL interactions without persisting credentials", async () => {
  await isolated(async (context) => {
    const adapter = createCursorAdapter(async (_context, _request, options) => {
      options?.onEvent?.({ type: "login-url", url: "https://user:secret@cursor.com/signin" });
      return { operation: "login", credentials };
    });
    await assert.rejects(adapter.authenticate(context, {
      signal: new AbortController().signal, onUpdate: () => undefined, readInput: async () => "",
    }), /unsafe sign-in URL/);
    assert.equal(readCursorCredentials(context.homeDirectory), undefined);
  });
});

test("Cursor native errors redact dynamic keys and retain authentication/cancellation classes", async () => {
  await isolated(async (context) => {
    const key = "not-a-standard-sk-prefix-private-key";
    const adapter = createCursorAdapter(async () => {
      throw new CursorWorkerError({ name: "AuthenticationError", message: `Rejected ${key}`, status: 401 });
    });
    await assert.rejects(adapter.run({ ...context, env: { CURSOR_API_KEY: key } }, { model: "live", prompt: "hello" }),
      (error: { message: string; code?: string; errorClass?: string }) =>
        !error.message.includes(key) && error.code === "provider_not_authenticated" && error.errorClass === "authentication");
    const aborted = createCursorAdapter(async () => { throw cursorAbortError(); });
    await assert.rejects(aborted.run({ ...context, env: { CURSOR_API_KEY: key } }, { model: "live", prompt: "hello" }),
      (error: { code?: string; errorClass?: string }) => error.code === "aborted" && error.errorClass === "cancelled");
  });
});

test("Cursor SDK awaits executor disposal before releasing SQLite or reporting completion", async () => {
  const disposalStarted = Promise.withResolvers<void>();
  const releaseDisposal = Promise.withResolvers<void>();
  const harness = sdkHarness({ dispose: async () => {
    disposalStarted.resolve();
    await releaseDisposal.promise;
  } });
  let completed = false;
  const running = executeCursorSdk(harness.sdk, () => harness.sqlite, request,
    new AbortController().signal, async () => undefined).then((result) => {
      completed = true;
      return result;
    });
  await disposalStarted.promise;
  assert.equal(completed, false);
  assert.equal(harness.observed.disposed, 0);
  assert.equal(harness.observed.syncClosed, 0);
  releaseDisposal.resolve();
  await running;
  assert.equal(harness.observed.closed, 1);
  assert.equal(harness.observed.disposed, 1);
});

// Integration exercises real cross-process TERM/KILL deadlines. Fake timers
// cannot drive a separate Node process or kernel signals; await actual exits.
for (const scenario of ["descendant-exit-leader", "descendant-term-leader"]) {
  test(`Cursor ${scenario} retains escalation until the TERM-resistant descendant stops`, {
    skip: process.platform !== "linux",
  }, async () => {
    await isolated(async (context) => {
      const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.send({ready:true});"], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      try {
        await once(unrelated, "message");
        const descendantFile = path.join(context.cwd, "descendant.json");
        const termFile = path.join(context.cwd, "descendant-term.txt");
        const leaderExitFile = path.join(context.cwd, "leader-exit.txt");
        const invoke = createCursorInvoker(new URL("./cursor-protocol-fixture.ts", import.meta.url), {
          cancelMs: 100, terminateMs: 100,
        });
        const controller = new AbortController();
        await assert.rejects(invoke({
          ...context,
          env: {
            CURSOR_TEST_SCENARIO: scenario,
            CURSOR_TEST_DESCENDANT_FILE: descendantFile,
            CURSOR_TEST_TERM_FILE: termFile,
            CURSOR_TEST_LEADER_EXIT_FILE: leaderExitFile,
          },
        }, { ...request, cwd: context.cwd, stateRoot: path.join(context.homeDirectory, "state") }, {
          signal: controller.signal,
          onEvent(event) { if (event.type === "text" && event.text === "descendant-ready") controller.abort(); },
        }), (error: Error) => error.name === "AbortError");
        const descendant = JSON.parse(await readFile(descendantFile, "utf8")) as {
          pid: number; groupId: number; workerPid: number;
        };
        assert.ok((await readFile(leaderExitFile, "utf8")).includes("exited leader"));
        assert.match(await readFile(termFile, "utf8"), /TERM ignored/);
        // A zombie has stopped executing; Linux init may reap it later.
        assert.equal(cursorOwnedGroupMembers(descendant.groupId).some((member) => member.pid === descendant.pid), false);
        assert.equal(unrelated.exitCode, null);
        assert.equal(unrelated.signalCode, null);
        assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
        // A stale numeric PID never grants signal authority over its new owner.
        await waitForCursorOwnedProcesses([{ pid: unrelated.pid!, startTime: "stale-identity" }]);
        assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
      } finally {
        if (unrelated.exitCode === null && unrelated.signalCode === null) {
          const closed = once(unrelated, "close");
          unrelated.kill("SIGKILL");
          await closed;
        }
      }
    });
  });
}
