import { z } from 'zod';
import { WORKSPACE_COLORS, WORKSPACE_ICONS } from '../../domain/src/workspace-identity.ts';

export const updateWorkspaceIdentityPayloadSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  icon: z.enum(WORKSPACE_ICONS),
  color: z.enum(WORKSPACE_COLORS),
  // Omitted organization fields keep their current values; explicit null clears.
  taxId: z.string().trim().min(1).max(64).nullable().optional(),
  businessAddress: z.string().trim().min(1).max(300).nullable().optional(),
});

export const workspaceOrganizationSchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
  taxId: z.string().min(1).max(64).nullable(),
  businessAddress: z.string().min(1).max(300).nullable(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const workspaceIdentitySchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
  name: z.string().min(1).max(200),
  icon: z.enum(WORKSPACE_ICONS),
  color: z.enum(WORKSPACE_COLORS),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});
