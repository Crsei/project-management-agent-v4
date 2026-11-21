import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { UIMessage } from "ai";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import { agentCatalogSchema, type AgentCatalog } from "../../../../../packages/contracts/src/agent-file-areas.ts";
import { threadSettingsSchema, executionSelectionSchema, chatOnlyExecutionSelection } from "@agent-workspace/contracts/chat";
import { pmToolInvocationSchema, pmToolTargetSchema } from "@agent-workspace/contracts/pm-tools";
import { publicThread, publicAuthorizedThread, publicChatGeneration } from "../chat.ts";
import { ensureThread, getThread, getThreadHistory, getThreadBranch, updateThread } from "../durable/threads.ts";
import { cancelThreadChat, getActiveChat, getChatGeneration, listChatGenerations, submitChat, type ChatRequest } from "../durable/chat-runtime.ts";
import { readRecord, transaction, writeRecord } from "../durable/store.ts";
import { listStoredInstances } from "../providers/instances.ts";
import { getProviderModels, resolveProviderModelOptions } from "../providers/catalog.ts";
import { callPmTool, listPmTools, readPmToolOperation, destructivePmToolNames } from "../pm-tools.ts";
import { assertMcpIdentity, assertMcpThread, grantMcpThread, mcpIdentityHeaders, type McpInvocationIdentity } from "./identity.ts";
import { assertLocalContext, isLocalMcpContext, localCatalog, localIdentityForTarget, localScopedIdentity, type LocalMcpContext, type McpToolIdentity } from "./local-access.ts";
import { closeMcpAppSession } from "../mcp-apps/live.ts";
import { resolveAgentExecution } from "../durable/agent-execution.ts";
import { readMcpExecutionRoot, readMcpExecutionRootRecord, reserveMcpExecutionRoot, type McpExecutionRoot } from "./grants.ts";
import { createPmVisibilityProjector } from "../pm-visibility.ts";

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
  t3_thread_launch: z.strictObject({ clientRequestId: id, title: z.string().trim().min(1).max(256), executionSelection: executionSelectionSchema.optional(), providerInstanceId: id.optional(), modelId: id.optional() }),
  t3_thread_send: z.strictObject({ threadId: id, clientRequestId: id, text: z.string().min(1).max(120000), providerInstanceId: id.optional(), modelId: id.optional() }),
  t3_thread_interrupt: z.strictObject({ threadId: id, generationId: id }),
  pm_get_operation_result: z.strictObject({ operationId: z.uuid().toLowerCase() }),
};
const descriptions: Record<keyof typeof schemas, string> = {
  orchestrator_capabilities: "Read enabled Provider/model catalogs. No provider login, native session, configuration, or secrets are returned.",
  t3_project_list: "List currently authorized PM business projects; projectId is a PM ID, not a repository or directory.",
  t3_project_read: "Read one currently authorized PM project catalog entry, without creating a default directory.",
  t3_thread_list: "List only explicitly granted or this client's atomically created Chat threads. Never search unrelated history.",
  t3_thread_read: "Read a granted Chat thread and a bounded history page. Acceptance/interrupt does not imply rollback.",
  t3_thread_launch: "Create one idle chat-only Session, with a separate PM delegation ceiling. Directory-backed Sessions cannot be created by PM credentials. Pass providerInstanceId/modelId to save an explicit catalog selection. clientRequestId is required; no model turn is created.",
  t3_thread_send: "Send a message to a granted idle Chat. Optional providerInstanceId/modelId explicitly save a catalog-validated selection using idle revision-CAS before sending. Returns acceptance, not completion. Retry the same clientRequestId only with identical arguments; unknown outcomes are never redispatched.",
  t3_thread_interrupt: "Stop the exact current generation of a granted Chat. Cancellation is not rollback; existing receipts remain authoritative.",
  pm_get_operation_result: "Read the original PM operation's currently authorized result and server-issued correlation. Requires only its original operationId; never executes or redispatches a business command. Unknown stays unresolved without authoritative evidence.",
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
  return pmCatalogSchema.parse(await listPmTools(await mcpIdentityHeaders(identity), identity)).tools;
}
type PmCatalogTool = z.infer<typeof pmCatalogSchema>["tools"][number];
function toMcpToolDefinition(tool: PmCatalogTool): McpToolDefinition {
  return { name: tool.name, description: `${tool.description ?? tool.name} Uses the common PM approval/receipt service. No Chat Session is required. Preserve operationId and exact arguments; recover using pm_get_operation_result.`,
    inputSchema: decodeToolSchema({ ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties as Record<string, unknown>), operationId: { type: "string", format: "uuid" } },
      required: [...new Set([...((tool.inputSchema.required as string[] | undefined) ?? []), "operationId"])], additionalProperties: false }),
    annotations: { readOnlyHint: !tool.write, destructiveHint: destructivePmToolNames[tool.name] === true, idempotentHint: true, openWorldHint: tool.write } };
}
/** Local access has no Chat thread delegation; only PM business targets and project reads are exposed. */
const localApplicationTools = applicationTools.filter(tool => tool.name === "orchestrator_capabilities" || tool.name === "t3_project_list" || tool.name === "t3_project_read" || tool.name === "pm_get_operation_result");
function localRefs(identity: LocalMcpContext) {
  const wide = new Set(identity.local.grants.filter(ref => ref.projectId === null).map(ref => ref.workspaceId));
  return identity.local.grants.filter(ref => ref.projectId === null || !wide.has(ref.workspaceId));
}
/** The union reflects every enabled workspace/project; each call still rechecks the specific target. */
async function localPmCatalog(identity: LocalMcpContext): Promise<PmCatalogTool[]> {
  const tools = new Map<string, PmCatalogTool>();
  let lastError: unknown;
  for (const ref of localRefs(identity)) {
    try {
      const scoped = localScopedIdentity(identity, ref);
      for (const tool of await pmCatalog(scoped)) {
        const prior = tools.get(tool.name);
        if (!prior) tools.set(tool.name, { ...tool });
        else if (tool.write && !prior.write) prior.write = true;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!tools.size) {
    if (lastError instanceof Error) throw lastError;
    fail("No PM tool is currently authorized for local access", 403);
  }
  return [...tools.values()];
}
export async function listMcpTools(identity: McpToolIdentity): Promise<McpToolDefinition[]> {
  if (isLocalMcpContext(identity)) {
    await assertLocalContext(identity);
    await localCatalog(identity);
    const tools = localApplicationTools.map(tool => ({ ...tool }));
    for (const tool of await localPmCatalog(identity)) {
      if (tools.some(existing => existing.name === tool.name)) fail("PM tool registry contains a duplicate tool name", 503);
      tools.push(toMcpToolDefinition(tool));
    }
    return tools;
  }
  await catalog(identity);
  const tools = applicationTools.filter(tool => identity.access === "full" || !writes[tool.name]);
  for (const tool of await pmCatalog(identity)) {
    if (tool.write && identity.access !== "full") continue;
    if (tools.some(existing => existing.name === tool.name)) fail("PM tool registry contains a duplicate tool name", 503);
    tools.push(toMcpToolDefinition(tool));
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
function externalPmContext(identity: McpInvocationIdentity, root: McpExecutionRoot) {
  return {
    executionRoot: "external" as const, executionId: root.executionId, traceId: root.traceId, executionGrantId: root.executionId,
    delegation: identity, targetCeiling: root.scope,
    authorizeExecution: async () => { await assertMcpIdentity(identity); },
  };
}
async function publicMcpAcceptance(identity: McpInvocationIdentity, threadId: string, value: unknown): Promise<unknown> {
  const result = z.object({ status: z.literal("accepted"), generation: z.object({ id, threadId: id }).passthrough() }).parse(value);
  if (result.generation.threadId !== threadId) fail("Acceptance belongs to another Chat", 409);
  const projector = await createPmVisibilityProjector(threadId, await mcpIdentityHeaders(identity));
  await assertMcpThread(identity, threadId);
  return { status: result.status, generation: projector.generation(result.generation) };
}
async function publicMcpCreatedThread(identity: McpInvocationIdentity, value: unknown): Promise<unknown> {
  const result = z.object({ thread: z.object({ remoteId: id }) }).parse(value);
  const thread = getThread(result.thread.remoteId);
  if (!thread) fail("Created Chat is unavailable", 404);
  await assertMcpThread(identity, thread.remoteId);
  const projected = await publicAuthorizedThread(thread, await mcpIdentityHeaders(identity));
  await assertMcpThread(identity, thread.remoteId);
  return { thread: projected };
}
function providerCatalog(search?: string) {
  return listStoredInstances().filter(instance => instance.enabled).map(instance => ({ instanceId: instance.instanceId, driver: instance.driver, label: instance.label,
    models: getProviderModels(instance.instanceId).filter(model => !search || JSON.stringify([model.id, model.label]).toLowerCase().includes(search)).map(model => ({ id: model.id, name: model.label })) }));
}
function flatProjects(value: AgentCatalog) {
  return value.workspaces.flatMap(workspace => workspace.projects.map(project => ({ ...project, workspaceId: workspace.id, workspaceName: workspace.name })));
}
async function invokeLocalMcpTool(identity: LocalMcpContext, name: string, value: unknown): Promise<unknown> {
  await assertLocalContext(identity);
  if (name === "orchestrator_capabilities") {
    const input = schemas.orchestrator_capabilities.parse(value); await localCatalog(identity);
    return { providers: providerCatalog(input.search?.toLowerCase()), scope: { all: true }, access: "full" };
  }
  if (name === "t3_project_list") {
    const input = schemas.t3_project_list.parse(value), projects = flatProjects(await localCatalog(identity));
    return { projects: projects.slice(input.cursor, input.cursor + input.limit), nextCursor: input.cursor + input.limit < projects.length ? input.cursor + input.limit : null };
  }
  if (name === "t3_project_read") {
    const input = schemas.t3_project_read.parse(value), project = flatProjects(await localCatalog(identity)).find(item => item.id === input.projectId);
    if (!project) fail("Project not found in the enabled local access", 404);
    return project;
  }
  if (name.startsWith("t3_thread_")) fail("Local MCP access does not include Chat sessions; grant explicit threads through OAuth consent.", 403);
  if (name === "pm_list_workspaces") {
    z.strictObject({ arguments: z.strictObject({}) }).parse(value);
    return { kind: "workspaces", items: (await localCatalog(identity)).workspaces, nextCursor: null, truncated: false, sources: [] };
  }
  if (name === "pm_get_operation_result") {
    const input = schemas.pm_get_operation_result.parse(value);
    const root = readMcpExecutionRootRecord(input.operationId);
    if (!root) fail("Original operation is unavailable to this delegation.", 404);
    const scoped = localIdentityForTarget(identity, root.scope);
    return readPmToolOperation(input.operationId, externalPmContext(scoped, readMcpExecutionRoot(scoped, input.operationId)));
  }
  const tool = (await localPmCatalog(identity)).find(item => item.name === name);
  if (!tool) fail("Unknown or unauthorized tool", 404);
  const supplied = z.strictObject({ operationId: z.uuid().toLowerCase(), target: pmToolTargetSchema.optional(), arguments: z.unknown() }).parse(value);
  const input = pmToolInvocationSchema.parse({ ...supplied, name });
  if (!input.target) fail("This PM tool requires an explicit workspace/project target.", 400);
  const scoped = localIdentityForTarget(identity, input.target);
  const { root, created } = reserveMcpExecutionRoot(scoped, input);
  const context = externalPmContext(scoped, root);
  if (!created) return readPmToolOperation(input.operationId, context);
  await callPmTool({ ...context, headers: await mcpIdentityHeaders(scoped),
    authorizeExecution: async () => { await assertMcpIdentity(scoped); } }, input);
  return readPmToolOperation(input.operationId, context);
}
export async function invokeMcpTool(identity: McpToolIdentity, name: string, value: unknown): Promise<unknown> {
  if (isLocalMcpContext(identity)) return invokeLocalMcpTool(identity, name, value);
  await assertMcpIdentity(identity);
  if (writes[name]) assertMcpWrite(identity);
  if (name === "orchestrator_capabilities") {
    const input = schemas.orchestrator_capabilities.parse(value); await catalog(identity);
    return { providers: providerCatalog(input.search?.toLowerCase()), scope: identity.scope, access: identity.access };
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
      await assertMcpThread(identity, threadId);
      const projected = await publicAuthorizedThread(thread, await mcpIdentityHeaders(identity));
      await assertMcpThread(identity, threadId); threads.push(projected);
    }
    threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { threads: threads.slice(input.cursor, input.cursor + input.limit), nextCursor: input.cursor + input.limit < threads.length ? input.cursor + input.limit : null };
  }
  if (name === "t3_thread_read") {
    const input = schemas.t3_thread_read.parse(value); await assertMcpThread(identity, input.threadId);
    const thread = getThread(input.threadId); if (!thread) fail("Thread not found", 404);
    const history = getThreadHistory(input.threadId), active = getActiveChat(input.threadId);
    const projector = await createPmVisibilityProjector(input.threadId, await mcpIdentityHeaders(identity));
    await assertMcpThread(identity, input.threadId);
    const messages = projector.history(history.messages);
    const projectedThread = await publicAuthorizedThread(thread, await mcpIdentityHeaders(identity));
    await assertMcpThread(identity, input.threadId);
    return { thread: projectedThread, headId: history.headId, messages: messages.slice(input.cursor, input.cursor + input.limit), nextCursor: input.cursor + input.limit < messages.length ? input.cursor + input.limit : null, activeGeneration: active ? projector.generation(publicChatGeneration(active)) : null };
  }
  if (name === "t3_thread_launch") {
    const input = schemas.t3_thread_launch.parse(value); await catalog(identity);
    const key = receiptKey(identity, name, input.clientRequestId), signature = fingerprint(input);
    const selection = input.executionSelection ?? chatOnlyExecutionSelection();
    if (selection.agentWorkspaceId !== null || selection.agentWorkspaceRevision !== null)
      fail("PM MCP credentials confer no Agent directory access; launch must be chat-only");
    const prior = priorReceipt(key, signature);
    if (prior) return prior.result ? publicMcpCreatedThread(identity, prior.result) : { status: "unknown", message: "Original Session creation is unresolved; do not redispatch." };
    const threadId = randomUUID();
    const execution = await resolveAgentExecution(selection, threadId);
    const result = transaction(() => {
      const prior = priorReceipt(key, signature); if (prior) return prior.result;
      if ((input.providerInstanceId === undefined) !== (input.modelId === undefined))
        fail("Explicit launch selection requires both providerInstanceId and modelId", 400);
      const modelOptions = input.providerInstanceId && input.modelId
        ? resolveProviderModelOptions(input.providerInstanceId, input.modelId) : undefined;
      ensureThread(threadId, input.title, selection, execution.environment);
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
    return publicMcpCreatedThread(identity, result);
  }
  if (name === "t3_thread_send") {
    const input = schemas.t3_thread_send.parse(value); await assertMcpThread(identity, input.threadId);
    const key = receiptKey(identity, name, input.clientRequestId), signature = fingerprint(input);
    const prior = priorReceipt(key, signature);
    if (prior) {
      if (prior.result) return publicMcpAcceptance(identity, input.threadId, prior.result);
      // A process interruption between Chat acceptance and receipt publication is recoverable by its stable request identity.
      const accepted = listChatGenerations(input.threadId).find(generation => generation.request.idempotencyKey === key);
      if (accepted) {
        const result = { status: "accepted", generation: publicChatGeneration(accepted) };
        writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "succeeded", generationId: accepted.id, result });
        return publicMcpAcceptance(identity, input.threadId, result);
      }
      return { status: "unknown", message: "Original acceptance is unresolved; do not redispatch." };
    }
    let thread = getThread(input.threadId); if (!thread) fail("Thread not found", 404);
    if (getActiveChat(input.threadId)) fail("Thread is busy; stop it explicitly before changing selection or sending", 409);
    writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "running" });
    let result: unknown;
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
      result = { status: "accepted", generation: publicChatGeneration(generation) };
      writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "succeeded", generationId: generation.id, result });
    } catch (error) {
      writeRecord<Receipt>(receipts, key, { fingerprint: signature, status: "unknown" }); throw error;
    }
    return publicMcpAcceptance(identity, input.threadId, result);
  }
  if (name === "t3_thread_interrupt") {
    const input = schemas.t3_thread_interrupt.parse(value); await assertMcpThread(identity, input.threadId);
    const generation = getChatGeneration(input.generationId);
    if (!generation || generation.threadId !== input.threadId) fail("Generation not granted", 404);
    await assertMcpThread(identity, input.threadId);
    await cancelThreadChat(input.threadId, { generationId: input.generationId });
    return { cancelled: true, generationId: input.generationId, rollback: false };
  }
  if (name === "pm_get_operation_result") {
    const input = schemas.pm_get_operation_result.parse(value);
    const root = readMcpExecutionRoot(identity, input.operationId);
    return readPmToolOperation(input.operationId, externalPmContext(identity, root));
  }
  const tool = (await pmCatalog(identity)).find(item => item.name === name);
  if (!tool) fail("Unknown or unauthorized tool", 404);
  if (tool.write) assertMcpWrite(identity);
  const supplied = z.strictObject({ operationId: z.uuid().toLowerCase(), target: pmToolTargetSchema.optional(), arguments: z.unknown() }).parse(value);
  const input = pmToolInvocationSchema.parse({ ...supplied, name });
  const { root, created } = reserveMcpExecutionRoot(identity, input);
  const context = externalPmContext(identity, root);
  if (!created) return readPmToolOperation(input.operationId, context);
  await callPmTool({ ...context, headers: await mcpIdentityHeaders(identity),
    authorizeExecution: async () => { if (tool.write) assertMcpWrite(identity); await assertMcpIdentity(identity); } }, input);
  return readPmToolOperation(input.operationId, context);
}
