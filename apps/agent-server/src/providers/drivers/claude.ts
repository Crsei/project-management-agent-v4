// Ported from t3code ClaudeProvider.ts, Drivers/ClaudeHome.ts and
// orchestration-v2/Adapters/ClaudeAdapterV2.ts (MIT). Uses the actual Agent SDK.
import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn as spawnPty } from "@lydell/node-pty";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { NativeSessionRef, ProviderConfig, ProviderModel } from "@agent-workspace/contracts/provider";
import type { NativeProviderAdapter, ProviderDriverContext } from "../driver-adapter.ts";
import type { CliChatResult, CliTokenUsage } from "../../agents/cli-chat.ts";
import { runProviderCommand } from "../process.ts";
import { expandNativePath, nativeFailure, nativeStringConfig, tokenizeNativeArgs } from "./codex-config.ts";
import { object } from "./codex-rpc.ts";
import { ClaudeOutput } from "./claude-output.ts";
import { ClaudeUsage } from "./claude-usage.ts";

export function validateClaudeConfig(input: ProviderConfig): ProviderConfig {
  const config = nativeStringConfig(input, { binaryPath: "claude", homePath: "", launchArgs: "", autoCompactWindow: "", idleCompaction: "default" });
  if (!config.binaryPath) config.binaryPath = "claude";
  if (!/^(?:|[1-9]\d{5}|1000000)$/.test(config.autoCompactWindow!)) throw new Error("autoCompactWindow must be empty or a whole token count from 100000 to 1000000.");
  // beforeCacheExpires is a host orchestration scheduler, not an SDK option.
  // Do not expose an inert or unsafe detached background-generation mode.
  if (!["default", "off"].includes(config.idleCompaction!)) throw new Error("idleCompaction supports default and off; onReturn user dialogs and beforeCacheExpires scheduling require the T3 host orchestration UI.");
  claudeLaunchFlags(config.launchArgs!);
  return config;
}

export function claudeLaunchFlags(input: string): Record<string, string | null> {
  const tokens = tokenizeNativeArgs(input);
  const flags: Record<string, string | null> = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!/^--[a-zA-Z][\w-]*(?:=.*)?$/.test(token)) throw new Error("Claude launch arguments must be long native CLI flags, without positional prompts.");
    const split = token.indexOf("=");
    const key = split < 0 ? token.slice(2) : token.slice(2, split);
    if (/^(?:dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode|allowedTools|allowed-tools|disallowedTools|disallowed-tools|add-dir|settings|setting-sources|mcp-config|strict-mcp-config|tools|resume|continue|fork-session|session-id|model|output-format|input-format|print|p|dangerously-load-development-channels|sdk-url|remote-control|bare|sandbox)$/.test(key)) throw new Error(`Claude launch argument cannot override PM session, authorization or transport: --${key}`);
    if (split >= 0) flags[key] = token.slice(split + 1);
    else if (tokens[index + 1] !== undefined && !tokens[index + 1]!.startsWith("--")) flags[key] = tokens[++index]!;
    else flags[key] = null;
  }
  return flags;
}

async function claudeEnvironment(context: ProviderDriverContext): Promise<NodeJS.ProcessEnv> {
  await mkdir(context.homeDirectory, { recursive: true, mode: 0o700 });
  return { ...context.env, CLAUDE_CONFIG_DIR: context.homeDirectory, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1", FORCE_CODE_TERMINAL: undefined };
}

async function claudeExecutable(context: ProviderDriverContext): Promise<string> {
  const binary = expandNativePath(String(context.config.binaryPath || "claude"));
  if (binary.includes(path.sep)) return path.resolve(context.cwd, binary);
  for (const directory of (context.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, binary);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next explicit PATH entry. */ }
  }
  throw Object.assign(new Error(`Claude native executable was not found: ${binary}`), { code: "ENOENT" });
}

