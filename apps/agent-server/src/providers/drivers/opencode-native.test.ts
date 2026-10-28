import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { ProviderDriverAuthOptions, ProviderDriverContext } from "../driver-adapter.ts";
import { opencodeAdapter } from "./opencode.ts";
import { OpenCodeConnection, openCodeEvents, openCodeEnvironment } from "./opencode-transport.ts";

type RecordedRequest = { method: string; path: string; url: URL; body: Record<string, unknown>; authorization?: string; directory?: string };
type Scenario = "success" | "subagent" | "question" | "question-external" | "disconnect" | "error" | "wait" | "approval" | "form" | "rejected-stream" | "busy" | "usage" | "usage-partial";
async function fixture(generation: "v1" | "v2", scenario: Scenario = "success", password = "密碼-password") {
  const requests: RecordedRequest[] = [];
  const streams = new Set<ServerResponse>();
  let authorized = false;
  let oauthPolls = 0;
  const prompted = Promise.withResolvers<void>();
  const questionRejected = Promise.withResolvers<void>();
  const event = (type: string, properties: Record<string, unknown>) => {
    const payload = generation === "v2" ? { type, data: properties, created: Date.now() } : { type, properties };
    for (const stream of streams) stream.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);
  };
  const complete = () => event(generation === "v2" ? "session.execution.succeeded" : "session.status", { sessionID: "ses_1", status: { type: "idle" } });
  const cwd = "/scoped/project with spaces";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url!, "http://127.0.0.1");
    let body: Record<string, unknown> = {};
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const record: RecordedRequest = { method: request.method!, path: url.pathname, url, body,
      authorization: request.headers.authorization, directory: request.headers["x-opencode-directory"] as string | undefined };
    requests.push(record);
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const empty = () => { response.writeHead(204); response.end(); };
    if (password && request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
      json({ message: "secret-that-must-not-leak" }, 401); return;
    }
    if (url.pathname === "/api/info") {
      if (generation === "v2") json({ version: "2.0.28", pid: process.pid });
      else { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html>SPA"); }
      return;
    }
    if (url.pathname === "/global/health") { json({ healthy: true, version: "1.14.19" }); return; }
    if (url.pathname === "/provider") {
      json({ all: [{ id: "native-api", name: "Native provider", source: "api", models: { "model/one": { id: "model/one", name: "Model One", temperature: true, reasoning: true } } },
        { id: "disconnected", name: "Do not list", models: { other: { id: "other", name: "Disconnected model" } } }], connected: ["native-api"], default: {} }); return;
    }
    if (url.pathname === "/provider/auth") { json({ "native-api": [{ type: "api", label: "API key" }, { type: "oauth", label: "Browser login", prompts: [{ type: "select", key: "account", message: "Account", options: [{ value: "work", label: "Work" }] }] }] }); return; }
    if (url.pathname === "/auth/native-api" && request.method === "PUT") { authorized = body.type === "api" && body.key === "native-key"; json(authorized); return; }
    if (url.pathname === "/auth/native-api" && request.method === "DELETE") { authorized = false; json(true); return; }
    if (url.pathname.endsWith("/oauth/authorize")) { json({ url: "https://auth.example.test/authorize", method: "code", instructions: "Sign in with the native provider." }); return; }
    if (url.pathname.endsWith("/oauth/callback")) { authorized = body.method === 1 && body.code === "auth-code"; json(authorized); return; }
    if (url.pathname === "/api/model") { json({ location: { directory: cwd }, data: [{ id: "model/one", providerID: "native-api", name: "Model One", variants: [{ id: "high" }] }] }); return; }
    if (url.pathname === "/api/integration") {
      json({ location: { directory: cwd }, data: [{ id: "native-api", name: "Native provider", connections: authorized ? [{ type: "credential", id: "cred_1", method: "key" }] : [], methods: [
        { type: "key", label: "API key", form: [{ type: "string", key: "endpoint", title: "Endpoint", required: true }] },
        { id: "browser", type: "oauth", label: "OAuth" }, { id: "external", type: "external", label: "External" }, { id: "command", type: "command", label: "Command", command: ["native-auth"] },
      ] }] }); return;
    }
    if (url.pathname === "/api/integration/native-api/connect/key") { authorized = body.key === "native-key" && (body.answer as Record<string, unknown>)?.endpoint === "https://native.example.test"; if (!authorized) { json({}, 400); return; } empty(); return; }
    if (url.pathname === "/api/integration/native-api/connect/external") { authorized = body.methodID === "external"; empty(); return; }
    if (url.pathname === "/api/integration/native-api/connect/oauth") { json({ data: { attemptID: "con_1", url: "https://auth.example.test/authorize", mode: "auto", instructions: "Authorize", time: { created: Date.now(), expires: Date.now() + 60_000 } } }); return; }
    if (url.pathname === "/api/integration/native-api/connect/command") { json({ data: { attemptID: "con_command", time: { created: Date.now(), expires: Date.now() + 60_000 } } }); return; }
    if (/\/connect\/(oauth|command)\/con_/.test(url.pathname)) {
      if (request.method === "DELETE") { empty(); return; }
      oauthPolls += 1; authorized = true;
      json({ data: { status: "complete", time: { created: Date.now(), expires: Date.now() + 60_000 } } }); return;
    }
    if (url.pathname === "/api/credential/cred_1" && request.method === "DELETE") { authorized = false; empty(); return; }
    const root = generation === "v2" ? "/api/session" : "/session";
    if (url.pathname === (generation === "v2" ? "/api/session/active" : "/session/status")) {
      const active = scenario === "busy" ? { ses_1: { type: generation === "v2" ? "running" : "busy" } } : {};
      json(generation === "v2" ? { data: active } : active); return;
    }
    if (url.pathname === root && request.method === "POST") { json(generation === "v2" ? { data: { id: "ses_1", location: { directory: cwd } } } : { id: "ses_1", directory: cwd }); return; }
    if (url.pathname === `${root}/ses_1` && request.method === "GET") { json(generation === "v2" ? { data: { id: "ses_1", location: { directory: cwd } } } : { id: "ses_1", directory: cwd }); return; }
    if (url.pathname === `${root}/ses_1` && request.method === "PATCH") { if (generation === "v2") empty(); else json({ id: "ses_1", directory: cwd }); return; }
    if (url.pathname === `${root}/ses_1/model`) { empty(); return; }
    if (url.pathname === (generation === "v2" ? "/api/event" : "/event")) {
      if (scenario === "rejected-stream") { response.writeHead(200, { "content-type": "text/html" }); response.end("<html>SPA</html>"); return; }
      response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
      response.write(": heartbeat\n\n");
      streams.add(response); response.once("close", () => streams.delete(response)); return;
    }
    if (url.pathname.endsWith("/prompt") || url.pathname.endsWith("/prompt_async")) {
      if (generation === "v2") json({ data: { id: "msg_admitted" } }); else empty();
      if (generation === "v2") {
        event("session.execution.started", { sessionID: "ses_other" });
        event("session.text.delta", { sessionID: "ses_other", assistantMessageID: "msg_other", ordinal: 0, delta: "wrong session" });
        event("session.execution.started", { sessionID: "ses_1" });
        event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "Hello" });
        event("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, text: "Hello world" });
      } else {
        event("message.updated", { sessionID: "ses_1", info: { id: "msg_user", sessionID: "ses_1", role: "user" } });
        event("message.part.updated", { part: { id: "prt_user", sessionID: "ses_1", messageID: "msg_user", type: "text", text: "Do not echo the prompt" } });
        event("session.status", { sessionID: "ses_1", status: { type: "busy" } });
        if (scenario === "usage") {
          event("message.part.updated", { part: { id: "step_1", sessionID: "ses_1", messageID: "msg_a", type: "step-finish", cost: 0.01,
            tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 3 } } } });
          event("message.part.updated", { part: { id: "foreign", sessionID: "ses_1", messageID: "msg_old", type: "step-finish",
            tokens: { input: 999, output: 999 } } });
          event("message.updated", { sessionID: "ses_1", info: { id: "msg_old", sessionID: "ses_1", role: "assistant", parentID: "old_prompt" } });
        }
        event("message.updated", { sessionID: "ses_1", info: { id: "msg_a", sessionID: "ses_1", role: "assistant", parentID: body.messageID } });
        event("message.part.updated", { part: { id: "prt_a", sessionID: "ses_1", messageID: "msg_a", type: "text", text: "Hello" } });
        event("message.part.delta", { sessionID: "ses_1", messageID: "msg_a", partID: "prt_a", field: "text", delta: " world" });
        event("message.part.updated", { part: { id: "prt_a", sessionID: "ses_1", messageID: "msg_a", type: "text", text: "Hello world" } });
      }
      prompted.resolve();
      if (scenario === "usage" || scenario === "usage-partial") {
        const tokens = scenario === "usage" ? { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 3 } } : { input: 10, output: 4, cache: { read: 6 } };
        const second = { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 1 } };
        if (generation === "v2") {
          event("session.step.ended", { sessionID: "ses_other", id: "foreign", tokens });
          event("session.step.ended", { sessionID: "ses_1", id: "step_1", tokens, cost: 0.01 });
          event("session.step.ended", { sessionID: "ses_1", id: "step_1", tokens, cost: 0.01 });
          event("session.step.ended", { sessionID: "ses_1", id: "step_2", tokens: second, cost: 0.02 });
        } else {
          const step = (id: string, value: unknown) => event("message.part.updated", { part: { id, sessionID: "ses_1", messageID: "msg_a", type: "step-finish", tokens: value, cost: id === "step_1" ? 0.01 : 0.02 } });
          step("step_1", tokens); step("step_1", tokens); step("step_2", second);
        }
        complete();
      }
      if (scenario === "success") event(generation === "v2" ? "session.execution.succeeded" : "session.status", { sessionID: "ses_1", status: { type: "idle" } });
      if (scenario === "subagent") {
        if (generation === "v2") {
          event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_child", name: "subagent" });
          event("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_child", input: { agent: "explore" } });
          event("session.created", { sessionID: "ses_child", parentID: "ses_1", title: "Child" });
          event("session.tool.progress", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_child", metadata: { sessionID: "ses_child" } });
          event("session.text.delta", { sessionID: "ses_child", assistantMessageID: "msg_child", ordinal: 0, delta: "child output" });
          event("session.execution.succeeded", { sessionID: "ses_child" });
        } else {
          event("message.part.updated", { part: { id: "prt_tool", sessionID: "ses_1", messageID: "msg_a", type: "tool", tool: "task",
            callID: "call_child", state: { status: "running", input: { subagent_type: "explore" }, metadata: { sessionId: "ses_child" } } } });
          event("message.updated", { sessionID: "ses_child", info: { id: "msg_child", sessionID: "ses_child", role: "assistant" } });
          event("message.part.updated", { part: { id: "prt_child", sessionID: "ses_child", messageID: "msg_child", type: "text", text: "child output" } });
          event("session.status", { sessionID: "ses_child", status: { type: "idle" } });
        }
        event(generation === "v2" ? "session.execution.succeeded" : "session.status", { sessionID: "ses_1", status: { type: "idle" } });
      }
      if (scenario === "error") event(generation === "v2" ? "session.execution.failed" : "session.error", { sessionID: "ses_1", error: generation === "v2" ? { type: "provider.quota", status: 429, message: "must-not-leak-token" } : { name: "APIError", data: { statusCode: 429, message: "must-not-leak-token" } } });
      if (scenario === "approval") event("permission.asked", { sessionID: "ses_1", id: "per_1", action: "shell", permission: "bash", resources: ["*"], patterns: ["*"] });
      if (scenario === "form") event(generation === "v2" ? "form.created" : "question.asked", generation === "v2" ? { form: { sessionID: "ses_1", id: "frm_1", fields: [] } } : { sessionID: "ses_1", id: "que_1" });
      if (scenario === "question" || scenario === "question-external") {
        event(generation === "v2" ? "form.created" : "question.asked", generation === "v2"
          ? { form: { sessionID: "ses_1", id: "frm_1", title: "Questions", metadata: { kind: "question" }, fields: [
            { key: "color", type: "string", title: "Color", description: "Pick a color", options: [{ value: "blue", label: "Blue" }, { value: "red", label: "Red" }], custom: false },
          ] } }
          : { sessionID: "ses_1", id: "que_1", questions: [{ header: "Color", question: "Pick a color",
            options: [{ label: "Blue", description: "Blue" }, { label: "Red", description: "Red" }], custom: false }] });
        if (scenario === "question-external") {
          event(generation === "v2" ? "form.cancelled" : "question.rejected", generation === "v2"
            ? { sessionID: "ses_1", id: "frm_1" } : { sessionID: "ses_1", requestID: "que_1" });
          complete();
        }
      }
      if (scenario === "disconnect") for (const stream of streams) stream.end();
      return;
    }
    if (url.pathname.endsWith("/interrupt") || url.pathname.endsWith("/abort")) { if (generation === "v2") json({ data: { interrupted: true } }); else json(true); return; }
    if (url.pathname.endsWith("/reply") || url.pathname.endsWith("/reject") || (url.pathname.includes("/form/") && request.method === "DELETE")) {
      empty();
      if (scenario === "question" && (url.pathname.includes("/question/") || url.pathname.includes("/form/"))) {
        const rejected = url.pathname.endsWith("/reject") || request.method === "DELETE";
        if (rejected) questionRejected.resolve();
        event(generation === "v2" ? (rejected ? "form.cancelled" : "form.replied") : (rejected ? "question.rejected" : "question.replied"),
          generation === "v2" ? { sessionID: "ses_1", id: "frm_1" } : { sessionID: "ses_1", requestID: "que_1" });
        complete();
      }
      return;
    }
    json({ error: "unexpected endpoint" }, 404);
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const context: ProviderDriverContext = { instanceId: "oc-test", driver: "opencode", revision: 7, homeDirectory: "/isolated/test-home", cwd,
    config: { binaryPath: "/never-run-for-remote", serverUrl: `http://127.0.0.1:${address.port}`, serverPassword: password }, env: {} };
  return { context, requests, prompted: prompted.promise, questionRejected: questionRejected.promise, get authorized() { return authorized; }, get oauthPolls() { return oauthPolls; },
    close: async () => { for (const stream of streams) stream.end(); server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; } };
}

