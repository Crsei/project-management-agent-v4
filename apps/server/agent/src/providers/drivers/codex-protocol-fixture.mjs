#!/usr/bin/env node
// Deterministic app-server peer, not an inference fallback. All state belongs to its temporary test Home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
const eventLog = process.env.EVENT_LOG;
const scopeLog = process.env.SCOPE_LOG;
const record = event => { if (eventLog) fs.appendFileSync(eventLog, JSON.stringify(event) + "\n"); };
const scopeRecord = event => { if (scopeLog) fs.appendFileSync(scopeLog, JSON.stringify(event) + "\n"); };
record({ args, cwd: process.cwd(), home, processHome: process.env.HOME, key: process.env.FIXTURE_NATIVE_KEY });
if (args.includes("--version")) {
  console.log("codex-cli 0.156.1");
} else if (args.includes("mcp") && args.includes("list")) {
  if (process.env.MODE === "mcp-failure") process.exitCode = 2;
  else console.log(JSON.stringify([{ name: "ambient.test", enabled: true }]));
} else if (args[0] === "exec") {
  const output = args[args.indexOf("--output-last-message") + 1];
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  record({ titlePrompt: prompt, args });
  fs.writeFileSync(output, JSON.stringify({ title: "Controlled native title" }));
} else if (args[0] === "app-server") {
  fs.mkdirSync(home, { recursive: true });
  const statePath = path.join(home, "controlled-native-threads.json");
  const readState = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const save = state => fs.writeFileSync(statePath, JSON.stringify(state));
  const timestamp = () => Math.floor(Date.now() / 1000);
  const threadResponse = thread => ({ thread, model: thread.model || "native-codex-1", modelProvider: "openai", cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd], instructionSources: [], approvalPolicy: "untrusted", approvalsReviewer: "user",
    sandbox: { type: "readOnly" }, reasoningEffort: "medium", serviceTier: null });
  const makeThread = (cwd, model, forkedFromId = null) => {
    const id = randomUUID();
    return { id, sessionId: id, cliVersion: "0.156.1", createdAt: timestamp(), updatedAt: timestamp(),
      cwd, ephemeral: false, forkedFromId, model, modelProvider: "openai", preview: "", projectId: null, source: "cli", status: { type: "idle" }, turns: [] };
  };
  const send = value => process.stdout.write(JSON.stringify(value) + "\n");
  const notify = (method, params) => send({ method, params });
  let active;
  const complete = (threadId, turn, text, status = "completed") => {
    const state = readState();
    const final = { ...turn, status, completedAt: timestamp(), items: [{ id: `${turn.id}:assistant`, type: "agentMessage", text, phase: "final_answer" }],
      error: status === "failed" ? { message: "Controlled interruption", codexErrorInfo: "other", additionalDetails: null } : null };
    if (state[threadId]) { state[threadId].turns.push(final); state[threadId].updatedAt = timestamp(); save(state); }
    if (status === "completed") notify("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item: final.items[0] });
    notify("turn/completed", { threadId, turn: final });
    active = undefined;
  };
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    record({ rpc: message });
    const { method, id } = message;
    const params = message.params || {};
    const respond = result => send({ id, result });
    const reject = text => send({ id, error: { code: -32000, message: text } });
    if (!method) {
      if (id === "input-1" && active) {
        if (message.error) complete(active.threadId, active.turn, "", "failed");
        else {
          record({ answer: message.result });
          send({ id: "permissions-1", method: "item/permissions/requestApproval", params: {
            threadId: active.threadId, turnId: active.turn.id, itemId: "permission-tool", startedAtMs: Date.now(),
            cwd: process.cwd(), reason: "Request native workspace write access", permissions: { fileSystem: { write: [process.cwd()] } },
          } });
        }
      }
      if (id === "permissions-1" && active) {
        if (message.error) complete(active.threadId, active.turn, "", "failed");
        else { record({ permissionAnswer: message.result }); complete(active.threadId, active.turn, "native answer"); }
      }
      continue;
    }
    if (method === "initialize") respond({ userAgent: "codex/0.156.1", codexHome: process.env.REPORTED_HOME || home, platformFamily: "unix", platformOs: "linux" });
    else if (method === "initialized") continue;
    else if (method === "account/read") {
      if (process.env.ACCOUNT_REPORT === "rpc-error") reject("Native credential configuration failed");
      else respond(process.env.ACCOUNT_REPORT ? JSON.parse(process.env.ACCOUNT_REPORT) : { account: { type: "apiKey" }, requiresOpenaiAuth: true });
    } else if (method === "account/rateLimits/read") reject("Usage unavailable in this controlled account");
    else if (method === "config/read") reject("No native config override in this scenario");
    else if (method === "skills/list") respond({ data: [] });
    else if (method === "model/list") respond({ nextCursor: null, data: ["native-codex-1", "scope-model"].map(model => ({ id: model, model, displayName: model,
      description: "Controlled native model", hidden: false, isDefault: model === "native-codex-1", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }, { reasoningEffort: "xhigh", description: "Extra high" }],
      serviceTiers: [{ id: "priority", name: "Priority", description: "Priority" }], defaultServiceTier: "priority" })) });
    else if (method === "thread/loaded/list") respond({ data: Object.keys(readState()), nextCursor: null });
    else if (method === "thread/read") {
      const thread = readState()[params.threadId];
      if (!thread) reject("Unknown native thread"); else respond({ thread });
    } else if (method === "thread/turns/list") {
      const thread = readState()[params.threadId];
      if (!thread) reject("Unknown native thread"); else respond({ data: thread.turns, nextCursor: null });
    } else if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      const state = readState();
      let thread;
      if (method === "thread/start") thread = makeThread(params.cwd || process.cwd(), params.model);
      else {
        const source = state[params.threadId];
        if (!source) { reject("Unknown native thread"); continue; }
        if (method === "thread/resume") thread = source;
        else {
          const index = params.lastTurnId ? source.turns.findIndex(turn => turn.id === params.lastTurnId && turn.status === "completed") : source.turns.length - 1;
          if (index < 0) { reject("Unknown completed native fork boundary"); continue; }
          thread = { ...makeThread(source.cwd, params.model || source.model, source.id), turns: source.turns.slice(0, index + 1) };
          scopeRecord({ rpc: message, cwd: process.cwd() });
        }
      }
      state[thread.id] = thread; save(state);
      scopeRecord({ session: method, threadId: params.threadId, cwd: process.cwd() });
      respond(threadResponse(thread));
    } else if (method === "turn/start") {
      const state = readState(); const thread = state[params.threadId];
      if (!thread) { reject("Unknown native thread"); continue; }
      const turn = { id: randomUUID(), items: [], status: "inProgress", error: null, startedAt: timestamp(), completedAt: null };
      active = { threadId: thread.id, turn };
      const markerPath = path.join(process.cwd(), "scope.txt");
      const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "native answer";
      scopeRecord({ turn: params, cwd: process.cwd(), marker });
      respond({ turn }); notify("turn/started", { threadId: thread.id, turn });
      notify("item/agentMessage/delta", { threadId: thread.id, turnId: turn.id, itemId: `${turn.id}:assistant`, delta: marker });
      if (process.env.MODE === "cancel") continue;
      if (process.env.MODE === "eof") process.exit(0);
      if (process.env.MODE === "input") {
        send({ id: "input-1", method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId: turn.id, itemId: "question-tool", isBlocking: true, questions: [
          { id: "color", header: "Color", question: "Choose a color", isOther: false, isSecret: false, options: [{ label: "Blue", description: "Blue option" }] },
        ] } }); continue;
      }
      if (process.env.MODE === "tools") {
        const base = { threadId: thread.id, turnId: turn.id };
        const command = { type: "commandExecution", id: `${turn.id}:command`, command: "pwd", cwd: process.cwd(),
          processId: "42", source: "unifiedExecStartup", status: "inProgress",
          commandActions: [{ type: "unknown", command: "pwd" }], aggregatedOutput: null, exitCode: null, durationMs: null };
        notify("item/started", { ...base, startedAtMs: Date.now(), item: command });
        notify("item/commandExecution/outputDelta", { ...base, itemId: command.id, delta: "native-command\n" });
        notify("item/completed", { ...base, completedAtMs: Date.now(), item: { ...command, status: "completed", aggregatedOutput: "native-command\n", exitCode: 0, durationMs: 1 } });
        const tool = { type: "mcpToolCall", id: `${turn.id}:tool`, server: "weather", tool: "get_weather",
          status: "completed", arguments: { city: "Oslo" }, result: { content: [{ type: "text", text: "Sunny" }] } };
        notify("item/completed", { ...base, completedAtMs: Date.now(), item: tool });
      }
      if (process.env.MODE === "mcp-app") {
        // No item/started notification: the source capture seam must own both
        // provisional rows. The peer handles resource requests only after this
        // synchronous turn/start handler has emitted turn/completed.
        for (const suffix of ["one", "two"]) notify("item/completed", {
          threadId: thread.id, turnId: turn.id, completedAtMs: Date.now(),
          item: { type: "mcpToolCall", id: `${turn.id}:app-${suffix}`, server: "weather", tool: "get_weather",
            status: "completed", arguments: { city: "Oslo" }, mcpAppResourceUri: `ui://weather/${suffix}`,
            result: { content: [{ type: "text", text: `Sunny ${suffix}` }], structuredContent: { temp: 21 } } },
        });
      }
      const tokens = { totalTokens: 12, inputTokens: 8, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 1 };
      notify("thread/tokenUsage/updated", { threadId: thread.id, turnId: turn.id, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 200000 } });
      const failed = path.join(process.cwd(), "fail-next");
      if (fs.existsSync(failed)) { fs.unlinkSync(failed); complete(thread.id, turn, marker, "failed"); }
      else complete(thread.id, turn, marker);
    } else if (method === "turn/interrupt") { respond({}); if (active) complete(active.threadId, active.turn, "", "interrupted"); }
    else if (method === "thread/backgroundTerminals/list") respond({ data: [], nextCursor: null });
    else if (method === "thread/unsubscribe") respond({ status: "unsubscribed" });
    else if (process.env.MODE === "mcp-app" && method === "mcpServer/resource/read") {
      if (params.server !== "weather" || !params.uri.startsWith("ui://weather/")) { reject("Unknown App source"); continue; }
      record({ appResourceAfterTerminal: active === undefined, uri: params.uri });
      if (process.env.MCP_APP_RESOURCE_URL) {
        const endpoint = new URL(process.env.MCP_APP_RESOURCE_URL);
        endpoint.searchParams.set("uri", params.uri);
        const response = await fetch(endpoint);
        if (!response.ok) reject("Controlled App resource was unavailable");
        else respond(await response.json());
      } else respond({ contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app",
        text: "<!doctype html><h1>Native captured App</h1>", _meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] } } } }] });
    } else if (process.env.MODE === "mcp-app" && method === "mcpServerStatus/list") {
      respond({ data: [{ name: "weather", authStatus: "unsupported", resources: [], resourceTemplates: [],
        tools: { get_weather: { name: "get_weather", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } } } }], nextCursor: null });
    } else if (process.env.MODE === "mcp-app" && method === "mcpServer/tool/call") {
      if (params.server !== "weather" || params.tool !== "get_weather") { reject("Unknown App tool"); continue; }
      respond({ content: [{ type: "text", text: "Sunny refreshed" }], structuredContent: { temp: 21 } });
    }
    else if (id !== undefined) respond({});
  }
}
