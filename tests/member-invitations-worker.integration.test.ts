import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInvitationFixture, invitationDatabaseUrl } from './member-invitations-fixture.ts';

/** Observes real OS processes and committed SQL/SMTP state; never restarts an existing service. */
describe('invitation Worker process', { skip: !invitationDatabaseUrl, timeout: 90_000 }, () => {
  it('claims persistent mail from a separate process and records SMTP acceptance without redelivery', async () => {
    const f = await createInvitationFixture();
    const invitation = await f.invite();
    const config = f.smtp.config;
    const worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: f.databaseUrl, WORKER_INTERVAL_MS: '25', SMTP_HOST: config.host, SMTP_PORT: String(config.port),
        SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: config.from, SMTP_USER: '', SMTP_PASSWORD: '',
        SMTP_TIMEOUT_MS: String(config.timeoutMs), INVITATION_WEB_ORIGIN: config.webOrigin,
        INVITATION_TOKEN_KEY: config.tokenKey.toString('base64'), INVITATION_TTL_SECONDS: String(config.ttlSeconds) },
    });
    let closed = false;
    let launchError = false;
    const diagnostics: string[] = [];
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      worker.once('error', () => { launchError = true; });
      worker.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    for (const stream of [worker.stdout, worker.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        for (const line of chunk.trim().split('\n')) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && 'event' in parsed && typeof parsed.event === 'string') diagnostics.push(parsed.event);
          } catch { /* Startup failure is observed via exit, not raw potentially-sensitive output. */ }
        }
      });
    }
    async function until(check: () => Promise<boolean>, label: string): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        assert.equal(launchError, false, 'Owned Worker must launch');
        assert.equal(closed, false, `Owned Worker exited before ${label}`);
        if (await check()) return;
        // The independent child uses the platform clock; wait on committed DB state, not fake local timers.
        await setTimeout(25);
      }
      assert.fail(`Timed out waiting for ${label}`);
    }
    try {
      await until(async () => {
        const row = (await f.pool.query('SELECT status FROM invitation_mail_queue WHERE invitation_id=$1', [invitation.id])).rows[0];
        return row?.status === 'smtp_accepted';
      }, 'committed SMTP acceptance');
      assert.equal(f.smtp.messages.length, 1);
      assert.ok(f.token(invitation.email));
      await until(async () => (await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>now()-interval '2 seconds'")).rowCount === 1, 'live independent heartbeat');
      const heartbeat = (await f.pool.query("SELECT heartbeat_at FROM service_heartbeats WHERE role='worker'")).rows[0].heartbeat_at;
      await until(async () => (await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>$1", [heartbeat])).rowCount === 1, 'the next committed Worker cycle');
      assert.equal(f.smtp.messages.length, 1);
      assert.equal((await f.pool.query('SELECT token_ciphertext FROM invitation_mail_queue WHERE invitation_id=$1', [invitation.id])).rows[0].token_ciphertext, null);
      assert.equal(diagnostics.includes('invitation_mail_cycle_failed'), false);
    } finally {
      worker.kill('SIGTERM');
      // Bound shutdown of this owned OS process; unref keeps successful tests from waiting for the deadline.
      const stopped = await Promise.race([exit, setTimeout(10_000, null, { ref: false })]);
      if (!stopped) { worker.kill('SIGKILL'); await exit; }
      await f.close();
      assert.ok(stopped, 'Owned SMTP Worker must stop within its bounded shutdown deadline');
      assert.equal(stopped.code, 0);
      assert.equal(stopped.signal, null);
    }
  });
});
