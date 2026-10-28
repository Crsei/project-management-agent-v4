// Ported from t3code packages/provider-opencode (MIT); native wire schemas are
// @opencode-ai/sdk 1.15.13 (OpenCode 1.x) and @opencode/{protocol,schema} 2.0.28.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeSessionRef, ProviderAuthMethod, ProviderConfig, ProviderModel } from "@agent-workspace/contracts/provider";
import type { CliChatResult } from "../../agents/cli-chat.ts";
import type { NativeProviderAdapter, ProviderDriverAuthOptions, ProviderDriverContext, ProviderDriverRunOptions, ProviderDriverStatus } from "../driver-adapter.ts";
import { OpenCodeConnection, OpenCodeError, aborted, array, data, object, openCodeEvents, string, withOpenCode } from "./opencode-transport.ts";
import { OpenCodeOutput } from "./opencode-output.ts";
import { openCodeQuestion, openCodeQuestionAnswer } from "./opencode-questions.ts";
import type { OpenCodeQuestion } from "./opencode-questions.ts";
import type { UsageTokenTotals } from "@agent-workspace/contracts/usage";
import { ReportedTurnAccumulator, reportedCount } from "./reported-turn.ts";

// Token layout adapted from t3code provider-opencode adapters, Copyright (c)
// 2026 T3 Tools Inc. MIT; see LICENSE.t3code. OpenCode's reasoning is separate
// from output, whereas the shared contract includes reasoning in output.
function openCodeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function openCodeStepTotals(value: unknown): UsageTokenTotals | undefined {
  const tokens = object(value);
  const cache = object(tokens.cache);
  if (![tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write].some(
    (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  )) return undefined;
  const reasoning = openCodeCount(tokens.reasoning);
  return {
    uncachedInputTokens: openCodeCount(tokens.input),
    cachedInputTokens: openCodeCount(cache.read),
    cacheCreationTokens: openCodeCount(cache.write),
    outputTokens: Math.min(Number.MAX_SAFE_INTEGER, openCodeCount(tokens.output) + reasoning),
    reasoningTokens: reasoning,
  };
}

type NativeAuthMethod = { public: ProviderAuthMethod; providerID: string; index: number; method: Record<string, unknown> };
type Inventory = { models: ProviderModel[]; methods: NativeAuthMethod[]; connected: string[]; credentialIDs: string[] };
const capabilities = { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native", portableHandoff: true } as const;
const runningSessions = new Set<string>();

function validateConfig(config: ProviderConfig): ProviderConfig {
  for (const key of Object.keys(config)) {
    if (!["binaryPath", "serverUrl", "serverPassword"].includes(key)) throw new Error(`Unknown OpenCode setting: ${key}.`);
    if (typeof config[key] !== "string") throw new Error(`OpenCode ${key} must be a string.`);
    if (string(config[key]).includes("\0")) throw new Error(`OpenCode ${key} contains an invalid character.`);
  }
  const binaryPath = string(config.binaryPath).trim() || "opencode";
  const serverUrl = string(config.serverUrl).trim();
  if (serverUrl) {
    let url: URL;
    try { url = new URL(serverUrl); } catch { throw new Error("OpenCode server URL must be an http:// or https:// URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("OpenCode server URL must use HTTP(S), with no embedded credentials, query or fragment. Use Server password instead.");
    }
  }
  return { binaryPath, serverUrl, serverPassword: string(config.serverPassword).trim() };
}
function methodID(provider: string, method: string): string { return `${encodeURIComponent(provider)}:${encodeURIComponent(method)}`; }
function fieldLabel(field: Record<string, unknown>): string {
  const options = array(field.options).map((entry) => `${string(entry.value)} (${string(entry.label)})`).join(", ");
  return `${string(field.title) || string(field.message) || string(field.key)}${options ? ` — ${options}` : ""}`;
}
function fieldsFor(method: Record<string, unknown>, v2: boolean): Record<string, unknown>[] {
  return array(v2 ? method.form : method.prompts);
}
function publicFields(method: Record<string, unknown>, v2: boolean): NonNullable<ProviderAuthMethod["fields"]> {
  const fields = fieldsFor(method, v2).filter((field) => field.type !== "external" && field.hidden !== true)
    .map((field) => ({ name: string(field.key), label: fieldLabel(field), secret: true }));
  return method.type === "key" || method.type === "api" ? [{ name: "key", label: "API key (stored by OpenCode)", secret: true }, ...fields] : fields;
}
async function inventory(connection: OpenCodeConnection, signal?: AbortSignal): Promise<Inventory> {
  const methods: NativeAuthMethod[] = [];
  const models: ProviderModel[] = [];
  const connected: string[] = [];
  const credentialIDs: string[] = [];
  if (connection.generation === "v1") {
    const [providersResponse, authResponse] = await Promise.all([
      connection.request("/provider", { signal }), connection.request("/provider/auth", { signal }),
    ]);
    const providers = object(providersResponse);
    for (const id of Array.isArray(providers.connected) ? providers.connected : []) if (typeof id === "string") connected.push(id);
    for (const provider of array(providers.all)) {
      if (connected.includes(string(provider.id))) {
        if (provider.source === "api" || provider.source === "custom") credentialIDs.push(string(provider.id));
        for (const [id, value] of Object.entries(object(provider.models))) {
          const model = object(value);
          if (!string(model.name)) continue;
          models.push({ id: `${string(provider.id)}/${string(model.id) || id}`, label: `${string(provider.name) || string(provider.id)} / ${string(model.name)}`,
            source: "discovered", temperature: model.temperature === true, reasoning: model.reasoning === true || object(model.capabilities).reasoning === true });
        }
      }
      array(object(authResponse)[string(provider.id)]).forEach((method, index) => {
        if (method.type !== "api" && method.type !== "oauth") return;
        const fields = publicFields(method, false);
        methods.push({ providerID: string(provider.id), index, method, public: {
          id: methodID(string(provider.id), String(index)), name: `${string(provider.name) || string(provider.id)} — ${string(method.label)}`,
          type: method.type === "api" ? "credentials" : "browser", ...(fields.length ? { fields } : {}),
        } });
      });
    }
  } else {
    const [modelResponse, integrationResponse] = await Promise.all([
      connection.request("/api/model", { signal }), connection.request("/api/integration", { signal }),
    ]);
    for (const model of array(data(modelResponse))) {
      models.push({ id: `${string(model.providerID)}/${string(model.id)}`, label: `${string(model.providerID)} / ${string(model.name) || string(model.id)}`,
        source: "discovered", temperature: false, reasoning: array(model.variants).length > 0 });
    }
    for (const integration of array(data(integrationResponse))) {
      for (const credential of array(integration.connections)) {
        if (credential.type === "credential") credentialIDs.push(string(credential.id));
        if (object(credential.status).status === "needs_auth") continue;
        if (!connected.includes(string(integration.id))) connected.push(string(integration.id));
      }
      array(integration.methods).forEach((method, index) => {
        if (!["key", "oauth", "external", "command"].includes(string(method.type))) return;
        const fields = publicFields(method, true);
        methods.push({ providerID: string(integration.id), index, method, public: {
          id: methodID(string(integration.id), string(method.id) || "key"),
          name: `${string(integration.name) || string(integration.id)} — ${string(method.label) || string(method.type)}`,
          type: method.type === "oauth" ? "browser" : method.type === "command" ? "terminal" : "credentials",
          ...(fields.length ? { fields } : {}),
        } });
      });
    }
  }
  models.sort((a, b) => a.label.localeCompare(b.label));
  return { models, methods, connected, credentialIDs };
}
async function settledInventory(connection: OpenCodeConnection, signal?: AbortSignal): Promise<Inventory> {
  // t3code's 2.x catalog loader waits for two agreeing nonempty reads after cold start.
  let latest = await inventory(connection, signal);
  if (connection.generation !== "v2") return latest;
  let previous = latest.models.map((model) => model.id).join("\n");
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    await delay(250, undefined, { signal });
    const next = await inventory(connection, signal);
    const fingerprint = next.models.map((model) => model.id).join("\n");
    latest = next;
    if (fingerprint && previous === fingerprint) break;
    previous = fingerprint;
  }
  return latest;
}
async function check(context: ProviderDriverContext, signal?: AbortSignal): Promise<ProviderDriverStatus> {
  try {
    return await withOpenCode(context, async (connection) => {
      const found = await settledInventory(connection, signal);
      // Free native models may work without stored credentials; empty inventory is not proof of logout.
      const authentication = found.models.length || found.connected.length ? "authenticated" : "unknown";
      return { installation: { status: "installed", checkedAt: new Date().toISOString(), version: connection.version,
        ...(string(context.config.serverUrl) ? {} : { executablePath: string(context.config.binaryPath) || "opencode" }) },
        authentication, models: found.models, methods: found.methods.map((entry) => entry.public),
        canLogout: found.credentialIDs.length > 0,
        capabilities, message: found.models.length ? `OpenCode ${connection.version} lists ${found.models.length} native models.` : "OpenCode is running, but has not listed any connected models yet." };
    }, signal);
  } catch (error) {
    if (signal?.aborted) throw aborted();
    const failure = error instanceof OpenCodeError ? error : new OpenCodeError("Could not inspect OpenCode.");
    return { installation: { status: string(context.config.serverUrl).trim() ? "installed" : failure.code === "not-installed" ? "not-installed" : "unknown", checkedAt: new Date().toISOString(), error: failure.message },
      authentication: failure.statusCode === 401 || failure.statusCode === 403 ? "unauthenticated" : "unknown", models: [], methods: [], canLogout: false, capabilities, message: failure.message };
  }
}

async function inputValues(options: ProviderDriverAuthOptions, fields: NonNullable<ProviderAuthMethod["fields"]>, initial?: Record<string, string>): Promise<Record<string, string>> {
  if (!fields.length) return initial ?? {};
  if (fields.every((field) => initial?.[field.name] !== undefined)) return initial!;
  options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id: `opencode-${randomBytes(8).toString("hex")}`, fields } });
  const raw = await options.readInput();
  if (options.signal.aborted) throw aborted();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = fields.length === 1 ? { [fields[0]!.name]: raw } : {}; }
  const values = { ...initial };
  for (const [key, value] of Object.entries(object(parsed))) if (typeof value === "string") values[key] = value;
  if (!fields.every((field) => values[field.name] !== undefined)) throw new OpenCodeError("OpenCode authentication is missing a required field.");
  return values;
}
async function collectAnswers(entry: NativeAuthMethod, v2: boolean, options: ProviderDriverAuthOptions): Promise<{ key?: string; answer: Record<string, unknown> }> {
  let values = options.values ?? {};
  const answer: Record<string, unknown> = {};
  let key: string | undefined;
  if (entry.method.type === "api" || entry.method.type === "key") {
    values = await inputValues(options, [{ name: "key", label: "API key (stored by OpenCode)", secret: true }], values);
    key = values.key?.trim();
    if (!key) throw new OpenCodeError("An OpenCode API key is required.");
  }
  for (const field of fieldsFor(entry.method, v2)) {
    const conditions = Array.isArray(field.when) ? array(field.when) : field.when ? [object(field.when)] : [];
    if (!conditions.every((condition) => {
      const supplied = answer[string(condition.key)];
      if (supplied === undefined) return false;
      const equal = Array.isArray(supplied) ? supplied.includes(condition.value) : supplied === condition.value;
      return condition.op === "neq" ? !equal : equal;
    })) continue;
    if (field.type === "external") {
      options.onUpdate({ phase: "waiting", interaction: { type: "browser", id: string(field.key), url: browserUrl(field.url) } });
      continue;
    }
    const name = string(field.key);
    if (values[name] === undefined && field.default !== undefined) answer[name] = field.default;
    else if (values[name] === undefined && (field.hidden === true || field.required === false)) continue;
    else {
      values = await inputValues(options, [{ name, label: fieldLabel(field), secret: true }], values);
      const raw = values[name]!;
      if (field.type === "number" || field.type === "integer") {
        const number = Number(raw);
        if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) throw new OpenCodeError("OpenCode authentication requires a valid numeric answer.");
        answer[name] = number;
      } else if (field.type === "boolean") {
        if (raw !== "true" && raw !== "false") throw new OpenCodeError("OpenCode authentication requires true or false.");
        answer[name] = raw === "true";
      } else if (field.type === "multiselect") {
        let selected: unknown;
        try { selected = JSON.parse(raw); } catch { throw new OpenCodeError("OpenCode authentication requires a JSON array of option values."); }
        if (!Array.isArray(selected) || selected.some((value) => typeof value !== "string")) throw new OpenCodeError("OpenCode authentication requires a JSON array of option values.");
        answer[name] = selected;
      } else answer[name] = raw;
    }
  }
  return { key, answer };
}
function browserUrl(value: unknown): string {
  const url = string(value);
  try { if (["https:", "http:"].includes(new URL(url).protocol)) return url; } catch { /* Fixed safe error below. */ }
  throw new OpenCodeError("OpenCode returned an invalid authorization URL.");
}
async function authenticate(context: ProviderDriverContext, options: ProviderDriverAuthOptions): Promise<void> {
  await withOpenCode(context, async (connection) => {
    const found = await settledInventory(connection, options.signal);
    const entry = options.methodId ? found.methods.find((entry) => entry.public.id === options.methodId) : found.methods.length === 1 ? found.methods[0] : undefined;
    if (!entry) throw new OpenCodeError("Select one of OpenCode's discovered provider authentication methods.");
    const { key, answer } = await collectAnswers(entry, connection.generation === "v2", options);
    options.onUpdate({ phase: "starting", interaction: null, message: "Authenticating with OpenCode's native provider." });
    const provider = encodeURIComponent(entry.providerID);
    if (connection.generation === "v1") {
      if (entry.method.type === "api") {
        const result = await connection.request(`/auth/${provider}`, { method: "PUT", body: { type: "api", key }, signal: options.signal });
        if (result !== true) throw new OpenCodeError("OpenCode did not confirm storing the provider credential.");
        return;
      }
      const authorization = object(await connection.request(`/provider/${provider}/oauth/authorize`, { method: "POST", body: { method: entry.index, inputs: answer }, signal: options.signal }));
      options.onUpdate({ phase: "waiting", interaction: { type: "browser", id: entry.public.id, url: browserUrl(authorization.url) },
        message: string(authorization.instructions) || "Complete OpenCode authorization in your browser." });
      let code: string | undefined;
      if (authorization.method === "code") {
        code = (await inputValues(options, [{ name: "code", label: "Authorization code", secret: true }])).code;
      }
      const result = await connection.request(`/provider/${provider}/oauth/callback`, { method: "POST", body: { method: entry.index, ...(code ? { code } : {}) }, signal: options.signal, timeoutMs: 10 * 60_000 });
      if (result !== true) throw new OpenCodeError("OpenCode did not confirm provider authorization.");
      return;
    }
    const root = `/api/integration/${provider}/connect`;
    if (entry.method.type === "key" || entry.method.type === "external") {
      await connection.request(`${root}/${entry.method.type}`, { method: "POST", body: {
        ...(entry.method.type === "key" ? { key } : { methodID: entry.method.id }), ...(Object.keys(answer).length ? { answer } : {}),
      }, signal: options.signal });
      return;
    }
    const kind = entry.method.type === "command" ? "command" : "oauth";
    const attempt = object(data(await connection.request(`${root}/${kind}`, { method: "POST", body: { methodID: entry.method.id, ...(Object.keys(answer).length ? { answer } : {}) }, signal: options.signal })));
    if (!string(attempt.attemptID)) throw new OpenCodeError("OpenCode returned an invalid authentication attempt.");
    const attemptPath = `${root}/${kind}/${encodeURIComponent(string(attempt.attemptID))}`;
    let complete = false;
    try {
      if (kind === "oauth") {
        options.onUpdate({ phase: "waiting", interaction: { type: "browser", id: entry.public.id, url: browserUrl(attempt.url) },
          message: string(attempt.instructions) || "Complete OpenCode authorization in your browser." });
        if (attempt.mode === "code") {
          const values = await inputValues(options, [{ name: "code", label: "Authorization code", secret: true }]);
          await connection.request(`${attemptPath}/complete`, { method: "POST", body: { code: values.code }, signal: options.signal });
        }
      } else options.onUpdate({ phase: "waiting", interaction: { type: "terminal", id: entry.public.id, output: "OpenCode is running the selected native authentication command." } });
      const expires = typeof object(attempt.time).expires === "number" ? Number(object(attempt.time).expires) : Date.now() + 10 * 60_000;
      while (!options.signal.aborted && Date.now() < expires) {
        const status = object(data(await connection.request(attemptPath, { signal: options.signal })));
        if (status.status === "complete") { complete = true; return; }
        if (status.status === "failed" || status.status === "expired") throw new OpenCodeError("OpenCode provider authentication failed or expired.");
        if (status.status !== "pending") throw new OpenCodeError("OpenCode returned an invalid authentication status.");
        // Command output can include credentials, so the API's unstructured message is not echoed.
        await delay(1000, undefined, { signal: options.signal });
      }
      if (options.signal.aborted) throw aborted();
      throw new OpenCodeError("OpenCode provider authentication expired.");
    } finally {
      if (!complete) await connection.request(attemptPath, { method: "DELETE", timeoutMs: 3000 }).catch(() => {});
    }
  }, options.signal);
}
async function logout(context: ProviderDriverContext, signal?: AbortSignal): Promise<void> {
  await withOpenCode(context, async (connection) => {
    const found = await inventory(connection, signal);
    if (!found.credentialIDs.length) throw new OpenCodeError("OpenCode has no removable stored credentials. Environment-based authentication must be removed from the provider environment.");
    if (connection.generation === "v2") {
      for (const id of new Set(found.credentialIDs)) await connection.request(`/api/credential/${encodeURIComponent(id)}`, { method: "DELETE", signal });
    } else {
      for (const id of found.credentialIDs) {
        const result = await connection.request(`/auth/${encodeURIComponent(id)}`, { method: "DELETE", signal });
        if (result !== true) throw new OpenCodeError("OpenCode did not confirm removing the provider credential.");
      }
    }
  }, signal);
}

