import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";

/**
 * T8 wire contract, independent of the driver and its event/schema constructors.
 * Both real upstream SDKs talk HTTP/SSE to this server. ADD a b computes a sum;
 * ACCUMULATE n reads the previous native turn's committed sum. No prompt echo or
 * preselected answer is accepted. Native state, pending requests, transcript,
 * event IDs and subscription-before-work are enforced here, not in the client.
 * Control methods belong to the test controller, never to the provider API.
 */
export type OpenCodeGeneration = "v1" | "v2";
export type OpenCodeScenario = "complete" | "hold" | "disconnect" | "payment" | "authentication" | "quota" | "interrupted" | "question" | "multi-question" | "secret" | "unsupported-form" | "permission" | "child" | "output" | "usage" | "usage-hold" | "usage-partial";
export type WireRequest = { method: string; path: string; url: URL; body: Record<string, unknown>; directory?: string };
export interface OpenCodeProtocolFixture {
  readonly generation: OpenCodeGeneration;
  readonly password: string;
  readonly version: string;
  readonly url: string;
  readonly requests: WireRequest[];
  readonly prompts: Array<{ sessionId: string; text: string; total: number; messageId: string; agent: string }>;
  readonly violations: string[];
  readonly prompted: Promise<void>;
  readonly rejected: Promise<void>;
  readonly subscriptions: number;
  readonly liveStreams: number;
  readonly connectedMcpServers: number;
  finish(): void;
  closeQuestion(): void;
  changeNativeCwd(directory: string): void;
  assertClean(): void;
  close(): Promise<void>;
}
type NativeSession = {
  id: string; directory: string; title: string; permissions: unknown[]; agent: string; model: unknown;
  state: "idle" | "running" | "waiting"; total?: number; pending?: string; promptId?: string;
  answerId?: string; result?: string; history: Array<Record<string, unknown>>; parentID?: string;
};
const nativeTokens = { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 3 } };
const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const model = {
  id: "model/one", modelID: "model/one", providerID: "native-api", name: "Arithmetic native model",
  package: "@opencode/ai/providers/openai-compatible", settings: {}, compatibility: {},
  capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "low" }, { id: "high" }],
  time: { released: 1789516800000 }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active", enabled: true, limit: { context: 100000, output: 4096 },
};