function authOptions(methodId: string, values?: Record<string, string>, inputs: string[] = []): ProviderDriverAuthOptions {
  return { methodId, values, signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => {
    assert.ok(inputs.length, "unexpected extra authentication prompt"); return inputs.shift()!;
  } };
}

test("OpenCode settings retain native server password secrecy metadata and reject embedded credentials", () => {
  assert.deepEqual(opencodeAdapter.validateConfig({}), { binaryPath: "opencode", serverUrl: "", serverPassword: "" });
  assert.equal(opencodeAdapter.definition.fields.find((field) => field.key === "serverPassword")?.type, "password");
  for (const serverUrl of ["file:///tmp/socket", "http://user:secret@localhost", "http://localhost?token=secret", "http://localhost/#secret"]) {
    assert.throws(() => opencodeAdapter.validateConfig({ serverUrl }));
  }
  assert.throws(() => opencodeAdapter.validateConfig({ apiKey: "not-a-standalone-provider" }));
});

for (const generation of ["v1", "v2"] as const) {
  test(`OpenCode ${generation} discovers only native model IDs and performs its real key authentication protocol`, async () => {
    const f = await fixture(generation);
    try {
      const status = await opencodeAdapter.check(f.context);
      assert.equal(status.installation.status, "installed");
      assert.deepEqual(status.models.map((model) => model.id), ["native-api/model/one"]);
      const method = status.methods.find((method) => method.type === "credentials" && method.name.includes("API key")); assert.ok(method);
      await opencodeAdapter.authenticate(f.context, authOptions(method.id, { key: "native-key", endpoint: "https://native.example.test" }));
      assert.equal(f.authorized, true);
      await opencodeAdapter.logout(f.context);
      assert.equal(f.authorized, false);
      assert.equal(f.requests.some((request) => request.path.includes("dispose") || request.path.includes("reload")), false);
      for (const request of f.requests.filter((request) => !["/api/info", "/global/health"].includes(request.path))) {
        assert.equal(request.url.searchParams.get(generation === "v2" ? "location[directory]" : "directory"), f.context.cwd);
      }
    } finally { await f.close(); }
  });

  test(`OpenCode ${generation} streams exact assistant output, observes native completion and resumes in the same cwd`, async () => {
    const f = await fixture(generation);
    try {
      const deltas: string[] = [];
      const output: NativeOutputEvent[] = [];
      const first = await opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "hello", onText: (delta) => deltas.push(delta),
        onEvent: (event) => output.push(event) });
      assert.equal(first.text, "Hello world"); assert.equal(deltas.join(""), first.text);
      assert.ok(output.some((event) => event.type === "item.upsert" && event.item.type === "assistant_message" && event.item.text === first.text));
      assert.equal(first.nativeSession?.sessionId, "ses_1"); assert.equal(first.nativeSession?.cwd, f.context.cwd);
      const create = f.requests.find((request) => request.method === "POST" && request.path === (generation === "v2" ? "/api/session" : "/session")); assert.ok(create);
      if (generation === "v2") assert.deepEqual(create.body.model, { providerID: "native-api", id: "model/one" });
      const resumed = await opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "again", resume: first.nativeSession });
      assert.equal(resumed.text, "Hello world");
      assert.equal(f.requests.filter((request) => request.method === "POST" && request.path === create.path).length, 1);
      await assert.rejects(opencodeAdapter.run({ ...f.context, cwd: "/wrong" }, { model: "native-api/model/one", prompt: "bad", resume: first.nativeSession }), /different provider instance, revision or working directory/);
    } finally { await f.close(); }
  });
  test(`OpenCode ${generation} reports cumulative disjoint native step usage and propagates consumer errors`, async () => {
    const f = await fixture(generation, "usage");
    try {
      const updates: NativeUsageUpdate[] = [];
      const result = await opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "hello", onUsage: (update) => updates.push(update) });
      assert.equal(result.text, "Hello world");
      assert.deepEqual(updates, [
        { turn: { model: "native-api/model/one", costUsd: 0.01, totals: { uncachedInputTokens: 10, cachedInputTokens: 6, cacheCreationTokens: 3, outputTokens: 6, reasoningTokens: 2 } }, reportedTurn: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 6, cacheCreationTokens: 3, reasoningTokens: 2 } },
        { turn: { model: "native-api/model/one", costUsd: 0.03, totals: { uncachedInputTokens: 17, cachedInputTokens: 8, cacheCreationTokens: 4, outputTokens: 10, reasoningTokens: 3 } }, reportedTurn: { inputTokens: 17, outputTokens: 7, cachedInputTokens: 8, cacheCreationTokens: 4, reasoningTokens: 3 } },
      ]);
      const failure = new Error("usage consumer failed");
      await assert.rejects(opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "hello", onUsage: () => { throw failure; } }), (error) => error === failure);
    } finally { await f.close(); }
  });
  test(`OpenCode ${generation} reports cumulative partial native counters without duplicate steps`, async () => {
    const f = await fixture(generation, "usage-partial");
    try {
      const updates: NativeUsageUpdate[] = [];
      await opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "hello", onUsage: (update) => updates.push(update) });
      assert.deepEqual(updates, [
        { reportedTurn: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 6 } },
        { reportedTurn: { inputTokens: 17, outputTokens: 7, cachedInputTokens: 8 } },
      ]);
    } finally { await f.close(); }
  });


  test(`OpenCode ${generation} keeps owned child output separate from the root reply`, async () => {
    const f = await fixture(generation, "subagent");
    try {
      const events: NativeOutputEvent[] = [];
      const chunks: string[] = [];
      const result = await opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "delegate",
        onEvent: (event) => events.push(event), onText: (chunk) => chunks.push(chunk) });
      assert.equal(result.text, "Hello world");
      assert.equal(chunks.join(""), "Hello world");
      assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "subagent" && event.item.childSessionId === "ses_child"));
      assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "assistant_message" &&
        event.item.text === "child output" && event.item.parentItemId));
    } finally { await f.close(); }
  });

  test(`OpenCode ${generation} sends validated information answers to the native question API`, async () => {
    const f = await fixture(generation, "question");
    try {
      const events: NativeOutputEvent[] = [];
      const result = await opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "ask",
        onEvent: (event) => events.push(event),
        onRequest: async (request) => {
          assert.equal(request.kind, "user_input");
          assert.equal(request.respondable, true);
          assert.equal(request.questions?.[0]?.prompt, "Pick a color");
          return { answers: { [generation === "v2" ? "color" : "q0"]: generation === "v2" ? "blue" : "Blue" } };
        },
      });
      assert.equal(result.text, "Hello world");
      const reply = f.requests.find((request) => request.path.includes(generation === "v2" ? "/form/frm_1/reply" : "/question/que_1/reply"));
      assert.deepEqual(reply?.body, generation === "v2" ? { answer: { color: "blue" } } : { answers: [["Blue"]] });
      assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "completed" && event.item.request?.respondable === false));
    } finally { await f.close(); }
  });

  test(`OpenCode ${generation} rejects cancelled or invalid information responses`, async () => {
    for (const invalid of [false, true]) {
      const f = await fixture(generation, "question");
      try {
        const run = opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "ask",
          onRequest: async () => invalid ? { answers: { [generation === "v2" ? "color" : "q0"]: "not offered" } } : { cancelled: true } });
        if (invalid) await assert.rejects(run, /Invalid OpenCode question answer/);
        else await run;
        await f.questionRejected;
        assert.ok(f.requests.some((request) => generation === "v2"
          ? request.method === "DELETE" && request.path.endsWith("/form/frm_1")
          : request.path.endsWith("/question/que_1/reject")));
        assert.equal(f.requests.some((request) => request.path.endsWith(generation === "v2" ? "/form/frm_1/reply" : "/question/que_1/reply")), false);
      } finally { await f.close(); }
    }
  });

  test(`OpenCode ${generation} observes native question closure while awaiting a response`, async () => {
    const f = await fixture(generation, "question-external");
    const pending = Promise.withResolvers<{ answers: Record<string, string> }>();
    try {
      const events: NativeOutputEvent[] = [];
      const result = await opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "ask",
        onRequest: () => pending.promise,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "cancelled")
            pending.reject(new Error("native request closed"));
        } });
      assert.equal(result.text, "Hello world");
      assert.ok(events.some((event) => event.type === "item.upsert" && event.item.type === "user_input_request" && event.item.status === "cancelled" && event.item.request?.respondable === false));
      assert.equal(f.requests.some((request) => request.path.includes("/question/") || request.path.includes("/form/")), false);
    } finally { await f.close(); }
  });


  test(`OpenCode ${generation} propagates structured output callback errors`, async () => {
    const f = await fixture(generation);
    try {
      await assert.rejects(opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "hello",
        onEvent: () => { throw new Error("output callback failed"); } }), /output callback failed/);
    } finally { await f.close(); }
  });
  for (const scenario of ["disconnect", "error", "approval", "form", "rejected-stream"] as const) {
    test(`OpenCode ${generation} never treats partial output as success after ${scenario}`, async () => {
      const f = await fixture(generation, scenario);
      try {
        const events: NativeOutputEvent[] = [];
        await assert.rejects(opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "test", onEvent: (event) => events.push(event) }), (error: unknown) => {
          assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /must-not-leak-token|密碼-password/); return true;
        });
        assert.ok(f.requests.some((request) => request.path.endsWith(generation === "v2" ? "/interrupt" : "/abort")));
        if (scenario === "rejected-stream") assert.equal(f.requests.some((request) => request.path.endsWith("/prompt") || request.path.endsWith("/prompt_async")), false);
        if (scenario === "approval") assert.equal(f.requests.find((request) => request.path.endsWith("/reply"))?.body[generation === "v2" ? "decision" : "reply"], "reject");
        if (scenario === "form" && generation === "v2") assert.ok(f.requests.some((request) => request.method === "DELETE" && request.path.endsWith("/form/frm_1")));
        if (scenario === "approval" || scenario === "form") assert.ok(events.some((event) =>
          event.type === "item.upsert" && event.item.type === (scenario === "approval" ? "approval_request" : "user_input_request") &&
          event.item.request?.respondable === false));
      } finally { await f.close(); }
    });
  }

  test(`OpenCode ${generation} cancellation sends the native session interrupt without stopping the external server`, async () => {
    const f = await fixture(generation, "wait");
    try {
      const controller = new AbortController();
      const run = opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "wait", signal: controller.signal });
      await f.prompted; controller.abort();
      await assert.rejects(run, (error: unknown) => error instanceof Error && error.name === "AbortError");
      assert.ok(f.requests.some((request) => request.path.endsWith(generation === "v2" ? "/interrupt" : "/abort")));
      assert.equal((await opencodeAdapter.check(f.context)).installation.status, "installed");
    } finally { await f.close(); }
  });

  test(`OpenCode ${generation} does not steal an already-active remote session`, async () => {
    const f = await fixture(generation, "busy");
    try {
      await assert.rejects(opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "do not enqueue",
        resume: { providerInstanceId: f.context.instanceId, driver: "opencode", sessionId: "ses_1", cwd: f.context.cwd, instanceRevision: f.context.revision },
      }), /already active in another client/);
      assert.equal(f.requests.some((request) => request.method !== "GET"), false);
    } finally { await f.close(); }
  });

  test(`OpenCode ${generation} rejects overlapping turns in an owned native session`, async () => {
    const f = await fixture(generation, "wait");
    const controller = new AbortController();
    let nativeSession: NativeSessionRef | undefined;
    const first = opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "wait", signal: controller.signal,
      onSession: (ref) => { nativeSession = ref; } });
    try {
      await f.prompted;
      assert.ok(nativeSession);
      const before = f.requests.length;
      await assert.rejects(opencodeAdapter.run(f.context, { model: "native-api/model/one", prompt: "overlap", resume: nativeSession }), /already has an active turn/);
      assert.equal(f.requests.length, before);
    } finally {
      controller.abort();
      await assert.rejects(first, (error: unknown) => error instanceof Error && error.name === "AbortError");
      await f.close();
    }
  });
}

