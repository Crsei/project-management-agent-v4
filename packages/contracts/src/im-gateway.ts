import { z } from 'zod';

/** Satori webhook/WS event subset accepted by the PM bridge. Extra adapter fields are ignored. */
const satoriElementSchema = z.looseObject({
  type: z.string().min(1).max(40),
  attrs: z.record(z.string(), z.unknown()).optional(),
  children: z.array(z.unknown()).max(100).optional(),
});

export const satoriEventSchema = z.looseObject({
  sn: z.number().int().nonnegative(),
  type: z.string().min(1).max(80),
  self_id: z.string().min(1).max(200),
  platform: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  timestamp: z.number().int().nonnegative(),
  user: z.looseObject({
    id: z.string().min(1).max(200),
    name: z.string().max(200).optional(),
    nick: z.string().max(200).optional(),
    is_bot: z.boolean().optional(),
  }).optional(),
  channel: z.looseObject({
    id: z.string().min(1).max(300),
    type: z.number().int().optional(),
  }).optional(),
  guild: z.looseObject({ id: z.string().min(1).max(300) }).optional(),
  message: z.looseObject({
    id: z.string().min(1).max(300).optional(),
    content: z.string().max(8000).optional(),
    elements: z.array(satoriElementSchema).max(100).optional(),
  }).optional(),
}).superRefine((event, context) => {
  if (event.type !== 'message') context.addIssue({ code: 'custom', message: 'Only message events are accepted' });
  if (!event.user) context.addIssue({ code: 'custom', path: ['user'], message: 'A sender is required' });
  if (!event.channel) context.addIssue({ code: 'custom', path: ['channel'], message: 'A channel is required' });
  if (!event.message) context.addIssue({ code: 'custom', path: ['message'], message: 'A message is required' });
  if (event.message && !event.message.content && !event.message.elements?.some(element => element.type === 'text')) {
    context.addIssue({ code: 'custom', path: ['message'], message: 'Only text messages are accepted' });
  }
});
export type SatoriEvent = z.infer<typeof satoriEventSchema>;

export const imBindingSchema = z.strictObject({
  id: z.uuid(),
  platform: z.string().min(1).max(40),
  accountLabel: z.string().min(1).max(300),
  notifyEnabled: z.boolean(),
  defaultProjectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).nullable(),
  verifiedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
});
export type ImBinding = z.infer<typeof imBindingSchema>;

export const imBotSchema = z.strictObject({
  platform: z.string().min(1).max(40),
  selfId: z.string().min(1).max(200),
  name: z.string().max(200).nullable(),
  status: z.enum(['online', 'offline', 'connecting', 'unknown']),
  username: z.string().max(100).nullable(),
  url: z.url().nullable(),
});
export type ImBot = z.infer<typeof imBotSchema>;

export const imSatoriStatusSchema = z.strictObject({
  state: z.enum(['disconnected', 'connecting', 'ready', 'auth_failed', 'error']),
  readyAt: z.iso.datetime().nullable(),
  lastEventAt: z.iso.datetime().nullable(),
  lastErrorCode: z.string().max(100).nullable(),
});
export type ImSatoriStatus = z.infer<typeof imSatoriStatusSchema>;

export const imConnectivitySchema = z.strictObject({
  satori: imSatoriStatusSchema,
  bots: z.array(imBotSchema).max(20),
});
export type ImConnectivity = z.infer<typeof imConnectivitySchema>;

export const imSettingsSchema = z.strictObject({
  configuration: z.enum(['disabled', 'configured']),
  connectivity: imConnectivitySchema,
  bindings: z.array(imBindingSchema),
});
export type ImSettings = z.infer<typeof imSettingsSchema>;

export const imLinkCodeSchema = z.strictObject({
  code: z.string().regex(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){7}$/),
  expiresAt: z.iso.datetime(),
});
export type ImLinkCode = z.infer<typeof imLinkCodeSchema>;

export const imBindingUpdateSchema = z.strictObject({ notifyEnabled: z.boolean() });
export type ImBindingUpdate = z.infer<typeof imBindingUpdateSchema>;

export const imEmptySchema = z.strictObject({});
export const imParamsSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
export const imBindingParamsSchema = z.strictObject({ workspaceId: z.uuid().toLowerCase(), bindingId: z.uuid().toLowerCase() });