export async function claudeQueryOptions(context: ProviderDriverContext, abortController: AbortController, probe = false): Promise<Options> {
  const environment = await claudeEnvironment(context);
  const flags = claudeLaunchFlags(String(context.config.launchArgs ?? ""));
  const inline = flags["append-system-prompt"];
  const filename = flags["append-system-prompt-file"];
  if (inline === null || filename === null) throw new Error("Claude append-system-prompt arguments require a value.");
  delete flags["append-system-prompt"]; delete flags["append-system-prompt-file"];
  let fileText: string | undefined;
  if (filename !== undefined && !probe) {
    const file = path.resolve(context.cwd, filename);
    if (file !== context.cwd && !file.startsWith(context.cwd + path.sep)) throw new Error("Claude system-prompt file must be within the resolved PM working directory.");
    fileText = (await readFile(file, "utf8")).replace(/\r?\n$/, "");
    if (fileText.length > 1_000_000) throw new Error("Claude system-prompt file exceeds the safe limit.");
  }
  const managedMcp = await access(process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-mcp.json" : "/etc/claude-code/managed-mcp.json").then(() => true, () => false);
  return {
    pathToClaudeCodeExecutable: await claudeExecutable(context), env: environment, cwd: context.cwd, abortController,
    permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "This PM session does not authorize interactive native tool permissions." }),
    mcpServers: {}, ...(managedMcp ? {} : { strictMcpConfig: true }),
    sandbox: { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false },
    settingSources: ["user", "project", "local"],
    settings: { disableAllHooks: true, ...(probe ? {} : { ...(context.config.autoCompactWindow ? { autoCompactWindow: Number(context.config.autoCompactWindow) } : {}), ...(context.config.idleCompaction === "off" ? { idleCompaction: false } : {}) }) },
    ...(probe ? { persistSession: false, tools: [], allowedTools: [] } : {
      includePartialMessages: true,
      ...(Object.keys(flags).length ? { extraArgs: flags } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: [fileText, inline].filter((text): text is string => typeof text === "string" && text.length > 0).join("\n\n") },
    }),
  };
}

