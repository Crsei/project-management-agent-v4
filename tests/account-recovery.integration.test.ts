import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { after,before,describe,it } from 'node:test';
import { createUser,login } from '../packages/infrastructure/src/auth.ts';
import { deliverAccountRecoveryMailBatch } from '../packages/application/src/account-recovery-delivery.ts';
import { createRecoveryFixture,recoveryDatabaseUrl,recoveryPassword } from './account-recovery-fixture.ts';
import type { RecoveryResponse } from './account-recovery-fixture.ts';
import { AccountRecoveryClient } from '../packages/contracts/src/account-recovery-client.ts';
import { fenceRestoredAccountRecovery } from '../packages/application/src/account-recovery-restore.ts';
import { decryptMailToken } from '../packages/infrastructure/src/system-mail.ts';
import { createMailFixtureDatabase } from './mail-fixture-database.ts';
import type { MailFixtureDatabase } from './mail-fixture-database.ts';
import { mailFixtureCaseTimeout,mailFixtureCleanupTimeout,mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
const base='/api/v1/auth/password-recovery';
const nextPassword='isolated-recovery-next-password';
async function waitForBlocked(pool:Pool,blocker:number,query:string) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    const waiting=await pool.query(`WITH RECURSIVE blocked(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
    ) SELECT 1 FROM pg_stat_activity a JOIN blocked b USING(pid) WHERE a.wait_event_type='Lock' AND a.query=$2`,[blocker,query]);
    if(waiting.rowCount)return;
    await delay(20);
  }
  assert.fail('The real operation did not wait on the owned user lock');
}
describe('account recovery real HTTP/PostgreSQL/SMTP',{skip:!recoveryDatabaseUrl,concurrency:false},()=>{
  let database:MailFixtureDatabase;
  before(async t=>{database=await createMailFixtureDatabase({signal:t.signal});},{timeout:mailSchemaInitTimeout});
  after(()=>database?.close(),{timeout:mailFixtureCleanupTimeout});
  it('starts every account unverified and binds only through password, same-account session and fresh mail',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});
    const before=(await f.request('/api/v1/auth/security')).body;
    assert.equal(before.recoveryEmail.email,null);assert.equal(before.recoveryEmail.verifiedAt,null);assert.equal(before.recoveryEmail.emailVersion,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM memberships WHERE user_id=$1',[f.user.id])).rows[0].n,0);
    const email=`${randomUUID()}@example.test`;
    const begun=await f.request('/api/v1/auth/security/recovery-email',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:1,email,currentPassword:recoveryPassword});
    assert.equal(begun.body.status,'committed');
    const untrusted=await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');assert.equal(untrusted.status,202);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM account_recovery_tokens WHERE purpose='reset_password'")).rows[0].n,0);
    await deliverAccountRecoveryMailBatch(f.pool,f.config);
    const token=f.token('verify-recovery-email',email);
    const stranger=await createUser(f.pool,{email:`${randomUUID()}@example.test`,password:recoveryPassword,name:'Other account'});
    const session=await login(f.pool,{email:stranger.email,password:recoveryPassword});
    const forbidden=await f.request('/api/v1/auth/security/recovery-email/confirm',{actionId:randomUUID(),token,expectedRecoveryEmailVersion:1},`pm_v3_session=${session.token}`);
    assert.notEqual(forbidden.body.status,'committed');
    const verified=await f.request('/api/v1/auth/security/recovery-email/confirm',{actionId:randomUUID(),token,expectedRecoveryEmailVersion:1});assert.equal(verified.body.status,'committed');
    const after=(await f.request('/api/v1/auth/security')).body;
    assert.equal(after.recoveryEmail.email,email);assert.equal(after.recoveryEmail.emailVersion,2);assert.deepEqual(after.sessions,before.sessions);
    assert.equal((await f.pool.query('SELECT email FROM users WHERE id=$1',[f.user.id])).rows[0].email,f.user.email);
    const rejected=await f.request(`${base}/complete`,{actionId:randomUUID(),token,newPassword:nextPassword},'');assert.equal(rejected.status,409);
  });
  it('uniformly accepts unknown/unverified/verified/limited addresses and never rotates active tokens or resends request identities',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();
    for(const address of [`${randomUUID()}@example.test`,f.user.email,email,email,email,email]) {
      const requestId=randomUUID(),result=await f.request(`${base}/requests`,{requestId,email:address},'');
      assert.equal(result.status,202);assert.deepEqual(result.body,{requestId,status:'accepted'});
      assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('referrer-policy'),'no-referrer');
    }
    const tokens=await f.pool.query("SELECT id,expires_at FROM account_recovery_tokens WHERE purpose='reset_password'");assert.equal(tokens.rowCount,1);
    const repeated=randomUUID(),first=await f.request(`${base}/requests`,{requestId:repeated,email},'');
    assert.deepEqual((await f.request(`${base}/requests`,{requestId:repeated,email},'')).body,first.body);
    assert.equal((await f.request(`${base}/requests`,{requestId:repeated,email:'different@example.test'},'')).status,409);
    const id=randomUUID();assert.equal((await f.request(`${base}/requests/recover`,{requestId:id},'')).body.request.status,'cancelled');
    assert.equal((await f.request(`${base}/requests`,{requestId:id,email},'')).body.status,'cancelled');
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM account_recovery_tokens WHERE purpose='reset_password'")).rows[0].n,1);
    await deliverAccountRecoveryMailBatch(f.pool,f.config);assert.equal(f.smtp.messages.length,2);
    assert.equal((await f.request(`${base}/requests/lookup`,{requestId:randomUUID()},'')).body.request,null);
  });
  it('atomically consumes one token, revokes every session and recovers the immutable original result without credentials',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();
    await login(f.pool,{email:f.user.email,password:recoveryPassword});
    await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);
    const token=f.token('recovery',email),actionId=randomUUID();
    const completed=await f.request(`${base}/complete`,{actionId,token,newPassword:nextPassword},'');assert.equal(completed.body.status,'committed');assert.equal(completed.headers.has('set-cookie'),false);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1',[f.user.id])).rows[0].n,0);
    assert.equal((await f.request('/api/v1/auth/me')).status,401);
    assert.equal((await f.request('/api/v1/auth/login',{email:f.user.email,password:recoveryPassword},'')).status,401);
    assert.equal((await f.request('/api/v1/auth/login',{email:f.user.email,password:nextPassword},'')).status,200);
    const found=await f.request(`${base}/actions/lookup`,{actionId,token},'');assert.deepEqual(found.body.action,completed.body);
    const repeat=await f.request(`${base}/complete`,{actionId,token,newPassword:'another-password-not-to-apply'},'');assert.equal(repeat.status,409);
    assert.equal((await f.request(`${base}/inspect`,{token},'')).status,409);
    const stored=JSON.stringify((await f.pool.query('SELECT * FROM account_password_reset_actions')).rows);
    assert.equal(stored.includes(token),false);assert.equal(stored.includes(nextPassword),false);assert.equal(stored.includes('scrypt'),false);
  });
  it('fences delayed reset actions, preserves the active token and rejects a different token for the same action identity',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();
    await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);
    const token=f.token('recovery',email),actionId=randomUUID();
    assert.equal((await f.request(`${base}/actions/lookup`,{actionId,token},'')).body.action,null);
    assert.equal((await f.request(`${base}/actions/recover`,{actionId,token},'')).body.action.status,'cancelled');
    assert.equal((await f.request(`${base}/complete`,{actionId,token,newPassword:nextPassword},'')).status,409);
    assert.equal((await f.request(`${base}/inspect`,{token},'')).status,200);
    const second=await createUser(f.pool,{email:`${randomUUID()}@example.test`,password:recoveryPassword,name:'Other'});
    const otherSession=await login(f.pool,{email:second.email,password:recoveryPassword}),otherCookie=`pm_v3_session=${otherSession.token}`,otherEmail=`${randomUUID()}@example.test`;
    assert.equal((await f.request('/api/v1/auth/security/recovery-email',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:1,email:otherEmail,currentPassword:recoveryPassword},otherCookie)).body.status,'committed');
    await deliverAccountRecoveryMailBatch(f.pool,f.config);
    assert.equal((await f.request('/api/v1/auth/security/recovery-email/confirm',{actionId:randomUUID(),token:f.token('verify-recovery-email',otherEmail),expectedRecoveryEmailVersion:1},otherCookie)).body.status,'committed');
    await f.request(`${base}/requests`,{requestId:randomUUID(),email:otherEmail},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);
    const different=f.token('recovery',otherEmail);
    for(const method of ['lookup','recover']) {
      const conflict=await f.request(`${base}/actions/${method}`,{actionId,token:different},'');
      assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'security_action_token_conflict');
    }
    assert.equal((await f.pool.query('SELECT credential_version FROM users WHERE id=$1',[f.user.id])).rows[0].credential_version,1);
  });
  it('keeps old trust when cancelling a candidate and unbind invalidates all links without extending or revoking sessions',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind(),candidate=`${randomUUID()}@example.test`;
    const before=(await f.request('/api/v1/auth/security')).body;
    await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);const token=f.token('recovery',email);
    const begun=await f.request('/api/v1/auth/security/recovery-email',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:2,email:candidate,currentPassword:recoveryPassword});
    const cancelled=await f.request('/api/v1/auth/security/recovery-email/cancel',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:2,challengeId:begun.body.challengeId,currentPassword:recoveryPassword});assert.equal(cancelled.body.status,'committed');
    assert.equal((await f.request('/api/v1/auth/security')).body.recoveryEmail.email,email);
    const unbound=await f.request('/api/v1/auth/security/recovery-email/unbind',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:2,currentPassword:recoveryPassword});assert.equal(unbound.body.status,'committed');
    const after=(await f.request('/api/v1/auth/security')).body;assert.equal(after.recoveryEmail.email,null);assert.equal(after.recoveryEmail.emailVersion,3);assert.deepEqual(after.sessions,before.sessions);
    assert.equal((await f.request(`${base}/inspect`,{token},'')).status,409);
  });
  it('has one winner for concurrent complete on the same user lock',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);
    const token=f.token('recovery',email);
    const results=await Promise.all([nextPassword,'concurrent-other-password'].map(newPassword=>f.request(`${base}/complete`,{actionId:randomUUID(),token,newPassword},'')));
    assert.equal(results.filter(item=>item.body.status==='committed').length,1);
    assert.equal((await f.pool.query('SELECT credential_version FROM users WHERE id=$1',[f.user.id])).rows[0].credential_version,2);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM account_recovery_tokens WHERE status='consumed' AND purpose='reset_password'")).rows[0].n,1);
  });
  for(const resetFirst of [false,true]) it(`orders reset and ordinary password change with reset first=${resetFirst}`,{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);const token=f.token('recovery',email);
    const blocker=await f.pool.connect();
    let changing:Promise<RecoveryResponse>|undefined,resetting:Promise<RecoveryResponse>|undefined;
    try {
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.user.id]);
      const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const change=()=>f.request('/api/v1/auth/security/password',{actionId:randomUUID(),expectedCredentialVersion:1,currentPassword:recoveryPassword,newPassword:'ordinary-change-winning-password'});
      const reset=()=>f.request(`${base}/complete`,{actionId:randomUUID(),token,newPassword:nextPassword},'');
      if(resetFirst){resetting=reset();await waitForBlocked(f.pool,pid,'SELECT * FROM users WHERE id=$1 FOR UPDATE');changing=change();await waitForBlocked(f.pool,pid,'SELECT id,credential_version,password_hash,password_changed_at,disabled_at FROM users WHERE id=$1 FOR UPDATE');}
      else{changing=change();await waitForBlocked(f.pool,pid,'SELECT id,credential_version,password_hash,password_changed_at,disabled_at FROM users WHERE id=$1 FOR UPDATE');resetting=reset();await waitForBlocked(f.pool,pid,'SELECT * FROM users WHERE id=$1 FOR UPDATE');}
      await blocker.query('COMMIT');
      const [changed,resetResult]=await Promise.all([changing,resetting]);
      assert.equal((await f.pool.query('SELECT credential_version FROM users WHERE id=$1',[f.user.id])).rows[0].credential_version,2);
      if(resetFirst){assert.equal(resetResult!.body.status,'committed');assert.equal(changed!.status,401);assert.equal((await f.request('/api/v1/auth/me')).status,401);}
      else{assert.equal(changed!.body.status,'committed');assert.equal(resetResult!.body.status,'rejected');assert.equal((await f.request('/api/v1/auth/me')).status,200);}
    }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled([changing,resetting]);}
  });
  it('does not let a previously verified old-password login survive a reset that wins the user lock',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);const token=f.token('recovery',email),blocker=await f.pool.connect();
    let resetting:Promise<RecoveryResponse>|undefined,signingIn:Promise<RecoveryResponse>|undefined;
    try{
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.user.id]);const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      resetting=f.request(`${base}/complete`,{actionId:randomUUID(),token,newPassword:nextPassword},'');await waitForBlocked(f.pool,pid,'SELECT * FROM users WHERE id=$1 FOR UPDATE');
      signingIn=f.request('/api/v1/auth/login',{email:f.user.email,password:recoveryPassword},'');await waitForBlocked(f.pool,pid,'SELECT id,email,name,password_hash,credential_version,disabled_at FROM users WHERE id=$1 FOR UPDATE');
      await blocker.query('COMMIT');assert.equal((await resetting).body.status,'committed');assert.equal((await signingIn).status,401);
      assert.equal((await f.request('/api/v1/auth/login',{email:f.user.email,password:nextPassword},'')).status,200);
    }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled([resetting,signingIn]);}
  });
  it('rejects expiry with receipt-only recovery and persists source/address throttles outside failed business transactions',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});await f.bind();
    const token=randomBytes(32).toString('base64url'),id=randomUUID();
    await f.pool.query("INSERT INTO account_recovery_tokens(id,user_id,purpose,token_hash,credential_version,recovery_email_version,created_at,expires_at) VALUES($1,$2,'reset_password',$3,1,2,clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '1 second')",[id,f.user.id,createHash('sha256').update(token).digest('hex')]);
    assert.equal((await f.request(`${base}/inspect`,{token},'')).status,409);
    const actionId=randomUUID(),rejected=await f.request(`${base}/complete`,{actionId,token,newPassword:nextPassword},'');assert.equal(rejected.body.status,'rejected');
    assert.deepEqual((await f.request(`${base}/actions/recover`,{actionId,token},'')).body.action,rejected.body);
    for(let count=0;count<20;count++)assert.equal((await f.request(`${base}/requests`,{requestId:randomUUID(),email:`absent-${count}@example.test`},'')).status,202);
    assert.equal((await f.request(`${base}/requests`,{requestId:randomUUID(),email:'another@example.test'},'')).status,429);
    assert.ok((await f.pool.query('SELECT 1 FROM account_auth_limits WHERE attempts>20')).rowCount);
    assert.equal((await f.pool.query('SELECT credential_version FROM users WHERE id=$1',[f.user.id])).rows[0].credential_version,1);
  });
  for(const fault of ['drop','malformed','503'] as const) it(`recovers one real committed reset after ${fault} response fault without resending password`,{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);
    const token=f.token('recovery',email),actionId=randomUUID();
    const client=new AccountRecoveryClient(async(path,input)=>{
      const response=await fetch(`${f.origin}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      if(path.endsWith('/complete')){
        const realBody=await response.text();assert.equal(response.status,200);
        if(fault==='drop')throw new Error('Injected response loss after real HTTP commit');
        return new Response(fault==='malformed' ? '{\"wrong\":\"shape\"}' : realBody,{status:fault==='503' ? 503 : 200,headers:{'content-type':'application/json'}});
      }
      return response;
    });
    await assert.rejects(client.complete(actionId,token,nextPassword));
    const original=await client.lookupAction(actionId,token);assert.equal(original.action?.status,'committed');
    assert.deepEqual((await client.recoverAction(actionId,token)).action,original.action);
    assert.equal((await f.pool.query('SELECT credential_version FROM users WHERE id=$1',[f.user.id])).rows[0].credential_version,2);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM account_password_reset_actions')).rows[0].n,1);assert.equal(f.smtp.messages.length,2);
  });
  it('replaces trust only after new verification and arbitrates a shared candidate email through the unique index',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const old=await f.bind();
    await f.request(`${base}/requests`,{requestId:randomUUID(),email:old},'');await deliverAccountRecoveryMailBatch(f.pool,f.config);const oldToken=f.token('recovery',old);
    const second=await createUser(f.pool,{email:`${randomUUID()}@example.test`,password:recoveryPassword,name:'Competing account'}),session=await login(f.pool,{email:second.email,password:recoveryPassword}),cookie=`pm_v3_session=${session.token}`,candidate=`${randomUUID()}@example.test`;
    await f.request('/api/v1/auth/security/recovery-email',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:2,email:candidate,currentPassword:recoveryPassword});await deliverAccountRecoveryMailBatch(f.pool,f.config);const firstToken=f.token('verify-recovery-email',candidate);
    assert.equal((await f.request('/api/v1/auth/security')).body.recoveryEmail.email,old);
    await f.request('/api/v1/auth/security/recovery-email',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:1,email:candidate,currentPassword:recoveryPassword},cookie);await deliverAccountRecoveryMailBatch(f.pool,f.config);const secondToken=f.token('verify-recovery-email',candidate);
    const outcomes=await Promise.all([f.request('/api/v1/auth/security/recovery-email/confirm',{actionId:randomUUID(),token:firstToken,expectedRecoveryEmailVersion:2}),f.request('/api/v1/auth/security/recovery-email/confirm',{actionId:randomUUID(),token:secondToken,expectedRecoveryEmailVersion:1},cookie)]);
    assert.equal(outcomes.filter(item=>item.body.status==='committed').length,1);assert.equal(outcomes.filter(item=>item.body.errorCode==='recovery_email_conflict').length,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM users WHERE recovery_email=$1',[candidate])).rows[0].n,1);
    const owner=(await f.pool.query('SELECT id FROM users WHERE recovery_email=$1',[candidate])).rows[0].id;
    assert.equal((await f.request(`${base}/inspect`,{token:oldToken},'')).status,owner===f.user.id ? 409 : 200);
  });
  it('fences restored sessions/tokens/mail in one caller transaction without rewriting trust, credentials or immutable receipts',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});const email=await f.bind();
    await f.request(`${base}/requests`,{requestId:randomUUID(),email},'');
    const resetQueue=(await f.pool.query("SELECT id,token_id,token_ciphertext FROM account_recovery_mail_queue WHERE purpose='reset_password' AND status='queued'")).rows[0];
    const token=decryptMailToken(f.config.tokenKey,`reset_password:${resetQueue.token_id}:${resetQueue.id}`,resetQueue.token_ciphertext),actionId=randomUUID();
    const original=await f.request(`${base}/actions/recover`,{actionId,token},'');assert.equal(original.body.action.status,'cancelled');
    await f.request('/api/v1/auth/security/recovery-email',{actionId:randomUUID(),expectedCredentialVersion:1,expectedRecoveryEmailVersion:2,email:`${randomUUID()}@example.test`,currentPassword:recoveryPassword});
    await f.pool.query("UPDATE account_recovery_mail_queue SET status='sending',token_ciphertext=NULL,lease_id=$1,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE purpose='verify_recovery_email' AND status='queued'",[randomUUID()]);
    const receipts=(await f.pool.query('SELECT * FROM account_security_actions ORDER BY action_id')).rows;
    const requests=(await f.pool.query('SELECT request_id,status,occurred_at FROM account_recovery_requests ORDER BY request_id')).rows;
    const before=(await f.pool.query('SELECT password_hash,credential_version,recovery_email,recovery_email_verified_at,recovery_email_version FROM users WHERE id=$1',[f.user.id])).rows[0];
    const sql=await f.pool.connect();
    try {await sql.query('BEGIN');await fenceRestoredAccountRecovery(sql);await fenceRestoredAccountRecovery(sql);await sql.query('COMMIT');}
    catch(error){await sql.query('ROLLBACK');throw error;}finally{sql.release();}
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,0);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM account_recovery_tokens WHERE status='active'")).rows[0].n,0);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM account_recovery_mail_queue WHERE status IN ('queued','sending') OR token_ciphertext IS NOT NULL OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL")).rows[0].n,0);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM account_recovery_mail_queue WHERE status='unknown' AND failure_code='send_lease_expired'")).rows[0].n,1);
    assert.equal((await f.pool.query('SELECT status FROM account_recovery_mail_queue WHERE id=$1',[resetQueue.id])).rows[0].status,'cancelled');
    assert.deepEqual((await f.pool.query('SELECT * FROM account_security_actions ORDER BY action_id')).rows,receipts);
    assert.deepEqual((await f.pool.query('SELECT request_id,status,occurred_at FROM account_recovery_requests ORDER BY request_id')).rows,requests);
    assert.deepEqual((await f.pool.query('SELECT password_hash,credential_version,recovery_email,recovery_email_verified_at,recovery_email_version FROM users WHERE id=$1',[f.user.id])).rows[0],before);
    assert.deepEqual((await f.request(`${base}/actions/lookup`,{actionId,token},'')).body.action,original.body.action);
    assert.equal((await f.request(`${base}/inspect`,{token},'')).status,409);
    const delivery=await deliverAccountRecoveryMailBatch(f.pool,f.config);assert.equal(delivery.attempted,0);assert.equal(f.smtp.messages.length,1);
  });
  it('does not issue fake tokens when disabled and rejects queries or widened body inputs',{timeout:mailFixtureCaseTimeout},async t=>{
    const f=await createRecoveryFixture({database,signal:t.signal,disabled:true});t.after(()=>f.close(),{timeout:mailFixtureCleanupTimeout});
    const disabled=await f.request(`${base}/requests`,{requestId:randomUUID(),email:f.user.email},'');assert.equal(disabled.status,503);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM account_recovery_tokens')).rows[0].n,0);
    assert.equal((await f.request(`${base}/inspect?token=private-query-value`,{token:'x'.repeat(43)},'')).status,400);
    assert.equal((await f.request(`${base}/requests`,{requestId:randomUUID(),email:f.user.email,userId:f.user.id},'')).status,400);
  });
});
