import { z } from 'zod';
import { WORKSPACE_COLORS, WORKSPACE_ICONS } from '../../domain/src/workspace-identity.ts';

export const updateWorkspaceIdentityPayloadSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  icon: z.enum(WORKSPACE_ICONS),
  color: z.enum(WORKSPACE_COLORS),
});

export const workspaceIdentitySchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
  name: z.string().min(1).max(200),
  icon: z.enum(WORKSPACE_ICONS),
  color: z.enum(WORKSPACE_COLORS),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});
