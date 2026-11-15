import assert from 'node:assert/strict';
import test from 'node:test';
import { imLinkCodeSchema, satoriEventSchema } from '../src/im-gateway.ts';

const event = {
  sn: 1,
  type: 'message',
  self_id: 'bot-1',
  platform: 'telegram',
  timestamp: 1,
  user: { id: 'user-1', name: 'Operator' },
  channel: { id: 'dm-1', type: 1 },
  message: { id: 'message-1', content: '/help' },
};

test('Satori IM schema accepts a private text command and rejects unsupported events', () => {
  assert.equal(satoriEventSchema.safeParse(event).success, true);
  assert.equal(satoriEventSchema.safeParse({ ...event, type: 'guild-added' }).success, false);
  assert.equal(satoriEventSchema.safeParse({ ...event, message: { id: 'message-1' } }).success, false);
  assert.equal(satoriEventSchema.safeParse({ ...event, message: { id: 'message-1', elements: [{ type: 'image' }] } }).success, false);
  assert.equal(satoriEventSchema.safeParse({ ...event, platform: 'Telegram' }).success, false);
});

test('IM link-code schema matches the generated private code format', () => {
  assert.equal(imLinkCodeSchema.safeParse({ code: '0123-4567-89AB-CDEF-0123-4567-89AB-CDEF', expiresAt: new Date().toISOString() }).success, true);
  assert.equal(imLinkCodeSchema.safeParse({ code: '0123-4567-89ab-cdef-0123-4567-89ab-cdef', expiresAt: new Date().toISOString() }).success, false);
  assert.equal(imLinkCodeSchema.safeParse({ code: 'ABCD-EFGH', expiresAt: new Date().toISOString() }).success, false);
});
