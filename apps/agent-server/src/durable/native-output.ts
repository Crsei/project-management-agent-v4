import {
  agentOutputSnapshotSchema,
  isOutputActive,
  nativeInteractionRequestSchema,
  nativeInteractionResponseSchema,
  nativeOutputItemSchema,
  type AgentOutputFrame,
  type AgentOutputSnapshot,
  type CommandOutputFrame,
  type GenerationOutputStatus,
  type NativeInteractionRequest,
  type NativeInteractionResponse,
  type NativeOutputEvent,
  type NativeOutputItem,
} from "@agent-workspace/contracts/output";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputResumeText,
  terminalOutputTail,
  TERMINAL_OUTPUT_TAIL_CHARS,
  type TerminalOutputState,
} from "@agent-workspace/contracts/terminal-output";
import { DurableError } from "./errors.ts";
import { listRecords, readRecord, writeRecord } from "./store.ts";

const OUTPUTS = "native-output";
const QUEUE_LIMIT = 128;
const ITEM_DELAY_MS = 50;
const COMMAND_DELAY_MS = 100;
type TerminalStatus = Exclude<GenerationOutputStatus, "queued" | "running">;
type PendingRequest = {
  request: NativeInteractionRequest;
  resolve: (response: NativeInteractionResponse) => void;
  reject: (error: Error) => void;
};
type Sink<T> = { push: (frame: T) => void; finish: () => void };
type CommandState = {
  generationId: string;
  itemId: string;
  terminal: TerminalOutputState;
  itemOutput?: string;
  itemOutputTruncated?: boolean;
  pending: string;
  replace: boolean;
  timer?: NodeJS.Timeout;
  sinks: Set<Sink<CommandOutputFrame>>;
};
type RuntimeState = {
  items: Map<string, Map<string, AgentOutputFrame & { kind: "item" }>>;
  itemTimers: Map<string, NodeJS.Timeout>;
  subscribers: Map<string, Set<Sink<AgentOutputFrame>>>;
  commands: Map<string, CommandState>;
  requests: Map<string, Map<string, PendingRequest>>;
  usedRequests: Map<string, Set<string>>;
  closingItems: Map<string, Set<string>>;
  closedInteractions: Set<string>;
};
const stateKey = Symbol.for("agent-workspace.native-output-runtime");
const globals = globalThis as typeof globalThis & { [stateKey]?: RuntimeState };
const state = (globals[stateKey] ??= {
  items: new Map(), itemTimers: new Map(), subscribers: new Map(),
  commands: new Map(), requests: new Map(), usedRequests: new Map(), closingItems: new Map(), closedInteractions: new Set(),
});
const active = (status: GenerationOutputStatus) => status === "queued" || status === "running";

/** Provider tool payloads are untrusted, potentially cyclic and not necessarily JSON. */
function normalizeToolValue(value: unknown): unknown {
  let remaining = 64 * 1024;
  let nodes = 2_000;
  const seen = new WeakSet<object>();
  const visit = (part: unknown, depth: number): unknown => {
    if (--nodes < 0 || remaining <= 0 || depth > 8) return "[truncated]";
    if (typeof part === "string") {
      const length = Math.min(part.length, remaining, 16 * 1024);
      remaining -= length;
      return length < part.length ? `${part.slice(0, length)}[truncated]` : part;
    }
    if (part === null || typeof part === "boolean") return part;
    if (typeof part === "number") return Number.isFinite(part) ? part : String(part);
    if (typeof part === "bigint") return visit(part.toString(), depth);
    if (typeof part !== "object") return `[${typeof part}]`;
    if (seen.has(part)) return "[circular]";
    if (part instanceof Uint8Array) return `[binary ${part.byteLength} bytes]`;
    if (part instanceof Date) return Number.isNaN(part.getTime()) ? "[invalid date]" : part.toISOString();
    seen.add(part);
    if (Array.isArray(part)) {
      const result: unknown[] = [];
      const length = Math.min(part.length, 200);
      for (let index = 0; index < length && nodes > 0 && remaining > 0; index++) result.push(visit(part[index], depth + 1));
      if (length < part.length || result.length < length) result.push("[truncated]");
      seen.delete(part);
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in part) {
      if (!Object.prototype.hasOwnProperty.call(part, key)) continue;
      if (count++ >= 100 || nodes <= 0 || remaining <= 0) { result["[truncated]"] = true; break; }
      const safeKey = key.slice(0, 512);
      remaining -= safeKey.length;
      result[safeKey] = visit((part as Record<string, unknown>)[key], depth + 1);
    }
    seen.delete(part);
    return result;
  };
  try { return visit(value, 0); } catch { return "[uninspectable]"; }
}
const commandKey = (generationId: string, itemId: string) => JSON.stringify([generationId, itemId]);