export function createClaudeAdapter(queryImpl: typeof query = query): NativeProviderAdapter {
  return {
    definition: {
      driver: "claude", label: "Claude", description: "Native Claude Agent SDK with dedicated account configuration and real session resume.", defaultInstance: true,
      docsUrl: "https://code.claude.com/docs/en/overview", source: "t3code/packages/contracts/src/settings.ts#ClaudeSettings; apps/server/src/provider/{ClaudeProvider.ts,Drivers/ClaudeHome.ts}; orchestration-v2/Adapters/ClaudeAdapterV2.ts",
      fields: [
        { key: "binaryPath", label: "Binary path", type: "string", defaultValue: "claude", placeholder: "claude" },
        { key: "homePath", label: "CLAUDE_CONFIG_DIR path", type: "string", defaultValue: "", description: "Dedicated instance-owned configuration. Empty uses Agent's isolated home, never global credentials." },
        { key: "autoCompactWindow", label: "Auto-compact after", type: "string", defaultValue: "", placeholder: "300000", description: "Native Claude autoCompactWindow, 100000–1000000 tokens; empty uses Claude's default." },
        { key: "idleCompaction", label: "Compact idle threads", type: "select", defaultValue: "default", options: [{ value: "default", label: "Claude default" }, { value: "off", label: "Never" }], description: "Native idle-compaction disable switch. Host background cache-expiry scheduling is not enabled." },
        { key: "launchArgs", label: "Launch arguments", type: "string", defaultValue: "", description: "Native CLI arguments passed through the SDK; transport, session and PM authorization overrides are rejected." },
      ],
    },
    validateConfig: validateClaudeConfig,
    async check(context, signal) {
      const checkedAt = new Date().toISOString();
      const version = await runProviderCommand(expandNativePath(String(context.config.binaryPath || "claude")), ["--version"], { cwd: context.cwd, env: await claudeEnvironment(context), signal });
      if (signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
      if (!version.installed || version.code !== 0) return { installation: { status: version.installed ? "unknown" : "not-installed", checkedAt, error: nativeFailure(context, version.stderr || "Claude version probe failed.").message }, authentication: "unknown", models: [], methods: [{ id: "terminal", name: "Claude sign-in", type: "terminal" }], canLogout: false };
      const abort = new AbortController();
      const release = Promise.withResolvers<void>();
      const cancel = () => { abort.abort(); release.resolve(); };
      signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, 20_000);
      let q: Query | undefined;
      try {
        const opts = await claudeQueryOptions(context, abort, true);
        // oxlint-disable-next-line require-yield -- Keep SDK input open for metadata initialization without sending a user turn.
        q = queryImpl({ prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await release.promise; })(), options: opts });
        const init = await q.initializationResult();
        const account = object(init.account);
        const authenticated = (typeof account.apiProvider === "string" && account.apiProvider !== "firstParty") ||
          (typeof account.tokenSource === "string" && account.tokenSource.length > 0 && account.tokenSource !== "none") ||
          Boolean(account.email || account.subscriptionType || (account.apiKeySource && account.apiKeySource !== "none"));
        const models: ProviderModel[] = [];
        const seen = new Set<string>();
        for (const model of await q.supportedModels()) {
          if (model.value && !seen.has(model.value)) { seen.add(model.value); models.push({ id: model.value, label: model.displayName || model.value, source: "discovered", temperature: false, reasoning: model.supportsEffort === true || model.supportsAdaptiveThinking === true }); }
        }
        const externalCredential = Boolean(context.env.ANTHROPIC_API_KEY || context.env.ANTHROPIC_AUTH_TOKEN || context.env.CLAUDE_CODE_OAUTH_TOKEN) ||
          (typeof account.apiProvider === "string" && account.apiProvider !== "firstParty");
        return {
          installation: { status: "installed", checkedAt, version: version.stdout.trim().slice(0, 200), executablePath: opts.pathToClaudeCodeExecutable },
          authentication: authenticated ? "authenticated" : account.tokenSource === "none" ? "unauthenticated" : "unknown",
          ...(typeof account.email === "string" ? { email: account.email } : {}),
          authLabel: account.apiKeySource && account.apiKeySource !== "none" ? "Claude API key" : "Claude account",
          models,
          methods: [{ id: "terminal", name: "Claude sign-in", type: "terminal", description: "Runs claude auth login in this instance's isolated home. Native API-key authentication also honors this instance's explicitly configured ANTHROPIC_API_KEY environment." }],
          canLogout: authenticated && !externalCredential,
          capabilities: { nativeResume: true, nativeFork: true, boundedFork: true, modelTransition: "native", portableHandoff: true },
        };
      } catch (error) {
        if (signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
        return { installation: { status: "installed", checkedAt, version: version.stdout.trim().slice(0, 200) }, authentication: "unknown", models: [], methods: [{ id: "terminal", name: "Claude sign-in", type: "terminal" }], canLogout: false, message: nativeFailure(context, error).message };
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); cancel(); q?.close(); }
    },
    async authenticate(context, options) {
      if (options.methodId && options.methodId !== "terminal") throw new Error("Unsupported native Claude authentication method.");
      if (options.signal.aborted) throw nativeFailure(context, "Request cancelled.", true);
      const env = await claudeEnvironment(context);
      const terminal = spawnPty(await claudeExecutable(context), ["auth", "login"], { cwd: context.cwd, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), name: "xterm-256color", cols: 100, rows: 30 });
      const exit = Promise.withResolvers<number>();
      let output = ""; let emittedOutput = ""; let finished = false; let stopped = false;
      const stopTerminal = () => { if (!finished && !stopped) { stopped = true; terminal.kill("SIGKILL"); } };
      const abort = () => { stopTerminal(); exit.reject(nativeFailure(context, "Request cancelled.", true)); };
      options.signal.addEventListener("abort", abort, { once: true });
      const data = terminal.onData((chunk) => {
        output = (output + chunk).slice(-16_384);
        // oxlint-disable-next-line no-control-regex -- Remove native terminal ANSI escapes before exposing authentication output.
        let safe = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        for (const [key, value] of Object.entries(env)) if (value && value.length >= 4 && /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) safe = safe.split(value).join("[redacted]");
        safe = safe.replace(/sk-[\w-]{6,}/g, "[redacted]").replace(/Bearer\s+[\w.~+/=:-]+/gi, "Bearer [redacted]");
        const delta = safe.startsWith(emittedOutput) ? safe.slice(emittedOutput.length) : safe;
        emittedOutput = safe;
        options.onUpdate({ phase: "waiting", output: delta, interaction: { type: "terminal", id: "claude-login", output: safe } });
      });
      const listener = terminal.onExit(({ exitCode }) => { finished = true; exit.resolve(exitCode); });
      void (async () => { while (!finished && !options.signal.aborted) { const input = await options.readInput(); if (!finished && !options.signal.aborted) terminal.write(input.endsWith("\n") || input.endsWith("\r") ? input : input + "\r"); } })().catch((error) => { if (!finished) { stopTerminal(); exit.reject(error); } });
      try {
        if (options.signal.aborted) abort();
        const code = await exit.promise;
        if (code !== 0) throw nativeFailure(context, `Claude login exited with code ${code}.`);
        options.onUpdate({ phase: "verifying", interaction: null });
        const result = await runProviderCommand(expandNativePath(String(context.config.binaryPath || "claude")), ["auth", "status", "--json"], { cwd: context.cwd, env, signal: options.signal });
        let status: Record<string, unknown> = {}; try { status = object(JSON.parse(result.stdout)); } catch { /* Invalid output is not authentication. */ }
        if (result.code !== 0 || status.loggedIn !== true) throw nativeFailure(context, "Claude did not confirm authenticated native credentials after login.");
      } finally { stopTerminal(); finished = true; data.dispose(); listener.dispose(); options.signal.removeEventListener("abort", abort); }
    },
    async logout(context, signal) {
      const env = await claudeEnvironment(context);
      const result = await runProviderCommand(expandNativePath(String(context.config.binaryPath || "claude")), ["auth", "logout"], { cwd: context.cwd, env, signal });
      if (signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
      if (result.code !== 0) throw nativeFailure(context, result.stderr || "Claude native logout failed.");
      const status = await runProviderCommand(expandNativePath(String(context.config.binaryPath || "claude")), ["auth", "status", "--json"], { cwd: context.cwd, env, signal });
      let observed: Record<string, unknown> = {}; try { observed = object(JSON.parse(status.stdout)); } catch { throw new Error("Claude logout could not confirm native credential removal."); }
      if (observed.loggedIn !== false) throw new Error("Claude remains authenticated (possibly through an instance environment API key); remove that credential explicitly.");
    },
    async run(context, options) {
      if (!options.model.trim()) throw nativeFailure(context, "A native Claude model is required.");
      if (options.signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
      if (options.resume && (options.resume.driver !== "claude" || options.resume.providerInstanceId !== context.instanceId || (options.resume.instanceRevision !== undefined && options.resume.instanceRevision !== context.revision) || (options.resume.cwd !== undefined && options.resume.cwd !== context.cwd))) throw nativeFailure(context, "Native Claude session belongs to another instance, revision or working directory.");
      const abort = new AbortController();
      let q: Query | undefined;
      const cancel = () => { void q?.interrupt().catch(() => undefined); abort.abort(); q?.close(); };
      options.signal?.addEventListener("abort", cancel, { once: true });
      let text = ""; let usage: CliTokenUsage | undefined; let nativeSession: NativeSessionRef | undefined; let completed = false; let failure: unknown; let rateLimitEvidence: Record<string, unknown> | undefined; let callbackFailure: unknown;
      let usageCallbackFailed = false;
      let usageCallbackError: unknown;
      const output = new ClaudeOutput(options.onEvent, (delta) => { text += delta; options.onText?.(delta); });
      const telemetry = new ClaudeUsage();
      try {
        const sdkOptions = await claudeQueryOptions(context, abort);
        const denyTool = sdkOptions.canUseTool!;
        sdkOptions.canUseTool = async (toolName, input, permissionOptions) => {
          try { if (!abort.signal.aborted && !permissionOptions.signal.aborted) output.permission(toolName, input, permissionOptions.toolUseID); }
          catch (error) { callbackFailure = error; abort.abort(); throw error; }
          return denyTool(toolName, input, permissionOptions);
        };
        if (options.signal?.aborted) throw nativeFailure(context, "Request cancelled.", true);
        q = queryImpl({ prompt: options.prompt, options: { ...sdkOptions, model: options.model, ...(options.resume ? { resume: options.resume.sessionId } : {}) } });
        for await (const message of q) {
          if (typeof message.session_id === "string") {
            if (options.resume && options.resume.sessionId !== message.session_id) throw new Error("Claude did not resume the requested native session.");
            nativeSession = { ...nativeSession, providerInstanceId: context.instanceId, driver: "claude", sessionId: message.session_id, modelId: options.model, cwd: context.cwd, instanceRevision: context.revision, ...(message.type === "assistant" ? { messageId: message.uuid } : {}) };
            options.onSession?.(nativeSession);
          }
          output.handle(message);
          const usageUpdate = options.onUsage ? telemetry.update(message) : undefined;
          if (usageUpdate) {
            try { options.onUsage!(usageUpdate); }
            catch (error) { usageCallbackFailed = true; usageCallbackError = error; throw error; }
          }
          if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") rateLimitEvidence = { ...message.rate_limit_info, code: "usage_limit" };
          if (message.type === "assistant" && message.error) {
            const full = message.message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("");
            failure = { ...rateLimitEvidence, code: message.error, message: full || message.error };
          }
          if (message.type === "result") {
            completed = true;
            usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
            if (message.subtype !== "success" || message.is_error) failure = failure ?? { ...rateLimitEvidence, ...message, message: message.subtype === "success" ? message.result : message.errors.join("\n") };
            // SDK can hold a successful result while background work reports. Do
            // not use iterator EOF or partial assistant text as a terminal result.
            break;
          }
        }
        if (options.signal?.aborted || abort.signal.aborted) throw nativeFailure(context, "Request cancelled.", true);
        if (failure) throw nativeFailure(context, failure);
        if (!completed || !nativeSession || !text.trim()) throw nativeFailure(context, "Claude closed without a successful terminal result, native session and assistant text.");
        return { text, nativeSession, ...(usage ? { usage } : {}) } satisfies CliChatResult;
      } catch (error) { if (usageCallbackFailed) throw usageCallbackError; throw callbackFailure ?? nativeFailure(context, error, options.signal?.aborted); }
      finally { options.signal?.removeEventListener("abort", cancel); abort.abort(); q?.close(); }
    },
  };
}

export const claudeAdapter = createClaudeAdapter();
