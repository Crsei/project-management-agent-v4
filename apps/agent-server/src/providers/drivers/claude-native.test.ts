import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Options, Query, SDKAssistantMessage, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { NativeOutputEvent } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { claudeAdapter, claudeQueryOptions, createClaudeAdapter } from "./claude.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-native-protocol-"));
  const binary = path.join(directory, "claude.mjs");
  await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2), credential=path.join(process.env.CLAUDE_CONFIG_DIR,'fixture-auth');
if(args[0]==='--version')console.log('Claude fixture-native-version');
else if(args[0]==='auth'&&args[1]==='status')console.log(JSON.stringify({loggedIn:fs.existsSync(credential)}));
else if(args[0]==='auth'&&args[1]==='logout'){fs.rmSync(credential,{force:true});}
else if(args[0]==='auth'&&args[1]==='login'){
 if(!process.stdin.isTTY)process.exit(2);
 console.log('Enter controlled fixture code:');process.stdin.setEncoding('utf8');process.stdin.on('data',input=>{if(input.trim()==='fixture-code'){if(process.env.AUTH_FAIL)process.exit(1);fs.writeFileSync(credential,'controlled');process.exit(0);}});
} else process.exit(3);
`);
  await chmod(binary, 0o700);
  const context: ProviderDriverContext = { instanceId: "controlled-claude", driver: "claude", revision: 4, config: claudeAdapter.validateConfig({ binaryPath: binary, autoCompactWindow: "300000", idleCompaction: "off" }), cwd: directory, homeDirectory: path.join(directory, "home"), env: { ...process.env, HOME: path.join(directory, "home") } };
  return { directory, context };
}

type SdkInput = { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options };
function assistantMessage(text: string, error?: SDKAssistantMessage["error"]): SDKAssistantMessage {
  return {
    type: "assistant", session_id: "actual-claude-session", uuid: "00000000-0000-4000-8000-000000000001", parent_tool_use_id: null,
    ...(error ? { error } : {}),
    message: {
      id: "controlled-message", type: "message", role: "assistant", model: "native-claude",
      content: [{ type: "text", text, citations: null }],
      container: null, context_management: null, diagnostics: null, stop_details: null, stop_reason: "end_turn", stop_sequence: null,
      usage: {
        input_tokens: 2, output_tokens: 3, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null,
        fallback_credit: null, inference_geo: null, iterations: null, output_tokens_details: null, server_tool_use: null, service_tier: null, speed: null,
      },
    },
  };
}
function fakeSdk(mode: "success" | "eof" | "error" | "cancel" | "telemetry" = "success", account: Record<string, unknown> = { email: "fixture@example.invalid", apiProvider: "firstParty", tokenSource: "oauth", apiKeySource: "none" }) {
  const opened: SdkInput[] = []; let interrupts = 0; let closes = 0;
  const factory = ((input: SdkInput): Query => {
    opened.push(input);
    const closed = Promise.withResolvers<void>();
    const messages = (async function* (): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "actual-claude-session" } as SDKMessage;
      if (mode !== "telemetry") {
        yield { type: "stream_event", session_id: "actual-claude-session", event: { type: "message_start" } } as SDKMessage;
        yield { type: "stream_event", session_id: "actual-claude-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "native " } } } as SDKMessage;
      }
      if (mode === "cancel") { await closed.promise; return; }
      if (mode === "eof") return;
      if (mode === "telemetry") {
        yield { type: "stream_event", session_id: "actual-claude-session", parent_tool_use_id: null, event: { type: "message_start", message: { id: "controlled-message", model: "native-claude", usage: { input_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } } } } } as unknown as SDKMessage;
        yield { type: "stream_event", session_id: "actual-claude-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "native " } } } as SDKMessage;
        yield { type: "stream_event", session_id: "actual-claude-session", parent_tool_use_id: null, event: { type: "message_delta", usage: { output_tokens: 3, input_tokens: null } } } as unknown as SDKMessage;
        yield { type: "rate_limit_event", session_id: "actual-claude-session", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1900000000 } } as SDKMessage;
        yield assistantMessage("native answer");
        yield { type: "result", subtype: "success", is_error: false, result: "native answer", session_id: "actual-claude-session", usage: { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 20, output_tokens: 10 }, total_cost_usd: 0.42, modelUsage: { "native-claude": { contextWindow: 200000 } } } as unknown as SDKMessage;
        return;
      }
      if (mode === "error") {
        yield { type: "rate_limit_event", session_id: "actual-claude-session", rate_limit_info: { status: "rejected", resetsAt: 1900000000 } } as SDKMessage;
        yield assistantMessage("Usage limit reached", "rate_limit");
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Usage limit reached"], session_id: "actual-claude-session", usage: { input_tokens: 2, output_tokens: 3 } } as SDKMessage;
        return;
      }
      yield assistantMessage("native answer");
      yield { type: "result", subtype: "success", is_error: false, result: "native answer", session_id: "actual-claude-session", usage: { input_tokens: 2, output_tokens: 3 } } as SDKMessage;
    })();
    return Object.assign(messages, {
      initializationResult: async () => ({ account }),
      supportedModels: async () => [{ value: "native-claude", displayName: "Native Claude", description: "Controlled protocol model" }],
      interrupt: async () => { interrupts++; closed.resolve(); }, close: () => { closes++; closed.resolve(); },
    }) as unknown as Query;
  }) as typeof query;
  return { adapter: createClaudeAdapter(factory), opened, interrupts: () => interrupts, closes: () => closes };
}

test("Claude probes native account and model initialization without sending a user prompt", async () => {
  const f = await fixture(); const sdk = fakeSdk();
  try {
    const status = await sdk.adapter.check(f.context);
    assert.equal(status.authentication, "authenticated");
    assert.deepEqual(status.models.map((model) => model.id), ["native-claude"]);
    assert.equal(status.models[0]?.reasoning, false);
    assert.equal(typeof sdk.opened[0]?.prompt, "object");
    assert.equal(sdk.opened[0]?.options?.persistSession, false);
    assert.equal(sdk.opened[0]?.options?.env?.CLAUDE_CONFIG_DIR, f.context.homeDirectory);
    assert.deepEqual(sdk.opened[0]?.options?.tools, []);
    assert.equal(sdk.closes(), 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude native auth distinguishes explicitly logged-out accounts from token-only and API-key accounts", async () => {
  const f = await fixture();
  try {
    assert.equal((await fakeSdk("success", { tokenSource: "none", apiKeySource: "none" }).adapter.check(f.context)).authentication, "unauthenticated");
    const unavailable = await fakeSdk("success", {}).adapter.check(f.context);
    assert.equal(unavailable.authentication, "unknown"); assert.equal(unavailable.canLogout, false);
    assert.equal((await fakeSdk("success", { tokenSource: "oauth", apiKeySource: "none" }).adapter.check(f.context)).authentication, "authenticated");
    const keyed = await fakeSdk("success", { tokenSource: "none", apiKeySource: "environment" }).adapter.check({ ...f.context, env: { ...f.context.env, ANTHROPIC_API_KEY: "controlled-native-key" } });
    assert.equal(keyed.authentication, "authenticated"); assert.equal(keyed.canLogout, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude SDK config effects include native compaction, append prompt, launch arguments and PM permission rejection", async () => {
  const f = await fixture(); const sdk = fakeSdk();
  try {
    await writeFile(path.join(f.directory, "rules.txt"), "file sentinel\n");
    const context = { ...f.context, config: { ...f.context.config, launchArgs: '--append-system-prompt-file rules.txt --append-system-prompt "inline sentinel" --chrome' } };
    const chunks: string[] = []; const events: NativeOutputEvent[] = [];
    const result = await sdk.adapter.run(context, { model: "native-claude", prompt: "controlled fixture", onText: (delta) => chunks.push(delta), onEvent: (event) => events.push(event) });
    assert.equal(result.text, "native answer"); assert.equal(chunks.join(""), result.text);
    assert.equal(events.flatMap((event) => event.type === "item.upsert" && event.item.type === "assistant_message" ? [event.item] : []).at(-1)?.text, result.text);
    assert.equal(result.nativeSession?.sessionId, "actual-claude-session"); assert.equal(result.nativeSession?.messageId, "00000000-0000-4000-8000-000000000001"); assert.equal(result.nativeSession?.instanceRevision, 4);
    assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3 });
    const options = sdk.opened[0]!.options!;
    assert.equal(options.settings && typeof options.settings === "object" ? options.settings.autoCompactWindow : undefined, 300000);
    assert.equal(options.settings && typeof options.settings === "object" ? options.settings.idleCompaction : undefined, false);
    assert.equal(options.extraArgs?.chrome, null);
    assert.equal(options.systemPrompt && typeof options.systemPrompt === "object" && "append" in options.systemPrompt ? options.systemPrompt.append : undefined, "file sentinel\n\ninline sentinel");
    assert.equal(options.sandbox?.enabled, true); assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
    assert.equal((await options.canUseTool!("Bash", { command: "rm -rf /" }, { signal: new AbortController().signal, toolUseID: "fixture", requestId: "fixture-request" }))?.behavior, "deny");
    await sdk.adapter.run(context, { model: "native-claude", prompt: "resume", resume: result.nativeSession });
    assert.equal(sdk.opened[1]?.options?.resume, "actual-claude-session");
    await assert.rejects(sdk.adapter.run(context, { model: "native-claude", prompt: "wrong revision", resume: { ...result.nativeSession!, instanceRevision: 3 } }), /another instance/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude rejects partial EOF and terminal errors, preserving quota evidence", async () => {
  const f = await fixture();
  try {
    await assert.rejects(fakeSdk("eof").adapter.run(f.context, { model: "native-claude", prompt: "partial eof" }), /successful terminal result/);
    await assert.rejects(fakeSdk("error").adapter.run(f.context, { model: "native-claude", prompt: "quota failure" }), (error: unknown) => {
      assert.ok(error instanceof Error && "errorClass" in error && error.errorClass === "usage_limit");
      assert.ok("resetAt" in error && error.resetAt === "2030-03-17T17:46:40.000Z"); return true;
    });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude cancellation interrupts and closes the actual SDK query without partial success", async () => {
  const f = await fixture(); const sdk = fakeSdk("cancel"); const abort = new AbortController();
  try {
    await assert.rejects(sdk.adapter.run(f.context, { model: "native-claude", prompt: "cancel fixture", signal: abort.signal, onText: () => abort.abort() }), (error: unknown) => error instanceof Error && "code" in error && error.code === "aborted");
    assert.equal(sdk.interrupts(), 1); assert.ok(sdk.closes() >= 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude terminal authentication uses a real TTY, verifies native status and supports logout", async () => {
  const f = await fixture(); let submitted = false;
  const unused = Promise.withResolvers<string>();
  try {
    await claudeAdapter.authenticate(f.context, { methodId: "terminal", signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => { if (!submitted) { submitted = true; return "fixture-code"; } return unused.promise; } });
    await claudeAdapter.logout(f.context);
    let failedSubmitted = false;
    await assert.rejects(claudeAdapter.authenticate({ ...f.context, env: { ...f.context.env, AUTH_FAIL: "true" } }, { signal: new AbortController().signal, onUpdate: () => {}, readInput: async () => { if (!failedSubmitted) { failedSubmitted = true; return "fixture-code"; } return unused.promise; } }), /exited with code 1/);
  } finally { unused.resolve(""); await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude cancelling terminal authentication terminates the pending native login", async () => {
  const f = await fixture(); const abort = new AbortController(); const unused = Promise.withResolvers<string>();
  try {
    await assert.rejects(claudeAdapter.authenticate(f.context, {
      signal: abort.signal, readInput: () => unused.promise,
      onUpdate: (update) => { if (update.interaction?.type === "terminal") abort.abort(); },
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "aborted");
  } finally { unused.resolve(""); await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude config rejects unknown fields, inert host scheduler modes and permission bypass", async () => {
  assert.throws(() => claudeAdapter.validateConfig({ autoCompactWindow: "99999" }), /100000/);
  assert.throws(() => claudeAdapter.validateConfig({ autoCompactWindow: "1000001" }), /100000/);
  assert.throws(() => claudeAdapter.validateConfig({ idleCompaction: "beforeCacheExpires" }), /orchestration/);
  assert.throws(() => claudeAdapter.validateConfig({ launchArgs: "--dangerously-skip-permissions" }), /authorization/);
  assert.throws(() => claudeAdapter.validateConfig({ launchArgs: "--resume another-session" }), /authorization/);
  assert.throws(() => claudeAdapter.validateConfig({ mystery: "value" }), /Unknown/);
  const f = await fixture();
  try {
    await assert.rejects(claudeQueryOptions({ ...f.context, config: { ...f.context.config, launchArgs: "--append-system-prompt-file ../outside" } }, new AbortController()), /within the resolved PM/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude telemetry separates result totals from live context and forwards rate limits", async () => {
  const f = await fixture(); const sdk = fakeSdk("telemetry");
  try {
    const updates: NativeUsageUpdate[] = [];
    const result = await sdk.adapter.run(f.context, { model: "native-claude", prompt: "fixture", onUsage: (update) => updates.push(update) });
    assert.equal(result.text, "native answer");
    assert.deepEqual(updates.filter((update) => update.context).map((update) => update.context?.usedTokens), [19, 22, 22]);
    assert.equal(updates[0]?.context?.promptCacheTtlMs, 3600000);
    assert.equal(updates.at(-1)?.context?.maxTokens, 200000);
    assert.deepEqual(updates.at(-1)?.turn, { model: "native-claude", costUsd: 0.42, totals: { uncachedInputTokens: 60, cachedInputTokens: 40, cacheCreationTokens: 20, outputTokens: 10, reasoningTokens: 0 } });
    assert.deepEqual(updates.find((update) => update.limits)?.limits?.windows, [{ id: "five_hour", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: 40, resetsAt: "2030-03-17T17:46:40.000Z" }]);
    const failure = new Error("usage consumer failed");
    await assert.rejects(sdk.adapter.run(f.context, { model: "native-claude", prompt: "fixture", onUsage: () => { throw failure; } }), (error) => error === failure);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