function missing(): never {
  throw new DurableError(404, "native_output_not_found", "Generation output was not found.");
}
function requireOutput(generationId: string): AgentOutputSnapshot {
  return getNativeOutput(generationId) ?? missing();
}
function nextSequence(snapshot: AgentOutputSnapshot): number {
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence >= Number.MAX_SAFE_INTEGER)
    throw new Error("Native output sequence exhausted.");
  return snapshot.sequence + 1;
}
function save(snapshot: AgentOutputSnapshot): void {
  writeRecord(OUTPUTS, snapshot.generationId, snapshot);
}
function publish(generationId: string, frame: AgentOutputFrame): void {
  for (const sink of state.subscribers.get(generationId) ?? []) sink.push(frame);
}
function flushItems(generationId: string): void {
  const timer = state.itemTimers.get(generationId);
  clearTimeout(timer);
  state.itemTimers.delete(generationId);
  const pending = state.items.get(generationId);
  state.items.delete(generationId);
  if (!pending) return;
  for (const frame of [...pending.values()].sort((a, b) => a.sequence - b.sequence)) {
    publish(generationId, frame);
    if (frame.item.type === "command_execution") updateCommandStatus(generationId, frame.item.id);
  }
}
function scheduleItem(frame: AgentOutputFrame & { kind: "item" }): void {
  let pending = state.items.get(frame.generationId);
  if (!pending) state.items.set(frame.generationId, pending = new Map());
  pending.set(frame.item.id, frame);
  if (!state.itemTimers.has(frame.generationId)) {
    const timer = setTimeout(() => flushItems(frame.generationId), ITEM_DELAY_MS);
    timer.unref?.();
    state.itemTimers.set(frame.generationId, timer);
  }
}
function upsert(generationId: string, item: NativeOutputItem, settling = false): void {
  const snapshot = requireOutput(generationId);
  if (!active(snapshot.status)) return;
  const output: unknown = item.output;
  const text = output === undefined ? undefined : typeof output === "string" ? output : JSON.stringify(normalizeToolValue(output));
  const boundedOutput = text !== undefined && text.length > TERMINAL_OUTPUT_TAIL_CHARS
    ? item.type === "command_execution" ? terminalOutputTail(text, TERMINAL_OUTPUT_TAIL_CHARS).text : text.slice(0, TERMINAL_OUTPUT_TAIL_CHARS)
    : text;
  let checked = nativeOutputItemSchema.parse({
    ...item,
    ...(item.input === undefined ? {} : { input: normalizeToolValue(item.input) }),
    ...(boundedOutput === undefined ? {} : { output: boundedOutput }),
    ...(text !== undefined && text.length > TERMINAL_OUTPUT_TAIL_CHARS ? { outputTruncated: true } : {}),
  });
  const index = snapshot.items.findIndex((entry) => entry.id === checked.id);
  const previous = snapshot.items[index];
  let pending = [...(state.requests.get(generationId)?.values() ?? [])].find((entry) => entry.request.itemId === checked.id);
  if (!settling && pending && (!isOutputActive(checked.status) || (checked.request && (checked.request.id !== pending.request.id || !checked.request.respondable)))) {
    const requests = state.requests.get(generationId)!;
    requests.delete(pending.request.id);
    if (!requests.size) state.requests.delete(generationId);
    pending.reject(requestError("The provider closed the interaction."));
    if (!checked.request || checked.request.id === pending.request.id) {
      checked = {
        ...checked, status: isOutputActive(checked.status) ? "cancelled" : checked.status,
        request: { ...pending.request, ...checked.request, respondable: false },
      };
    }
    pending = undefined;
  }
  if (!settling && pending) checked = { ...checked, status: "waiting", request: pending.request };
  else if (!settling && previous?.request && !previous.request.respondable && !isOutputActive(previous.status) && isOutputActive(checked.status)) {
    checked = { ...checked, status: previous.status, completedAt: previous.completedAt, request: previous.request };
  }
  if (!settling && checked.status === "completed" && state.closingItems.get(generationId)?.has(checked.id)) {
    checked = { ...checked, status: previous && isOutputActive(previous.status) ? previous.status : "running", completedAt: undefined };
  }
  // Use provider timestamps when present; otherwise measure observed execution,
  // preserving the first arrival across cumulative item revisions.
  const now = new Date().toISOString();
  checked = {
    ...checked,
    startedAt: checked.startedAt ?? previous?.startedAt ?? now,
    completedAt: isOutputActive(checked.status) ? undefined : checked.completedAt ?? previous?.completedAt ?? now,
  };
  if (checked.type === "command_execution" && isOutputActive(checked.status) && checked.output !== undefined) {
    const command = getCommand(generationId, checked.id);
    if (command.itemOutput !== checked.output || command.itemOutputTruncated !== checked.outputTruncated) {
      command.itemOutput = checked.output;
      command.itemOutputTruncated = checked.outputTruncated;
      command.terminal = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, checked.output);
      command.pending = "";
      command.replace = true;
      scheduleCommand(command);
    }
    checked = { ...checked, output: undefined };
  } else if (checked.type === "command_execution" && !isOutputActive(checked.status) && checked.output === undefined) {
    const command = state.commands.get(commandKey(generationId, checked.id));
    if (command) checked = {
      ...checked, output: command.terminal.text,
      outputTruncated: command.terminal.truncated || command.itemOutputTruncated === true,
    };
  }
  if (index < 0) flushItems(generationId);
  if (index < 0) snapshot.items.push(checked);
  else snapshot.items[index] = checked;
  snapshot.sequence = nextSequence(snapshot);
  save(snapshot);
  scheduleItem({ kind: "item", generationId, sequence: snapshot.sequence, item: checked });
}

