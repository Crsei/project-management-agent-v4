import { z } from 'zod';

/** Dependency ids come from the pinned OpenHands production catalog, not connection discovery. */
export const automationIntegrationProviders = [
  { id: 'github', name: 'GitHub', sourceIds: ['github'], transports: ['mcp_http', 'native_api'] },
  { id: 'slack', name: 'Slack', sourceIds: ['slack'], transports: ['mcp_http'] },
  { id: 'linear', name: 'Linear', sourceIds: ['linear'], transports: ['mcp_http'] },
  { id: 'gitlab', name: 'GitLab', sourceIds: ['gitlab'], transports: ['mcp_http', 'native_api'] },
  { id: 'bitbucket', name: 'Bitbucket', sourceIds: ['bitbucket'], transports: ['mcp_http'] },
  { id: 'atlassian-rovo', name: 'Atlassian Rovo', sourceIds: ['atlassian-rovo', 'atlassian', 'jira'], transports: ['mcp_http'] },
  { id: 'tavily', name: 'Tavily', sourceIds: ['tavily'], transports: ['mcp_http'] },
  { id: 'notion', name: 'Notion', sourceIds: ['notion'], transports: ['mcp_http'] },
] as const;
export const automationIntegrationProviderSchema = z.enum(['github', 'slack', 'linear', 'gitlab', 'bitbucket', 'atlassian-rovo', 'tavily', 'notion']);
export type AutomationIntegrationProvider = z.infer<typeof automationIntegrationProviderSchema>;
const uuid = z.uuid().toLowerCase();
const project = z.string().regex(/^PRJ-\d+$/);
const tool = z.string().regex(/^[a-zA-Z0-9_.:/-]{1,200}$/);
const revision = { requestId: uuid, expectedRevision: z.number().int().nonnegative() };
export const automationMcpDefinitionRefSchema = z.strictObject({ contextId: z.string().min(1).max(100), serverId: z.string().min(1).max(300) });
export type AutomationMcpDefinitionRef = z.infer<typeof automationMcpDefinitionRefSchema>;
export type AutomationMcpDefinition = AutomationMcpDefinitionRef & { name: string; configFingerprint: string; transport: 'streamable-http' };
export type AutomationMcpDefinitionList = { contextId: string; definitions: AutomationMcpDefinition[] };
export const automationIntegrationConfigSchema = z.strictObject({
  projectId: project, provider: automationIntegrationProviderSchema, label: z.string().trim().min(1).max(160),
  mcpDefinition: automationMcpDefinitionRefSchema.optional(), readTools: z.array(tool).max(100), writeTools: z.array(tool).max(100),
  nativeApi: z.strictObject({ baseUrl: z.string().url().max(2048), repositories: z.array(z.string().trim().min(1).max(300)).min(1).max(100), allowWrites: z.boolean(), allowOwnerLoadSearch: z.boolean().optional() }).optional(),
}).superRefine((value, ctx) => {
  const names = [...value.readTools, ...value.writeTools];
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['readTools'], message: 'Specify unique, explicitly authorized tool names' });
  if (names.length && !value.mcpDefinition) ctx.addIssue({ code: 'custom', path: ['mcpDefinition'], message: 'Select a managed MCP definition for explicitly authorized tools' });
  if (!names.length && value.mcpDefinition) ctx.addIssue({ code: 'custom', path: ['mcpDefinition'], message: 'A managed MCP binding requires an explicit tool allowlist' });
  if (!names.length && (!['github', 'gitlab'].includes(value.provider) || !value.nativeApi)) ctx.addIssue({ code: 'custom', path: ['readTools'], message: 'Zero MCP tools is supported only for an explicitly configured GitHub/GitLab native API connection' });
});
export type AutomationIntegrationConfig = z.infer<typeof automationIntegrationConfigSchema>;
export const automationIntegrationVerificationSchema = z.strictObject({ mcp: z.boolean(), nativeApi: z.boolean() });
export type AutomationIntegrationVerification = z.infer<typeof automationIntegrationVerificationSchema>;
export function automationIntegrationSupportsMcp(config: AutomationIntegrationConfig): boolean { return config.mcpDefinition !== undefined && config.readTools.length + config.writeTools.length > 0; }
export function automationIntegrationSupportsNativeApi(config: AutomationIntegrationConfig): boolean { return (config.provider === 'github' || config.provider === 'gitlab') && config.nativeApi !== undefined; }
export const automationIntegrationSaveSchema = z.strictObject({ ...revision, config: automationIntegrationConfigSchema,
  /** Native API credentials only. MCP secrets belong exclusively to the managed definition. Omit to retain; {} clears. */
  nativePrivateHeaders: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().max(8192)).optional(),
});
export const automationIntegrationMutationSchema = z.strictObject(revision);
export type AutomationIntegrationConnection = AutomationIntegrationConfig & { id: string; revision: number; status: 'configured' | 'verified' | 'error' | 'revoked'; verification: AutomationIntegrationVerification; hasCredentials: boolean; mcpConfigFingerprint: string | null; lastCheckedAt: string | null; lastError: string | null; createdAt: string; updatedAt: string };
export type AutomationIntegrationList = { providers: typeof automationIntegrationProviders; connections: AutomationIntegrationConnection[]; privateStorageAvailable: boolean };
export const automationEventVerificationSchema = z.enum(['key', 'hmac_sha256_hex', 'standard_webhooks', 'slack_v0']);
export type AutomationEventVerification = z.infer<typeof automationEventVerificationSchema>;
export const automationEventConfigSchema = z.strictObject({ definitionId: uuid, projectId: project, source: z.string().trim().min(1).max(100), key: z.string().trim().min(1).max(200), verification: automationEventVerificationSchema,
  /** Optional JSON pointer selecting an object from the authenticated raw body. */
  payloadPointer: z.string().max(500).regex(/^(?:\/(?:[^~]|~[01])*)*$/).default(''),
});
export const automationEventSaveSchema = z.strictObject({ ...revision, config: automationEventConfigSchema, secret: z.string().min(16).max(8192).optional() });
export type AutomationEventConfig = z.infer<typeof automationEventConfigSchema>;
export type AutomationEventEndpoint = AutomationEventConfig & { id: string; revision: number; status: 'active' | 'revoked'; url: string; hasSecret: boolean; createdAt: string; updatedAt: string };
export type AutomationEventReceipt = { eventId: string; status: 'accepted' | 'filtered' | 'rejected'; executionId: string | null; reason: string | null; receivedAt: string };
export type AutomationIntegrationReceipt = { requestId: string; result: unknown; httpStatus: number };
export const automationIntegrationRuntimeSchema = z.strictObject({ executionId: uuid, generationId: uuid, method: z.enum(['grant/open', 'grant/close', 'tools/list', 'tools/call', 'provider/request', 'provider/origin']), params: z.record(z.string(), z.unknown()).optional() });
export type AutomationIntegrationRuntimeInput = z.infer<typeof automationIntegrationRuntimeSchema>;
export const automationProviderRequestSchema = z.strictObject({ provider: z.enum(['github', 'gitlab']), operationId: uuid, method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().min(1).max(4096), body: z.record(z.string(), z.unknown()).optional() });
export type AutomationProviderRequest = z.infer<typeof automationProviderRequestSchema>;
export type AutomationProviderResult = { status: number; body: unknown; headers: { link?: string; 'x-next-page'?: string } };
export type AutomationIntegrationOperation = { id: string; executionId: string; connectionId: string; connectionRevision: number; status: 'dispatching' | 'completed' | 'outcome_unknown'; result: unknown; createdAt: string; finishedAt: string | null };
/** Use these refs in StudioConfig.action.plugins. Version freezes a verified connection revision. */
export function automationIntegrationPlugin(connection: AutomationIntegrationConnection): { id: string; version: string } { return { id: `integration:${connection.id}`, version: String(connection.revision) }; }
export function automationIntegrationProviderForSource(sourceId: string): AutomationIntegrationProvider | null {
  return automationIntegrationProviders.find(provider => (provider.sourceIds as readonly string[]).includes(sourceId))?.id ?? null;
}