export async function createOpenCodeProtocolFixture(options: {
  generation: OpenCodeGeneration; cwd: string; scenario?: OpenCodeScenario; version?: string;
  password?: string; rejectStream?: boolean; htmlOnly?: boolean; port?: number; rejectMcp?: boolean; externalBusy?: boolean;
}): Promise<OpenCodeProtocolFixture> {
  const generation = options.generation;
  const password = options.password ?? "päss-密碼-fixture";
  const version = options.version ?? (generation === "v1" ? "1.18.32" : "2.1.2");
  const scenario = options.scenario ?? "complete";
  const requests: WireRequest[] = [];
  const violations: string[] = [];
  const streams = new Set<ServerResponse>();
  const sessions = new Map<string, NativeSession>();
  if (options.externalBusy) sessions.set("ses_external", { id: "ses_external", directory: options.cwd, title: "Owned by another client",
    permissions: [], agent: "build", model: { providerID: "native-api", id: "model/one" }, state: "running", history: [] });
  const mcp = new Map<string, { connected: boolean; directory: string; config: Record<string, unknown> }>();
  const prompts: Array<{ sessionId: string; text: string; total: number; messageId: string; agent: string }> = [];
  const totalsByMessage = new Map<string, number>();
  const prompted = Promise.withResolvers<void>();
  const rejected = Promise.withResolvers<void>();
  let nextId = 0;
  let eventId = 0;
  let subscriptions = 0;
  let disconnected = false;
  const seq = new Map<string, number>();
  const root = generation === "v2" ? "/api/session" : "/session";
  const envelope = (type: string, data: Record<string, unknown>, id?: string) => {
    if (generation === "v1") return { type, properties: data };
    const sessionId = String(data.sessionID ?? "global");
    const n = (seq.get(sessionId) ?? 0) + 1;
    const ephemeral = /\.(?:delta|progress)$/.test(type) || /^(?:form|permission)\./.test(type);
    if (!ephemeral) seq.set(sessionId, n);
    return { id: id ?? `evt_fixture_${++eventId}`, type, data, created: Date.now(),
      ...(!ephemeral ? { durable: { aggregateID: sessionId, seq: n, version: type === "session.tool.success" ? 2 : 1 } } : {}) };
  };
  const broadcast = (payload: unknown) => {
    const bytes = Buffer.from(`data: ${JSON.stringify(payload)}\r\n\r\n`, "utf8");
    // Split a multibyte character and frame delimiters across writes too.
    const split = Math.max(1, bytes.indexOf(Buffer.from("計")) + 1);
    for (const stream of streams) { stream.write(bytes.subarray(0, split)); stream.write(bytes.subarray(split, bytes.length - 1)); stream.write(bytes.subarray(bytes.length - 1)); }
  };
  const emit = (type: string, data: Record<string, unknown>, duplicate = false) => {
    const payload = envelope(type, data);
    broadcast(payload);
    if (duplicate) broadcast(payload);
  };
  const info = (s: NativeSession) => generation === "v2"
    ? { id: s.id, ...(s.parentID ? { parentID: s.parentID } : {}), projectID: "prj_fixture", agent: s.agent,
      model: s.model, cost: 0, tokens: emptyTokens, title: s.title, location: { directory: s.directory },
      time: { created: 1780000000000, updated: 1780000000001, ...(s.state === "idle" ? { idle: 1780000000001 } : {}) }, permissions: s.permissions }
    : { id: s.id, ...(s.parentID ? { parentID: s.parentID } : {}), projectID: "prj_fixture", directory: s.directory,
      title: s.title, slug: "arithmetic", version, time: { created: 1780000000000, updated: 1780000000001 }, permission: s.permissions };
  function text(s: NativeSession, value: string, duplicate = true) {
    const messageId = s.answerId!;
    if (generation === "v2") {
      emit("session.text.started", { sessionID: s.id, assistantMessageID: messageId, ordinal: 0 });
      emit("session.text.delta", { sessionID: s.id, assistantMessageID: messageId, ordinal: 0, delta: value.slice(0, 2) }, duplicate);
      emit("session.text.ended", { sessionID: s.id, assistantMessageID: messageId, ordinal: 0, text: value }, duplicate);
    } else {
      const assistant = { id: messageId, sessionID: s.id, role: "assistant", parentID: s.promptId,
        time: { created: Date.now() }, modelID: "model/one", providerID: "native-api", mode: s.agent, agent: s.agent,
        path: { cwd: s.directory, root: s.directory }, cost: 0, tokens: emptyTokens };
      emit("message.updated", { sessionID: s.id, info: assistant });
      const part = { id: `prt_${messageId}`, sessionID: s.id, messageID: messageId, type: "text", text: value, time: { start: Date.now(), end: Date.now() } };
      emit("message.part.updated", { part }, duplicate);
      s.history.push({ info: assistant, parts: [part] });
    }
  }
  function terminal(s: NativeSession, outcome: "completed" | "interrupted" = "completed") {
    if (s.state === "idle") return;
    s.state = "idle";
    s.pending = undefined;
    if (generation === "v2") {
      if (outcome === "completed") s.history.push({ id: s.answerId, type: "assistant", agent: s.agent,
        model: s.model, content: [{ type: "text", text: s.result ?? "" }], finish: "stop",
        time: { created: Date.now(), completed: Date.now() }, cost: 0, tokens: emptyTokens });
      s.history.push({ id: `msg_idle_${++nextId}`, type: "idle",
        outcome: outcome === "completed" ? "succeeded" : "interrupted", time: { created: Date.now() } });
      emit(outcome === "completed" ? "session.execution.succeeded" : "session.execution.interrupted",
        { sessionID: s.id, ...(outcome === "interrupted" ? { reason: "user" } : {}) }, true);
    } else {
      if (outcome === "interrupted") emit("session.error", { sessionID: s.id, error: { name: "MessageAbortedError", data: { message: "Interrupted" } } });
      const assistant = { id: s.answerId, sessionID: s.id, role: "assistant", parentID: s.promptId,
        time: { created: Date.now(), completed: Date.now() }, finish: "stop", modelID: "model/one", providerID: "native-api",
        mode: s.agent, agent: s.agent, path: { cwd: s.directory, root: s.directory }, cost: 0, tokens: emptyTokens,
        ...(outcome === "interrupted" ? { error: { name: "MessageAbortedError", data: { message: "Interrupted" } } } : {}) };
      const entry = s.history.find(entry => entry.info && typeof entry.info === "object" && "id" in entry.info && entry.info.id === s.answerId);
      if (entry) entry.info = assistant;
      emit("message.updated", { sessionID: s.id, info: assistant });
      emit("session.status", { sessionID: s.id, status: { type: "idle" } }, true);
    }
  }
  function usage(s: NativeSession, partial: boolean) {
    const second = { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 1 } };
    // A partial RUN has a fully schema-valid observed step followed by interruption.
    // Missing required v2 token fields were an invalid old handwritten wire fixture.
    for (const [index, tokens] of (partial ? [nativeTokens] : [nativeTokens, second]).entries()) {
      if (generation === "v2") emit("session.step.ended", { sessionID: s.id, assistantMessageID: s.answerId,
        finish: "stop", tokens, cost: index ? 0.02 : 0.01 }, true);
      else emit("message.part.updated", { part: { id: `step_${s.promptId}_${index}`, sessionID: s.id, messageID: s.answerId,
        type: "step-finish", reason: "stop", tokens, cost: index ? 0.02 : 0.01 } }, true);
    }
  }
  function tool(s: NativeSession, id: string, name: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}, output = "ok") {
    if (generation === "v2") {
      const base = { sessionID: s.id, assistantMessageID: s.answerId, id };
      emit("session.tool.input.started", { ...base, name });
      emit("session.tool.called", { ...base, input, executed: true });
      emit("session.tool.progress", { ...base, metadata });
      emit("session.tool.success", { ...base, content: [{ type: "text", text: output }], metadata, executed: true }, true);
    } else {
      const base = { id: `prt_${id}`, sessionID: s.id, messageID: s.answerId, type: "tool", tool: name, callID: id };
      emit("message.part.updated", { part: { ...base, state: { status: "running", input, metadata, time: { start: Date.now() } } } });
      emit("message.part.updated", { part: { ...base, state: { status: "completed", input, output, metadata, time: { start: Date.now(), end: Date.now() } } } }, true);
    }
  }
  function question(s: NativeSession) {
    s.state = "waiting";
    s.pending = generation === "v2" ? "frm_fixture" : "que_fixture";
    if (generation === "v2") {
      const fields = scenario === "unsupported-form" ? [{ key: "url", type: "external", url: "https://example.test" }]
        : scenario === "multi-question" ? [{ key: "colors", type: "multiselect", title: "Colors", options: [{ value: "blue", label: "Blue" }, { value: "red", label: "Red" }], minItems: 1, maxItems: 2 }]
        : [{ key: "color", type: "string", title: "Color", description: "Choose a color; password is ordinary text here", options: [{ value: "blue", label: "Blue" }, { value: "red", label: "Red" }], custom: false }];
      emit("form.created", { form: { id: s.pending, sessionID: s.id, title: "Color",
        metadata: { kind: scenario === "secret" ? "authentication" : "question" }, fields } }, true);
    } else emit("question.asked", { id: s.pending, sessionID: s.id, questions: [
      { header: "Color", question: "Choose a color; password is ordinary text here", options: [{ label: "Blue", description: "Blue" }, { label: "Red", description: "Red" }], custom: false, multiple: scenario === "multi-question" },
      ...(scenario === "multi-question" ? [{ header: "Notes", question: "Add notes", options: [], custom: true }] : []),
    ] }, true);
  }
  function child(s: NativeSession) {
    const c: NativeSession = { ...s, id: "ses_child", answerId: "msg_child_answer", promptId: "msg_child_prompt", parentID: s.id,
      agent: "explore", result: "child arithmetic=5", history: [], state: "running" };
    sessions.set(c.id, c);
    if (generation === "v2") emit("session.created", { sessionID: c.id, parentID: s.id, projectID: "prj_fixture", location: { directory: c.directory }, slug: "child", version });
    else emit("session.created", { info: info(c) });
    const input = { prompt: "independent child", subagent_type: "explore", agent: "explore" };
    const metadata = generation === "v2" ? { sessionID: c.id } : { sessionId: c.id };
    const call = { sessionID: s.id, assistantMessageID: s.answerId, id: "call_child" };
    const part = { id: "prt_child_call", sessionID: s.id, messageID: s.answerId, type: "tool", tool: "task", callID: "call_child" };
    if (generation === "v2") {
      emit("session.tool.input.started", { ...call, name: "subagent" });
      emit("session.tool.called", { ...call, input, executed: true });
      emit("session.tool.progress", { ...call, metadata });
    } else emit("message.part.updated", { part: { ...part, state: { status: "running", input, metadata, time: { start: Date.now() } } } });
    if (generation === "v2") emit("session.execution.started", { sessionID: c.id });
    else emit("message.updated", { sessionID: c.id, info: { id: c.promptId, role: "user", sessionID: c.id,
      agent: c.agent, model: c.model, time: { created: Date.now() } } });
    text(c, "child arithmetic=5");
    terminal(c);
    if (generation === "v2") emit("session.tool.success", { ...call, content: [{ type: "text", text: "child arithmetic=5" }], metadata, executed: true }, true);
    else emit("message.part.updated", { part: { ...part, state: { status: "completed", input, metadata, output: "child arithmetic=5", time: { start: Date.now(), end: Date.now() } } } }, true);
  }
  function output(s: NativeSession) {
    if (generation === "v2") {
      emit("session.reasoning.ended", { sessionID: s.id, assistantMessageID: s.answerId, ordinal: 0, text: "Compute, do not echo" });
      tool(s, "call_shell", "shell", { command: "printf arithmetic" }, { output: "arithmetic\n", exit: 0 }, "arithmetic\n");
    } else {
      emit("message.part.updated", { part: { id: "prt_reason", sessionID: s.id, messageID: s.answerId, type: "reasoning", text: "Compute, do not echo", time: { start: Date.now(), end: Date.now() } } });
      const command = { id: "prt_shell_call", sessionID: s.id, messageID: s.answerId, type: "tool", tool: "bash", callID: "call_shell" };
      for (const output of ["arith", "arithm"]) emit("message.part.updated", { part: { ...command,
        state: { status: "running", input: { command: "printf arithmetic" }, metadata: { output }, time: { start: Date.now() } } } });
      emit("message.part.updated", { part: { ...command, state: { status: "completed", input: { command: "printf arithmetic" },
        output: "arithmetic\n", metadata: { exit: 0 }, time: { start: Date.now(), end: Date.now() } } } }, true);
    }
    tool(s, "call_edit", "edit", { filePath: "answer.txt", oldString: "before", newString: "after" }, { diff: "-before\n+after" });
    tool(s, "call_search", "glob", { pattern: "*.ts", path: "src" }, {}, "src/a.ts");
    if (generation === "v1") emit("todo.updated", { sessionID: s.id, todos: [{ content: "compute", status: "completed", priority: "high" }] }, true);
    tool(s, "call_plan", "todowrite", { todos: [{ content: "compute", status: "completed", priority: "high" }] });
  }
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const empty = () => { response.writeHead(204); response.end(); };
    const violation = (message: string, status = 409) => { violations.push(message); json({ _tag: "ConflictError", message }, status); };
    try {
      const url = new URL(request.url!, "http://127.0.0.1");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
      const rawDirectory = request.headers["x-opencode-directory"];
      const directoryHeader = typeof rawDirectory === "string" ? decodeURIComponent(rawDirectory) : undefined;
      requests.push({ method: request.method!, path: url.pathname, url, body, directory: directoryHeader });
      const expectedAuthorization = password ? `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}` : undefined;
      if (request.headers.authorization !== expectedAuthorization) {
        json({ _tag: "UnauthorizedError", message: "secret-that-must-not-leak" }, 401); return;
      }
      if (options.htmlOnly) { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><html>unrelated SPA</html>"); return; }
      if (url.pathname === "/api/info") {
        if (generation === "v2") json({ version, pid: process.pid, urls: [], paths: { tmp: "/tmp/fixture" } });
        else { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html>SPA"); }
        return;
      }
      if (url.pathname === "/global/health") { json({ healthy: true, version }); return; }
      if (generation === "v1" && (url.searchParams.get("directory") ?? directoryHeader) !== options.cwd)
        return violation("The native SDK request lost its trusted directory");
      if (generation === "v2" && ["/api/model", "/api/provider", "/api/agent", "/api/command", "/api/skill", "/api/mcp"].includes(url.pathname)
        && url.searchParams.get("location[directory]") !== options.cwd) return violation("The native client inventory request lost its trusted location");
      if (url.pathname === (generation === "v2" ? "/api/event" : "/event")) {
        if (options.rejectStream || disconnected) { json({ _tag: "ServiceUnavailableError", message: "Stream unavailable" }, 503); return; }
        subscriptions++;
        response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
        streams.add(response); response.once("close", () => streams.delete(response));
        response.write(`data: ${JSON.stringify(generation === "v2" ? { id: `evt_connected_${subscriptions}`, type: "server.connected", data: {} } : { type: "server.connected", properties: {} })}\n\n`);
        return;
      }
      if (url.pathname === "/provider") { json({ all: [{ id: "native-api", name: "Arithmetic", source: "api", models: { "model/one": { id: "model/one", name: "Arithmetic native model", temperature: true, reasoning: true, variants: { low: {}, high: {} }, limit: model.limit } } }, { id: "disconnected", name: "Unavailable", models: { other: { id: "other", name: "other" } } }], connected: ["native-api"], default: {} }); return; }
      if (url.pathname === "/api/model") { json({ location: { directory: options.cwd }, data: [model] }); return; }
      if (url.pathname === "/api/provider") { json({ location: { directory: options.cwd }, data: [{ id: "native-api", integrationID: "native-api", name: "Arithmetic", activation: "enabled", package: model.package, settings: {} }] }); return; }
      if (["/agent", "/api/agent"].includes(url.pathname)) {
        const agents = ["build", "plan", "explore"].map(id => generation === "v2" ? { id, name: id, request: { settings: {}, headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] } : { name: id, mode: "primary", hidden: false, permission: {} });
        json(generation === "v2" ? { location: { directory: options.cwd }, data: agents } : agents); return;
      }
      if (["/command", "/skill", "/api/command", "/api/skill"].includes(url.pathname)) { json(generation === "v2" ? { location: { directory: options.cwd }, data: [] } : []); return; }
      if (url.pathname === (generation === "v2" ? `${root}/active` : `${root}/status`)) {
        const active = Object.fromEntries([...sessions].filter(([, s]) => s.state !== "idle").map(([id]) => [id, { type: generation === "v2" ? "running" : "busy" }]));
        json(generation === "v2" ? { data: active } : active); return;
      }
      if (url.pathname === root && request.method === "POST") {
        if (!streams.size) return violation("Session creation before event subscription");
        if (generation === "v2") {
          const location = body.location;
          if (!location || typeof location !== "object" || !("directory" in location) || location.directory !== options.cwd)
            return violation("Native session must be created in the trusted directory");
        }
        const s: NativeSession = { id: `ses_fixture_${++nextId}`, directory: options.cwd, title: String(body.title ?? "Arithmetic"),
          permissions: (body[generation === "v2" ? "permissions" : "permission"] as unknown[]) ?? [], agent: "build",
          model: body.model ?? { providerID: "native-api", id: "model/one" }, state: "idle", history: [] };
        sessions.set(s.id, s); json(generation === "v2" ? { data: info(s) } : info(s)); return;
      }
      if ((url.pathname === "/mcp" && request.method === "POST") || /^\/api\/experimental\/mcp\/[^/]+$/.test(url.pathname) && request.method === "PUT") {
        const name = generation === "v2" ? decodeURIComponent(url.pathname.split("/").at(-1)!) : String(body.name);
        const directory = generation === "v2" ? url.searchParams.get("location[directory]") : url.searchParams.get("directory") ?? directoryHeader;
        const config = body.config as Record<string, unknown>;
        if (directory !== options.cwd || config?.type !== "local" || !Array.isArray(config.command) || config.command.at(-1) !== "mcp")
          return violation("Host transport must be a scoped local MCP command");
        if (mcp.has(name)) return violation("Host transport identity was reused");
        mcp.set(name, { connected: !options.rejectMcp, directory: options.cwd, config });
        if (generation === "v2") empty();
        else json({ [name]: options.rejectMcp ? { status: "failed", error: "Controlled transport refusal" } : { status: "connected" } });
        return;
      }
      if ((url.pathname === "/mcp" || url.pathname === "/api/mcp") && request.method === "GET") {
        if (generation === "v2") json({ location: { directory: options.cwd }, data: [...mcp].map(([name, state]) => ({
          name, status: state.connected ? { status: "connected" } : { status: "failed", error: "Controlled transport refusal" },
        })) });
        else json(Object.fromEntries([...mcp].map(([name, state]) => [name, { status: state.connected ? "connected" : "disconnected" }])));
        return;
      }
      if (/^\/mcp\/[^/]+\/disconnect$/.test(url.pathname) || /^\/api\/experimental\/mcp\/[^/]+$/.test(url.pathname) && request.method === "DELETE") {
        const name = decodeURIComponent(generation === "v2" ? url.pathname.split("/").at(-1)! : url.pathname.split("/")[2]!);
        if (!mcp.delete(name)) return violation("Unknown or already-released generation transport");
        if (generation === "v2") empty(); else json(true); return;
      }
      if (/^\/api\/experimental\/session\/[^/]+\/instructions\/entries\//.test(url.pathname)) { empty(); return; }
      const match = new RegExp(`^${root}/([^/]+)(/.*)?$`).exec(url.pathname);
      const s = match ? sessions.get(match[1]!) : undefined;
      const suffix = match?.[2] ?? "";
      if (s && suffix === "" && request.method === "GET") { json(generation === "v2" ? { data: info(s) } : info(s)); return; }
      if (s && suffix === "" && request.method === "PATCH") {
        if (body.title) s.title = String(body.title);
        const permissions = body[generation === "v2" ? "permissions" : "permission"];
        if (Array.isArray(permissions)) s.permissions = permissions;
        if (generation === "v2") empty(); else json(info(s)); return;
      }
      if (s && suffix === "/agent") { s.agent = String(body.agent); empty(); return; }
      if (s && suffix === "/model") { s.model = body.model; empty(); return; }
      if (s && suffix === "/move") return violation("Native cwd must be verified, never moved to hide a mismatch");
      if (s && ["/children", "/permission", "/form"].includes(suffix)) { json(generation === "v2" ? { data: [] } : []); return; }
      if ((s && suffix === "/message") || url.pathname === "/api/message") {
        const owner = s ?? sessions.get(url.searchParams.get("sessionID") ?? "");
        const history = url.searchParams.get("order") === "desc" ? [...(owner?.history ?? [])].reverse() : owner?.history ?? [];
        const limit = Number(url.searchParams.get("limit") ?? history.length);
        json(generation === "v2" ? { data: history.slice(0, limit), cursor: {} } : history); return;
      }
      if (s && suffix === "/fork" && request.method === "POST") {
        if (s.state !== "idle") return violation("Cannot fork active native history");
        const before = body[generation === "v2" ? "before" : "messageID"];
        const index = before === undefined ? s.history.length : s.history.findIndex(entry => {
          const info = entry.info;
          return (generation === "v2" ? entry.id : info && typeof info === "object" && "id" in info ? info.id : undefined) === before;
        });
        if (index < 0) return violation("Requested native fork boundary does not exist");
        const history = s.history.slice(0, index);
        const retainedUserIds = history.flatMap(entry => {
          if (generation === "v2") return entry.type === "user" ? [entry.id] : [];
          const info = entry.info;
          return info && typeof info === "object" && "role" in info && info.role === "user" && "id" in info ? [info.id] : [];
        });
        const retainedHead = retainedUserIds.at(-1);
        const retainedTotal = typeof retainedHead === "string" ? totalsByMessage.get(retainedHead) : undefined;
        const forkedId = `ses_fixture_${++nextId}`;
        const forkHistory = structuredClone(history);
        // A fork may assign its own native message IDs. Consumers must read the
        // target transcript rather than copy or relabel the source's proof.
        const messageIds = new Map<string, string>();
        for (const [index, entry] of forkHistory.entries()) {
          const message = generation === "v2" ? entry : entry.info;
          if (message && typeof message === "object" && "id" in message && typeof message.id === "string")
            messageIds.set(message.id, `msg_fork_${forkedId}_${index}`);
        }
        for (const entry of forkHistory) {
          const message = generation === "v2" ? entry : entry.info;
          if (message && typeof message === "object" && "id" in message && typeof message.id === "string") {
            const originalId = message.id;
            const targetId = messageIds.get(originalId)!;
            message.id = targetId;
            const total = totalsByMessage.get(originalId);
            if (total !== undefined) totalsByMessage.set(targetId, total);
            if ("sessionID" in message) message.sessionID = forkedId;
            if ("parentID" in message && typeof message.parentID === "string")
              message.parentID = messageIds.get(message.parentID) ?? message.parentID;
          }
          if (Array.isArray(entry.parts)) for (const part of entry.parts) {
            if (!part || typeof part !== "object") continue;
            if ("sessionID" in part) part.sessionID = forkedId;
            if ("messageID" in part && typeof part.messageID === "string")
              part.messageID = messageIds.get(part.messageID) ?? part.messageID;
          }
        }
        const forked: NativeSession = { ...s, id: forkedId, history: forkHistory, total: retainedTotal,
          pending: undefined, promptId: undefined, answerId: undefined };
        sessions.set(forked.id, forked); json(generation === "v2" ? { data: info(forked) } : info(forked)); return;
      }
      if (s && suffix === "/synthetic" && generation === "v2") {
        json({ data: { id: `msg_synthetic_${++nextId}`, sessionID: s.id, type: "synthetic", delivery: "queue",
          payload: { text: String(body.text ?? ""), ...(body.description ? { description: body.description } : {}) }, time: { created: Date.now() } } }); return;
      }
      if (s && ["/prompt", "/prompt_async"].includes(suffix)) {
        if (!streams.size) return violation("Prompt before accepted SSE subscription");
        if (s.state !== "idle") return violation("Overlapping native turn");
        if (generation === "v1" && !Array.isArray(body.parts)) return violation("Native prompt requires parts", 400);
        if (generation === "v1") {
          // v1 resolves the agent afresh per prompt; omitting it selects native
          // build, not the previous turn's plan agent. v2 persists /agent instead.
          s.agent = typeof body.agent === "string" ? body.agent : "build";
          const nativeModel = body.model;
          if (!nativeModel || typeof nativeModel !== "object" || !("providerID" in nativeModel) || !("modelID" in nativeModel)
            || typeof nativeModel.providerID !== "string" || typeof nativeModel.modelID !== "string")
            return violation("Native user history requires the resolved model", 400);
          s.model = { providerID: nativeModel.providerID, modelID: nativeModel.modelID,
            ...(typeof body.variant === "string" ? { variant: body.variant } : {}) };
        }
        if (!["build", "plan", "explore"].includes(s.agent)) return violation("Unknown native agent", 400);
        const parts: unknown[] = Array.isArray(body.parts) ? body.parts : [];
        const promptText = generation === "v2" ? String(body.text) : parts.flatMap(part =>
          part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n");
        const add = /^ADD (-?\d+) (-?\d+)$/.exec(promptText.trim());
        const acc = /^ACCUMULATE (-?\d+)$/.exec(promptText.trim());
        if (!add && !acc) return violation("Fixture accepts only arithmetic programs, never echoes arbitrary prompts", 400);
        if (acc && s.total === undefined) return violation("Continuation lost prior native memory");
        s.total = add ? Number(add[1]) + Number(add[2]) : s.total! + Number(acc![1]);
        s.promptId = String(body[generation === "v2" ? "id" : "messageID"]);
        if (!s.promptId.startsWith("msg_")) return violation("Client must supply a native message identity");
        s.answerId = `msg_answer_${prompts.length + 1}`;
        s.state = "running"; s.result = `計算=${s.total}`;
        prompts.push({ sessionId: s.id, text: promptText, total: s.total, messageId: s.promptId, agent: s.agent });
        totalsByMessage.set(s.promptId, s.total);
        if (generation === "v2") {
          const payload = { text: promptText, files: [], agents: [], skills: [] };
          s.history.push({ id: s.promptId, type: "user", ...payload, time: { created: Date.now() } });
          json({ data: { id: s.promptId, sessionID: s.id, type: "user", delivery: "queue", payload, time: { created: Date.now() } } });
          emit("session.execution.started", { sessionID: s.id });
        } else {
          empty();
          const user = { id: s.promptId, sessionID: s.id, role: "user", agent: s.agent, model: s.model, time: { created: Date.now() } };
          s.history.push({ info: user, parts: [{ id: `prt_${s.promptId}`, sessionID: s.id, messageID: s.promptId, type: "text", text: promptText }] });
          emit("message.updated", { sessionID: s.id, info: user }); emit("session.status", { sessionID: s.id, status: { type: "busy" } });
          emit("message.part.updated", { part: { id: "prt_user_secret", sessionID: s.id, messageID: s.promptId, type: "text", text: "PROMPT MUST NOT APPEAR IN OUTPUT" } });
        }
        // A foreign session's valid terminal/text can never own this generation.
        if (generation === "v2") { emit("session.execution.started", { sessionID: "ses_foreign" }); emit("session.text.ended", { sessionID: "ses_foreign", assistantMessageID: "msg_foreign", ordinal: 0, text: "FOREIGN MUST NOT APPEAR" }); emit("session.execution.succeeded", { sessionID: "ses_foreign" }); }
        text(s, s.result);
        if (scenario === "usage" || scenario === "usage-hold" || scenario === "usage-partial") usage(s, scenario === "usage-partial");
        if (scenario === "output") output(s);
        if (scenario === "child") child(s);
        if (["question", "multi-question", "secret", "unsupported-form"].includes(scenario)) question(s);
        else if (scenario === "permission") {
          s.pending = "per_fixture"; s.state = "waiting";
          emit("permission.asked", generation === "v2" ? { sessionID: s.id, id: s.pending, action: "shell", resources: ["*"], metadata: {}, save: [] }
            : { sessionID: s.id, id: s.pending, permission: "bash", patterns: ["*"], always: [], metadata: {} });
        } else if (["payment", "authentication", "quota"].includes(scenario)) {
          s.state = "idle";
          const status = scenario === "payment" ? 402 : scenario === "authentication" ? 401 : 429;
          if (generation === "v2") {
            const error = { type: status === 401 ? "provider.authentication" : "provider.quota", status,
              message: status === 402 ? "Payment required" : status === 401 ? "Authentication required" : "Rate limited" };
            s.history.push({ id: `msg_idle_${++nextId}`, type: "idle", outcome: "failed", error, time: { created: Date.now() } });
            emit("session.execution.failed", { sessionID: s.id, error });
          }
          else emit("session.error", { sessionID: s.id, error: { name: "APIError", data: { statusCode: status, message: status === 402 ? "Payment required" : status === 401 ? "Authentication required" : "Rate limited", isRetryable: false } } });
        } else if (scenario === "disconnect") { disconnected = true; for (const stream of streams) stream.end(); }
        else if (scenario === "interrupted" || scenario === "usage-partial") terminal(s, "interrupted");
        else if (!["hold", "usage-hold", "child"].includes(scenario)) terminal(s);
        prompted.resolve(); return;
      }
      if (s && ["/interrupt", "/abort"].includes(suffix)) {
        const active = s.state !== "idle"; terminal(s, "interrupted");
        if (generation === "v2") json({ interrupted: active }); else json(true); return;
      }
      const questionReply = generation === "v2" ? s && /^\/form\/frm_fixture(?:\/reply)?$/.test(suffix) : /^\/question\/que_fixture\/(?:reply|reject)$/.test(url.pathname);
      const permissionReply = generation === "v2" ? s && suffix === "/permission/per_fixture/reply" : url.pathname === "/permission/per_fixture/reply";
      if (questionReply || permissionReply) {
        const owner = s ?? [...sessions.values()].find(candidate => candidate.pending);
        if (!owner?.pending || owner.state !== "waiting") return violation("Stale or duplicate native response");
        const cancel = request.method === "DELETE" || url.pathname.endsWith("/reject") || body.reply === "reject" || body.decision === "reject";
        if (permissionReply && !cancel) return violation("PM must not grant native permissions");
        if (!cancel && questionReply) {
          const answer = generation === "v2" ? body.answer as Record<string, unknown> : undefined;
          const answers = generation === "v1" ? body.answers as unknown[][] : undefined;
          const values = generation === "v2" ? (scenario === "multi-question" ? answer?.colors : [answer?.color]) : answers?.[0];
          if (!Array.isArray(values) || values.length < 1 || values.length > 2 || new Set(values).size !== values.length ||
            values.some(value => !(generation === "v2" ? ["blue", "red"] : ["Blue", "Red"]).includes(String(value))) ||
            (scenario === "multi-question" && generation === "v1" && answers?.[1]?.[0] !== "notes")) return violation("Invalid native answer", 400);
        }
        const pendingId = owner.pending; owner.pending = undefined;
        empty();
        if (cancel) rejected.resolve();
        if (permissionReply) emit("permission.replied", { sessionID: owner.id, requestID: pendingId, reply: "reject" });
        else if (generation === "v2") emit(cancel ? "form.cancelled" : "form.replied", { sessionID: owner.id, id: pendingId, ...(!cancel ? { answer: body.answer } : {}) });
        else emit(cancel ? "question.rejected" : "question.replied", { sessionID: owner.id, requestID: pendingId });
        // The native v2 root form Cancel is a user Stop, not a successful reply.
        terminal(owner, generation === "v2" && questionReply && cancel ? "interrupted" : "completed"); return;
      }
      // Never synthesize success for unknown SDK endpoints (including server shutdown).
      violations.push(`Unexpected endpoint ${request.method} ${url.pathname}`);
      json({ _tag: "NotFoundError", message: "Unrecorded endpoint" }, 404);
    } catch (error) {
      violations.push(error instanceof Error ? error.message : "Invalid fixture request");
      if (!response.headersSent) json({ _tag: "InvalidRequestError", message: "Invalid fixture request" }, 400);
      else response.end();
    }
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject); server.listen(options.port ?? 0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return {
    generation, password, version, url: `http://127.0.0.1:${address.port}`, requests, prompts, violations,
    prompted: prompted.promise, rejected: rejected.promise,
    get subscriptions() { return subscriptions; },
    get liveStreams() { return streams.size; },
    get connectedMcpServers() { return [...mcp.values()].filter(server => server.connected).length; },
    finish() { for (const s of sessions.values()) if (!s.parentID) terminal(s); },
    closeQuestion() { for (const s of sessions.values()) if (s.pending) {
      const id = s.pending; s.pending = undefined;
      emit(generation === "v2" ? "form.cancelled" : "question.rejected", generation === "v2" ? { sessionID: s.id, id } : { sessionID: s.id, requestID: id });
      terminal(s, generation === "v2" ? "interrupted" : "completed");
    } },
    changeNativeCwd(directory: string) { for (const s of sessions.values()) s.directory = directory; },
    assertClean() { assert.deepEqual(violations, [], "Independent fixture rejected the provider's protocol/state transitions"); },
    async close() {
      for (const stream of streams) stream.end(); server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    },
  };
}
