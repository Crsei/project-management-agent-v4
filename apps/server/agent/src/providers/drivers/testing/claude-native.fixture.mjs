#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }
const value = (name) => args[args.indexOf(name) + 1];
const sessionId = args.includes("--resume") ? value("--resume") : value("--session-id");
if (!sessionId) throw new Error("Fixture requires the original SDK's native session identity.");
const log = (event) => fs.appendFileSync(process.env.PM_CLAUDE_FIXTURE_LOG, JSON.stringify(event) + "\n");
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const respond = (request, response) => send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
log({ type: "launch", sessionId, cwd: process.cwd(), home: process.env.CLAUDE_CONFIG_DIR, args });
let pending;
let count = 0;
function finish(text, failure = false) {
  const uuid = crypto.randomUUID();
  const usage = { input_tokens: 11, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 7 };
  if (!failure) send({ type: "assistant", session_id: sessionId, uuid, parent_tool_use_id: null,
    message: { id: "msg_" + uuid, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text }], stop_reason: "end_turn", usage } });
  send({ type: "result", subtype: failure ? "error_during_execution" : "success", is_error: failure,
    session_id: sessionId, uuid: crypto.randomUUID(), result: failure ? undefined : text,
    errors: failure ? ["Controlled native callback rejected"] : undefined, num_turns: 1,
    duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0.001, usage,
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 20, outputTokens: 3, cacheReadInputTokens: 7, cacheCreationInputTokens: 2, costUSD: 0.001, contextWindow: 200000, maxOutputTokens: 64000 } } });
  log({ type: "terminal", uuid, sessionId, failure });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type === "control_request") {
    const request = event.request;
    log({ type: "control", subtype: request.subtype });
    if (request.subtype === "initialize") respond(event, { commands: [], agents: [], models: [], output_style: "default", available_output_styles: ["default"], account: { tokenSource: "none", apiKeySource: "none" } });
    else if (request.subtype === "mcp_set_servers") respond(event, { added: Object.keys(request.servers ?? {}), removed: [], errors: process.env.PM_CLAUDE_FIXTURE_MCP_FAIL ? { pm_tools: "Controlled connection refusal" } : {} });
    else if (request.subtype === "interrupt") { respond(event, { still_queued: [] }); finish("", true); }
    else respond(event, {});
    return;
  }
  if (event.type === "control_response") {
    log({ type: "permission_response", response: event.response });
    const failed = event.response.subtype === "error" || event.response.response?.behavior === "deny";
    finish(pending ?? "native callback", failed);
    pending = undefined;
    return;
  }
  if (event.type !== "user") return;
  const content = event.message.content;
  const text = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  log({ type: "prompt", text, sessionId, uuid: event.uuid });
  send({ ...event, type: "user", session_id: sessionId, parent_tool_use_id: null });
  send({ type: "system", subtype: "init", session_id: sessionId, uuid: crypto.randomUUID(), cwd: process.cwd(), tools: [], model: "claude-sonnet-4-6", permissionMode: "default", apiKeySource: "none" });
  count++;
  if (text === "eof") { process.exit(0); }
  if (text === "dialog") {
    pending = "native dialog";
    send({ type: "control_request", request_id: "dialog-" + count, request: { subtype: "request_user_dialog", dialog_kind: "resume_return", payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 } } });
  } else if (text.startsWith("permission:")) {
    pending = "native permission";
    send({ type: "control_request", request_id: "permission-" + count, request: { subtype: "can_use_tool", tool_name: text.slice(11), input: { workspaceId: "fixture-workspace" }, tool_use_id: "tool-" + count } });
  } else finish(text === "/compact" ? "" : "native answer " + count);
});
