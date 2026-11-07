import { z } from 'zod';
import { localDirectorySchema } from './local-projects.ts';

export const agentScopeSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), projectId: z.string().regex(/^PRJ-\d+$/).nullable() });
export type AgentScope = z.infer<typeof agentScopeSchema>;
export const agentFileAreaSchema = z.strictObject({
  path: z.string().nullable(),
  status: z.enum(['available', 'unconfigured', 'unavailable']),
  revision: z.number().int().nonnegative(),
  source: z.enum(['explicit', 'project_location', 'default']).nullable(),
  canManage: z.boolean(),
  reason: z.string().optional(),
});
export type AgentFileArea = z.infer<typeof agentFileAreaSchema>;
export const agentCatalogSchema = z.strictObject({ workspaces: z.array(z.strictObject({
  id: z.uuid(), name: z.string(),
  /** Explicit workspace-wide consent eligibility; absent older catalogs grant no new authority. */
  workspaceAllowed: z.boolean().optional(),
  fileArea: agentFileAreaSchema,
  projects: z.array(z.strictObject({ id: z.string(), name: z.string(), fileArea: agentFileAreaSchema })),
})) });
export type AgentCatalog = z.infer<typeof agentCatalogSchema>;
export const agentFileAreaUpdateSchema = z.strictObject({ directory: localDirectorySchema, expectedRevision: z.number().int().nonnegative() });
export type AgentFileAreaUpdate = z.infer<typeof agentFileAreaUpdateSchema>;
export const agentFileAreaResponseSchema = z.strictObject({ fileArea: agentFileAreaSchema });
export const authorizedAgentContextSchema = z.strictObject({ scope: agentScopeSchema, actorId: z.uuid(), workspaceName: z.string(), projectName: z.string().nullable() });
export type AuthorizedAgentContext = z.infer<typeof authorizedAgentContextSchema>;
export const agentStorageSettingsSchema = z.strictObject({
  defaultRoot: z.string().nullable(), effectiveRoot: z.string().nullable(),
  revision: z.number().int().nonnegative(), canManage: z.boolean(),
});
export type AgentStorageSettings = z.infer<typeof agentStorageSettingsSchema>;
export const agentStorageSettingsUpdateSchema = z.strictObject({ directory: localDirectorySchema, expectedRevision: z.number().int().nonnegative() });
export type AgentStorageSettingsUpdate = z.infer<typeof agentStorageSettingsUpdateSchema>;
