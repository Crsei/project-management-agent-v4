import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { createPool,migrate } from '../packages/infrastructure/src/database.ts';
import { createUser,createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { recoveryDatabaseUrl,recoveryPassword } from './account-recovery-fixture.ts';

it('upgrades a legacy administrator, CLI account, accepted invitation and immutable security history without inventing trust',{skip:!recoveryDatabaseUrl,timeout:120000},async()=>{
  const admin=createPool(recoveryDatabaseUrl!),namespace=`test_recovery_upgrade_${randomUUID().replaceAll('-','')}`;
  let created=false;
  const url=new URL(recoveryDatabaseUrl!);url.searchParams.set('options',`-c search_path=${namespace},public`);
  const pool=createPool(url.toString());
  try {
    await admin.query(`CREATE SCHEMA ${namespace}`);created=true;
    await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const folder=new URL('../packages/infrastructure/migrations/',import.meta.url);
    const prior=(await readdir(folder)).filter(name=>/^\d+_[\w-]+\.sql$/.test(name) && name<'0027_account_recovery.sql').sort();
    for(const name of prior) {
      const source=await readFile(new URL(name,folder),'utf8');await pool.query(source);
      await pool.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,createHash('sha256').update(source).digest('hex')]);
    }
    const administrator=await createUser(pool,{email:'admin@project-management.local',password:recoveryPassword,name:'Legacy administrator'});
    const cli=await createUser(pool,{email:'cli@example.test',password:recoveryPassword,name:'CLI account'});
    const invited=await createUser(pool,{email:'accepted@example.test',password:recoveryPassword,name:'Accepted invitation account'});
    const workspace=await createWorkspace(pool,administrator.id,'Legacy recovery migration');
    await pool.query("INSERT INTO member_invitations(id,workspace_id,email,role,status,token_hash,invited_by,accepted_by,accepted_at,expires_at) VALUES($1,$2,$3,'member','accepted',$4,$5,$6,clock_timestamp(),clock_timestamp()+interval '1 day')",[randomUUID(),workspace.id,invited.email,createHash('sha256').update(randomUUID()).digest('hex'),administrator.id,invited.id]);
    const actionId=randomUUID();await pool.query("INSERT INTO account_security_actions(user_id,action_id,kind,status,credential_version,http_status) VALUES($1,$2,'revoke_sessions','committed',1,200)",[cli.id,actionId]);
    const hashes=(await pool.query('SELECT id,password_hash,email FROM users ORDER BY id')).rows;
    await migrate(pool);
    const migrated=await pool.query('SELECT recovery_email,recovery_email_verified_at,recovery_email_version FROM users');
    assert.equal(migrated.rowCount,3);for(const user of migrated.rows)assert.deepEqual(user,{recovery_email:null,recovery_email_verified_at:null,recovery_email_version:1});
    assert.deepEqual((await pool.query('SELECT id,password_hash,email FROM users ORDER BY id')).rows,hashes);
    assert.deepEqual((await pool.query('SELECT recovery_email_version,challenge_id FROM account_security_actions WHERE action_id=$1',[actionId])).rows[0],{recovery_email_version:1,challenge_id:null});
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM account_recovery_tokens')).rows[0].n,0);
    await assert.rejects(pool.query('UPDATE account_security_actions SET recovery_email_version=2 WHERE action_id=$1',[actionId]));
  } finally {await pool.end();if(created)await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});
