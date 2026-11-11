import { agentOutputSnapshotSchema, type AgentOutputFrame, type AgentOutputSnapshot, type CommandOutputFrame, type NativeOutputItem } from "@agent-workspace/contracts/output";
import { pmToolTargetSchema, pmToolCallRecordSchema, type PmToolTarget, type PmToolCallProjection, type PmAuthorizedOperation } from "@agent-workspace/contracts/pm-tools";
import { authorizePmTarget } from "./durable/pm-context.ts";
import { listRecords, readRecord, writeRecord } from "./durable/store.ts";
import type { StoredMessage } from "./durable/threads.ts";
import type { StoredPmToolCall } from "./pm-tools.ts";
import { normalizePmToolResult, pmOutcomeFromToolOutput } from "./pm-outcomes.ts";
import { agentChatContextSourceSchema, agentChatToolEntitySchema, agentChatToolCommentSchema } from "@agent-workspace/contracts/pm-tool-result";
import { pmReferenceInputSchema, pmReferenceResolutionSchema } from "@agent-workspace/contracts/pm-references";
import type { UIMessageChunk } from "ai";

const CALLS = "pm-tool-calls", PROVENANCE = "pm-content-provenance";
type Visibility = "visible" | "redacted" | "unavailable";
export type PmContentProvenance = { operationIds: string[]; targets: PmToolTarget[]; authorities?: PmAuthorizedOperation[] };
type QuoteProvenance = PmContentProvenance & { threadId: string; messageId: string; sourceMessageId: string; complete: boolean };
type ProvenanceRecord = PmContentProvenance & { threadId: string; generationId: string; messageIds: string[] };
type Generation = { id: string; threadId: string; messageId: string; createdAt?: string; pmOperations?: { actorId: string; target: PmToolTarget }[]; pmReferences?: unknown[] };
const key = (target: PmToolTarget) => JSON.stringify([target.workspaceId, target.projectId]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unavailableText = "PM content is temporarily unavailable. Retry the read without redispatching the operation.";
const redactedText = "PM content is no longer accessible.";
const notice = (visibility: Visibility) => visibility === "unavailable" ? unavailableText : redactedText;
function merge(...values: PmContentProvenance[]): PmContentProvenance {
  return { operationIds: [...new Set(values.flatMap(value => value.operationIds))],
    targets: [...new Map(values.flatMap(value => value.targets).map(target => [key(target), target])).values()],
    authorities: [...new Map(values.flatMap(value => value.authorities ?? []).map(authority => [JSON.stringify([authority.actorId, key(authority.target)]), authority])).values()] };
}
/** Dependencies come from typed PM evidence, never JSON examples in user prose or tool arguments. */
export function pmPayloadTargets(value: unknown, workspaceId?: string): PmToolTarget[] {
  const targets = new Map<string, PmToolTarget>();
  const seen = new WeakSet<object>();
  const add = (workspace: string | undefined, projectId: unknown): void => {
    const parsed = pmToolTargetSchema.safeParse({ workspaceId: workspace, projectId });
    if (parsed.success) targets.set(key(parsed.data), parsed.data);
  };
  const visit = (part: unknown, workspace?: string): void => {
    if (typeof part !== "object" || part === null || seen.has(part)) return;
    seen.add(part);
    if (Array.isArray(part)) { for (const entry of part) visit(entry, workspace); return; }
    const item = part as Record<string, unknown>;
    const direct = pmToolTargetSchema.safeParse(item);
    if (direct.success) { add(direct.data.workspaceId, direct.data.projectId); return; }
    const source = agentChatContextSourceSchema.safeParse(item);
    if (source.success) {
      add(source.data.workspaceId, source.data.kind === "project" ? source.data.entityId : source.data.projectId);
      return;
    }
    const reference = pmReferenceResolutionSchema.safeParse(item);
    const referenceInput = reference.success ? undefined : pmReferenceInputSchema.safeParse(item);
    const resolved = reference.success ? reference.data : referenceInput?.success ? referenceInput.data : undefined;
    if (resolved) { add(resolved.workspaceId, resolved.kind === "project" ? resolved.id : resolved.projectId); return; }
    const entity = agentChatToolEntitySchema.safeParse(item);
    if (entity.success) { add(workspace, entity.data.entity === "project" ? entity.data.id : entity.data.projectId); return; }
    const comment = agentChatToolCommentSchema.safeParse(item);
    if (comment.success) { add(workspace, comment.data.projectId); return; }
    const call = pmToolCallRecordSchema.safeParse(item);
    if (call.success) {
      const scope = call.data.target?.workspaceId ?? call.data.workspaceId ?? workspace;
      visit(call.data.target, scope);
      visit(call.data.result, scope);
      if (call.data.changeSet?.projectId) add(scope, call.data.changeSet.projectId);
      return;
    }
    // Original invocation fields are authoritative; arguments are content, not another ACL.
    if (typeof item.operationId === "string" && typeof item.name === "string" && item.name.startsWith("pm_")) visit(item.target, workspace);
    // Results are validated at the PM boundary. Only their typed source/identity metadata is used.
    if (typeof item.kind === "string" && Array.isArray(item.sources) && Array.isArray(item.items)) {
      visit(item.sources, workspace); visit(item.items, workspace);
    }
    if (Array.isArray(item.pmReferences)) visit(item.pmReferences, workspace);
    if (Array.isArray(item.pmOperations)) for (const operation of item.pmOperations) if (object(operation)) visit(operation.target, workspace);
    if (object(item.turnContext)) visit(item.turnContext.pmReferences, workspace);
    // Stored Chat messages carry canonical context above; ordinary text parts are never parsed.
    const content = object(item.content) ? item.content : item;
    if (Array.isArray(content.parts)) for (const entry of content.parts) {
      if (!object(entry) || typeof entry.type !== "string" || !/^(?:tool-|dynamic_tool$|dynamic-tool$)/.test(entry.type)) continue;
      const output = pmOutcomeFromToolOutput(entry.output ?? entry.result);
      if (output) visit(output, workspace);
    }
    if ("structuredContent" in item || Array.isArray(item.content) || item.type === "dynamic_tool" || item.type === "tool-output-available") {
      const output = pmOutcomeFromToolOutput(item);
      if (output) visit(output, workspace);
    }
  };
  visit(value, workspaceId);
  return [...targets.values()];
}
export function recordPmContentProvenance(input: { threadId: string; generationId: string; messageIds?: string[]; operationIds: string[]; targets?: PmToolTarget[]; authorities?: PmAuthorizedOperation[] }): void {
  const previous = readRecord<ProvenanceRecord>(PROVENANCE, input.generationId);
  if (previous && previous.threadId !== input.threadId) throw new Error("PM provenance belongs to another Session");
  const deps = merge(previous ?? { operationIds: [], targets: [] }, { operationIds: input.operationIds, targets: input.targets ?? [], authorities: input.authorities ?? [] });
  writeRecord<ProvenanceRecord>(PROVENANCE, input.generationId, { ...deps, threadId: input.threadId, generationId: input.generationId,
    messageIds: [...new Set([...(previous?.messageIds ?? []), ...(input.messageIds ?? [])])] });
}
export function collectPmContentProvenance(threadId: string, messageIds: readonly string[]): PmContentProvenance {
  const ids = new Set(messageIds);
  const calls = listRecords<StoredPmToolCall>(CALLS).filter(call => call.record.threadId === threadId && ids.has(call.record.messageId));
  const saved = listRecords<ProvenanceRecord>(PROVENANCE).filter(value => value.threadId === threadId && value.messageIds.some(id => ids.has(id)));
  const quotes = listRecords<QuoteProvenance>("pm-quote-provenance").filter(value => value.threadId === threadId && ids.has(value.messageId));
  const generations = listRecords<Generation>("chat:generations").filter(value => value.threadId === threadId && ids.has(value.messageId));
  return merge(...saved, ...quotes, { operationIds: calls.map(call => call.record.operationId),
    targets: calls.flatMap(call => pmPayloadTargets([call.record, call.request], call.record.workspaceId ?? undefined)),
    authorities: generations.flatMap(value => value.pmOperations ?? []) });
}
/** A quote keeps its own immutable source binding; it does not taint the user's unrelated prose. */
export function recordPmQuoteProvenance(input: { threadId: string; messageId: string; sourceMessageId: string }): void {
  const id = JSON.stringify([input.threadId, input.messageId]);
  const previous = readRecord<QuoteProvenance>("pm-quote-provenance", id);
  if (previous) {
    if (previous.sourceMessageId !== input.sourceMessageId) throw new Error("Quote already belongs to another source message");
    return;
  }
  const sources = listRecords<ProvenanceRecord>(PROVENANCE).filter(value => value.threadId === input.threadId && value.messageIds.includes(input.sourceMessageId));
  const source = listRecords<{ threadId: string; messages: StoredMessage[] }>("chat:history").find(value => value.threadId === input.threadId)?.messages.find(message => message.id === input.sourceMessageId);
  const deps = collectPmContentProvenance(input.threadId, [input.sourceMessageId]);
  const sourceQuotes = listRecords<QuoteProvenance>("pm-quote-provenance").filter(value => value.threadId === input.threadId && value.messageId === input.sourceMessageId);
  const sourceMetadata: Record<string, unknown> = source && object(source.content.metadata) ? source.content.metadata : {};
  const hasLegacyQuote = object(sourceMetadata.custom) && sourceMetadata.custom.quote && sourceQuotes.length === 0;
  writeRecord<QuoteProvenance>("pm-quote-provenance", id, { ...input, ...deps,
    targets: merge(deps, { operationIds: [], targets: pmPayloadTargets(source) }).targets,
    complete: !hasLegacyQuote && sourceQuotes.every(value => value.complete) && (sources.length > 0 || source?.content.role === "user") });
}
export type PmVisibilityProjector = {
  calls: PmToolCallProjection[];
  provenance: PmContentProvenance;
  nativeContextContaminated: boolean;
  history(messages: StoredMessage[]): StoredMessage[];
  visibleProvenance(messageIds: readonly string[]): PmContentProvenance;
  generation<T extends { id?: string; generationId?: string; messageId?: string }>(value: T): T;
  nativeSnapshot(snapshot: AgentOutputSnapshot): AgentOutputSnapshot;
  nativeFrame(frame: AgentOutputFrame): AgentOutputFrame;
  commandFrame(frame: CommandOutputFrame, generationId: string, itemId: string): CommandOutputFrame;
  uiChunk(chunk: UIMessageChunk, generationId: string): UIMessageChunk;
};
/** Session/delegation authorization MUST run before this read projection. Recreate for every outgoing SSE frame. */
export async function createPmVisibilityProjector(threadId: string, headers: Headers, options?: { operationIds?: readonly string[] }): Promise<PmVisibilityProjector> {
  const allCalls = listRecords<StoredPmToolCall>(CALLS);
  const threadCalls = allCalls.filter(call => call.record.threadId === threadId && (!options?.operationIds || options.operationIds.includes(call.record.operationId)));
  const generations = listRecords<Generation>("chat:generations").filter(value => value.threadId === threadId);
  const provenance = listRecords<ProvenanceRecord>(PROVENANCE).filter(value => value.threadId === threadId);
  const quotes = listRecords<QuoteProvenance>("pm-quote-provenance").filter(value => value.threadId === threadId);
  // Only durable, server-written provenance can link another Session's operation.
  const linkedIds = new Set([...provenance, ...quotes].flatMap(value => value.operationIds));
  const calls = [...threadCalls, ...allCalls.filter(call => call.record.threadId !== threadId && linkedIds.has(call.record.operationId))];
  const histories = listRecords<{ threadId: string; messages: StoredMessage[] }>("chat:history").filter(value => value.threadId === threadId);
  const authorities = new Map<string, { target: PmToolTarget }>();
  const add = (target: PmToolTarget) => {
    authorities.set(key(target), { target });
  };
  const callTargets = new Map<string, PmToolTarget[]>();
  for (const call of calls) {
    const targets = pmPayloadTargets([call.record, call.request], call.record.workspaceId ?? undefined);
    if (call.record.result?.kind === "workspaces") {
      for (const workspace of call.record.result.items) {
        if (workspace.workspaceAllowed === true) targets.push({ workspaceId: workspace.id, projectId: null });
        for (const project of workspace.projects) targets.push({ workspaceId: workspace.id, projectId: project.id });
      }
    }
    callTargets.set(call.record.operationId, targets);
    for (const target of targets) add(target);
  }
  for (const generation of generations) {
    for (const operation of generation.pmOperations ?? []) add(operation.target);
    for (const target of pmPayloadTargets(generation.pmReferences)) add(target);
  }
  for (const saved of provenance) for (const target of saved.targets) add(target);
  for (const quote of quotes) for (const target of quote.targets) add(target);
  for (const saved of [...provenance, ...quotes]) for (const authority of saved.authorities ?? []) add(authority.target);
  for (const history of histories) for (const message of history.messages) for (const target of pmPayloadTargets(message)) add(target);
  const currentActors = new Map<string, string>();
  const visibility = new Map<string, Visibility>();
  await Promise.all([...authorities].map(async ([id, entry]) => {
    try {
      const authority = await authorizePmTarget(entry.target, headers);
      currentActors.set(id, authority.actorId);
      visibility.set(id, "visible");
    } catch (error) {
      const status = object(error) && "status" in error ? Number(error.status) : 0;
      visibility.set(id, [401, 403, 404].includes(status) ? "redacted" : "unavailable");
    }
  }));
  const targetsVisibility = (targets: PmToolTarget[]): Visibility => {
    const statuses = targets.map(target => visibility.get(key(target)) ?? "unavailable");
    return statuses.includes("redacted") ? "redacted" : statuses.includes("unavailable") ? "unavailable" : "visible";
  };
  const callVisibility = new Map<string, Visibility>();
  const projectedCalls: PmToolCallProjection[] = calls.map(call => {
    const targets = callTargets.get(call.record.operationId)!;
    const state = !call.record.actorId && call.record.name !== "pm_list_workspaces" ? "unavailable"
      : targets.some(target => call.record.actorId && currentActors.get(key(target)) && currentActors.get(key(target)) !== call.record.actorId) ? "redacted"
      : targets.length === 0 && call.record.name !== "pm_list_workspaces" ? "unavailable" : targetsVisibility(targets);
    callVisibility.set(call.record.operationId, state);
    if (state !== "visible") return { operationId: call.record.operationId, threadId: call.record.threadId, messageId: call.record.messageId, generationId: call.record.generationId, visibility: state };
    const args = call.request.arguments;
    const exposeArguments = args !== undefined && JSON.stringify(args).length <= 16 * 1024;
    return { ...normalizePmToolResult(call.record), ...(exposeArguments ? { arguments: args } : {}), visibility: "visible" };
  });
  const depsVisibility = (deps: PmContentProvenance): Visibility => {
    const actorMismatch = (deps.authorities ?? []).some(authority => currentActors.get(key(authority.target)) && currentActors.get(key(authority.target)) !== authority.actorId);
    if (actorMismatch) return "redacted";
    const statuses = [targetsVisibility([...deps.targets, ...(deps.authorities ?? []).map(authority => authority.target)]), ...deps.operationIds.map(id => callVisibility.get(id) ?? "unavailable")];
    return statuses.includes("redacted") ? "redacted" : statuses.includes("unavailable") ? "unavailable" : "visible";
  };
  const hidden = projectedCalls.some(call => call.visibility !== "visible") || [...visibility.values()].some(state => state !== "visible") ||
    [...provenance, ...quotes].some(value => depsVisibility(value) !== "visible") ||
    generations.some(value => value.pmOperations?.some(authority => currentActors.get(key(authority.target)) && currentActors.get(key(authority.target)) !== authority.actorId));
  const generationVisibility = (id: string): Visibility => {
    const generation = generations.find(value => value.id === id);
    if (generation?.pmOperations?.some(operation => currentActors.get(key(operation.target)) && currentActors.get(key(operation.target)) !== operation.actorId)) return "redacted";
    const saved = provenance.find(value => value.generationId === id);
    if (saved) return depsVisibility(merge(saved, { operationIds: calls.filter(call => call.record.generationId === id).map(call => call.record.operationId), targets: [] }));
    // Legacy summaries/cursors lack complete dependencies. Never guess them clean from text.
    if (hidden) return [...visibility.values()].includes("redacted") ? "redacted" : "unavailable";
    return targetsVisibility(pmPayloadTargets(generation));
  };
  const safeNested = (value: unknown): unknown => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(safeNested);
    if (!object(value)) return value;
    if (typeof value.operationId === "string" && "name" in value && "status" in value && callVisibility.has(value.operationId)) {
      return projectedCalls.find(call => call.operationId === value.operationId)!;
    }
    if (pmToolCallRecordSchema.safeParse(value).success) return { visibility: "unavailable", text: unavailableText };
    // Canonical references are handled at their known fields, not by inspecting arbitrary content.
    const type = typeof value.type === "string" ? value.type : "";
    if (/^(?:tool-|dynamic_tool$|dynamic-tool$)/.test(type) && typeof value.output === "string") {
      const record = pmOutcomeFromToolOutput(value.output);
      const projected = record ? projectedCalls.find(call => call.operationId === record.operationId) : undefined;
      if (record) return { ...value, output: JSON.stringify(projected ?? { visibility: "unavailable", text: unavailableText }) };
    }
    return Object.fromEntries(Object.entries(value).map(([name, part]) => [name, safeNested(part)]));
  };
  const itemProjection = (item: NativeOutputItem, generationId: string): NativeOutputItem => {
    const duplicate = pmOutcomeFromToolOutput(item.output);
    const operationId = item.id.startsWith("pm-tool:") ? item.id.slice(8) : duplicate?.operationId;
    const call = operationId ? projectedCalls.find(value => value.operationId === operationId) : undefined;
    const pmItem = Boolean(operationId || item.toolName && /(?:^|[./])pm_/.test(item.toolName));
    const state = call ? call.visibility : pmItem ? "unavailable" : generationVisibility(generationId);
    if (state !== "visible") return { id: item.id, type: "notification", status: "unknown", visibility: state, text: notice(state) };
    if (call && call.visibility === "visible") return {
      id: item.id, type: "dynamic_tool", toolName: call.name, visibility: "visible",
      status: call.status === "unknown" ? "unknown" : call.status === "succeeded" ? "completed" : call.status === "pending_approval" ? "waiting" : call.status === "running" ? "running" : "failed",
      startedAt: call.createdAt, ...(call.finishedAt && call.status !== "unknown" ? { completedAt: call.finishedAt } : {}),
      ...(call.arguments === undefined ? {} : { input: call.arguments }), output: JSON.stringify(call),
      ...(item.order ? { order: item.order } : {}),
    };
    return safeNested(item) as NativeOutputItem;
  };
  const nativeSnapshot = (snapshot: AgentOutputSnapshot): AgentOutputSnapshot => ({ ...snapshot, items: snapshot.items.map(item => itemProjection(item, snapshot.generationId)) });
  /** Routing reveals no PM payload. Only private server records can establish this binding. */
  const trustedNativeRoute = (generationId: string, messageId?: string): { generationId: string; nativeOutput: true } | undefined => {
    const generation = generations.find(value => value.id === generationId && (messageId === undefined || value.messageId === messageId));
    if (!generation) return undefined;
    const output = agentOutputSnapshotSchema.safeParse(readRecord("native-output", generationId));
    if (!output.success || output.data.generationId !== generation.id || output.data.threadId !== threadId) return undefined;
    return { generationId: generation.id, nativeOutput: true };
  };
  return {
    calls: projectedCalls.filter(call => call.threadId === threadId),
    provenance: merge(...provenance.filter(value => depsVisibility(value) === "visible"), { operationIds: projectedCalls.filter(call => call.visibility === "visible").map(call => call.operationId),
      targets: [...authorities.values()].filter(value => targetsVisibility([value.target]) === "visible").map(value => value.target),
      authorities: generations.filter(value => generationVisibility(value.id) === "visible").flatMap(value => value.pmOperations ?? []) }),
    nativeContextContaminated: hidden,
    visibleProvenance(messageIds) {
      const ids = new Set(messageIds);
      const deps = merge(...provenance.filter(value => value.messageIds.some(id => ids.has(id))), ...quotes.filter(value => ids.has(value.messageId) && depsVisibility(value) === "visible"), {
        operationIds: calls.filter(call => ids.has(call.record.messageId)).map(call => call.record.operationId), targets: [],
        authorities: generations.filter(value => ids.has(value.messageId)).flatMap(value => value.pmOperations ?? []),
      });
      return { operationIds: deps.operationIds.filter(id => callVisibility.get(id) === "visible"), targets: deps.targets.filter(target => targetsVisibility([target]) === "visible"),
        authorities: (deps.authorities ?? []).filter(authority => currentActors.get(key(authority.target)) === authority.actorId && targetsVisibility([authority.target]) === "visible") };
    },
    history(messages) {
      return messages.map(message => {
        const saved = provenance.filter(value => value.messageIds.includes(message.id));
        const role = message.content.role;
        const generation = generations.find(value => value.messageId === message.id);
        const states: Visibility[] = saved.map(value => generationVisibility(value.generationId));
        if (generation) states.push(generationVisibility(generation.id));
        else if (!saved.length && role === "assistant" && hidden) states.push("redacted");
        const state = states.includes("redacted") ? "redacted" : states.includes("unavailable") ? "unavailable" : "visible";
        if (state !== "visible") {
          const durable = role === "assistant" ? generations.filter(value => value.messageId === message.id)
            .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
            .map(value => trustedNativeRoute(value.id, message.id)).find(value => value !== undefined) : undefined;
          return { id: message.id, parent_id: message.parent_id, format: message.format, content: {
            role: role ?? "assistant", parts: [{ type: "text", text: notice(state) }],
            metadata: { pmVisibility: state, ...(durable ? { durable } : {}) },
          } };
        }
        // Only canonical immutable context is trusted; ignore serialized client metadata copies.
        const metadata: Record<string, unknown> = object(message.content.metadata) ? { ...message.content.metadata } : {};
        delete metadata.turnContext;
        const custom = object(metadata.custom) ? { ...metadata.custom } : {};
        delete custom.turnContext;
        const quote = quotes.find(value => value.messageId === message.id);
        const sourceId = quote?.sourceMessageId ?? (object(custom.quote) && typeof custom.quote.messageId === "string" ? custom.quote.messageId : undefined);
        const sourceGeneration = sourceId ? generations.find(value => value.messageId === sourceId) : undefined;
        const quoteStates: Visibility[] = [quote ? depsVisibility(quote) : "visible"];
        if (sourceGeneration) quoteStates.push(generationVisibility(sourceGeneration.id));
        if ((!quote || !quote.complete) && hidden) quoteStates.push("unavailable");
        const quoteState = quoteStates.includes("redacted") ? "redacted" : quoteStates.includes("unavailable") ? "unavailable" : "visible";
        if ((custom.quote || metadata.quote) && quoteState !== "visible") {
          delete custom.quote;
          delete custom.quoteContext;
        }
        const projectedMetadata: Record<string, unknown> = { ...metadata, custom };
        if (quoteState !== "visible") { delete projectedMetadata.quote; delete projectedMetadata.quoteContext; }
        const projected = { ...message, content: safeNested({ ...message.content, metadata: projectedMetadata }) as Record<string, unknown> } as StoredMessage & { turnContext?: Record<string, unknown> };
        const context = (message as StoredMessage & { turnContext?: Record<string, unknown> }).turnContext;
        if (context) {
          const refs = Array.isArray(context.pmReferences) ? context.pmReferences : [];
          const visibleRefs = refs.filter(reference => targetsVisibility(pmPayloadTargets(reference)) === "visible");
          projected.turnContext = { ...context, pmReferences: visibleRefs };
          if (visibleRefs.length !== refs.length) {
            delete projected.turnContext.executionGrantId;
            const safeMetadata = projected.content.metadata as Record<string, unknown>;
            safeMetadata.pmVisibility = refs.some(reference => targetsVisibility(pmPayloadTargets(reference)) === "redacted") ? "redacted" : "unavailable";
          }
        }
        return projected;
      });
    },
    generation(value) {
      const id = value.id ?? value.generationId ?? "";
      const state = generationVisibility(id);
      if (state === "visible") return safeNested(value) as typeof value;
      const input = value as Record<string, unknown>;
      const result: Record<string, unknown> = { ...input };
      for (const name of ["request", "output", "error", "errorClass", "pmReferences", "pmOperations", "turnContext", "nativeSession", "nativeSystemPrompt", "transferContext", "modelInputContext"]) delete result[name];
      result.pmVisibility = state;
      return result as typeof value;
    },
    nativeSnapshot,
    nativeFrame(frame) {
      return frame.kind === "snapshot" ? { ...frame, snapshot: nativeSnapshot(frame.snapshot) } : frame.kind === "item" ? { ...frame, item: itemProjection(frame.item, frame.generationId) } : frame;
    },
    commandFrame(frame, generationId) {
      const state = generationVisibility(generationId);
      return state === "visible" ? frame : { kind: "replace", text: notice(state), truncated: false, running: false };
    },
    uiChunk(chunk, generationId) {
      const state = generationVisibility(generationId);
      if (state === "visible") {
        if (chunk.type === "tool-output-available") {
          const record = pmOutcomeFromToolOutput(chunk.output);
          if (record) {
            const projected = projectedCalls.find(call => call.operationId === record.operationId) ?? { visibility: "unavailable", text: unavailableText };
            return { ...chunk, output: typeof chunk.output === "string" ? JSON.stringify(projected) : projected };
          }
          return { ...chunk, output: safeNested(chunk.output) };
        }
        if (chunk.type === "tool-input-available") return { ...chunk, input: safeNested(chunk.input) };
        if (chunk.type === "message-metadata" || chunk.type === "start" || chunk.type === "finish")
          return { ...chunk, messageMetadata: safeNested(chunk.messageMetadata) };
        if ("data" in chunk) return { ...chunk, data: safeNested(chunk.data) };
        return chunk;
      }
      const durable = trustedNativeRoute(generationId);
      const messageMetadata = { pmVisibility: state, ...(durable ? { durable } : {}) };
      switch (chunk.type) {
        case "start": {
          const generation = generations.find(value => value.id === generationId);
          return { type: "start", ...(generation ? { messageId: generation.messageId } : {}), messageMetadata };
        }
        case "finish": return { type: "finish", messageMetadata };
        case "message-metadata": return { type: "message-metadata", messageMetadata };
        case "start-step": case "finish-step": case "reset-step": return { type: chunk.type };
        case "text-start": case "text-end": case "reasoning-start": case "reasoning-end":
          return { type: chunk.type, id: chunk.id };
        case "text-delta": case "reasoning-delta": return { type: chunk.type, id: chunk.id, delta: notice(state) };
        case "abort": return { type: "abort" };
        default: return { type: "data-pm-visibility", data: { visibility: state }, transient: true };
      }
    },
  };
}