const v1Permissions = [
  // OpenCode child tasks inherit deny rules before their effective parent overrides.
  { permission: "*", pattern: "*", action: "deny" },
  ...["bash", "edit", "webfetch", "websearch", "codesearch", "external_directory", "doom_loop"]
    .map((permission) => ({ permission, pattern: "*", action: "deny" })),
  { permission: "*", pattern: "*", action: "ask" },
  ...["bash", "edit", "webfetch", "websearch", "codesearch", "external_directory", "doom_loop"]
    .map((permission) => ({ permission, pattern: "*", action: "ask" })),
  ...["read", "glob", "grep", "lsp", "skill", "todowrite"].map((permission) => ({ permission, pattern: "*", action: "allow" })),
  { permission: "read", pattern: "*.env", action: "ask" }, { permission: "read", pattern: "*.env.*", action: "ask" },
  { permission: "read", pattern: "*.env.example", action: "allow" }, { permission: "external_directory", pattern: "*", action: "ask" },
];
const v2Permissions = [
  { action: "*", resource: "*", effect: "ask" },
  ...["read", "glob", "grep", "lsp", "skill", "todowrite"].map((action) => ({ action, resource: "*", effect: "allow" })),
  { action: "read", resource: "*.env", effect: "ask" }, { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" }, { action: "external_directory", resource: "*", effect: "ask" },
];

async function run(context: ProviderDriverContext, options: ProviderDriverRunOptions): Promise<CliChatResult> {
  const slash = options.model.indexOf("/");
  if (slash <= 0 || slash === options.model.length - 1) throw new OpenCodeError("OpenCode model must use its native providerID/modelID identifier.");
  if (options.resume && (options.resume.driver !== "opencode" || options.resume.providerInstanceId !== context.instanceId ||
    (options.resume.cwd !== undefined && options.resume.cwd !== context.cwd) ||
    (options.resume.instanceRevision !== undefined && options.resume.instanceRevision !== context.revision))) {
    throw new OpenCodeError("The native OpenCode session belongs to a different provider instance, revision or working directory.", undefined, "session_mismatch");
  }
  let lease = options.resume ? `${context.instanceId}\0${options.resume.sessionId}` : undefined;
  if (lease && runningSessions.has(lease)) throw new OpenCodeError("This OpenCode session already has an active turn.");
  if (lease) runningSessions.add(lease);
  return withOpenCode(context, async (connection) => {
    const v2 = connection.generation === "v2";
    const root = v2 ? "/api/session" : "/session";
    const model = { providerID: options.model.slice(0, slash), ...(v2 ? { id: options.model.slice(slash + 1) } : { modelID: options.model.slice(slash + 1) }) };
    let session: Record<string, unknown>;
    if (options.resume) {
      session = object(data(await connection.request(`${root}/${encodeURIComponent(options.resume.sessionId)}`, { signal: options.signal })));
      const nativeCwd = v2 ? object(session.location).directory : session.directory;
      if (nativeCwd !== context.cwd) throw new OpenCodeError("OpenCode's saved session is bound to a different working directory.", undefined, "session_mismatch");
      const active = object(data(await connection.request(v2 ? "/api/session/active" : "/session/status", { signal: options.signal })));
      const status = object(active[options.resume.sessionId]);
      if (v2 ? options.resume.sessionId in active : status.type === "busy" || status.type === "retry") {
        throw new OpenCodeError("The OpenCode session is already active in another client; it was not interrupted or modified.");
      }
      if (v2) {
        await connection.request(`${root}/${encodeURIComponent(options.resume.sessionId)}/model`, { method: "POST", body: { model }, signal: options.signal });
        await connection.request(`${root}/${encodeURIComponent(options.resume.sessionId)}`, { method: "PATCH", body: { permissions: v2Permissions }, signal: options.signal });
      } else {
        await connection.request(`${root}/${encodeURIComponent(options.resume.sessionId)}`, { method: "PATCH", body: { permission: v1Permissions }, signal: options.signal });
      }
    } else session = object(data(await connection.request(root, { method: "POST", signal: options.signal, body: v2
      ? { location: { directory: context.cwd }, model, permissions: v2Permissions, title: "PM Agent" }
      : { permission: v1Permissions, title: "PM Agent" } })));
    const sessionId = string(session.id);
    if (!sessionId) throw new OpenCodeError("OpenCode returned no native session identifier.");
    if (!lease) {
      lease = `${context.instanceId}\0${sessionId}`;
      if (runningSessions.has(lease)) {
        lease = undefined;
        throw new OpenCodeError("This OpenCode session already has an active turn.");
      }
      runningSessions.add(lease);
    }
    const sessionPath = `${root}/${encodeURIComponent(sessionId)}`;
    const ref: NativeSessionRef = { providerInstanceId: context.instanceId, driver: "opencode", sessionId, modelId: options.model,
      cwd: context.cwd, instanceRevision: context.revision };
    options.onSession?.(ref);
    const streamController = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, streamController.signal]) : streamController.signal;
    let active = false;
    let terminal = false;
    let text = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    const output = new OpenCodeOutput((event) => options.onEvent?.(event));
    const ownedSessions = new Set([sessionId]);
    const parts = new Map<string, string>();
    const partTypes = new Map<string, string>();
    const assistantMessages = new Set<string>();
    const steps = new Set<string>();
    const telemetrySteps = new Set<string>();
    const telemetryOwners = new Map<string, boolean>();
    const pendingTelemetry = new Map<string, Map<string, { tokens: unknown; cost: unknown }>>();
    const messageID = `msg_${Date.now().toString(16)}${randomBytes(14).toString("hex")}`;
    let reportedCost = 0;
    let costComplete = true;
    const totals: UsageTokenTotals = { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const reportedTotals = new ReportedTurnAccumulator();
    let totalsComplete = true;
    const reportStep = (value: unknown, id?: string, cost?: unknown) => {
      if (!options.onUsage || (id && telemetrySteps.has(id))) return;
      const step = openCodeStepTotals(value);
      if (!step) return;
      if (id) telemetrySteps.add(id);
      const native = object(value);
      const cache = object(native.cache);
      const reportedTurn = reportedTotals.add(native.input, native.output, cache.read, cache.write, native.reasoning);
      if (![native.input, native.output, native.reasoning, cache.read, cache.write].every(reportedCount)) totalsComplete = false;
      if (reportedCount(native.output) && reportedCount(native.reasoning) && !Number.isSafeInteger(native.output + native.reasoning)) totalsComplete = false;
      for (const key of Object.keys(totals) as (keyof UsageTokenTotals)[]) {
        const sum = totals[key] + step[key];
        if (!Number.isSafeInteger(sum)) totalsComplete = false;
        totals[key] = Math.min(Number.MAX_SAFE_INTEGER, sum);
      }
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) reportedCost += cost;
      else costComplete = false;
      const turn = totalsComplete ? { totals: { ...totals }, model: options.model,
        ...(costComplete && reportedCost > 0 && Number.isFinite(reportedCost) ? { costUsd: reportedCost } : {}) } : undefined;
      if (turn || reportedTurn) options.onUsage({ ...(turn ? { turn } : {}), ...(reportedTurn ? { reportedTurn } : {}) });
    };
    const append = (key: string, full: string) => {
      const previous = parts.get(key) ?? "";
      parts.set(key, full);
      if (full.startsWith(previous)) {
        const delta = full.slice(previous.length);
        text += delta;
        if (delta) options.onText?.(delta);
      } else throw new OpenCodeError("OpenCode replaced streamed text before the turn completed.");
    };
    const interrupt = () => connection.request(`${sessionPath}/${v2 ? "interrupt" : "abort"}`, { method: "POST", timeoutMs: 3000 }).catch(() => {});
    try {
      const response = await connection.response(v2 ? "/api/event" : "/event", { signal, stream: true });
      const events = openCodeEvents(response, signal);
      const result = Promise.withResolvers<void>();
      // The subscription can fail while the prompt HTTP receipt is still pending.
      const pendingQuestions = new Map<string, { question: OpenCodeQuestion; closed: boolean }>();
      const settleQuestion = (entry: { question: OpenCodeQuestion; closed: boolean }, status: "completed" | "cancelled" | "failed", reason?: string) => {
        if (entry.closed) return;
        entry.closed = true;
        pendingQuestions.delete(entry.question.request.id);
        const request = { ...entry.question.request, respondable: false, ...(reason ? { unavailableReason: reason } : {}) };
        options.onEvent?.({ type: "item.upsert", item: { id: request.itemId, nativeItemId: request.id,
          type: "user_input_request", title: request.title, status, request } });
      };
      const closeQuestions = () => {
        for (const entry of pendingQuestions.values()) settleQuestion(entry, "cancelled", "The native execution ended.");
      };
      void result.promise.catch(() => {});
      let sent = false;
      const consume = (async () => {
        try {
          for await (const event of events) {
            const properties = object(v2 ? event.data : event.properties);
            const part = object(properties.part);
            const info = object(properties.info);
            const form = object(properties.form);
            const type = string(event.type);
            const owner = properties.sessionID ?? part.sessionID ?? info.sessionID ?? form.sessionID ??
              (type === "shell.created" ? object(object(properties.info).metadata).sessionID : undefined);
            if (!sent) continue;
            const announcedParent = v2 ? properties.parentID : info.parentID;
            const announcedId = v2 ? properties.sessionID : info.id;
            if (type === "session.created" && typeof announcedParent === "string" && ownedSessions.has(announcedParent) && typeof announcedId === "string")
              ownedSessions.add(announcedId);
            const metadata = v2 ? object(properties.metadata) : object(object(part.state).metadata);
            const childId = string(v2 ? metadata.sessionID : metadata.sessionId);
            if (typeof owner === "string" && ownedSessions.has(owner) && childId &&
                (v2 ? type === "session.tool.progress" : type === "message.part.updated" && part.type === "tool" && part.tool === "task"))
              ownedSessions.add(childId);
            if (v2 && type.startsWith("shell.") && active && (owner === undefined || (typeof owner === "string" && ownedSessions.has(owner)))) {
              output.update("v2", event);
              continue;
            }
            if (!(typeof owner === "string" && ownedSessions.has(owner)) && !(owner === undefined && type === "session.error")) continue;
            if (!v2 || active || type === "session.execution.started" || type === "permission.asked" || type === "form.created")
              output.update(connection.generation, event);
            if (type === "question.replied" || type === "question.rejected" || type === "form.replied" || type === "form.cancelled") {
              const id = string(v2 ? properties.id : properties.requestID);
              const entry = pendingQuestions.get(id);
              if (entry) settleQuestion(entry, type.endsWith("replied") ? "completed" : "cancelled", "The native request has already closed.");
              continue;
            }
            const childOwner = typeof owner === "string" && owner !== sessionId;
            if (childOwner && type !== "permission.asked" && type !== "question.asked" && type !== "form.created") continue;
            if (v2) {
              if (type === "session.execution.started") active = true;
              if (!active && type !== "permission.asked" && type !== "form.created") continue;
              if (type === "session.text.delta" || type === "session.text.ended") {
                const key = `${string(properties.assistantMessageID)}:${String(properties.ordinal)}`;
                append(key, type.endsWith(".delta") ? (parts.get(key) ?? "") + string(properties.delta) : string(properties.text));
              }
              if (type === "session.step.ended") {
                const tokens = object(properties.tokens);
                usage ??= { inputTokens: 0, outputTokens: 0 };
                usage.inputTokens += Number(tokens.input) || 0;
                usage.outputTokens += Number(tokens.output) || 0;
              }
              if (type === "session.step.ended" || type === "session.step.failed") {
                const id = string(properties.id) || (typeof properties.ordinal === "number" && string(properties.assistantMessageID) ? `${string(properties.assistantMessageID)}:${properties.ordinal}` : undefined);
                reportStep(properties.tokens, id, properties.cost);
              }
              if (type === "session.execution.succeeded") { closeQuestions(); output.finish(); terminal = true; result.resolve(); return; }
              if (type === "session.execution.failed") {
                const error = object(properties.error);
                throw new OpenCodeError("OpenCode execution failed.", typeof error.status === "number" ? error.status : undefined, string(error.type));
              }
              if (type === "session.execution.interrupted") throw aborted();
            } else {
              if (type === "message.updated") {
                if (info.role === "assistant") assistantMessages.add(string(info.id));
                if (info.role === "assistant" && string(info.id) && typeof info.parentID === "string") {
                  const id = string(info.id);
                  const owned = info.parentID === messageID;
                  telemetryOwners.set(id, owned);
                  if (owned) for (const [stepId, step] of pendingTelemetry.get(id) ?? []) reportStep(step.tokens, stepId, step.cost);
                  pendingTelemetry.delete(id);
                }
                if (info.error) {
                  const error = object(info.error);
                  if (error.name === "MessageAbortedError") throw aborted();
                  throw new OpenCodeError("OpenCode assistant message failed.", Number(object(error.data).statusCode) || undefined, string(error.name));
                }
                if (info.role === "user") active = true;
              }
              if (type === "session.status" && object(properties.status).type === "busy") active = true;
              if (type === "message.part.updated") {
                const id = string(part.id);
                partTypes.set(id, string(part.type));
                if (part.type === "text" && assistantMessages.has(string(part.messageID))) append(id, string(part.text));
                if (part.type === "step-finish" && !steps.has(id) && assistantMessages.has(string(part.messageID))) {
                  steps.add(id);
                  const tokens = object(part.tokens);
                  usage ??= { inputTokens: 0, outputTokens: 0 };
                  usage.inputTokens += Number(tokens.input) || 0;
                  usage.outputTokens += Number(tokens.output) || 0;
                }
                if (options.onUsage && part.type === "step-finish" && id && string(part.messageID)) {
                  const message = string(part.messageID);
                  if (telemetryOwners.get(message) === true) reportStep(part.tokens, id, part.cost);
                  else if (!telemetryOwners.has(message)) {
                    const pending = pendingTelemetry.get(message) ?? new Map<string, { tokens: unknown; cost: unknown }>();
                    pending.set(id, { tokens: part.tokens, cost: part.cost });
                    pendingTelemetry.set(message, pending);
                  }
                }
              }
              if (type === "message.part.delta" && properties.field === "text" && partTypes.get(string(properties.partID)) === "text" && assistantMessages.has(string(properties.messageID))) {
                const id = string(properties.partID);
                append(id, (parts.get(id) ?? "") + string(properties.delta));
              }
              if (type === "session.error") {
                const error = object(properties.error);
                if (error.name === "MessageAbortedError") throw aborted();
                throw new OpenCodeError("OpenCode session failed.", Number(object(error.data).statusCode) || undefined, string(error.name));
              }
              if ((type === "session.idle" || (type === "session.status" && object(properties.status).type === "idle")) && active) { closeQuestions(); output.finish(); terminal = true; result.resolve(); return; }
            }
            if (type === "permission.asked") {
              const request = encodeURIComponent(string(properties.id));
              const targetSessionPath = `${root}/${encodeURIComponent(typeof owner === "string" ? owner : sessionId)}`;
              await connection.request(v2 ? `${targetSessionPath}/permission/${request}/reply` : `/permission/${request}/reply`, {
                method: "POST", body: v2 ? { decision: "reject" } : { reply: "reject" }, timeoutMs: 3000,
              });
              const nativeId = string(properties.id);
              if (nativeId) {
                const itemId = `opencode:approval:${nativeId}`;
                const detail = [string(v2 ? properties.action : properties.permission),
                  ...(Array.isArray(v2 ? properties.resources : properties.patterns) ? (v2 ? properties.resources : properties.patterns) as unknown[] : []).filter((value): value is string => typeof value === "string")].filter(Boolean).join(": ");
                const request = { id: nativeId, itemId, kind: "approval" as const, title: "Approval required",
                  ...(detail ? { detail } : {}), respondable: false, unavailableReason: "This chat does not authorize OpenCode approval requests." };
                options.onEvent?.({ type: "item.upsert", item: { id: itemId, nativeItemId: nativeId,
                  type: "approval_request", status: "failed", title: request.title, request } });
              }
              throw new OpenCodeError("OpenCode requested an action requiring approval; this chat has no authorized approval callback.");
            }
            if (type === "question.asked" || type === "form.created") {
              const nativeId = string(v2 ? form.id : properties.id);
              const encodedId = encodeURIComponent(nativeId);
              const targetSessionPath = `${root}/${encodeURIComponent(typeof owner === "string" ? owner : sessionId)}`;
              const rejectQuestion = () => connection.request(v2 ? `${targetSessionPath}/form/${encodedId}` : `/question/${encodedId}/reject`, { method: v2 ? "DELETE" : "POST", timeoutMs: 3000 });
              const question = openCodeQuestion(connection.generation, properties);
              if (!question || !options.onRequest) {
                await rejectQuestion();
                if (nativeId) {
                  const request = question?.request ?? { id: nativeId, itemId: `opencode:question:${nativeId}`, kind: "user_input" as const, title: string(form.title) || "User input requested", respondable: false };
                  const unavailable = { ...request, respondable: false, unavailableReason: question ? "Interactive OpenCode input is not available in this chat." : "This native form is not a supported information question." };
                  options.onEvent?.({ type: "item.upsert", item: { id: request.itemId, nativeItemId: nativeId,
                    type: "user_input_request", status: "failed", title: request.title, request: unavailable } });
                }
                throw new OpenCodeError("OpenCode requested interactive input that is not available in this chat.");
              }
              if (pendingQuestions.has(nativeId)) throw new OpenCodeError("OpenCode repeated a pending question.");
              const entry = { question, closed: false };
              pendingQuestions.set(nativeId, entry);
              options.onEvent?.({ type: "item.upsert", item: { id: question.request.itemId, nativeItemId: nativeId,
                type: "user_input_request", status: "waiting", title: question.request.title, request: question.request } });
              void (async () => {
                let abort: (() => void) | undefined;
                try {
                  const responsePromise = options.onRequest!(question.request);
                  const cancelled = Promise.withResolvers<never>();
                  abort = () => cancelled.reject(aborted());
                  if (signal.aborted) abort();
                  else signal.addEventListener("abort", abort, { once: true });
                  const response = await Promise.race([responsePromise, cancelled.promise]);
                  if (entry.closed) return;
                  const body = openCodeQuestionAnswer(question, response, connection.generation);
                  if (response.cancelled) await rejectQuestion();
                  else await connection.request(v2 ? `${targetSessionPath}/form/${encodedId}/reply` : `/question/${encodedId}/reply`, {
                    method: "POST", body, signal, timeoutMs: 3000,
                  });
                  settleQuestion(entry, response.cancelled ? "cancelled" : "completed");
                } catch (error) {
                  if (entry.closed) return;
                  const rejection = signal.aborted ? undefined : rejectQuestion().catch(() => undefined);
                  try { settleQuestion(entry, "failed", "The native question could not be answered."); }
                  catch (callbackError) { result.reject(callbackError); await rejection; return; }
                  result.reject(error);
                  await rejection;
                } finally {
                  if (abort) signal.removeEventListener("abort", abort);
                }
              })();
            }
          }
        } catch (error) { result.reject(error); }
      })();
      try {
        sent = true;
        await connection.request(v2 ? `${sessionPath}/prompt` : `${sessionPath}/prompt_async`, { method: "POST", signal,
          body: v2 ? { id: messageID, text: options.prompt } : { messageID, model, parts: [{ type: "text", text: options.prompt }] } });
        await result.promise;
      } finally {
        streamController.abort();
        await consume;
      }
      if (!terminal) throw new OpenCodeError("OpenCode did not report a completed execution.");
      return { text, ...(usage ? { usage } : {}), nativeSession: ref };
    } finally {
      streamController.abort();
      if (!terminal) await interrupt();
    }
  }, options.signal).finally(() => { if (lease) runningSessions.delete(lease); });
}

export const opencodeAdapter: NativeProviderAdapter = {
  definition: {
    driver: "opencode", label: "OpenCode", description: "OpenCode native agent with its own provider authentication, model catalog and resumable sessions.", defaultInstance: false,
    docsUrl: "https://opencode.ai/docs/", source: "t3code/packages/provider-opencode (MIT)",
    fields: [
      { key: "binaryPath", label: "Binary path", type: "string", defaultValue: "opencode", placeholder: "opencode", clearWhenEmpty: "omit", description: "Path to the OpenCode binary." },
      { key: "serverUrl", label: "Server URL", type: "string", defaultValue: "", placeholder: "http://127.0.0.1:4096", clearWhenEmpty: "omit", description: "Leave blank to spawn an owned local server; set an explicit URL to connect to an existing server." },
      { key: "serverPassword", label: "Server password", type: "password", defaultValue: "", placeholder: "Optional", clearWhenEmpty: "omit", description: "Write-only password for the native server, stored separately on the host." },
    ],
  },
  validateConfig, check, authenticate, logout, run,
};
