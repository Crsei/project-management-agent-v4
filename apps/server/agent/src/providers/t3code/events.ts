import * as DateTime from "effect/DateTime";
import type { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem, OrchestrationV2ConversationMessage, OrchestrationV2PlanArtifact, OrchestrationV2Subagent } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { NativeInteractionRequest, NativeOutputEvent, NativeOutputItem } from "@agent-workspace/contracts/output";
import { normalizeToolValue } from "../../durable/native-output.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { classifyProviderError } from "../errors.ts";
import { pmExecutionError } from "./continuation.ts";
import type { PmProviderBoundaryError } from "./contract.ts";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import { mcpAppMetadataSchema, mcpAppToolResultSchema, type McpAppProducingIdentity } from "@agent-workspace/contracts/mcp-apps";

type RequestItem = Extract<OrchestrationV2TurnItem, { type: "user_input_request" | "approval_request" }>;
const active: Readonly<Partial<Record<string, true>>> = { idle: true, pending: true, running: true, waiting: true };
export function pmEventTime(value: DateTime.Utc | null): string | undefined {
  return value === null ? undefined : DateTime.formatIso(value);
}

/** The only cumulative-body projection; messages are a lookup, never a second text stream. */
export function makePmEventAdapter(input: {
  onEvent?: (event: NativeOutputEvent) => void;
  onText?: (text: string) => void;
  onRequest: (request: NativeInteractionRequest, source: OrchestrationV2RuntimeRequest) => void;
  onRequestClosed: (requestId: string) => void;
  canRespond: boolean;
  isRootItem?: (item: OrchestrationV2TurnItem) => boolean;
  isLiveRequest?: (request: OrchestrationV2RuntimeRequest) => boolean;
  rootThreadId?: string;
  mcpAppIdentity?: (item: OrchestrationV2TurnItem) => McpAppProducingIdentity | undefined;
}) {
  const items = new Map<string, NativeOutputItem>();
  const sourceItems = new Map<string, OrchestrationV2TurnItem>();
  const messages = new Map<string, OrchestrationV2ConversationMessage>();
  const requests = new Map<string, OrchestrationV2RuntimeRequest>();
  const requestItems = new Map<string, RequestItem>();
  const startedRequests = new Set<string>();
  const closedRequests = new Set<string>();
  const planItems = new Map<string, string>();
  const plans = new Map<string, OrchestrationV2PlanArtifact>();
  const subagents = new Map<string, OrchestrationV2Subagent>();
  const childNativeSessions = new Map<string, string>();
  const rootAssistantIds = new Set<string>();
  const publish = (item: NativeOutputItem) => {
    const previous = items.get(item.id);
    items.set(item.id, item);
    input.onEvent?.({ type: "item.upsert", item });
    if (item.type === "assistant_message" && rootAssistantIds.has(item.id)) {
      const before = previous?.text ?? "";
      const after = item.text ?? "";
      if (after.startsWith(before) && after.length > before.length) input.onText?.(after.slice(before.length));
    }
  };
  const projectSubagent = (child: OrchestrationV2Subagent, id: string, fallback?: NativeOutputItem) => {
    publish({ ...fallback, id, type: "subagent", status: child.status === "idle" ? "pending" : child.status,
      title: child.title ?? fallback?.title,
      childSessionId: (child.childThreadId ? childNativeSessions.get(child.childThreadId) ?? child.childThreadId : undefined) ?? child.nativeTaskRef?.nativeId ?? undefined,
      model: child.model ?? child.modelSelection?.model,
      text: child.progress ?? (child.promptOmitted ? items.get(id)?.text ?? fallback?.text : child.prompt),
      output: child.resultOmitted ? items.get(id)?.output ?? fallback?.output : child.result ?? undefined,
      startedAt: pmEventTime(child.startedAt), completedAt: pmEventTime(child.completedAt) });
  };
  const projectRequest = (id: string) => {
    const source = requests.get(id);
    const item = requestItems.get(id);
    if (!source || !item) return;
    const informational = item.type === "user_input_request";
    const itemOpen = active[item.status] === true;
    if (!itemOpen || source.status !== "pending") closedRequests.add(id);
    const live = !closedRequests.has(id) && source.status === "pending" && source.responseCapability.type === "live"
      && input.isLiveRequest?.(source) === true;
    const respondable = informational && live && input.canRespond && item.questions.length > 0;
    const request: NativeInteractionRequest = {
      id, itemId: item.id, kind: informational ? "user_input" : "approval", title: item.title ?? (informational ? "Provider question" : "Native permission denied"),
      respondable,
      ...(informational ? { questions: item.questions.map((question) => ({
        id: question.id, title: question.header, prompt: question.question,
        options: question.options.map((option) => ({ id: option.value ?? option.label, label: option.label, description: option.description })),
        multiple: question.multiSelect, allowText: question.allowCustomAnswer,
      })) } : { detail: item.reason ?? item.prompt }),
      ...(!respondable ? { unavailableReason: !informational ? "Native permissions are denied. PM business approvals remain separate."
        : source.responseCapability.type === "not_resumable" ? source.responseCapability.reason
        : !live ? "The provider closed this interaction." : "This interaction has no live response channel." } : {}),
    };
    const previous = items.get(item.id)!;
    publish({ ...previous, request, status: source.status === "resolved" ? "completed"
      : source.status !== "pending" || closedRequests.has(id) ? (itemOpen ? "cancelled" : previous.status) : "waiting" });
    if (closedRequests.has(id)) input.onRequestClosed(id);
    else if (!startedRequests.has(id) && (respondable || !informational)) {
      startedRequests.add(id);
      input.onRequest(request, source);
    }
  };
  const handleItem = (source: OrchestrationV2TurnItem) => {
    sourceItems.set(source.id, source);
    const base: NativeOutputItem = {
      id: source.id, type: "notification", status: source.status === "idle" ? "pending" : source.status,
      ...(source.title === null ? {} : { title: source.title }),
      ...(source.parentItemId === null ? {} : { parentItemId: source.parentItemId }),
      ...(source.nativeItemRef?.nativeId == null ? {} : { nativeItemId: source.nativeItemRef.nativeId }),
      startedAt: pmEventTime(source.startedAt), completedAt: pmEventTime(source.completedAt),
    };
    switch (source.type) {
      case "user_message": return;
      case "assistant_message": {
        if (input.isRootItem?.(source) ?? !source.parentItemId) rootAssistantIds.add(source.id);
        else if (!base.parentItemId) base.parentItemId = `native-child:${source.threadId}`;
        const message = messages.get(source.messageId);
        publish({ ...base, type: source.type, text: source.textOmitted ? message?.text ?? items.get(source.id)?.text ?? "" : source.text, streaming: source.streaming });
        return;
      }
      case "reasoning": publish({ ...base, type: source.type, text: source.text, streaming: source.streaming }); return;
      case "command_execution": publish({ ...base, type: source.type, input: source.input, output: source.output, exitCode: source.exitCode }); return;
      case "file_change": publish({ ...base, type: source.type, fileName: source.fileName, additions: source.additions, deletions: source.deletions,
        diff: source.diffStr, oldText: source.oldStr, newText: source.newStr, changes: source.changes?.map((change) => ({ ...change })) }); return;
      case "file_search": publish({ ...base, type: source.type, input: source.pattern, results: source.results?.map((result) => ({ path: result.fileName, text: result.preview, line: result.line })) }); return;
      case "web_search": publish({ ...base, type: source.type, input: source.patterns, results: source.results?.map((result) => ({ title: result.title, url: result.url, text: result.snippet })) }); return;
      case "dynamic_tool": {
        const app = mcpAppFromToolItem(source);
        const producing = app && source.status === "completed" ? input.mcpAppIdentity?.(source) : undefined;
        const result = source.output !== null && typeof source.output === "object" && "result" in source.output
          ? mcpAppToolResultSchema.safeParse(source.output.result) : undefined;
        publish({ ...base, type: source.type, toolName: source.toolName ?? undefined, input: source.input,
          output: source.output === undefined ? undefined : typeof source.output === "string" ? source.output : JSON.stringify(normalizeToolValue(source.output)),
          ...(app && producing && result?.success ? { mcpApp: mcpAppMetadataSchema.parse({ ...app, producing }), mcpToolResult: result.data } : {}) });
        return;
      }
      case "todo_list": case "proposed_plan": {
        planItems.set(source.planId, source.id);
        publish({ ...base, type: source.type,
          ...(source.type === "todo_list" ? { steps: source.steps.map((step) => ({ ...step })), text: source.explanation }
            : { text: source.markdown, streaming: source.streaming }) }); return;
      }
      case "approval_request": case "user_input_request":
        requestItems.set(source.requestId, source); publish({ ...base, type: source.type }); projectRequest(source.requestId); return;
      case "error": publish({ ...base, type: "error", text: source.failure.message, error: source.failure.message }); return;
      case "compaction": publish({ ...base, type: source.type, text: source.summary }); return;
      case "notification": publish({ ...base, type: source.type,
        text: source.detail && source.detail !== source.summary ? `${source.summary}\n\n${source.detail}` : source.summary }); return;
      case "subagent": {
        const row: NativeOutputItem = { ...base, type: source.type, childSessionId: source.childThreadId ?? undefined,
          text: source.progress ?? (source.promptOmitted ? items.get(source.id)?.text : source.prompt),
          output: source.resultOmitted ? items.get(source.id)?.output : source.result ?? undefined };
        const child = subagents.get(source.subagentId);
        if (child) projectSubagent(child, source.id, row);
        else publish(row);
        return;
      }
      default: {
        const text = "message" in source ? source.message : "summary" in source ? source.summary
          : "reason" in source ? source.reason : undefined;
        const unsupported = source.type === "secret_request" || source.type === "link_request"
          ? " This native request is unavailable in the PM host."
          : source.type === "checkpoint" ? " Filesystem checkpoint restoration is not enabled."
          : source.type === "handoff" || source.type === "fork" || source.type === "thread_created"
            ? " Native state only; no PM thread, task or dispatch was created." : "";
        publish({ ...base, text: `${typeof text === "string" ? text : source.type}${unsupported}`,
          input: source.type === "checkpoint" ? { files: source.files } : undefined });
      }
    }
  };
  return {
    items, sourceItems, messages, requests,
    finalText: () => [...items.values()].filter((item) => rootAssistantIds.has(item.id)).map((item) => item.text ?? "").join("\n\n"),
    pendingBodies: () => [...sourceItems.values()].filter((item) => (item.type === "assistant_message" && item.textOmitted && !messages.has(item.messageId))
      || ((item.type === "command_execution" || item.type === "dynamic_tool") && item.outputOmitted)
      || (item.type === "subagent" && ((item.promptOmitted && items.get(item.id)?.text === undefined)
        || (item.resultOmitted && items.get(item.id)?.output === undefined)))),
    handle(event: ProviderAdapterV2Event) {
      switch (event.type) {
        case "turn_item.updated": handleItem(event.turnItem); break;
        case "command_output.delta": input.onEvent?.({ type: "command.output", itemId: event.itemId, chunk: event.chunk }); break;
        case "message.updated": {
          messages.set(event.message.id, event.message);
          for (const item of sourceItems.values()) if (item.type === "assistant_message" && item.messageId === event.message.id && item.textOmitted) handleItem(item);
          break;
        }
        case "runtime_request.updated": requests.set(event.runtimeRequest.id, event.runtimeRequest); projectRequest(event.runtimeRequest.id); break;
        case "plan.updated": {
          const plan = event.plan;
          plans.set(plan.id, plan);
          // Wait for the authoritative item. Unrepresented artifacts are materialized once at final drain.
          break;
        }
        case "subagent.updated": {
          const child = event.subagent;
          subagents.set(child.id, child);
          const existing = [...sourceItems.values()].find((item) => item.type === "subagent" && item.subagentId === child.id);
          if (existing) projectSubagent(child, existing.id, items.get(existing.id));
          break;
        }
        case "provider_thread.updated": {
          const child = event.providerThread;
          if (!child.appThreadId || child.appThreadId === input.rootThreadId) break;
          if (child.nativeThreadRef?.nativeId != null) childNativeSessions.set(child.appThreadId, child.nativeThreadRef.nativeId);
          const id = `native-child:${child.appThreadId}`;
          publish({ ...items.get(id), id, type: "notification", status: "completed",
            childSessionId: child.nativeThreadRef?.nativeId ?? child.appThreadId,
            text: "Native child association; no PM thread or authorization was created.",
            input: { providerThreadId: child.id, nativeSessionId: child.nativeThreadRef?.nativeId } });
          for (const subagent of subagents.values()) {
            if (subagent.childThreadId !== child.appThreadId) continue;
            const row = [...sourceItems.values()].find((item) => item.type === "subagent" && item.subagentId === subagent.id);
            if (row) projectSubagent(subagent, row.id, items.get(row.id));
          }
          break;
        }
        case "turn.terminal":
          publish({ id: `native-terminal:${event.providerTurnId}`, type: "notification", status: event.status,
            title: `Native turn ${event.status}`,
            text: event.status === "failed" ? event.failure.message : "Provider terminal state; not a PM business receipt.",
            input: { providerThreadId: event.providerThreadId, providerTurnId: event.providerTurnId, runOrdinal: event.runOrdinal,
              threadDisposition: event.threadDisposition } });
          break;
        case "app_thread.created": publish({ id: `native-child:${event.appThread.id}`, type: "notification", status: "completed",
          title: event.appThread.title, childSessionId: event.appThread.id, text: "Native child thread; no PM thread or authorization was created." }); break;
      }
    },
    flushPlans() {
      for (const plan of plans.values()) {
        if (planItems.has(plan.id)) continue;
        publish({ id: `plan:${plan.id}`, type: plan.kind,
          status: plan.status === "completed" ? "completed" : plan.status === "superseded" ? "cancelled" : "running",
          ...(plan.kind === "proposed_plan" ? { text: plan.markdown } : { text: plan.explanation, steps: plan.steps.map((step) => ({ ...step })) }) });
      }
    },
    flushSubagents() {
      for (const child of subagents.values()) {
        if ([...sourceItems.values()].some((item) => item.type === "subagent" && item.subagentId === child.id)) continue;
        projectSubagent(child, `subagent:${child.id}`);
      }
    },
    close() {
      for (const [id, source] of requests) if (source.status === "pending") {
        requests.set(id, { ...source, status: "cancelled" }); projectRequest(id);
      }
      for (const item of items.values()) if (item.request?.respondable && active[item.status]) publish({ ...item, status: "cancelled", request: { ...item.request, respondable: false } });
    },
  };
}