export function initializeNativeOutput(generationId: string, threadId: string, status: GenerationOutputStatus = "queued"): AgentOutputSnapshot {
  const existing = getNativeOutput(generationId);
  if (existing) {
    if (existing.threadId !== threadId) throw new DurableError(409, "native_output_conflict", "Generation belongs to another thread.");
    return existing;
  }
  const snapshot = agentOutputSnapshotSchema.parse({ generationId, threadId, sequence: 0, status, items: [] });
  save(snapshot);
  return snapshot;
}
export function getNativeOutput(generationId: string): AgentOutputSnapshot | null {
  return readRecord<AgentOutputSnapshot>(OUTPUTS, generationId);
}
export function setNativeOutputStatus(generationId: string, status: GenerationOutputStatus): void {
  if (!active(status)) {
    endNativeOutput(generationId, status as TerminalStatus);
    return;
  }
  const snapshot = requireOutput(generationId);
  if (!active(snapshot.status) || snapshot.status === status) return;
  flushItems(generationId);
  snapshot.status = status;
  snapshot.sequence = nextSequence(snapshot);
  save(snapshot);
  publish(generationId, { kind: "status", generationId, sequence: snapshot.sequence, status });
}
export function endNativeOutput(generationId: string, status: TerminalStatus): void {
  if (active(status)) throw new TypeError("A terminal output status is required.");
  const snapshot = requireOutput(generationId);
  closeNativeInteractions(generationId);
  if (!active(snapshot.status)) {
    state.closedInteractions.delete(generationId);
    state.closingItems.delete(generationId);
    return;
  }
  flushItems(generationId);
  const current = requireOutput(generationId);
  const endedAt = new Date().toISOString();
  for (const item of current.items) {
    const interruptedWhileClosing = (status === "cancelled" || status === "interrupted") &&
      item.status === "completed" && state.closingItems.get(generationId)?.has(item.id);
    if (!isOutputActive(item.status) && !interruptedWhileClosing && !item.request?.respondable) continue;
    const itemStatus = isOutputActive(item.status) || interruptedWhileClosing
      ? status === "completed" ? "completed" : status
      : item.status;
    upsert(generationId, {
      ...item, status: itemStatus, streaming: false, completedAt: item.completedAt ?? endedAt,
      ...(item.request ? { request: { ...item.request, respondable: false, unavailableReason: "The generation has ended." } } : {}),
    }, true);
  }
  flushItems(generationId);
  const final = requireOutput(generationId);
  final.status = status;
  final.sequence = nextSequence(final);
  save(final);
  state.closedInteractions.delete(generationId);
  state.usedRequests.delete(generationId);
  state.closingItems.delete(generationId);
  publish(generationId, { kind: "status", generationId, sequence: final.sequence, status });
  for (const sink of state.subscribers.get(generationId) ?? []) sink.finish();
  state.subscribers.delete(generationId);
  for (const [key, command] of state.commands) {
    if (command.generationId !== generationId) continue;
    flushCommand(command);
    const frame = commandFrame(command);
    for (const sink of command.sinks) { sink.push(frame); sink.finish(); }
    state.commands.delete(key);
  }
}
/** Only records created by this projection are recovered; legacy chats are untouched. */
export function recoverNativeOutputs(): void {
  for (const snapshot of listRecords<AgentOutputSnapshot>(OUTPUTS)) {
    if (active(snapshot.status)) endNativeOutput(snapshot.generationId, "interrupted");
  }
}
export function emitNativeOutput(generationId: string, event: NativeOutputEvent): void {
  if (event.type === "item.upsert") {
    upsert(generationId, event.item);
    return;
  }
  const snapshot = requireOutput(generationId);
  if (!active(snapshot.status) || !event.chunk) return;
  const command = getCommand(generationId, event.itemId);
  command.terminal = appendTerminalOutput(command.terminal, event.chunk);
  if (!command.replace) {
    if (command.pending.length + event.chunk.length > TERMINAL_OUTPUT_TAIL_CHARS) {
      command.pending = "";
      command.replace = true;
    } else command.pending += event.chunk;
  }
  scheduleCommand(command);
}

