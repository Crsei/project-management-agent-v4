// Adapted from t3code CodexAdapterV2 and generated app-server schemas.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { nativeInteractionResponseSchema, type NativeOutputEvent, type NativeOutputItem, type NativeInteractionRequest, type NativeInteractionResponse } from "@agent-workspace/contracts/output";
import { object, type CodexRecord } from "./codex-rpc.ts";

const stringify = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "";
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const status = (value: unknown, completed: boolean): NativeOutputItem["status"] => value === "failed" || value === "declined" ? "failed" : value === "inProgress" ? "running" : completed ? "completed" : "running";

export class CodexOutput {
  private items = new Map<string, NativeOutputItem>();
  private reasoning = new Map<string, Map<string, string>>();
  private requests = new Map<string | number, NativeInteractionRequest>();
  private emit: ((event: NativeOutputEvent) => void) | undefined;
  constructor(emit?: (event: NativeOutputEvent) => void) { this.emit = emit; }
  private id(id: unknown): string { return `codex:${String(id)}`; }
  private put(item: NativeOutputItem): void { this.items.set(item.id, item); this.emit?.({ type: "item.upsert", item }); }
  handle(method: string, params: CodexRecord): void {
    if (method === "$request") { this.request(params); return; }
    const nativeId = str(params.itemId);
    if (method === "item/commandExecution/outputDelta" && nativeId && typeof params.delta === "string") {
      this.emit?.({ type: "command.output", itemId: this.id(nativeId), chunk: params.delta }); return;
    }
    if (nativeId && method === "item/fileChange/patchUpdated" && Array.isArray(params.changes)) {
      this.handle("item/started", { item: { id: nativeId, type: "fileChange", status: "inProgress", changes: params.changes } }); return;
    }
    if (nativeId && method === "item/fileChange/outputDelta" && typeof params.delta === "string") {
      const id = this.id(nativeId); const previous = this.items.get(id);
      this.put({ ...previous, id, nativeItemId: nativeId, type: "file_change", status: "running", output: (previous?.output ?? "") + params.delta }); return;
    }
    if (nativeId && method === "item/mcpToolCall/progress" && typeof params.message === "string") {
      const id = this.id(nativeId); const previous = this.items.get(id);
      this.put({ ...previous, id, nativeItemId: nativeId, type: "dynamic_tool", status: "running", text: params.message }); return;
    }
    if (["warning", "guardianWarning", "model/rerouted", "auth/recovery"].includes(method)) {
      this.put({ id: this.id(`notification:${this.items.size}`), type: "notification", status: "completed", title: method, text: str(params.message) ?? stringify(params) }); return;
    }
    if (nativeId && typeof params.delta === "string" && ["item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/plan/delta"].includes(method)) {
      const id = this.id(nativeId);
      const type = method.includes("agentMessage") ? "assistant_message" : method.includes("reasoning") ? "reasoning" : "proposed_plan";
      const previous = this.items.get(id);
      let text: string;
      if (type === "reasoning") {
        let parts = this.reasoning.get(id); if (!parts) { parts = new Map(); this.reasoning.set(id, parts); }
        const key = `${method.includes("summary") ? "summary" : "content"}:${String(params.summaryIndex ?? params.contentIndex ?? 0)}`;
        parts.set(key, (parts.get(key) ?? "") + params.delta);
        text = [...parts.values()].join("\n");
      } else text = (previous?.text ?? "") + params.delta;
      this.put({ ...previous, id, nativeItemId: nativeId, type, status: "running", text, streaming: true }); return;
    }
    if (method === "turn/plan/updated" && Array.isArray(params.plan)) {
      const id = this.id(`turn-plan:${String(params.turnId)}`);
      const steps = params.plan.flatMap((v, i) => { const s = object(v); return typeof s.step === "string" ? [{ id: `step-${i + 1}`, text: s.step, status: s.status === "completed" ? "completed" as const : s.status === "inProgress" ? "running" as const : "pending" as const }] : []; });
      this.put({ id, type: "todo_list", status: "running", steps, ...(str(params.explanation) ? { text: str(params.explanation) } : {}) }); return;
    }
    if (method === "turn/completed") {
      for (const item of this.items.values()) if (item.type === "todo_list" && item.status === "running") this.put({ ...item, status: object(params.turn).status === "completed" ? "completed" : "interrupted" });
      return;
    }
    if (method === "error") {
      const error = object(params.error); const message = str(error.message) ?? stringify(params.error);
      this.put({ id: this.id(`error:${this.items.size}`), type: "error", status: params.willRetry === true ? "running" : "failed", text: message }); return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const native = object(params.item); const nativeItemId = str(native.id); if (!nativeItemId) return;
    const id = this.id(nativeItemId); const previous = this.items.get(id); const completed = method === "item/completed";
    const base = { ...previous, id, nativeItemId, status: status(native.status, completed) };
    switch (native.type) {
      case "agentMessage": this.put({ ...base, type: "assistant_message", text: str(native.text) ?? previous?.text ?? "", streaming: !completed }); break;
      case "reasoning": {
        const parts = [...(Array.isArray(native.summary) ? native.summary : []), ...(Array.isArray(native.content) ? native.content : [])].filter((v): v is string => typeof v === "string");
        this.put({ ...base, type: "reasoning", text: parts.length ? parts.join("\n") : previous?.text ?? "", streaming: !completed }); break;
      }
      case "plan": this.put({ ...base, type: "proposed_plan", text: str(native.text) ?? previous?.text ?? "", streaming: !completed }); break;
      case "commandExecution": this.put({ ...base, type: "command_execution", title: str(native.command), input: native.command, ...(typeof native.aggregatedOutput === "string" ? { output: native.aggregatedOutput } : {}), ...(typeof native.exitCode === "number" ? { exitCode: native.exitCode } : {}) }); break;
      case "fileChange": {
        const changes = Array.isArray(native.changes) ? native.changes.flatMap((v) => { const c = object(v); if (typeof c.path !== "string") return []; const kind = object(c.kind); const target = str(kind.move_path); return [{ path: target ?? c.path, operation: str(c.kind) ?? str(kind.type) ?? "update", ...(target ? { oldPath: c.path } : {}), ...(str(c.diff) ? { diff: str(c.diff) } : {}) }]; }) : [];
        this.put({ ...base, type: "file_change", changes, ...(changes.length === 1 ? { fileName: changes[0]!.path, diff: changes[0]!.diff } : {}) }); break;
      }
      case "webSearch": this.put({ ...base, type: "web_search", text: str(native.query), input: native.action, ...(Array.isArray(native.results) ? { results: native.results.map((v) => { const r = object(v); return { title: str(r.title), url: str(r.url), text: str(r.snippet) }; }) } : {}) }); break;
      case "mcpToolCall": case "dynamicToolCall": case "functionCallOutput": this.put({ ...base, type: "dynamic_tool", toolName: str(native.tool) ?? str(native.name), title: str(native.server), input: native.arguments, ...(native.result != null || native.contentItems != null || native.output != null ? { output: stringify(native.result ?? native.contentItems ?? native.output) } : {}), ...(native.error != null ? { error: stringify(native.error) } : {}) }); break;
      case "collabAgentToolCall": case "subAgentActivity": this.put({ ...base, type: "subagent", title: str(native.tool) ?? str(native.agentPath), text: str(native.prompt), model: str(native.model), childSessionId: str(native.agentThreadId), input: native.agentsStates }); break;
      case "contextCompaction": this.put({ ...base, type: "compaction" }); break;
      case "userMessage": case "hookPrompt": break;
      default: this.put({ ...base, type: "notification", title: str(native.type), text: stringify(native) });
    }
  }
  async userInput(id: string | number, params: CodexRecord, onRequest: (request: NativeInteractionRequest) => Promise<NativeInteractionResponse>): Promise<CodexRecord | null> {
    if (typeof params.itemId !== "string" || !params.itemId || !Array.isArray(params.questions) || !params.questions.length) throw new Error("Invalid Codex user input request.");
    const seen = new Set<string>();
    const questions = params.questions.map((value) => {
      const q = object(value);
      if (typeof q.id !== "string" || !q.id || q.id.length > 512 || seen.has(q.id) || typeof q.header !== "string" || typeof q.question !== "string" || !q.question.trim() || (q.isOther !== undefined && typeof q.isOther !== "boolean") || (q.isSecret !== undefined && typeof q.isSecret !== "boolean") || (q.options != null && !Array.isArray(q.options))) throw new Error("Invalid Codex user input question.");
      seen.add(q.id);
      const labels = new Set<string>();
      const choices = Array.isArray(q.options) ? q.options.map((value) => {
        const option = object(value);
        if (typeof option.label !== "string" || !option.label || option.label.length > 512 || labels.has(option.label) || typeof option.description !== "string") throw new Error("Invalid Codex user input option.");
        labels.add(option.label);
        return { id: option.label, label: option.label, description: option.description };
      }) : [];
      return { id: q.id, title: q.header, prompt: q.question, options: choices, allowText: q.isOther === true || !choices.length, secret: q.isSecret === true, multiple: false };
    });
    const itemId = this.id(`request:${typeof id}:${String(id)}`);
    const request: NativeInteractionRequest = { id: itemId, itemId, kind: "user_input", title: "User input requested", questions, respondable: true };
    this.requests.set(id, request);
    this.put({ id: itemId, type: "user_input_request", status: "waiting", parentItemId: this.id(params.itemId), request });
    try {
      const response = nativeInteractionResponseSchema.parse(await onRequest(request));
      if (!this.requests.has(id)) return null;
      if (response.cancelled) {
        if (response.answers !== undefined || response.optionId !== undefined) throw new Error("Invalid cancelled Codex user input response.");
        this.requests.delete(id);
        this.put({ id: itemId, type: "user_input_request", status: "cancelled", parentItemId: this.id(params.itemId), request: { ...request, respondable: false, unavailableReason: "The user cancelled this request." } });
        return null;
      }
      if (response.optionId !== undefined || !response.answers || Object.keys(response.answers).length !== questions.length || Object.keys(response.answers).some((key) => !seen.has(key))) throw new Error("Invalid Codex user input response.");
      const entries: Array<[string, { answers: string[] }]> = [];
      for (const question of questions) {
        const value = Object.hasOwn(response.answers, question.id) ? response.answers[question.id] : undefined;
        const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        if (values.length !== 1 || !values[0]?.trim() || (!question.allowText && !question.options.some((option) => option.id === values[0]))) throw new Error("Codex user input does not match the offered question.");
        entries.push([question.id, { answers: values }]);
      }
      this.requests.delete(id);
      this.put({ id: itemId, type: "user_input_request", status: "completed", parentItemId: this.id(params.itemId), request: { ...request, respondable: false } });
      return { answers: Object.fromEntries(entries) };
    } catch (error) {
      if (this.requests.delete(id)) this.put({ id: itemId, type: "user_input_request", status: "failed", parentItemId: this.id(params.itemId), request: { ...request, respondable: false, unavailableReason: "The request could not be answered." } });
      throw error;
    }
  }
  expireRequest(id: string | number): void {
    const request = this.requests.get(id); if (!request) return;
    this.requests.delete(id);
    const item = this.items.get(request.itemId);
    this.put({ ...item, id: request.itemId, type: "user_input_request", status: "interrupted", request: { ...request, respondable: false, unavailableReason: "The native request has expired." } });
  }
  expireRequests(): void {
    for (const id of this.requests.keys()) this.expireRequest(id);
  }
  private request(params: CodexRecord): void {
    const method = str(params.method) ?? ""; const payload = object(params.params); const nativeId = str(payload.itemId); const id = this.id(`request:${String(params.id)}`);
    const isInput = method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request";
    if (!isInput && !method.endsWith("requestApproval") && method !== "execCommandApproval" && method !== "applyPatchApproval") {
      this.put({ id, type: "notification", status: "failed", title: method, text: "This PM session does not authorize this native request.", ...(nativeId ? { parentItemId: this.id(nativeId) } : {}) }); return;
    }
    const questions = Array.isArray(payload.questions) ? payload.questions.flatMap((v) => { const q = object(v); if (typeof q.id !== "string" || typeof q.question !== "string") return []; return [{ id: q.id, title: str(q.header), prompt: q.question, secret: q.isSecret === true, allowText: q.isOther === true, options: Array.isArray(q.options) ? q.options.flatMap((o) => { const opt = object(o); return typeof opt.label === "string" ? [{ id: opt.label, label: opt.label, description: str(opt.description) }] : []; }) : undefined }]; }) : undefined;
    const request: NativeInteractionRequest = { id, itemId: id, kind: isInput ? "user_input" : "approval", title: isInput ? "User input requested" : "Native permission requested", detail: str(payload.reason) ?? str(payload.command), respondable: false, unavailableReason: "This PM session does not authorize interactive native requests.", ...(questions ? { questions } : {}) };
    this.put({ id, type: isInput ? "user_input_request" : "approval_request", status: "failed", request, ...(nativeId ? { parentItemId: this.id(nativeId) } : {}) });
  }
}