test("OpenCode 1.x native OAuth collects provider prompts and an authorization code", async () => {
  const f = await fixture("v1");
  try {
    const updates: unknown[] = [];
    const options = authOptions("native-api:1", { account: "work" }, [JSON.stringify({ code: "auth-code" })]);
    options.onUpdate = (update) => updates.push(update);
    await opencodeAdapter.authenticate(f.context, options);
    assert.equal(f.authorized, true);
    assert.deepEqual(f.requests.find((request) => request.path.endsWith("/oauth/authorize"))?.body, { method: 1, inputs: { account: "work" } });
    assert.match(JSON.stringify(updates), /auth\.example\.test/);
    assert.doesNotMatch(JSON.stringify(updates), /auth-code/);
  } finally { await f.close(); }
});

test("OpenCode 2.x supports source-native OAuth, external and command methods", async () => {
  const f = await fixture("v2");
  try {
    for (const method of ["browser", "external", "command"]) await opencodeAdapter.authenticate(f.context, authOptions(`native-api:${method}`));
    assert.equal(f.authorized, true); assert.equal(f.oauthPolls, 2);
    assert.ok(f.requests.some((request) => request.path.endsWith("/connect/command")));
  } finally { await f.close(); }
});

test("OpenCode rejects incorrect remote passwords with redacted status and never spawns the binary", async () => {
  const f = await fixture("v2");
  try {
    const result = await opencodeAdapter.check({ ...f.context, config: { ...f.context.config, serverPassword: "wrong-secret" } });
    assert.equal(result.authentication, "unauthenticated");
    assert.equal(result.installation.status, "installed");
    assert.doesNotMatch(JSON.stringify(result), /密碼-password|wrong-secret|secret-that-must-not-leak/);
  } finally { await f.close(); }
});

