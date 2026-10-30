import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as AcpAgent from "effect-acp/agent";
import * as AcpErrors from "effect-acp/errors";

// A real typed ACP-v2 program, with durable native session state and arithmetic, never a model echo.
interface NativeSession { cwd: string; total: number; answer?: string; head?: string; busy?: boolean }
const root = process.env.PM_ACP_FIXTURE_ROOT!;
const statePath = path.join(root, "native-sessions.json");
const logPath = path.join(root, "native.ndjson");
const log = (event: object) => appendFileSync(logPath, `${JSON.stringify(event)}\n`);
const readSessions = (): Record<string, NativeSession> => JSON.parse(readFileSync(statePath, "utf8"));
const saveSession = (sessionId: string, session: NativeSession) => writeFileSync(statePath, JSON.stringify({ ...readSessions(), [sessionId]: session }));

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;
  const scope = yield* Effect.scope;
  let sessionId: string | undefined;
  let enforcedMode = "auto";
  let model = "native/other";
  let effort = "xhigh";
  let held = false;
  let mcpServerIds: string[] = [];
  const configOptions = () => [
    { configId: "model", name: "Model", category: "model" as const, type: "select" as const, currentValue: model,
      options: ["native/default", "native/other"].map(value => ({ value, name: value })) },
    { configId: "effort", name: "Effort", type: "select" as const, currentValue: effort,
      options: ["medium", "xhigh"].map(value => ({ value, name: value })) },
    { configId: "mode", name: "Mode", category: "mode" as const, type: "select" as const, currentValue: "ask",
      options: ["ask", "auto"].map(value => ({ value, name: value })) },
  ];
  yield* agent.handleInitialize(() => Effect.sync(() => {
    log({ method: "initialize", agentName: "pm-acp-native-fixture", pid: process.pid, home: process.env.HOME, cwd: process.cwd() });
    return { protocolVersion: 2, info: { name: "pm-acp-native-fixture", version: "1" },
      capabilities: { session: { mcp: { acp: {} } } }, authMethods: [] };
  }));
  yield* agent.handleCreateSession(request => Effect.sync(() => {
    sessionId = `native-${randomUUID()}`;
    saveSession(sessionId, { cwd: request.cwd, total: 0 });
    log({ method: "session/new", sessionId, cwd: request.cwd, mcpServers: request.mcpServers });
    mcpServerIds = (request.mcpServers ?? []).flatMap(server => {
      if (server.type !== "acp") return [];
      if (typeof server.serverId !== "string") throw new Error("Native ACP MCP serverId must be a string.");
      return [server.serverId];
    });
    return { sessionId, configOptions: configOptions() };
  }));
  yield* agent.handleListSessions(() => Effect.sync(() => {
    log({ method: "session/list" });
    return { sessions: Object.entries(readSessions()).map(([sessionId, session]) => ({ sessionId, cwd: session.cwd })) };
  }));
  yield* agent.handleLoadSession(request => Effect.gen(function* () {
    const session = readSessions()[request.sessionId];
    if (!session || session.cwd !== request.cwd) return yield* new AcpErrors.AcpRequestError({ code: -32602, errorMessage: "Native session directory mismatch." });
    sessionId = request.sessionId;
    log({ method: "session/load", sessionId, cwd: request.cwd, mcpServers: request.mcpServers });
    mcpServerIds = (request.mcpServers ?? []).flatMap(server => {
      if (server.type !== "acp") return [];
      if (typeof server.serverId !== "string") throw new Error("Native ACP MCP serverId must be a string.");
      return [server.serverId];
    });
    if (session.answer && session.head) yield* agent.client.sessionUpdate({ sessionId,
      update: { sessionUpdate: "agent_message", messageId: session.head, content: [{ type: "text", text: session.answer }] } });
    yield* agent.client.sessionUpdate({ sessionId, update: session.busy
      ? { sessionUpdate: "state_update", state: "running" }
      : { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
    return { configOptions: configOptions() };
  }));
  yield* agent.handleSetSessionConfigOption(request => Effect.sync(() => {
    if (request.type !== "id" || typeof request.value !== "string") throw new Error("ACP-v2 typed id discriminator is required.");
    log({ method: "session/set_config_option", type: request.type, configId: request.configId, value: request.value });
    if (request.configId === "mode") enforcedMode = request.value;
    else if (request.configId === "model") model = request.value;
    else if (request.configId === "effort") effort = request.value;
    else throw new Error("Unknown native config option.");
    return { configOptions: configOptions() };
  }));
  yield* agent.handlePrompt(request => Effect.gen(function* () {
    if (!sessionId) return yield* new AcpErrors.AcpRequestError({ code: -32602, errorMessage: "No native session." });
    const currentId = sessionId;
    const text = request.prompt.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    log({ method: "session/prompt", sessionId: currentId, text, enforcedMode, model, effort });
    if (process.env.PM_ACP_FIXTURE_FAMILY === "fx" && enforcedMode !== "ask")
      return yield* new AcpErrors.AcpRequestError({ code: -32602, errorMessage: "FX forced supervised mode was not applied." });
    yield* Effect.gen(function* () {
      yield* agent.client.sessionUpdate({ sessionId: currentId, update: { sessionUpdate: "state_update", state: "running" } });
      if (text.includes("HOLD_NATIVE")) {
        held = true;
        yield* agent.client.sessionUpdate({ sessionId: currentId, update: { sessionUpdate: "agent_message_chunk",
          messageId: "held-native-message", content: { type: "text", text: "Native hold admitted" } } });
        return;
      }
      if (text.includes("REQUEST_PERMISSION")) {
        const answer = yield* agent.client.requestPermission({ sessionId: currentId, title: "Write outside the read-only policy",
          subject: { type: "tool_call", toolCall: { toolCallId: "permission-write", kind: "edit", title: "Write notes" } },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        log({ method: "permission/response", answer });
      }
      const session = readSessions()[currentId]!;
      if (text.includes("REQUEST_PM_TOOLS")) {
        const serverId = mcpServerIds[0];
        if (!serverId) return yield* new AcpErrors.AcpRequestError({ code: -32602, errorMessage: "Missing generation-owned PM transport." });
        const { connectionId } = yield* agent.client.connectMcp({ serverId });
        yield* agent.client.messageMcp({ connectionId, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pm-acp-native-fixture", version: "1" } } });
        yield* agent.client.notifyMcp({ connectionId, method: "notifications/initialized" });
        const tools = yield* agent.client.messageMcp({ connectionId, method: "tools/list" });
        log({ method: "mcp/tools", tools });
        const result = yield* agent.client.messageMcp({ connectionId, method: "tools/call",
          params: { name: "fixture_add", arguments: { a: 19, b: 23 } } });
        log({ method: "mcp/result", result });
        yield* agent.client.disconnectMcp({ connectionId });
      }
      const add = /ADD\s+(-?\d+)\s+(-?\d+)/.exec(text);
      const more = /ACCUMULATE\s+(-?\d+)/.exec(text);
      if (add) session.total = Number(add[1]) + Number(add[2]);
      else if (more) session.total += Number(more[1]);
      const answer = `Native total=${session.total}`;
      const messageId = `assistant-${randomUUID()}`;
      saveSession(currentId, { ...session, answer, head: messageId });
      yield* agent.client.sessionUpdate({ sessionId: currentId,
        update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: answer } } });
      yield* agent.client.sessionUpdate({ sessionId: currentId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } });
      if (process.env.PM_ACP_FIXTURE_FAMILY === "grok") yield* agent.client.extNotification("_x.ai/session_notification", {
        sessionId: currentId, update: { sessionUpdate: "turn_completed", prompt_id: String(request._meta?.promptId ?? ""), stop_reason: "end_turn" },
      });
    }).pipe(Effect.forkIn(scope));
    return {};
  }));
  yield* agent.handleCancel(() => Effect.gen(function* () {
    log({ method: "session/cancel", sessionId });
    if (sessionId && held) {
      held = false;
      yield* agent.client.sessionUpdate({ sessionId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" } });
    }
  }));
  yield* agent.handleCloseSession(() => Effect.sync(() => { log({ method: "session/close", sessionId }); return {}; }));
  yield* Effect.never;
});
program.pipe(Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)), Effect.scoped, NodeRuntime.runMain);
