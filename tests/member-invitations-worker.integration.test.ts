import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createInvitationFixture, invitationDatabaseUrl } from './member-invitations-fixture.ts';
import { createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { mailWorkerEnvironment, startOwnedMailWorker, type OwnedMailWorker } from './mail-worker-process.ts';

/** Observes real OS processes and committed SQL/SMTP state; never restarts an existing service. */
describe('invitation Worker process', { skip: !invitationDatabaseUrl }, () => {
  let database: MailFixtureDatabase;
  before(async t => { database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: 60_000 });
  after(() => database?.close(), { timeout: 15_000 });
  it('claims persistent mail from a separate process and records SMTP acceptance without redelivery', { timeout: 30_000 }, async t => {
    const f = await createInvitationFixture({ database, signal: t.signal });
    let worker: OwnedMailWorker | undefined = undefined;
    t.after(async () => {
      try { await worker?.stop(); } finally { await f.close(); }
    }, { timeout: 30_000 });
    // Register ownership before invite initialization, which can itself fail.
    const invitation = await f.invite();
    worker = startOwnedMailWorker({ signal: t.signal,
      env: mailWorkerEnvironment({ databaseUrl: f.databaseUrl, coreRoot: f.coreRoot, invitationMail: f.smtp.config }),
    });
    try {
      await worker.until(async () => {
        const row = (await f.pool.query('SELECT status FROM invitation_mail_queue WHERE invitation_id=$1', [invitation.id])).rows[0];
        return row?.status === 'smtp_accepted';
      }, 'committed SMTP acceptance');
      assert.equal(f.smtp.messages.length, 1);
      assert.ok(f.token(invitation.email));
      await worker.until(async () => (await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>now()-interval '2 seconds'")).rowCount === 1, 'live independent heartbeat', 3000);
      const heartbeat = (await f.pool.query("SELECT heartbeat_at FROM service_heartbeats WHERE role='worker'")).rows[0].heartbeat_at;
      await worker.until(async () => (await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>$1", [heartbeat])).rowCount === 1, 'the next committed Worker cycle', 3000);
      assert.equal(f.smtp.messages.length, 1);
      assert.equal((await f.pool.query('SELECT token_ciphertext FROM invitation_mail_queue WHERE invitation_id=$1', [invitation.id])).rows[0].token_ciphertext, null);
      assert.equal(worker.hasEvent('invitation_mail_cycle_failed'), false, worker.diagnostics());
      const stopped = await worker.stop();
      assert.deepEqual(stopped, { code: 0, signal: null, forced: false }, worker.diagnostics());
    } catch (error) {
      t.diagnostic(worker.diagnostics());
      throw error;
    }
  });
});