function requestError(message: string): DurableError {
  return new DurableError(409, "native_interaction_closed", message);
}
export function requestNativeInteraction(generationId: string, input: NativeInteractionRequest): Promise<NativeInteractionResponse> {
  const request = nativeInteractionRequestSchema.parse(input);
  const snapshot = requireOutput(generationId);
  if (snapshot.status !== "running" || state.closedInteractions.has(generationId)) return Promise.reject(requestError("The generation is no longer accepting interactions."));
  if (!request.respondable) return Promise.reject(requestError("This request cannot be answered."));
  let requests = state.requests.get(generationId);
  if (!requests) state.requests.set(generationId, requests = new Map());
  let used = state.usedRequests.get(generationId);
  if (!used) state.usedRequests.set(generationId, used = new Set());
  if (used.has(request.id) || requests.has(request.id) || [...requests.values()].some((entry) => entry.request.itemId === request.itemId) || snapshot.items.some((item) => item.request && (item.request.id === request.id || item.id === request.itemId) && !isOutputActive(item.status)))
    return Promise.reject(requestError("This request is already registered or closed."));
  const item = snapshot.items.find((entry) => entry.id === request.itemId);
  upsert(generationId, {
    ...(item ?? { id: request.itemId, type: request.kind === "approval" ? "approval_request" : "user_input_request" }),
    status: "waiting", request,
  });
  used.add(request.id);
  const { promise, resolve, reject } = Promise.withResolvers<NativeInteractionResponse>();
  requests.set(request.id, { request, resolve, reject });
  return promise;
}
function validateResponse(request: NativeInteractionRequest, input: unknown): NativeInteractionResponse {
  const parsed = nativeInteractionResponseSchema.safeParse(input);
  if (!parsed.success) throw new DurableError(400, "invalid_native_response", "Invalid interaction response.");
  const response = parsed.data;
  const invalid = () => { throw new DurableError(400, "invalid_native_response", "Response does not match the offered interaction."); };
  if (response.cancelled) {
    if (response.optionId !== undefined || response.answers !== undefined) invalid();
    return response;
  }
  if (request.kind === "approval") {
    if (response.answers !== undefined || !response.optionId || !request.options?.some((option) => option.id === response.optionId)) invalid();
  } else {
    if (response.optionId !== undefined || !response.answers || !request.questions?.length) invalid();
    const answers = response.answers!;
    const questions = request.questions!;
    if (Object.keys(answers).some((id) => !questions.some((question) => question.id === id))) invalid();
    for (const question of questions) {
      const answer = answers[question.id];
      if (answer === undefined || (Array.isArray(answer) && (!question.multiple || !answer.length))) invalid();
      for (const value of Array.isArray(answer) ? answer : [answer]) {
        if (typeof value !== "string" || !value || (question.options?.length && !question.allowText && !question.options.some((option) => option.id === value))) invalid();
      }
    }
  }
  return response;
}
export function respondNativeInteraction(generationId: string, requestId: string, input: unknown): void {
  requireOutput(generationId);
  const requests = state.requests.get(generationId);
  const pending = requests?.get(requestId);
  if (!pending) throw requestError("The interaction is no longer active.");
  const response = validateResponse(pending.request, input);
  const snapshot = requireOutput(generationId);
  const item = snapshot.items.find((entry) => entry.id === pending.request.itemId);
  if (snapshot.status !== "running" || !item || item.status !== "waiting" || item.request?.id !== requestId || !item.request.respondable)
    throw requestError("The interaction is no longer active.");
  upsert(generationId, { ...item, status: response.cancelled ? "cancelled" : "completed", completedAt: new Date().toISOString(), request: { ...pending.request, respondable: false } }, true);
  requests!.delete(requestId);
  if (!requests!.size) state.requests.delete(generationId);
  pending.resolve(response);
}
export function closeNativeInteractions(generationId: string): void {
  state.closedInteractions.add(generationId);
  const snapshot = getNativeOutput(generationId);
  if (snapshot && active(snapshot.status)) {
    let closing = state.closingItems.get(generationId);
    if (!closing) state.closingItems.set(generationId, closing = new Set());
    for (const item of snapshot.items) {
      if (isOutputActive(item.status) && ["command_execution", "dynamic_tool", "file_change", "file_search", "web_search", "subagent"].includes(item.type)) closing.add(item.id);
    }
  }
  const requests = state.requests.get(generationId);
  if (!requests) return;
  state.requests.delete(generationId);
  for (const pending of requests.values())
    pending.reject(requestError("The generation ended before the interaction was answered."));
  for (const pending of requests.values()) {
    const snapshot = getNativeOutput(generationId);
    const item = snapshot?.items.find((entry) => entry.id === pending.request.itemId);
    if (snapshot && active(snapshot.status) && item && isOutputActive(item.status)) {
      upsert(generationId, { ...item, status: "cancelled", completedAt: new Date().toISOString(), request: { ...pending.request, respondable: false, unavailableReason: "The generation has ended." } }, true);
    }
  }
}

