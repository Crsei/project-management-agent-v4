import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { after,before,describe,it } from 'node:test';
import { deliverAccountRecoveryMailBatch } from '../packages/application/src/account-recovery-delivery.ts';
import { encryptMailToken } from '../packages/infrastructure/src/system-mail.ts';
import { createRecoveryFixture,recoveryDatabaseUrl } from './account-recovery-fixture.ts';
import { createMailFixtureDatabase,type MailFixtureDatabase } from './mail-fixture-database.ts';
import { mailWorkerEnvironment,startOwnedMailWorker,type OwnedMailWorker } from './mail-worker-process.ts';

describe('identity mail independent delivery',{skip:!recoveryDatabaseUrl},()=>{
  let database:MailFixtureDatabase;
  before(async t=>{database=await createMailFixtureDatabase({signal:t.signal});},{timeout:60000});
  after(()=>database?.close(),{timeout:15000});
  it('records DATA disconnect as unknown, wipes ciphertext and never redelivers or rotates an active reset token',{timeout:30000},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:15000});const email=await f.bind();
    await f.request('/api/v1/auth/password-recovery/requests',{requestId:randomUUID(),email},'');f.smtp.mode='drop_after_data';
    const results=await Promise.all([deliverAccountRecoveryMailBatch(f.pool,f.config),deliverAccountRecoveryMailBatch(f.pool,f.config)]);
    assert.equal(results.reduce((n,r)=>n+r.attempted,0),1);assert.equal(results.reduce((n,r)=>n+r.unknown,0),1);
    const row=(await f.pool.query("SELECT q.* FROM account_recovery_mail_queue q WHERE purpose='reset_password'")).rows[0];
    assert.equal(row.status,'unknown');assert.equal(row.token_ciphertext,null);assert.equal(f.smtp.messages.length,2);
    const token=f.token('recovery',email);assert.equal((await f.request('/api/v1/auth/password-recovery/inspect',{token},'')).status,200);
    await f.request('/api/v1/auth/password-recovery/requests',{requestId:randomUUID(),email},'');
    await deliverAccountRecoveryMailBatch(f.pool,f.config);assert.equal(f.smtp.messages.length,2);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM account_recovery_tokens WHERE purpose='reset_password'")).rows[0].n,1);
  });
  it('converges expired sending leases to unknown and cancels expired queued ciphertext even with issuance disabled',{timeout:30000},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:15000});const email=await f.bind();
    await f.request('/api/v1/auth/password-recovery/requests',{requestId:randomUUID(),email},'');
    await f.pool.query("UPDATE account_recovery_mail_queue SET status='sending',token_ciphertext=NULL,lease_id=$1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE purpose='reset_password' AND status='queued'",[randomUUID()]);
    const first=await deliverAccountRecoveryMailBatch(f.pool);assert.equal(first.expiredLeases,1);
    assert.equal((await f.pool.query("SELECT status FROM account_recovery_mail_queue WHERE purpose='reset_password'")).rows[0].status,'unknown');
    // This fixture models a pre-existing expired queue, not an artificial trust flag.
    await f.pool.query("UPDATE account_recovery_tokens SET status='revoked' WHERE user_id=$1 AND purpose='reset_password' AND status='active'",[f.user.id]);
    const id=randomUUID(),delivery=randomUUID(),token=randomBytes(32).toString('base64url');
    await f.pool.query("INSERT INTO account_recovery_tokens(id,user_id,purpose,token_hash,credential_version,recovery_email_version,created_at,expires_at) VALUES($1,$2,'reset_password',$3,1,2,clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '1 second')",[id,f.user.id,createHash('sha256').update(token).digest('hex')]);
    await f.pool.query("INSERT INTO account_recovery_mail_queue(id,token_id,purpose,token_ciphertext) VALUES($1,$2,'reset_password',$3)",[delivery,id,encryptMailToken(f.config.tokenKey,`reset_password:${id}:${delivery}`,token)]);
    await deliverAccountRecoveryMailBatch(f.pool);
    const cancelled=(await f.pool.query('SELECT status,token_ciphertext FROM account_recovery_mail_queue WHERE id=$1',[delivery])).rows[0];
    assert.deepEqual(cancelled,{status:'cancelled',token_ciphertext:null});assert.equal(f.smtp.messages.length,1);
    await deliverAccountRecoveryMailBatch(f.pool,f.config);assert.equal(f.smtp.messages.length,1);
  });
  it('keeps heartbeat independent while a real SMTP DATA attempt hangs in a separate owned Worker process',{timeout:45000},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});
    let worker:OwnedMailWorker|undefined=undefined;
    t.after(async()=>{
      try {await worker?.stop();} finally {await f.close();}
    },{timeout:30000});
    // Cleanup already owns the fixture if binding or request initialization fails.
    const email=await f.bind();
    await f.request('/api/v1/auth/password-recovery/requests',{requestId:randomUUID(),email},'');
    f.smtp.mode='hang_after_data';
    // Leave a real in-flight SMTP window in which to observe an independent heartbeat.
    const config={...f.config,timeoutMs:8000};
    worker=startOwnedMailWorker({signal:t.signal,env:mailWorkerEnvironment({databaseUrl:f.databaseUrl,coreRoot:f.coreRoot,recoveryMail:config})});
    try {
      await worker.until(()=>f.smtp.messages.length===2,'the actual recovery SMTP DATA attempt');
      await worker.until(async()=>(await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker'")).rowCount===1,'the first independent heartbeat',3000);
      const heartbeat=(await f.pool.query("SELECT heartbeat_at FROM service_heartbeats WHERE role='worker'")).rows[0].heartbeat_at;
      assert.equal((await f.pool.query("SELECT status FROM account_recovery_mail_queue WHERE purpose='reset_password'")).rows[0].status,'sending','SMTP must still be in flight before observing heartbeat progress');
      await worker.until(async()=>(await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>$1",[heartbeat])).rowCount===1,'heartbeat progress during the SMTP hang',3000);
      assert.equal((await f.pool.query("SELECT status FROM account_recovery_mail_queue WHERE purpose='reset_password'")).rows[0].status,'sending','Heartbeat must advance before the SMTP deadline, not after it');
      await worker.until(async()=>(await f.pool.query("SELECT 1 FROM account_recovery_mail_queue WHERE purpose='reset_password' AND status='unknown'")).rowCount===1,'the committed unknown SMTP outcome',10000);
      assert.equal(f.smtp.messages.length,2);
      assert.equal((await f.pool.query("SELECT token_ciphertext FROM account_recovery_mail_queue WHERE purpose='reset_password'")).rows[0].token_ciphertext,null);
      const finalHeartbeat=(await f.pool.query("SELECT heartbeat_at FROM service_heartbeats WHERE role='worker'")).rows[0].heartbeat_at;
      await worker.until(async()=>(await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>$1",[finalHeartbeat])).rowCount===1,'a post-finalization Worker cycle',3000);
      assert.equal(f.smtp.messages.length,2,'Unknown delivery outcomes must never be retried');
      assert.equal(worker.hasEvent('account_recovery_mail_cycle_failed'),false,worker.diagnostics());
      const stopped=await worker.stop();
      assert.deepEqual(stopped,{code:0,signal:null,forced:false},worker.diagnostics());
    } catch(error) {
      t.diagnostic(worker.diagnostics());
      throw error;
    }
  });
});
