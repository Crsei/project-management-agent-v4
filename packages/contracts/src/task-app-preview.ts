import { z } from 'zod';
export const appPreviewActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), head: z.string().regex(/^[a-f0-9]{40}$/), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('stop'), confirm: z.literal(true) }),
]);
export type AppPreviewState = {
  status: 'stopped' | 'starting' | 'running' | 'failed';
  available: boolean;
  head: string | null;
  url: string | null;
  expiresAt: string | null;
  message: string;
};