/** Flatten only structured error evidence; public text is curated/redacted by the original failure helper. */
export function pmAdapterBoundaryError(error: unknown, fallbackCode = "provider_error", fallbackStatus = 502): PmProviderBoundaryError {
  let cursor: unknown = error;
  let code: string | undefined;
  let status: number | undefined;
  let resetAt: unknown;
  let responseHeaders: unknown;
  const seen = new Set<object>();
  for (let depth = 0; depth < 16 && cursor !== null && typeof cursor === "object" && !seen.has(cursor); depth++) {
    seen.add(cursor);
    try {
      if ("code" in cursor && (typeof cursor.code === "string" || typeof cursor.code === "number")) code = String(cursor.code);
      const rawStatus = "statusCode" in cursor ? cursor.statusCode : "status" in cursor ? cursor.status : undefined;
      if ((typeof rawStatus === "number" || typeof rawStatus === "string") && /^\d{3}$/.test(String(rawStatus))) {
        const value = Number(rawStatus);
        if (value >= 400 && value <= 599) status = value;
      }
      if ("resetAt" in cursor) resetAt = cursor.resetAt;
      else if ("reset_at" in cursor) resetAt = cursor.reset_at;
      else if ("resetsAt" in cursor) resetAt = cursor.resetsAt;
      if ("responseHeaders" in cursor) responseHeaders = cursor.responseHeaders;
      cursor = "cause" in cursor ? cursor.cause : undefined;
    } catch { break; }
  }
  const failure = makeProviderFailure({ cause: error, code: code ?? fallbackCode });
  const classified = classifyProviderError({ message: failure.message, code: failure.code,
    statusCode: status, resetAt, responseHeaders,
    errorClass: code && /^(?:unauthorized|forbidden)$/i.test(code) ? "authentication" : undefined });
  const reliableNativeStatus = status !== undefined && [401, 402, 403, 429].includes(status);
  const metadataFailure = fallbackCode === "session_mismatch" || fallbackCode === "unsupported_fork";
  const publicStatus = reliableNativeStatus && status !== undefined ? status : metadataFailure ? fallbackStatus : status ?? fallbackStatus;
  const publicCode = metadataFailure && !reliableNativeStatus ? fallbackCode : failure.code ?? fallbackCode;
  const operation = error instanceof Error && "_tag" in error && typeof error._tag === "string" && error._tag.startsWith("ProviderAdapter")
    ? error._tag : undefined;
  return Object.assign(pmExecutionError(publicStatus, publicCode, classified.message), {
    errorClass: metadataFailure && !reliableNativeStatus ? "unsupported" as const : classified.errorClass,
    ...(operation ? { operation } : {}), ...(classified.resetAt ? { resetAt: classified.resetAt } : {}),
  });
}
