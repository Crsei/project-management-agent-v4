// Native MSP implementation ported from t3code/packages/provider-muse/src/server/{sdk,status,modelCatalog,adapter}.ts (MIT).
import path from "node:path";
import pty from "@lydell/node-pty";
import type { NativeSessionRef, ProviderAuthMethod } from "@agent-workspace/contracts/provider";
import type { UsageTokenTotals } from "@agent-workspace/contracts/usage";
import type { NativeInteractionRequest, NativeInteractionResponse, NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";
import { CliChatError, sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import type { NativeProviderAdapter, ProviderDriverContext, ProviderDriverStatus } from "../driver-adapter.ts";
import { runProviderCommand } from "../process.ts";
import { createMuseHost, museBinary, museEnvironment, museRequest, readMuseItemOutput, validateMuseConfig } from "./muse-sdk.ts";
import { MuseTurnOutput, museLimits, museRecord, museTokens, parseMuseModels } from "./muse-protocol.ts";
import { ReportedTurnAccumulator, reportedCount } from "./reported-turn.ts";

const methods: ProviderAuthMethod[] = [{ id: "cli-login", name: "Sign in with Muse CLI", description: "Run the source-supported muse login command in this instance's dedicated home. Muse MSP itself has no authentication status endpoint.", type: "terminal" }];
const capabilities = { nativeResume: true, nativeFork: false, boundedFork: false, modelTransition: "native" as const, portableHandoff: true as const };
function safeText(context: ProviderDriverContext, text: unknown): string {
  let message = text instanceof Error ? text.message : typeof text === "string" ? text : "Muse native operation failed.";
  for (const [key, value] of Object.entries(context.env)) if (value && /(?:api.?key|token|secret|password|authorization)/i.test(key)) message = message.replaceAll(value, "[redacted]");
  return sanitizeErrorMessage(message);
}

function museQuestionAnswers(questions: Record<string, unknown>[], response: NativeInteractionResponse) {
  if (!response.answers || response.optionId !== undefined) throw new Error("Invalid Muse question response.");
  return questions.map((question) => {
    const id = question.id as string;
    const raw = response.answers?.[id];
    if (typeof raw !== "string" && !Array.isArray(raw)) throw new Error("Muse requires an answer for every question.");
    const values = [...new Set(typeof raw === "string" ? [raw] : raw)];
    if (values.some((value) => typeof value !== "string" || !value)) throw new Error("Invalid Muse question answer.");
    const options = Array.isArray(question.options) ? question.options.map(museRecord) : [];
    const selected = values.filter((value) => options.some((option) => option.label === value));
    const freeText = values.filter((value) => !selected.includes(value)).join("\n");
    const selection = museRecord(question.selection);
    const minimum = typeof selection.minSelections === "number" ? selection.minSelections : 0;
    const maximum = typeof selection.maxSelections === "number" ? selection.maxSelections : Infinity;
    if ((!selected.length && !freeText) || freeText.length > 500 || (selection.mode === "single" && selected.length > 1) || (selected.length > 0 && (selected.length < minimum || selected.length > maximum))) throw new Error("Invalid Muse question selection.");
    return { questionId: id, ...(selected.length ? selection.mode === "single" ? { selectedLabel: selected[0] } : { selectedLabels: selected } : {}), ...(freeText ? selected.length ? { note: freeText } : { freeText } : {}) };
  });
}

async function checkMuse(context: ProviderDriverContext, signal?: AbortSignal): Promise<ProviderDriverStatus> {
  signal?.throwIfAborted();
  const version = await runProviderCommand(museBinary(context), ["--version"], { cwd: context.cwd, env: museEnvironment(context), signal, timeoutMs: 4_000 });
  signal?.throwIfAborted();
  const versionNumber = `${version.stdout}\n${version.stderr}`.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
  const base: ProviderDriverStatus = {
    installation: { status: version.installed ? "installed" : "not-installed", executablePath: museBinary(context), checkedAt: new Date().toISOString(), ...(versionNumber ? { version: versionNumber } : {}) },
    authentication: "unknown", methods, canLogout: false, models: [], capabilities,
  };
  if (!version.installed) return { ...base, message: "Muse CLI was not found. Install Muse Code and choose its binary path, then sign in with muse login." };
  if (version.code !== 0) return { ...base, installation: { ...base.installation, error: "Muse version check failed or timed out." }, message: "Muse CLI is installed but could not complete its version check." };
  const host = await createMuseHost(context, { signal, readOnly: true, startupTimeoutMs: 8_000 }).catch((error) => {
    signal?.throwIfAborted();
    return safeText(context, error);
  });
  if (typeof host === "string") return { ...base, message: `Muse SDK could not initialize: ${host}` };
  try {
    const result = await museRequest(host, "model/list", host.connection.request("model/list", {}), signal, 12_000);
    const models = parseMuseModels(result);
    // Muse returns a cached catalog even when logged out. This is deliberately NOT authentication evidence.
    return { ...base, models, message: models.length ? "Muse native catalog is available. Authentication is checked by Muse on the first turn; MSP exposes no auth-status signal." : "Muse returned no models. Run muse login for this instance and refresh." };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...base, message: `Muse could not read its native model catalog: ${safeText(context, error)}` };
  } finally { await host.close(); }
}

export const museAdapter: NativeProviderAdapter = {
  definition: {
    driver: "muse", label: "Muse Code", description: "Muse Code with its native MSP SDK, account authentication, and discovered model catalog.", defaultInstance: false,
    source: "t3code/packages/provider-muse/src/settings.ts; server/{sdk,status,modelCatalog,protocol,adapter}.ts",
    fields: [{ key: "binaryPath", label: "Binary path", description: "Path to the Muse Code binary on this server. Authentication runs muse login using this instance's dedicated home.", type: "string", defaultValue: "muse", placeholder: "muse" }],
  },
  validateConfig: validateMuseConfig,
  check: checkMuse,
  async authenticate(context, options) {
    if (options.methodId && options.methodId !== "cli-login") throw new Error("Unknown Muse authentication method.");
    options.signal.throwIfAborted();
    const env = Object.fromEntries(Object.entries(museEnvironment(context)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const child = pty.spawn(museBinary(context), ["login"], { cwd: context.cwd, env, name: "xterm-256color", cols: 100, rows: 30 });
    const completion = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    void completion.promise.catch(() => {});
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const output = child.onData((chunk) => options.onUpdate({ phase: "waiting", output: safeText(context, chunk) }));
    const exit = child.onExit(({ exitCode, signal }) => {
      exited = true;
      stopped.resolve();
      clearTimeout(killTimer);
      if (options.signal.aborted) completion.reject(options.signal.reason ?? new Error("Muse login cancelled."));
      else if (exitCode === 0 && !signal) completion.resolve();
      else completion.reject(new Error(`Muse login exited unsuccessfully (${signal || exitCode}).`));
    });
    const abort = () => {
      completion.reject(options.signal.reason ?? new Error("Muse login cancelled."));
      if (!exited) {
        try { child.kill("SIGTERM"); } catch { /* Process already exited. */ }
        killTimer = setTimeout(() => { if (!exited) { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } } }, 1_000);
        killTimer.unref();
      }
    };
    options.signal.addEventListener("abort", abort, { once: true });
    options.onUpdate({ phase: "waiting", interaction: { type: "terminal", id: `muse-login-${context.instanceId}`, output: "Running muse login in this provider instance's dedicated home. Follow the native login instructions below." } });
    const forwardInput = async () => {
      while (!exited && !options.signal.aborted) {
        const input = await Promise.race([options.readInput().then((value) => ({ value })), completion.promise.then(() => null)]);
        if (!input || exited) break;
        child.write(input.value.endsWith("\n") || input.value.endsWith("\r") ? input.value : `${input.value}\r`);
      }
    };
    void forwardInput().catch(completion.reject);
    try { if (options.signal.aborted) abort(); await completion.promise; }
    finally {
      options.signal.removeEventListener("abort", abort);
      if (!exited) {
        try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
        clearTimeout(killTimer);
        killTimer = setTimeout(() => { if (!exited) { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } } }, 1_000);
        killTimer.unref();
        await stopped.promise;
      }
      output.dispose();
      exit.dispose();
    }
  },
  async logout() { throw new Error("Muse sign-out is managed by the native Muse CLI in this instance's dedicated home. MSP has no logout API; Agent does not delete native credentials."); },
  async run(context, options) {
    const resume = options.resume;
    if (resume && (resume.driver !== "muse" || resume.providerInstanceId !== context.instanceId || (resume.instanceRevision !== undefined && resume.instanceRevision !== context.revision) || (resume.cwd && path.resolve(resume.cwd) !== path.resolve(context.cwd))))
      throw new CliChatError("provider_error", "Muse session belongs to a different provider instance, revision, or workspace.");
    const host = await createMuseHost(context, { signal: options.signal }).catch((error) => {
      if (options.signal?.aborted) throw new CliChatError("aborted", "Muse turn cancelled.");
      throw new CliChatError("provider_error", safeText(context, error), error, context.instanceId);
    });
    const sessionId = resume?.sessionId ?? host.connection.mintCommandId();
    const turnId = host.connection.mintCommandId();
    let callbackFailed = false;
    let callbackError: unknown;
    const onEvent = options.onEvent && ((event: NativeOutputEvent) => {
      try { options.onEvent?.(event); } catch (error) { callbackFailed = true; callbackError = error; throw error; }
    });
    const onText = options.onText && ((text: string) => {
      try { options.onText?.(text); } catch (error) { callbackFailed = true; callbackError = error; throw error; }
    });
    let turnTotals: UsageTokenTotals | undefined;
    let incompleteTokenEvents = false;
    const reportedTotals = new ReportedTurnAccumulator();
    const onUsage = options.onUsage && ((update: Parameters<NonNullable<typeof options.onUsage>>[0]) => {
      try { options.onUsage?.(update); } catch (error) { callbackFailed = true; callbackError = error; throw error; }
    });
    const reportTokens = (raw: unknown, input?: number, accumulate = false) => {
      const usage = museRecord(raw);
      const next = museTokens(raw, input);
      const reportedTurn = accumulate
        ? reportedTotals.add(input, usage.outputTokens, usage.cacheReadTokens ?? usage.cachedTokens, usage.cacheWriteTokens, usage.reasoningTokens)
        : reportedCount(usage.inputTokens) && reportedCount(usage.outputTokens)
          ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            ...(reportedCount(usage.cacheReadTokens ?? usage.cachedTokens) ? { cachedInputTokens: (usage.cacheReadTokens ?? usage.cachedTokens) as number } : {}),
            ...(reportedCount(usage.cacheWriteTokens) ? { cacheCreationTokens: usage.cacheWriteTokens } : {}),
            ...(reportedCount(usage.reasoningTokens) ? { reasoningTokens: usage.reasoningTokens } : {}) }
          : undefined;
      if (!next) { if (accumulate) incompleteTokenEvents = true; if (reportedTurn) onUsage?.({ reportedTurn }); return; }
      if (accumulate && incompleteTokenEvents) { if (reportedTurn) onUsage?.({ reportedTurn }); return; }
      if (accumulate && turnTotals) {
        const sum: UsageTokenTotals = {
          uncachedInputTokens: turnTotals.uncachedInputTokens + next.uncachedInputTokens,
          cachedInputTokens: turnTotals.cachedInputTokens + next.cachedInputTokens,
          cacheCreationTokens: turnTotals.cacheCreationTokens + next.cacheCreationTokens,
          outputTokens: turnTotals.outputTokens + next.outputTokens,
          reasoningTokens: turnTotals.reasoningTokens + next.reasoningTokens,
        };
        if (Object.values(sum).some((value) => !Number.isSafeInteger(value))) { incompleteTokenEvents = true; if (reportedTurn) onUsage?.({ reportedTurn }); return; }
        turnTotals = sum;
      } else turnTotals = next;
      onUsage?.({ turn: { totals: turnTotals }, ...(reportedTurn ? { reportedTurn } : {}) });
    };
    const output = new MuseTurnOutput(sessionId, turnId, onText, onEvent);
    const completion = Promise.withResolvers<void>();
    void completion.promise.catch(() => {});
    let terminal = false;
    let started = false;
    const reject = (error: unknown) => { if (!terminal) completion.reject(error); };
    const command = (method: string, params: Record<string, unknown>, commandId?: string) => museRequest(host, method, host.connection.command(method, { sessionId, ...params }, { ...(method === "turn/start" ? {} : { maxAttempts: 1 }), ...(commandId ? { commandId } : {}) }), options.signal);
    const pendingQuestions = new Map<string, { item: NativeOutputItem; active: boolean }>();
    const questionCommands = new Set<Promise<unknown>>();
    const handleQuestion = async (params: Record<string, unknown>) => {
      const nativeId = params.userInputId;
      if (typeof nativeId !== "string" || !nativeId) throw new Error("Invalid Muse user input request.");
      if (pendingQuestions.has(nativeId)) return;
      const id = `muse:input:${nativeId}`;
      const nativeQuestions = Array.isArray(params.questions) ? params.questions.map(museRecord) : [];
      const valid = nativeQuestions.length > 0 && nativeQuestions.every((question) => typeof question.id === "string" && !!question.id && typeof question.question === "string" && Array.isArray(question.options) && ["single", "multiple"].includes(String(museRecord(question.selection).mode))) && new Set(nativeQuestions.map((question) => question.id)).size === nativeQuestions.length;
      const questions: NonNullable<NativeInteractionRequest["questions"]> = nativeQuestions.flatMap((question) => {
        if (typeof question.id !== "string" || typeof question.question !== "string") return [];
        const selection = museRecord(question.selection);
        const choices = Array.isArray(question.options) ? question.options.map(museRecord).flatMap((option) => typeof option.label === "string" && option.label ? [{ id: option.label, label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }] : []) : [];
        return [{ id: question.id, prompt: question.question, ...(typeof question.header === "string" ? { title: question.header } : {}), options: choices, multiple: selection.mode === "multiple", allowText: true }];
      });
      const respondable = !!options.onRequest && valid;
      const request: NativeInteractionRequest = { id, itemId: id, kind: "user_input", title: "Muse question", questions, respondable, ...(respondable ? {} : { unavailableReason: "No usable native question callback is available." }) };
      const item: NativeOutputItem = { id, nativeItemId: nativeId, type: "user_input_request", status: "waiting", ...(typeof params.itemId === "string" ? { parentItemId: `muse:item:${params.itemId}` } : {}), request };
      const pending = { item, active: true };
      pendingQuestions.set(nativeId, pending);
      onEvent?.({ type: "item.upsert", item });
      if (!respondable || !options.onRequest) {
        await command("userInput/cancel", { userInputId: nativeId, reason: "Agent cannot answer native interactive questions." });
        throw new Error("Muse requested interactive input; use its native terminal to continue.");
      }
      let response: NativeInteractionResponse;
      try { response = await options.onRequest(request); }
      catch (error) {
        if (!pending.active && museRecord(error).code === "native_interaction_closed") return;
        callbackFailed = true; callbackError = error; throw error;
      }
      if (!pending.active || terminal || options.signal?.aborted) return;
      const work = response.cancelled
        ? command("userInput/cancel", { userInputId: nativeId, reason: "User declined the question." })
        : command("userInput/answer", { userInputId: nativeId, answers: museQuestionAnswers(nativeQuestions, response) });
      questionCommands.add(work);
      try { await work; } finally { questionCommands.delete(work); }
    };
    host.connection.onNotification((notification) => {
      try {
        const params = museRecord(notification.params);
        if (notification.method === "usage/changed") {
          const limits = museLimits(params);
          if (limits) onUsage?.({ limits });
          return;
        }
        if (params.sessionId !== undefined && params.sessionId !== sessionId) return;
        if (params.sessionId === sessionId && notification.method === "session/contextUsage") {
          if (typeof params.usedTokens === "number" && Number.isSafeInteger(params.usedTokens) && params.usedTokens >= 0) {
            const max = params.windowTokens;
            onUsage?.({ context: { usedTokens: params.usedTokens, ...(typeof max === "number" && Number.isSafeInteger(max) && max > 0 ? { maxTokens: max } : {}), updatedAt: new Date().toISOString() } });
          }
          return;
        }
        if (params.sessionId === sessionId && params.turnId === turnId && notification.method === "session/tokenUsage") {
          if (reportedCount(params.promptTokens)) reportTokens(params.usage, params.promptTokens, true);
          else { reportedTotals.add(undefined, undefined, undefined, undefined, undefined); incompleteTokenEvents = true; }
          return;
        }
        if (params.sessionId === sessionId && params.turnId === turnId && notification.method === "turn/completed") {
          if (!incompleteTokenEvents) {
            const input = turnTotals ? turnTotals.uncachedInputTokens + turnTotals.cachedInputTokens + turnTotals.cacheCreationTokens : undefined;
            reportTokens(params.usage, input);
          } else {
            const usage = museRecord(params.usage);
            if (reportedCount(usage.inputTokens) && reportedCount(usage.outputTokens)) {
              const reported = new ReportedTurnAccumulator().add(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? usage.cachedTokens, usage.cacheWriteTokens, usage.reasoningTokens);
              if (reported) onUsage?.({ reportedTurn: reported });
            }
          }
        }
        if (["approval/requested", "approval/updated"].includes(notification.method)) {
          const choices = Array.isArray(params.availableChoices) ? params.availableChoices.map(museRecord) : [];
          const deny = choices.find((choice) => choice.decision === "denied") ?? choices.find((choice) => choice.decision === "abort");
          if (deny && typeof params.approvalId === "string") void command("approval/decide", { approvalId: params.approvalId, requirementId: params.currentRequirementId, choiceId: deny.choiceId }).catch(reject);
          if (typeof params.approvalId === "string") {
            const id = `muse:approval:${params.approvalId}`;
            const subject = museRecord(params.subject);
            const detail = [params.toolName, subject.command, subject.path, subject.host, subject.target].filter((part): part is string => typeof part === "string" && !!part).join(" — ");
            onEvent?.({ type: "item.upsert", item: { id, nativeItemId: params.approvalId, type: "approval_request", status: "waiting", ...(typeof params.itemId === "string" ? { parentItemId: `muse:item:${params.itemId}` } : {}), request: { id, itemId: id, kind: "approval", title: "Muse approval", detail, respondable: false, unavailableReason: "Agent denies Muse approvals under its existing security policy.", options: choices.filter((choice) => (choice.decision === "denied" || choice.decision === "abort") && typeof choice.choiceId === "string").map((choice) => ({ id: choice.choiceId as string, label: typeof choice.label === "string" ? choice.label : "Deny" })) } } });
          }
          reject(new Error("Muse requested interactive approval. Agent did not approve the action; use the native terminal to continue."));
        } else if (notification.method === "userInput/requested") {
          if (typeof params.turnId === "string" && !output.ownsTurn(params.turnId)) return;
          void handleQuestion(params).catch(reject);
        } else if (notification.method === "userInput/settled") {
          const pending = typeof params.userInputId === "string" ? pendingQuestions.get(params.userInputId) : undefined;
          if (pending?.active) {
            pending.active = false;
            const request = pending.item.request!;
            const status = params.outcome === "answered" || params.outcome === "clarified" ? "completed" : params.outcome === "interrupted" ? "interrupted" : "cancelled";
            onEvent?.({ type: "item.upsert", item: { ...pending.item, status, request: { ...request, respondable: false, unavailableReason: "Muse has settled this question." } } });
          }
        } else if (output.consume(notification.method, notification.params)) { terminal = true; completion.resolve(); }
      } catch (error) { reject(error); }
    });
    host.connection.onProtocolError(reject);
    host.connection.onServerRequest(async (request) => {
      if (request.method === "approval/request" || request.method === "userInput/request") return {};
      const error = new Error(`Unsupported Muse server request: ${request.method}`);
      reject(error);
      throw error;
    });
    void host.connection.closed.then(() => reject(new Error("Muse connection closed before a successful terminal event.")), reject);
    void host.exited.then(() => reject(new Error("Muse process exited before a successful terminal event.")), reject);
    const abort = () => {
      reject(options.signal?.reason ?? new Error("Muse turn cancelled."));
      if (started) void host.connection.command("turn/interrupt", { sessionId, turnId }, { maxAttempts: 1 }).catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      let modelId = options.model && options.model !== "default" ? options.model : undefined;
      if (!modelId) {
        const catalog = await museRequest(host, "model/list", host.connection.request("model/list", {}), options.signal);
        parseMuseModels(catalog);
        const models = museRecord(catalog).models as unknown[];
        const defaultEntry = models.map(museRecord).find((model) => model.providerId === "meta" && model.isDefault === true);
        modelId = typeof defaultEntry?.modelId === "string" ? defaultEntry.modelId : undefined;
      }
      const startedSession = museRecord(await command(resume ? "session/resume" : "session/start", resume ? { excludeItems: true, permissionProfile: ":ask-me" } : { workspaceRoot: context.cwd, providerId: "meta", ...(modelId ? { modelId } : {}), approvalMode: "promptUnmatched", permissionProfile: ":ask-me" }));
      const session = museRecord(startedSession.session);
      if (session.sessionId !== sessionId) throw new Error("Muse returned a different native session identity.");
      if (resume) {
        await command("session/setApprovalMode", { mode: "promptUnmatched" });
        if (modelId && session.modelId !== modelId) await command("session/setModel", { model: { modelId, providerId: "meta" } });
      }
      const nativeSession: NativeSessionRef = { providerInstanceId: context.instanceId, driver: "muse", sessionId, turnId, modelId: modelId ?? options.model, cwd: context.cwd, instanceRevision: context.revision };
      options.onSession?.(nativeSession);
      started = true;
      const acknowledgement = command("turn/start", { input: [{ type: "text", text: options.prompt }], displayText: options.prompt, workspaceRoots: [context.cwd], ifBusy: "queue" }, turnId).then((value) => {
        if (museRecord(value).turnId !== turnId) throw new Error("Muse admitted the turn under an unexpected identity.");
      });
      // A native terminal may arrive before the command acknowledgement; neither acknowledgement nor process exit is success.
      await Promise.race([acknowledgement.then(() => completion.promise), completion.promise]);
      options.signal?.throwIfAborted();
      await Promise.all(questionCommands);
      for (const ref of output.references()) {
        const stored = await readMuseItemOutput(host, sessionId, ref.itemId, ref.refId, options.signal);
        if (stored) output.applyReference(ref, stored.content, stored.truncated);
      }
      if (callbackFailed) throw callbackError;
      if (output.terminal !== "completed") throw new CliChatError(output.terminal === "cancelled" ? "aborted" : "provider_error", safeText(context, output.failure ?? `Muse turn ${output.terminal ?? "failed"}.`), output.failure, context.instanceId);
      return { text: output.text, usage: output.usage, nativeSession };
    } catch (error) {
      if (callbackFailed) throw callbackError;
      if (options.signal?.aborted) throw new CliChatError("aborted", "Muse turn cancelled.");
      if (error instanceof CliChatError) throw error;
      throw new CliChatError("provider_error", safeText(context, error), error, context.instanceId);
    } finally { options.signal?.removeEventListener("abort", abort); await host.close(); }
  },
};