test("OpenCode environment isolates every native XDG home", () => {
  const env = openCodeEnvironment({ instanceId: "test", driver: "opencode", revision: 1, config: {}, cwd: "/cwd", homeDirectory: "/dedicated", env: { HOME: "/global", XDG_DATA_HOME: "/global-data" } });
  assert.equal(env.HOME, "/dedicated"); assert.equal(env.XDG_DATA_HOME, "/dedicated/.local/share");
  assert.equal(env.XDG_CONFIG_HOME, "/dedicated/.config"); assert.equal(env.OPENCODE_CONFIG_CONTENT, "{}");
});

test("OpenCode SSE accepts fragmented UTF-8 and CRLF frames without declaring EOF success", async () => {
  const bytes = new TextEncoder().encode('data: {"type":"hello","text":"你好"}\r\n\r\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = openCodeEvents(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  assert.deepEqual((await events.next()).value, { type: "hello", text: "你好" });
  await assert.rejects(events.next(), /ended before the turn completed/);
});

for (const generation of ["v1", "v2"] as const) {
  test(`OpenCode ${generation} blank URL owns and stops only its spawned server with exact cwd and isolated homes`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-native-"));
    const binary = path.join(directory, "opencode-fixture");
    const recordPath = path.join(directory, "spawn.json");
    const version = generation === "v2" ? "2.0.28" : "1.14.19";
    await writeFile(binary, `#!${process.execPath}\nconst http = require('node:http'); const fs = require('node:fs');\nif (process.argv.includes('--version')) { console.log('${version}'); process.exit(0); }\nconst port = Number(process.argv.find(x => x.startsWith('--port=')).split('=')[1]);\nfs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({pid:process.pid,cwd:process.cwd(),home:process.env.HOME,data:process.env.XDG_DATA_HOME,password:process.env.${generation === "v2" ? "OPENCODE_PASSWORD" : "OPENCODE_SERVER_PASSWORD"},wrongPassword:process.env.${generation === "v2" ? "OPENCODE_SERVER_PASSWORD" : "OPENCODE_PASSWORD"}}));\nconst server = http.createServer((req,res) => { const url = new URL(req.url,'http://localhost'); const send = value => {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};\nif(url.pathname === '/api/info') { ${generation === "v2" ? `send({version:'${version}',pid:process.pid});` : `res.writeHead(200,{'content-type':'text/html'});res.end('<html>SPA</html>');`} return; }\nif(url.pathname === '/global/health') {send({version:'${version}',healthy:true});return;}\nif(url.pathname === '/provider') {send({all:[{id:'native',name:'Native',models:{m:{id:'m',name:'Model'}}}],connected:['native']});return;}\nif(url.pathname === '/provider/auth') {send({native:[{type:'api',label:'Key'}]});return;}\nif(url.pathname === '/api/model') {send({data:[{id:'m',providerID:'native',name:'Model',variants:[]}]});return;}\nif(url.pathname === '/api/integration') {send({data:[]});return;} res.writeHead(404);res.end();\n});server.listen(port,'127.0.0.1',()=>console.log('OpenCode server listening on http://127.0.0.1:'+port));\n`);
    await chmod(binary, 0o700);
    try {
      const context: ProviderDriverContext = { instanceId: "local", driver: "opencode", revision: 1, cwd: directory, homeDirectory: path.join(directory, "private-home"), config: { binaryPath: binary, serverUrl: "" },
        env: { PATH: process.env.PATH, OPENCODE_SERVER_PASSWORD: "ambient-password", OPENCODE_PASSWORD: "ambient-other-password" } };
      const status = await opencodeAdapter.check(context);
      assert.equal(status.installation.status, "installed");
      assert.deepEqual(status.models.map((model) => model.id), ["native/m"]);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      assert.equal(record.cwd, directory); assert.equal(record.home, context.homeDirectory);
      assert.equal(record.data, path.join(context.homeDirectory, ".local/share"));
      assert.equal(record.wrongPassword, undefined);
      assert.ok(record.password && !record.password.includes("ambient"));
      assert.throws(() => process.kill(record.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("OpenCode identity probing rejects a successful HTML-only SPA", async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<html>Not OpenCode</html>"); });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try { await assert.rejects(new OpenCodeConnection(`http://127.0.0.1:${address.port}`, "", "/cwd").probe(), /did not identify itself/); }
  finally { server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; }
});

test("OpenCode never borrows an unrelated listener announced by a failed owned startup", async () => {
  const unrelated = await fixture("v2");
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-wrong-address-"));
  const binary = path.join(directory, "opencode-fixture");
  const pidPath = path.join(directory, "pid");
  await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--version')){console.log('2.0.28');process.exit(0);}fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));console.log('OpenCode server listening on '+${JSON.stringify(unrelated.context.config.serverUrl)});require('node:net').createServer().listen(0,'127.0.0.1');\n`);
  await chmod(binary, 0o700);
  try {
    const status = await opencodeAdapter.check({
      ...unrelated.context, cwd: directory, homeDirectory: path.join(directory, "home"),
      config: { binaryPath: binary, serverUrl: "" }, env: { PATH: process.env.PATH },
    });
    assert.match(status.message ?? "", /unexpected server address/);
    assert.equal(unrelated.requests.length, 0);
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    assert.equal((await opencodeAdapter.check(unrelated.context)).installation.status, "installed");
  } finally { await unrelated.close(); await rm(directory, { recursive: true, force: true }); }
});
