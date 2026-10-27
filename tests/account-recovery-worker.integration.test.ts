/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { describe,it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deliverAccountRecoveryMailBatch } from '../packages/application/src/account-recovery-delivery.ts';
import { encryptMailToken } from '../packages/infrastructure/src/system-mail.ts';
import { createRecoveryFixture,recoveryDatabaseUrl } from './account-recovery-fixture.ts';

describe('identity mail independent delivery',{skip:!recoveryDatabaseUrl,timeout:120000},()=>{
  it('records DATA disconnect as unknown, wipes ciphertext and never redelivers or rotates an active reset token',async t=>{
    const f=await createRecoveryFixture();t.after(()=>f.close());const email=await f.bind();
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
  it('converges expired sending leases to unknown and cancels expired queued ciphertext even with issuance disabled',async t=>{
    const f=await createRecoveryFixture();t.after(()=>f.close());const email=await f.bind();
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
  it('keeps heartbeat independent while a real SMTP DATA attempt hangs in a separate owned Worker process',async()=>{
    const f=await createRecoveryFixture(),email=await f.bind();
    await f.request('/api/v1/auth/password-recovery/requests',{requestId:randomUUID(),email},'');
    f.smtp.mode='hang_after_data';const c=f.config;
    const worker=spawn(process.execPath,['apps/worker/src/main.ts'],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore','ignore','ignore'],env:{...process.env,DATABASE_URL:f.databaseUrl,WORKER_INTERVAL_MS:'25',SMTP_HOST:c.host,SMTP_PORT:String(c.port),SMTP_SECURE:'false',SMTP_REQUIRE_TLS:'false',SMTP_FROM:c.from,SMTP_USER:'',SMTP_PASSWORD:'',SMTP_TIMEOUT_MS:String(c.timeoutMs),INVITATION_WEB_ORIGIN:'',INVITATION_TOKEN_KEY:'',INVITATION_TTL_SECONDS:'',ACCOUNT_RECOVERY_WEB_ORIGIN:c.webOrigin,ACCOUNT_RECOVERY_TOKEN_KEY:c.tokenKey.toString('base64'),PASSWORD_RESET_TTL_SECONDS:String(c.resetTtlSeconds),RECOVERY_EMAIL_VERIFY_TTL_SECONDS:String(c.verifyTtlSeconds)}});
    const exit=Promise.withResolvers<void>();worker.once('close',()=>exit.resolve());worker.once('error',()=>exit.resolve());
    async function until(check:()=>Promise<boolean>) {const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await delay(25);}assert.fail('Owned Worker did not reach expected committed state');}
    try {
      await until(async()=>f.smtp.messages.length===2);
      const heartbeat=(await f.pool.query("SELECT heartbeat_at FROM service_heartbeats WHERE role='worker'")).rows[0]?.heartbeat_at;
      assert.ok(heartbeat);
      await until(async()=>(await f.pool.query("SELECT 1 FROM service_heartbeats WHERE role='worker' AND heartbeat_at>$1",[heartbeat])).rowCount===1);
      await until(async()=>(await f.pool.query("SELECT 1 FROM account_recovery_mail_queue WHERE purpose='reset_password' AND status='unknown'")).rowCount===1);
      assert.equal(f.smtp.messages.length,2);
      assert.equal((await f.pool.query("SELECT token_ciphertext FROM account_recovery_mail_queue WHERE purpose='reset_password'")).rows[0].token_ciphertext,null);
    }finally{worker.kill('SIGTERM');const stopped=await Promise.race([exit.promise.then(()=>true),delay(10000,false,{ref:false})]);if(!stopped){worker.kill('SIGKILL');await exit.promise;}await f.close();}
  });
});
