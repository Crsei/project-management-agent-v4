import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as createPortReservation, type Server as PortReservation } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createLocalProjectFixture, type LocalProjectFixture } from "../../../../tests/local-project-fixture.ts";
import { createUser, createWorkspace } from "../../../../packages/infrastructure/src/auth.ts";
import { getThread } from "../src/durable/threads.ts";
import { createGateway } from "../../gateway.ts";
import { app } from "../src/app.ts";
import { startRuntime, stopRuntime } from "../src/runtime.ts";
import { getProviderSettings, listStoredInstances, updateProviderInstance, updateProviderSettings } from "../src/providers/instances.ts";
import { stopPmCoreChanges } from "../src/pm-core-changes/index.ts";

/**
 * Parent-only M3 gate: invokes the production startRuntime/stopRuntime assembly,
 * real PM HTTP authorization in a fresh PostgreSQL schema, real Chat HTTP/SSE,
 * the original OpenCode driver and an explicitly selected ACTUAL vendor model.
 * Never reads .env, credentials, provider homes or an existing PM access file.
 * Native CLI alone may use its existing authorized environment. No installation,
 * update, account import, mock model endpoint or external process shutdown.
 *
 * Required: TEST_DATABASE_URL explicitly supplied by parent; --model provider/model.
 * Optional: --binary /authorized/opencode, --server-url http://... (password only
 * from OPENCODE_SMOKE_SERVER_PASSWORD), --variant high, --browser, --evidence PATH.
 * --web-dist PATH selects an isolated Web build for browser verification; it does
 * not publish that build into the repository's running gateway.
 * --browser keeps owned random-port services/data alive until SIGINT/SIGTERM.
 * Login secrets are sent only over process.send IPC, never files/stdout. Without
 * IPC, parent must supply OPENCODE_SMOKE_EMAIL, OPENCODE_SMOKE_PASSWORD and
 * OPENCODE_SMOKE_AGENT_ACCESS_TOKEN (generated disposable values) in its child env.
 * Evidence deliberately separates settings, SSE, history, resume and browser:
 * this program does NOT assert that a parent has performed browser proof.
 * SSE failure cancels the owned Chat worker by message ID and drains it before
 * runtime/PM teardown. Cleanup deadlines fail visibly; a native drain failure
 * retains the owned data/schema/environment rather than disposing them early.
 */
const { values } = parseArgs({ strict: true, options: {
  model: { type: "string" }, binary: { type: "string", default: "opencode" },
  "server-url": { type: "string", default: "" }, variant: { type: "string" },
  browser: { type: "boolean", default: false }, evidence: { type: "string" }, "web-dist": { type: "string" },
} });
if (!values.model || !/^[^\s/]+\/.+/.test(values.model)) throw new Error("--model provider/model is required; no automatic model fallback");
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must explicitly authorize a disposable schema; no dotenv or current PM database fallback");
const databaseUrl = process.env.TEST_DATABASE_URL;
const serverPassword = process.env.OPENCODE_SMOKE_SERVER_PASSWORD ?? "";
const suppliedEmail = process.env.OPENCODE_SMOKE_EMAIL;
const suppliedPassword = process.env.OPENCODE_SMOKE_PASSWORD;
const suppliedAgentToken = process.env.OPENCODE_SMOKE_AGENT_ACCESS_TOKEN;
if (Boolean(suppliedEmail) !== Boolean(suppliedPassword)) throw new Error("Supply both disposable browser email and password, or neither");
if (suppliedAgentToken && suppliedAgentToken.length < 32) throw new Error("The disposable Agent access token must have at least 32 characters");
if (values.browser && (!process.send || !process.connected) && (!suppliedEmail || !suppliedPassword || !suppliedAgentToken))
  throw new Error("--browser requires private parent IPC or all three OPENCODE_SMOKE_* login environment values; no credential files are written");
