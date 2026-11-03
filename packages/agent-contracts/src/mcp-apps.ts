// Adapted from t3code packages/contracts/src/mcpApps.ts and shared/src/mcpApp.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { z } from "zod";

const id = z.string().min(1).max(512);
const domains = z.array(z.string().max(256)).max(32).optional();
export const mcpAppProducingIdentitySchema = z.object({
  threadId: id, itemId: id, generationId: id, providerInstanceId: id,
  instanceRevision: z.number().int().nonnegative(), providerSessionId: id,
  providerThreadId: id, nativeSessionId: id,
}).strict();
export type McpAppProducingIdentity = z.infer<typeof mcpAppProducingIdentitySchema>;
export const mcpAppMetadataSchema = z.object({
  attachmentId: id, server: z.string().min(1).max(256), tool: z.string().min(1).max(256),
  resourceUri: z.string().max(4096).startsWith("ui://"),
  csp: z.object({ connectDomains: domains, resourceDomains: domains, frameDomains: domains, baseUriDomains: domains }).optional(),
  permissions: z.object({ camera: z.object({}).optional(), microphone: z.object({}).optional(),
    geolocation: z.object({}).optional(), clipboardWrite: z.object({}).optional() }).optional(),
  prefersBorder: z.boolean().optional(), producing: mcpAppProducingIdentitySchema,
});
export type McpAppMetadata = z.infer<typeof mcpAppMetadataSchema>;
export const mcpAppToolResultSchema = z.object({
  content: z.array(z.unknown()), structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(), _meta: z.unknown().optional(),
});
export type McpAppToolResult = z.infer<typeof mcpAppToolResultSchema>;
export const mcpAppCallInputSchema = z.object({
  name: z.string().trim().min(1).max(256), arguments: z.record(z.string(), z.unknown()),
}).strict();
export type McpAppCallInput = z.infer<typeof mcpAppCallInputSchema>;
export const mcpAppResourceInputSchema = z.object({ uri: z.string().trim().min(1).max(4096) }).strict();
export type McpAppResourceInput = z.infer<typeof mcpAppResourceInputSchema>;
export const mcpAppContextInputSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type McpAppContextInput = z.infer<typeof mcpAppContextInputSchema>;
export type McpAppToolInfo = { name: string; callable: boolean; readOnly: boolean; title?: string; tool?: unknown };
export type McpAppSnapshot = { app: McpAppMetadata; html: string; toolInput?: unknown; toolResult: McpAppToolResult };
export type McpAppToolsResult = { tools: McpAppToolInfo[] };
export type McpAppResourceResult = { contents: unknown[] };
export type McpAppContextResult = { revision: number };
