import { z } from 'zod';
import type { FileRecord } from '../../pm-schema/index.ts';

export const localDirectorySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('existing'), path: z.string().min(1).max(4096) }),
  z.strictObject({ mode: z.literal('new'), parentPath: z.string().min(1).max(4096), folderName: z.string().min(1).max(255).refine(value => value !== '.' && value !== '..' && !/[\\/\0]/.test(value), 'Use a single folder name') }),
]);
export type LocalDirectory = z.infer<typeof localDirectorySchema>;
export const localProjectInputSchema = z.object({ entity: z.literal('project'), title: z.string().trim().min(1).max(500), body: z.string().max(1_000_000).optional() }).catchall(z.unknown());
export const localProjectInitializationSchema = z.strictObject({ input: localProjectInputSchema, directory: localDirectorySchema });
export const localProjectSettingsUpdateSchema = z.strictObject({ defaultParent: z.string().min(1).max(4096) });
export const localProjectMoveSchema = z.strictObject({ directory: localDirectorySchema, writersStopped: z.literal(true) });
export const localProjectRelocationSchema = localProjectMoveSchema.extend({ mode: z.enum(['move', 'rebind']) });
export const localProjectPreviewSchema = z.strictObject({ directory: localDirectorySchema });
export type LocalProjectInitialization = z.infer<typeof localProjectInitializationSchema>;
export type LocalProjectSettings = {
  enabled: boolean;
  reason: 'not_configured' | null;
  canManage: boolean;
  dataRoot: string | null;
  coreRoot: string | null;
  defaultParent: string | null;
  allowedRoots: string[];
  backupRoot: string | null;
  attachments: 'project_directory';
  databaseRequired: true;
};
export type LocalProjectDirectoryListing = { path: string | null; parentPath: string | null; roots: string[]; directories: { name: string; path: string }[] };
export type LocalProjectPreview = { path: string; exists: boolean; mode: LocalDirectory['mode']; creates: string[]; preservesExistingFiles: true };
export type LocalProjectLocation = { projectId: string; storageId: string | null; kind: 'local' | 'legacy'; path: string | null; status: 'available' | 'unavailable'; reason?: string };
export type LocalProjectAttempt =
  | { status: 'not_found' }
  | { status: 'pending'; key: string; operation: 'initialize' | 'migrate' | 'relocate'; reason: 'write_unconfirmed' | 'audit_pending' | 'storage_pending'; projectId?: string }
  | { status: 'rejected'; key: string; operation: 'initialize' | 'migrate' | 'relocate'; code: string }
  | { status: 'ready'; key: string; operation: 'initialize' | 'migrate' | 'relocate'; record: FileRecord; location: LocalProjectLocation };

/** All routes share the API session and Origin policy. Host paths require unrestricted access.manage;
 * initialization/moves additionally require planning.edit. Scoped members receive no host paths. */
export const LOCAL_PROJECT_ROUTES = {
  settings: '/api/v1/workspaces/:workspaceId/local-projects/settings',
  directories: '/api/v1/workspaces/:workspaceId/local-projects/directories',
  preview: '/api/v1/workspaces/:workspaceId/local-projects/preview',
  initializations: '/api/v1/workspaces/:workspaceId/local-projects/initializations',
  initialization: '/api/v1/workspaces/:workspaceId/local-projects/initializations/:key',
  recover: '/api/v1/workspaces/:workspaceId/local-projects/initializations/:key/recover',
  location: '/api/v1/workspaces/:workspaceId/local-projects/projects/:projectId/location',
  migrate: '/api/v1/workspaces/:workspaceId/local-projects/projects/:projectId/migrate',
  relocate: '/api/v1/workspaces/:workspaceId/local-projects/projects/:projectId/relocate',
} as const;
