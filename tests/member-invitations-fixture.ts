import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../apps/api/src/app.ts';
import type { Actor, Command, CommandReceipt } from '../packages/domain/src/core.ts';
import type { MemberInvitationDto } from '../packages/domain/src/invitations.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import type { InvitationMailConfig } from '../packages/infrastructure/src/invitation-mail.ts';
import { createBoundLocalStorage } from './blob-fixture.ts';

export const invitationDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
export type SmtpFixture = {
  config: InvitationMailConfig;
  messages: { to: string; data: string }[];
  mode: 'accept' | 'reject' | 'drop_after_data' | 'hang_after_data';
  close(): Promise<void>;
};
/** A real loopback SMTP receiver; production SMTP sending remains the nodemailer adapter. */
export async function createSmtpFixture(): Promise<SmtpFixture> {
  const sockets = new Set<Socket>();
  const messages: SmtpFixture['messages'] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    let receiving = false;
    let message: string[] = [];
    let recipient = '';
    socket.write('220 loopback.test ESMTP integration receiver\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (receiving) {
          if (line !== '.') { message.push(line.startsWith('..') ? line.slice(1) : line); continue; }
          receiving = false;
          messages.push({ to: recipient, data: message.join('\r\n') });
          if (fixture.mode === 'drop_after_data') socket.destroy();
          else if (fixture.mode !== 'hang_after_data') socket.write('250 2.0.0 SMTP accepted, inbox delivery not asserted\r\n');
        } else if (/^EHLO /i.test(line)) socket.write('250-loopback.test\r\n250 SIZE 1000000\r\n');
        else if (/^HELO /i.test(line)) socket.write('250 loopback.test\r\n');
        else if (/^MAIL FROM:/i.test(line)) { recipient = ''; socket.write('250 2.1.0 sender accepted\r\n'); }
        else if (/^RCPT TO:/i.test(line)) {
          recipient = /TO:<([^>]+)>/i.exec(line)?.[1] ?? '';
          socket.write(fixture.mode === 'reject' ? '550 5.1.1 private-smtp-diagnostics.invalid rejects recipient\r\n' : '250 2.1.5 recipient accepted\r\n');
        } else if (line.toUpperCase() === 'DATA') { receiving = true; message = []; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (line.toUpperCase() === 'QUIT') socket.end('221 Bye\r\n');
        else if (line.toUpperCase() === 'RSET' || line.toUpperCase() === 'NOOP') socket.write('250 OK\r\n');
        else socket.write('502 Command unavailable\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const fixture: SmtpFixture = { config: { host: '127.0.0.1', port: address.port, secure: false, requireTls: false,
    from: 'invitations@example.test', webOrigin: 'http://127.0.0.1:4100', tokenKey: randomBytes(32), ttlSeconds: 3600, timeoutMs: 2000 },
    messages, mode: 'accept',
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
  return fixture;
}
export type InvitationResponse<T> = { status: number; body: T; headers: Headers };
export type InvitationFixture = {
  pool: Pool; app: FastifyInstance; owner: Actor; workspaceId: string; ownerCookie: string; smtp: SmtpFixture; databaseUrl: string; coreRoot: string;
  request<T = unknown>(path: string, body?: unknown, cookie?: string): Promise<InvitationResponse<T>>;
  send(command: Command, cookie?: string, workspaceId?: string): Promise<InvitationResponse<CommandReceipt>>;
  invite(email?: string, options?: { role?: 'admin' | 'member' | 'guest'; projectIds?: string[] | null }): Promise<MemberInvitationDto>;
  token(email: string): string;
  close(): Promise<void>;
};
export async function createInvitationFixture(options: { disabled?: boolean } = {}): Promise<InvitationFixture> {
  if (!invitationDatabaseUrl) throw new Error('A real TEST_DATABASE_URL or DATABASE_URL is required');
  const namespace = `test_invitations_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(invitationDatabaseUrl);
  const smtp = await createSmtpFixture();
  let pool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let root: string | undefined;
  let created = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await app?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        try { if (created) await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); }
        finally { await bootstrap.end(); await smtp.close(); if (root) await rm(root, { recursive: true, force: true }); }
      }
    }
  }
  try {
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    created = true;
    const url = new URL(invitationDatabaseUrl);
    url.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(url.toString());
    await migrate(pool);
    const password = 'isolated-invitation-owner-password';
    const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Invitation owner', password });
    const workspaceId = (await createWorkspace(pool, owner.id, 'Invitation integration')).id;
    root = await mkdtemp(join(tmpdir(), 'pm-invitations-'));
    const coreRoot = join(root, 'core');
    app = buildApp({ databaseUrl: url.toString(), ...await createBoundLocalStorage(pool, join(root, 'blobs')), coreWorkspaceRoot: coreRoot, ...(options.disabled ? {} : { invitationMail: smtp.config }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    let ownerCookie = '';
    async function request<T = unknown>(path: string, body?: unknown, cookie = ownerCookie): Promise<InvitationResponse<T>> {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as T, headers: response.headers };
    }
    const signedIn = await request('/api/v1/auth/login', { email: owner.email, password });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    ownerCookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
    async function send(command: Command, cookie?: string, workspace = workspaceId) {
      return request<CommandReceipt>(`/api/v1/workspaces/${workspace}/commands`, command, cookie);
    }
    return { pool, app, owner, workspaceId, ownerCookie, smtp, databaseUrl: url.toString(), coreRoot, request, send, close,
      async invite(email = `${randomUUID()}@example.test`, input = {}) {
        const response = await send({ commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email, role: input.role ?? 'member', projectIds: input.projectIds ?? null } });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.status, 'committed', JSON.stringify(response.body));
        return response.body.result as MemberInvitationDto;
      },
      token(email) {
        const message = [...smtp.messages].reverse().find(item => item.to === email);
        const data = message?.data.replace(/=\r\n/g, '').replace(/=3D/g, '=');
        const token = data && /\/pm\/invitations\/accept#token=([A-Za-z0-9_-]{43})/.exec(data)?.[1];
        assert.ok(token, 'An actual SMTP message must contain the invitation fragment link');
        return token;
      },
    };
  } catch (error) { await close(); throw error; }
}
