import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { UIMessage } from "ai";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import { agentCatalogSchema } from "../../../../../packages/contracts/src/agent-file-areas.ts";
import { threadSettingsSchema } from "@agent-workspace/contracts/chat";
import { publicThread, publicChatGeneration } from "../chat.ts";
import { ensureThread, getThread, getThreadHistory, getThreadBranch, updateThread } from "../durable/threads.ts";
import { cancelThreadChat, getActiveChat, getChatGeneration, listChatGenerations, submitChat, type ChatRequest } from "../durable/chat-runtime.ts";
import { readRecord, transaction, writeRecord } from "../durable/store.ts";
import { listStoredInstances } from "../providers/instances.ts";
import { getProviderModels, resolveProviderModelOptions } from "../providers/catalog.ts";
import { callPmTool, listPmTools, destructivePmToolNames } from "../pm-tools.ts";
import { assertMcpIdentity, assertMcpThread, grantMcpThread, mcpIdentityHeaders, type McpInvocationIdentity } from "./identity.ts";
import { closeMcpAppSession } from "../mcp-apps/live.ts";

// Adapted from copied mcp/toolkits/{orchestrator,project}/tools.ts and handlers.ts.
// PM project IDs identify business projects, NOT upstream repository projects or arbitrary cwd.
export type McpToolDefinition = { name: string; description: string; inputSchema: McpSchema.ToolJson; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } };
const id = z.string().min(1).max(256);
const page = { cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) };
const schemas = {
  orchestrator_capabilities: z.strictObject({ search: z.string().max(128).optional() }),
  t3_project_list: z.strictObject(page),
  t3_project_read: z.strictObject({ projectId: id }),
  t3_thread_list: z.strictObject(page),
  t3_thread_read: z.strictObject({ threadId: id, ...page }),
  t3_thread_launch: z.strictObject({ clientRequestId: id, title: z.string().trim().min(1).max(256), providerInstanceId: id.optional(), modelId: id.optional() }),
  t3_thread_send: z.strictObject({ threadId: id, clientRequestId: id, text: z.string().min(1).max(120000), providerInstanceId: id.optional(), modelId: id.optional() }),
  t3_thread_interrupt: z.strictObject({ threadId: id, generationId: id }),
};
const descriptions: Record<keyof typeof schemas, string> = {
  orchestrator_capabilities: "Read enabled Provider/model catalogs. No provider login, native session, configuration, or secrets are returned.",
  t3_project_list: "List currently authorized PM business projects; projectId is a PM ID, not a repository or directory.",
  t3_project_read: "Read one currently authorized PM project catalog entry, without creating a default directory.",
  t3_thread_list: "List only explicitly granted or this client's atomically created Chat threads. Never search unrelated history.",
  t3_thread_read: "Read a granted Chat thread and a bounded history page. Acceptance/interrupt does not imply rollback.",
  t3_thread_launch: "Create one idle scoped Chat thread. Pass both providerInstanceId and modelId to save an explicit catalog selection, or inherit Chat defaults. clientRequestId is required; no worktree or model turn is created.",
  t3_thread_send: "Send a message to a granted idle Chat. Optional providerInstanceId/modelId explicitly save a catalog-validated selection using idle revision-CAS before sending. Returns acceptance, not completion. Retry the same clientRequestId only with identical arguments; unknown outcomes are never redispatched.",
  t3_thread_interrupt: "Stop the exact current generation of a granted Chat. Cancellation is not rollback; existing receipts remain authoritative.",
};
const writes: Readonly<Record<string, true>> = { t3_thread_launch: true, t3_thread_send: true, t3_thread_interrupt: true };
const decodeToolSchema = Schema.decodeUnknownSync(McpSchema.ToolJson);
const applicationTools: McpToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name as keyof typeof schemas], inputSchema: decodeToolSchema(z.toJSONSchema(schema, { io: "input" })),
  annotations: { readOnlyHint: !writes[name], destructiveHint: writes[name] === true, idempotentHint: true, openWorldHint: name === "t3_thread_send" },
}));
const pmCatalogSchema = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional(), write: z.boolean(), inputSchema: z.record(z.string(), z.unknown()) })) });
function fail(message: string, status = 403): never { throw Object.assign(new Error(message), { status }); }
export function assertMcpWrite(identity: McpInvocationIdentity): void { if (identity.access !== "full") fail("Read-only MCP grants cannot create, send, stop, or execute write tools."); }
async function catalog(identity: McpInvocationIdentity) {
  await assertMcpIdentity(identity);
  const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) fail("Invalid PM API origin", 503);
  const response = await fetch(new URL("/api/v1/agent-contexts", base.origin), { headers: await mcpIdentityHeaders(identity), redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) fail("Current PM scope is unavailable", response.status === 401 ? 401 : 403);
  const result = agentCatalogSchema.parse(await response.json());
  await assertMcpIdentity(identity);
  const workspace = result.workspaces.find(item => item.id === identity.scope.workspaceId);
  if (!workspace || identity.scope.projectId !== null && !workspace.projects.some(item => item.id === identity.scope.projectId)) fail("Granted PM project is no longer accessible");
  return workspace.projects.filter(item => identity.scope.projectId === null || item.id === identity.scope.projectId);
}
async function pmCatalog(identity: McpInvocationIdentity) {
  return pmCatalogSchema.parse(await listPmTools(identity.scope.workspaceId, await mcpIdentityHeaders(identity))).tools;
}
export async function listMcpTools(identity: McpInvocationIdentity): Promise<McpToolDefinition[]> {
  await catalog(identity);
  const tools = applicationTools.filter(tool => identity.access === "full" || !writes[tool.name]);
  for (const tool of await pmCatalog(identity)) {
    if (tool.write && identity.access !== "full") continue;
    tools.push({ name: tool.name, description: `${tool.description ?? tool.name} Uses the common PM approval/receipt service. Preserve operationId and exact arguments.`,
      inputSchema: decodeToolSchema({ type: "object", properties: { threadId: { type: "string", minLength: 1 }, operationId: { type: "string", format: "uuid" }, arguments: tool.inputSchema }, required: ["threadId", "operationId", "arguments"], additionalProperties: false }),
      annotations: { readOnlyHint: !tool.write, destructiveHint: destructivePmToolNames[tool.name] === true, idempotentHint: true, openWorldHint: tool.write } });
  }
  return tools;
}
const receipts = "mcp:tool-receipts";
type Receipt = { fingerprint: string; status: "running" | "succeeded" | "unknown"; result?: unknown; generationId?: string };
function receiptKey(identity: McpInvocationIdentity, name: string, requestId: string) { return JSON.stringify([identity.grantId, name, requestId]); }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function priorReceipt(key: string, signature: string): Receipt | null {
  const prior = readRecord<Receipt>(receipts, key);
  if (prior && prior.fingerprint !== signature) fail("clientRequestId already belongs to different arguments", 409);
  return prior;
}
export async function invokeMcpTool(identity: McpInvocationIdentity, name: string, value: unknown): Promise<unknown> {
  await assertMcpIdentity(identity);
  if (writes[name]) assertMcpWrite(identity);
  if (name === "orchestrator_capabilities") {
    const input = schemas.orchestrator_capabilities.parse(value); await catalog(identity);
    const search = input.search?.toLowerCase();
    return { providers: listStoredInstances().filter(instance => instance.enabled).map(instance => ({ instanceId: instance.instanceId, driver: instance.driver, label: instance.label,
      models: getProviderModels(instance.instanceId).filter(model => !search || JSON.stringify([model.id, model.label]).toLowerCase().includes(search)).map(model => ({ id: model.id, name: model.label })) })), scope: identity.scope, access: identity.access };
  }
  if (name === "t3_project_list") {
    const input = schemas.t3_project_list.parse(value), projects = await catalog(identity);
    return { projects: projects.slice(input.cursor, input.cursor + input.limit), nextCursor: input.cursor + input.limit < projects.length ? input.cursor + input.limit : null };
  }
  if (name === "t3_project_read") {
    const input = schemas.t3_project_read.parse(value), project = (await catalog(identity)).find(item => item.id === input.projectId);
    if (!project) fail("Project not granted", 404); return project;
  }
  if (name === "t3_thread_list") {
    const input = schemas.t3_thread_list.parse(value); await catalog(identity);
    const threads = [];
    for (const threadId of identity.threadIds) {
      const thread = getThread(threadId); if (!thread) continue;
      await assertMcpThread(identity, threadId); threads.push(publicThread(thread));
    }
    threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { threads: threads.slice(input.cursor, input.cursor + input.limit), nextCursor: input.cursor + input.limit < threads.length ? input.cursor + input.limit : null };
  }
  if (name === "t3_thread_read") {
    const input = schemas.t3_thread_read.parse(value); await assertMcpThread(identity, input.threadId);
    const thread = getThread(input.threadId); if (!thread) fail("Thread not found", 404);
    const history = getThreadHistory(input.threadId), active = getActiveChat(input.threadId);
    return { thread: publicThread(thread), headId: history.headId, messages: history.messages.slice(input.cursor, input.cursor + input.limit), nextCursor: input.cursor + input.limit < history.messages.length ? input.cursor + input.limit : null, activeGeneration: active ? publicChatGeneration(active) : null };
  }
  if (name === "t3_thread_launch") {
    const input = schemas.t3_thread_launch.parse(value); await catalog(identity);
    const key = receiptKey(identity, name, input.clientRequestId), signature = fingerprint(input);
    return transaction(() => {
      const prior = priorReceipt(key, signature); if (prior) return prior.result;
      if ((input.providerInstanceId === undefined) !== (input.modelId === undefined))
        fail("Explicit launch selection requires both providerInstanceId and modelId", 400);
      const modelOptions = input.providerInstanceId && input.modelId
        ? resolveProviderModelOptions(input.providerInstanceId, input.modelId) : undefined;
      const threadId = randomUUID(); ensureThread(threadId, input.title, identity.scope);
      if (input.providerInstanceId && input.modelId) {
        const thread = getThread(threadId)!;
        updateThread(threadId, { revision: thread.revision, settings: threadSettingsSchema.parse({
          ...thread.settings, providerInstanceId: input.providerInstanceId, model: input.modelId, modelOptions,
        }) });
      }
      grantMcpThread(identity, threadId);
      const result = { thread: publicThread(getThread(threadId)!) };
      writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "succeeded", result }); return result;
    });
  }
  if (name === "t3_thread_send") {
    const input = schemas.t3_thread_send.parse(value); await assertMcpThread(identity, input.threadId);
    const key = receiptKey(identity, name, input.clientRequestId), signature = fingerprint(input);
    const prior = priorReceipt(key, signature);
    if (prior) {
      if (prior.result) return prior.result;
      // A process interruption between Chat acceptance and receipt publication is recoverable by its stable request identity.
      const accepted = listChatGenerations(input.threadId).find(generation => generation.request.idempotencyKey === key);
      if (accepted) {
        const result = { status: "accepted", generation: publicChatGeneration(accepted) };
        writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "succeeded", generationId: accepted.id, result });
        return result;
      }
      return { status: "unknown", message: "Original acceptance is unresolved; do not redispatch." };
    }
    let thread = getThread(input.threadId); if (!thread) fail("Thread not found", 404);
    if (getActiveChat(input.threadId)) fail("Thread is busy; stop it explicitly before changing selection or sending", 409);
    writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "running" });
    try {
      if (input.providerInstanceId !== undefined || input.modelId !== undefined) {
        const providerInstanceId = input.providerInstanceId ?? thread.settings.providerInstanceId;
        const model = input.modelId ?? thread.settings.model;
        const settings = threadSettingsSchema.parse({ ...thread.settings, providerInstanceId, model,
          modelOptions: resolveProviderModelOptions(providerInstanceId, model) });
        if (JSON.stringify(settings) !== JSON.stringify(thread.settings)) {
          // Same catalog validation, App invalidation and revision-CAS as Chat settings, additionally idle-only.
          await closeMcpAppSession(input.threadId);
          await assertMcpThread(identity, input.threadId);
          if (getActiveChat(input.threadId)) fail("Thread became busy before selection was saved", 409);
          thread = updateThread(input.threadId, { revision: thread.revision, settings });
        }
      }
      const request: ChatRequest = { id: input.threadId, idempotencyKey: key, config: { providerInstanceId: thread.settings.providerInstanceId, modelName: thread.settings.model, threadSettingsRevision: thread.revision },
        messages: [...getThreadBranch(input.threadId).map(message => ({ id: message.id, ...message.content }) as UIMessage), { id: randomUUID(), role: "user", parts: [{ type: "text", text: input.text }] }] };
      const generation = await submitChat(request, undefined, await mcpIdentityHeaders(identity));
      const result = { status: "accepted", generation: publicChatGeneration(generation) };
      writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "succeeded", generationId: generation.id, result }); return result;
    } catch (error) {
      writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "unknown" }); throw error;
    }
  }
  if (name === "t3_thread_interrupt") {
    const input = schemas.t3_thread_interrupt.parse(value); await assertMcpThread(identity, input.threadId);
    const generation = getChatGeneration(input.generationId);
    if (!generation || generation.threadId !== input.threadId) fail("Generation not granted", 404);
    await assertMcpThread(identity, input.threadId);
    await cancelThreadChat(input.threadId, { generationId: input.generationId });
    return { cancelled: true, generationId: input.generationId, rollback: false };
  }
  const tool = (await pmCatalog(identity)).find(item => item.name === name);
  if (!tool) fail("Unknown or unauthorized tool", 404);
  if (tool.write) assertMcpWrite(identity);
  const input = z.strictObject({ threadId: id, operationId: z.uuid(), arguments: z.unknown() }).parse(value);
  await assertMcpThread(identity, input.threadId);
  return callPmTool({ scope: identity.scope, threadId: input.threadId, messageId: `mcp:${input.operationId}`, generationId: `mcp:${input.operationId}`, delegation: identity,
    headers: await mcpIdentityHeaders(identity), authorizeExecution: async () => { if (tool.write) assertMcpWrite(identity); await assertMcpThread(identity, input.threadId); } }, { operationId: input.operationId, name, arguments: input.arguments });
}