const browserEmail = suppliedEmail || `opencode-smoke-${randomUUID()}@example.test`;
const browserPassword = suppliedPassword || randomBytes(32).toString("base64url");
const agentAccessToken = suppliedAgentToken || randomBytes(32).toString("base64url");
if (values["server-url"]) {
  const url = new URL(values["server-url"]);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("--server-url must not contain credentials, query parameters or fragments");
}
const root = await mkdtemp(path.join(tmpdir(), "pm-opencode-real-m3-"));
const previous = new Map<string, string | undefined>();
function bind(name: string, value: string | undefined) {
  if (!previous.has(name)) previous.set(name, process.env[name]);
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
async function withinSmokeDeadline<T>(operation: Promise<T>, milliseconds: number) {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error("Owned OpenCode smoke cleanup deadline")), milliseconds);
  try { return await Promise.race([operation, deadline.promise]); }
  finally { clearTimeout(timer); }
}
const stopped = Promise.withResolvers<void>(); const controller = new AbortController();
const onSignal = () => { controller.abort(new Error("Owned OpenCode smoke stopped")); stopped.resolve(); };
process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
let pm: LocalProjectFixture | undefined; let agentServer: Server | undefined; let gateway: Server | undefined;
let phase = "initialize";
let safeTerminal: { status?: string; errorClass?: string } | undefined;
let nativeTranscript: string | undefined;
let smokeThreadId: string | undefined;
let cancelTurn: (() => Promise<void>) | undefined;
let browserPort: number | undefined;
let portReservation: PortReservation | undefined;
try {
  const data = path.join(root, "agent-data"); const area = path.join(root, "file-areas");
  await mkdir(data); await mkdir(area);
  bind("AGENT_WORKSPACE_DATA_DIR", data); bind("AGENT_WORKSPACE_PROJECT_ROOT", area);
  bind("AGENT_WORKSPACE_ACCESS_TOKEN", agentAccessToken);
  // Default bootstrap providers are disabled before any workers/health checks run.
  for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
  const settings = getProviderSettings(); updateProviderSettings(settings.revision, 0);
  if (values.browser) {
    portReservation = createPortReservation(socket => socket.destroy());
    const reserved = Promise.withResolvers<void>();
    portReservation.once("error", reserved.reject);
    portReservation.listen(0, "127.0.0.1", reserved.resolve);
    await reserved.promise;
    const address = portReservation.address(); assert.ok(address && typeof address !== "string");
    browserPort = address.port;
  }
  pm = await createLocalProjectFixture({ databaseUrl, chatSpaceRoot: area,
    ...(browserPort === undefined ? {} : { publicOrigin: `http://127.0.0.1:${browserPort}` }) });
  // This controller drains Agent workers before disposing PM; do not let a
  // signal independently drop the PM schema beneath an in-flight native turn.
  controller.signal.throwIfAborted();
  const user = await createUser(pm.pool, { email: browserEmail, name: "Disposable OpenCode browser owner", password: browserPassword });
  const workspace = await createWorkspace(pm.pool, user.id, "Disposable OpenCode M3");
  const pmLogin = await fetch(`${pm.origin}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: browserEmail, password: browserPassword }), signal: controller.signal });
  assert.equal(pmLogin.status, 200); const pmCookie = pmLogin.headers.get("set-cookie")?.split(";")[0];
  await pmLogin.body?.cancel(); assert.ok(pmCookie);
  // Explicit fixture infrastructure secrets must never reach a native Provider environment.
  for (const name of ["TEST_DATABASE_URL", "OPENCODE_SMOKE_SERVER_PASSWORD", "OPENCODE_SMOKE_EMAIL", "OPENCODE_SMOKE_PASSWORD", "OPENCODE_SMOKE_AGENT_ACCESS_TOKEN"]) bind(name, undefined);
  bind("PM_API_URL", pm.origin);
  phase = "runtime-start"; await startRuntime();
  const listening = Promise.withResolvers<void>();
  agentServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => listening.resolve()) as Server;
  agentServer.once("error", listening.reject); await listening.promise;
  const agentAddress = agentServer.address(); assert.ok(agentAddress && typeof agentAddress !== "string");
  const agentOrigin = `http://127.0.0.1:${agentAddress.port}`;
  const login = await fetch(`${agentOrigin}/api/access`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.AGENT_WORKSPACE_ACCESS_TOKEN }), signal: controller.signal });
  assert.equal(login.status, 200); const agentCookie = login.headers.get("set-cookie")?.split(";")[0];
  await login.body?.cancel(); assert.ok(agentCookie);
  // Agent and PM authenticate their own cookies; an Agent bearer must not mask the PM cookie.
  const headers = new Headers({ cookie: `${pmCookie}; ${agentCookie}`, "content-type": "application/json" });
  async function json<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${agentOrigin}/api${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`HTTP phase failed: ${phase}`), { status: response.status });
    }
    return await response.json() as T;
  }
  phase = "provider-configuration";
  await json("/providers", "POST", { instanceId: "opencode-real-m3", driver: "opencode", label: "Disposable actual-provider M3",
    config: { binaryPath: values.binary, serverUrl: values["server-url"], serverPassword } });
  phase = "settings-check";
  const check = await json<{ ok: boolean; authentication: string; models?: Array<{ id: string }> }>("/providers/opencode-real-m3/test", "POST", {});
  assert.equal(check.ok, true, "Settings readiness must pass before actual inference; an inventory alone is not proof");
  assert.ok(check.models?.some(model => model.id === values.model), "Explicit model must be present in the original provider catalog");
  const scope = { workspaceId: workspace.id, projectId: null };
  const resolved = await pm.request<{ path: string }>("/api/v1/agent-contexts/resolve", { method: "POST", body: scope, cookie: pmCookie });
  assert.equal(resolved.status, 200); assert.ok(path.resolve(resolved.body.path).startsWith(path.resolve(area) + path.sep));
  const threadId = `opencode-real-${randomUUID()}`;
  smokeThreadId = threadId;
  await json("/chat/threads", "POST", { id: threadId, scope });
  const thread = await json<{ thread: { revision: number } }>(`/chat/threads/${threadId}`);
  const saved = await json<{ thread: { revision: number } }>(`/chat/threads/${threadId}`, "PUT", { revision: thread.thread.revision,
    settings: { providerInstanceId: "opencode-real-m3", model: values.model, systemPrompt: "Perform only the requested arithmetic. Do not use tools or change files or PM objects.", temperature: 0,
      ...(values.variant ? { modelOptions: [{ id: "variant", value: values.variant }] } : {}), interactionMode: "default" } });
  const a = randomInt(13, 80), b = randomInt(11, 60), c = randomInt(101, 999); const expected = String(a * b + c);
  const messages: Array<{ id: string; role: "user" | "assistant"; parts: Array<{ type: "text"; text: string }> }> = [];
  async function turn(prompt: string, expectedText: string) {
    const messageId = randomUUID();
    messages.push({ id: messageId, role: "user", parts: [{ type: "text", text: prompt }] });
    // Closing an SSE reader only unsubscribes; explicitly cancel the owned Chat
    // worker on failure, even if the request failed before returning a generation.
    cancelTurn = async () => {
      const cancelled = await fetch(`${agentOrigin}/api/chat/threads/${threadId}/cancel`, {
        method: "POST", headers, body: JSON.stringify({ messageId }), signal: AbortSignal.timeout(15_000),
      });
      await cancelled.body?.cancel();
      assert.equal(cancelled.status, 200, "Owned native generation cancellation must drain before fixture disposal");
    };
    const response = await fetch(`${agentOrigin}/api/chat`, { method: "POST", headers, body: JSON.stringify({ id: threadId, messages,
      config: { providerInstanceId: "opencode-real-m3", modelName: values.model, threadSettingsRevision: saved.thread.revision, responseStreamingMode: "turn" } }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const generationId = response.headers.get("x-resumable-stream-id"); assert.ok(generationId);
    let text = ""; let eventCount = 0; let finish = false; let buffer = ""; let streamError = false;
    assert.ok(response.body);
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk.replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) if (line.startsWith("data: ") && line !== "data: [DONE]") {
          const event = JSON.parse(line.slice(6)) as { type: string; delta?: string };
          eventCount++;
          if (event.type === "error") streamError = true;
          if (event.type === "text-delta") text += event.delta ?? "";
          if (event.type === "finish") finish = true;
        }
      }
    }
    const generations = await json<{ generations: Array<{ id: string; status: string; errorClass?: string }> }>(`/chat/threads/${threadId}/generations`);
    const terminal = generations.generations.find(generation => generation.id === generationId);
    safeTerminal = { status: terminal && ["completed", "failed", "interrupted", "cancelled"].includes(terminal.status) ? terminal.status : "unknown",
      ...(terminal?.errorClass && ["authentication", "usage_limit", "provider_error", "cancelled", "unsupported"].includes(terminal.errorClass) ? { errorClass: terminal.errorClass } : {}) };
    assert.equal(streamError, false, "Native errors cannot be accepted as a nonempty reply");
    assert.equal(terminal?.status, "completed");
    assert.equal(finish, true); assert.equal(text.trim(), expectedText, "Actual provider must compute the unseen arithmetic result, not echo the prompt");
    const history = await json<{ messages: Array<{ id: string; content: { role: string; parts: Array<{ type: string; text?: string }> } }> }>(`/chat/threads/${threadId}/history`);
    const answer = history.messages.filter(message => message.content.role === "assistant").at(-1); assert.ok(answer);
    assert.equal(answer.content.parts.filter(part => part.type === "text").map(part => part.text).join("").trim(), expectedText);
    messages.push({ id: answer.id, role: "assistant", parts: [{ type: "text", text }] });
    cancelTurn = undefined;
    return { generationId, eventCount, answer: expectedText };
  }
  phase = "actual-sse";
  const first = await turn(`Compute (${a} * ${b}) + ${c}. Reply with the decimal integer only. Do not use tools.`, expected);
  const nativeSession = getThread(threadId)?.nativeSession?.sessionId; assert.ok(nativeSession); nativeTranscript = nativeSession;
  phase = "actual-resume-history";
  const second = await turn("Add 7 to your previous result. Reply with the decimal integer only. Do not use tools.", String(Number(expected) + 7));
  assert.equal(getThread(threadId)?.nativeSession?.sessionId, nativeSession, "Continuation must use the same actual native session");
  const evidence = { event: "opencode_m3_actual_provider", model: values.model, configuredServer: Boolean(values["server-url"]),
    nativeSessionId: nativeSession, nativeTranscriptDisposition: "retained_provider_owned",
    settings: { ok: check.ok, authentication: check.authentication }, first, second, historyReread: true, nativeResume: true,
    browserProof: "parent-required", persistence: "existing Chat records storage" };
  if (values.evidence) await writeFile(path.resolve(values.evidence), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (values.browser) {
    phase = "browser-ready";
    gateway = createGateway({ pmUrl: pm.origin, agentUrl: agentOrigin,
      webDist: values["web-dist"] ? path.resolve(values["web-dist"]) : fileURLToPath(new URL("../../../web/dist", import.meta.url)) });
    assert.ok(portReservation && browserPort);
    const released = Promise.withResolvers<void>();
    portReservation.close(error => error ? released.reject(error) : released.resolve());
    await released.promise;
    portReservation = undefined;
    const ready = Promise.withResolvers<void>(); gateway.once("error", ready.reject); gateway.listen(browserPort, "127.0.0.1", ready.resolve); await ready.promise;
    const address = gateway.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    if (process.send && process.connected) {
      const delivered = Promise.withResolvers<void>();
      process.send({ event: "opencode_m3_browser_credentials", origin, email: browserEmail, password: browserPassword,
        agentAccessToken, threadId, scope, model: values.model, expectedAnswers: [first.answer, second.answer] },
        error => error ? delivered.reject(error) : delivered.resolve());
      await delivered.promise;
    }
    console.log(JSON.stringify({ event: "opencode_m3_browser_ready", origin, threadId, nativeSessionId: nativeSession,
      nativeTranscriptDisposition: "retained_provider_owned", settingsPath: "/agent/settings/providers", chatPath: "/agent/workspace", shutdown: "SIGINT/SIGTERM this controller only" }));
    await stopped.promise;
  } else console.log(JSON.stringify(evidence));
} catch (error) {
  // Never print vendor responses, request URLs, environment, cookies or raw errors.
  console.error(JSON.stringify({ event: "opencode_m3_actual_failed", phase,
    status: error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined,
    terminal: safeTerminal,
    errorType: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  if (!nativeTranscript && smokeThreadId) {
    try { nativeTranscript = getThread(smokeThreadId)?.nativeSession?.sessionId; } catch { /* Failed evidence reads do not replace the original failure. */ }
  }
  const cleanupErrors: unknown[] = [];
  if (portReservation?.listening) {
    const released = Promise.withResolvers<void>();
    portReservation.close(error => error ? released.reject(error) : released.resolve());
    try { await withinSmokeDeadline(released.promise, 5_000); }
    catch (error) { cleanupErrors.push(error); }
  }
  controller.abort(new Error("Owned OpenCode smoke cleanup"));
  try { await withinSmokeDeadline(cancelTurn?.() ?? Promise.resolve(), 16_000); }
  catch (error) { cleanupErrors.push(error); }
  for (const server of [gateway, agentServer]) if (server) {
    server.closeAllConnections(); const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    try { await withinSmokeDeadline(closed.promise, 5_000); } catch (error) { cleanupErrors.push(error); }
  }
  let runtimeDrained = false;
  try { await withinSmokeDeadline(stopRuntime(), 20_000); runtimeDrained = true; }
  catch (error) { cleanupErrors.push(error); }
  try { await withinSmokeDeadline(stopPmCoreChanges(), 5_000); }
  catch (error) { cleanupErrors.push(error); }
  // A failed native drain must not resume against a different environment or a
  // removed PM schema. Preserve owned resources and report failure to the parent.
  if (runtimeDrained) {
    try { await withinSmokeDeadline(pm?.close() ?? Promise.resolve(), 15_000); }
    catch (error) { cleanupErrors.push(error); }
    for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  console.log(JSON.stringify({ event: "opencode_m3_native_transcript", nativeSessionId: nativeTranscript, disposition: nativeTranscript ? "retained_provider_owned" : "none_observed" }));
  if (cleanupErrors.length) {
    console.error(JSON.stringify({ event: "opencode_m3_cleanup_failed", ownedRoot: root, failures: cleanupErrors.length })); process.exitCode = 1;
  } else { await rm(root, { recursive: true, force: true }); console.log(JSON.stringify({ event: "opencode_m3_stopped", ownedResourcesCleaned: true })); }
}