/** A small private queue with explicit reset instead of unbounded ReadableStream buffering. */
function stream<T>(initial: T, sinks: Set<Sink<T>>, reset: () => T, signal?: AbortSignal, done = false, sequence?: (frame: T) => number): ReadableStream<T> {
  let queue = [initial];
  let latestSequence = sequence?.(initial);
  let controller: ReadableStreamDefaultController<T>;
  let waiting = false;
  let finished = done;
  let closed = false;
  const cleanup = () => { sinks.delete(sink); signal?.removeEventListener("abort", abort); };
  const abort = () => { if (!closed) { closed = true; cleanup(); controller.close(); } };
  const pump = () => {
    if (closed || !waiting) return;
    if (queue.length) {
      waiting = false;
      controller.enqueue(queue.shift()!);
    } else if (finished) abort();
  };
  const sink: Sink<T> = {
    push(frame) {
      if (closed || finished) return;
      const frameSequence = sequence?.(frame);
      if (frameSequence !== undefined && latestSequence !== undefined && frameSequence <= latestSequence) return;
      if (queue.length >= QUEUE_LIMIT) {
        const snapshot = reset();
        queue = [snapshot];
        latestSequence = sequence?.(snapshot);
      } else {
        queue.push(frame);
        latestSequence = frameSequence;
      }
      pump();
    },
    finish() { finished = true; sinks.delete(sink); pump(); },
  };
  return new ReadableStream<T>({
    start(c) {
      controller = c;
      if (!finished) sinks.add(sink);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    pull() { waiting = true; pump(); },
    cancel() { closed = true; cleanup(); },
  }, { highWaterMark: 0 });
}
export function subscribeNativeOutput(generationId: string, signal?: AbortSignal): ReadableStream<AgentOutputFrame> {
  flushItems(generationId);
  const snapshot = requireOutput(generationId);
  let sinks = state.subscribers.get(generationId);
  if (!sinks) state.subscribers.set(generationId, sinks = new Set());
  return stream<AgentOutputFrame>(
    { kind: "snapshot", snapshot }, sinks, () => ({ kind: "snapshot", snapshot: requireOutput(generationId) }),
    signal, !active(snapshot.status), (frame) => frame.kind === "snapshot" ? frame.snapshot.sequence : frame.sequence,
  );
}
function getCommand(generationId: string, itemId: string, restore = false): CommandState {
  const key = commandKey(generationId, itemId);
  let command = state.commands.get(key);
  if (!command) {
    const item = restore ? getNativeOutput(generationId)?.items.find((entry) => entry.id === itemId) : undefined;
    command = { generationId, itemId, terminal: item?.output ? appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, item.output) : EMPTY_TERMINAL_OUTPUT, pending: "", replace: false, sinks: new Set() };
    state.commands.set(key, command);
  }
  return command;
}
function commandFrame(command: CommandState): CommandOutputFrame {
  const snapshot = requireOutput(command.generationId);
  const item = snapshot.items.find((entry) => entry.id === command.itemId);
  return { kind: "replace", text: terminalOutputResumeText(command.terminal), truncated: command.terminal.truncated || item?.outputTruncated === true, running: active(snapshot.status) && (!item || isOutputActive(item.status)) };
}
function scheduleCommand(command: CommandState): void {
  if (!command.timer) {
    command.timer = setTimeout(() => flushCommand(command), COMMAND_DELAY_MS);
    command.timer.unref?.();
  }
}
function flushCommand(command: CommandState): void {
  clearTimeout(command.timer);
  command.timer = undefined;
  if (!command.pending && !command.replace) return;
  const base = commandFrame(command);
  const frame: CommandOutputFrame = command.replace ? base : { ...base, kind: "append", text: command.pending };
  command.pending = "";
  command.replace = false;
  for (const sink of command.sinks) sink.push(frame);
}
function updateCommandStatus(generationId: string, itemId: string): void {
  const command = state.commands.get(commandKey(generationId, itemId));
  if (!command) return;
  const item = requireOutput(generationId).items.find((entry) => entry.id === itemId);
  if (item && !isOutputActive(item.status) && item.output !== undefined) {
    clearTimeout(command.timer);
    command.timer = undefined;
    command.pending = "";
    command.replace = false;
    command.terminal = appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, item.output);
  } else {
    flushCommand(command);
  }
  const frame = commandFrame(command);
  if (!frame.running) for (const sink of command.sinks) { sink.push(frame); sink.finish(); }
}
export function subscribeCommandOutput(generationId: string, itemId: string, signal?: AbortSignal): ReadableStream<CommandOutputFrame> {
  const snapshot = requireOutput(generationId);
  const item = snapshot.items.find((entry) => entry.id === itemId);
  if (!item || item.type !== "command_execution") throw new DurableError(404, "command_output_not_found", "Command output was not found.");
  const command = getCommand(generationId, itemId, true);
  flushCommand(command);
  const initial = commandFrame(command);
  if (!active(snapshot.status)) state.commands.delete(commandKey(generationId, itemId));
  return stream(initial, command.sinks, () => commandFrame(command), signal, !initial.running);
}
