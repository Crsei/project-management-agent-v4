import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { describe,it } from 'node:test';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { createUser,createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { readNotificationInbox } from '../packages/application/src/notifications.ts';
import { pruneEventHistory } from '../packages/application/src/outbox.ts';
import { dashboardDatabaseUrl } from './dashboard-fixture.ts';
describe('0026 forward migration preserves real personal history independent of SSE retention',{skip:!dashboardDatabaseUrl,timeout:120_000},()=>{
 it('upgrades a real 0024 database with exact event identity, CAS/read/archive timestamps, private audience and non-task navigation',async()=>{
  const admin=createPool(dashboardDatabaseUrl!),schema=`test_notification_upgrade_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(dashboardDatabaseUrl!);url.searchParams.set('options',`-c search_path=${schema},public`);const pool=createPool(url.toString());
  try {
   const directory=new URL('../packages/infrastructure/migrations/',import.meta.url);
   const migrations=(await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name<'0025_').sort();
   for(const name of migrations)await pool.query(await readFile(new URL(name,directory),'utf8'));
   const a=await createUser(pool,{email:`${randomUUID()}@example.test`,name:'History A',password:'isolated-notification-password'}),b=await createUser(pool,{email:`${randomUUID()}@example.test`,name:'History B',password:'isolated-notification-password'});
   const workspace=(await createWorkspace(pool,a.id,'Legacy history')).id;
   await pool.query("INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,ARRAY['domain.read'],'{PRJ-001}')",[workspace,b.id]);
   const shared=randomUUID(),privateNote=randomUUID(),untouched=randomUUID();
   for(const [index,eventId,kind,project,audience] of [[1,shared,'conversation','PRJ-001',null],[2,privateNote,'private_note',null,a.id],[3,untouched,'conversation','PRJ-001',null]] as const) {
    const envelope={eventId,eventType:kind==='private_note'?'PrivateNoteCreated':'ConversationCreated',workspaceId:workspace,projectId:project,aggregateId:randomUUID(),aggregateKind:kind,aggregateVersion:1,occurredAt:'2026-01-01T00:00:00.000Z'};
    await pool.query("INSERT INTO events(workspace_id,cursor,event_id,envelope,audience_actor_id,created_at) VALUES($1,$2,$3,$4::jsonb,$5,now()-interval '8 days')",[workspace,index,eventId,JSON.stringify(envelope),audience]);
   }
   await pool.query('UPDATE workspaces SET stream_cursor=3 WHERE id=$1',[workspace]);
   await pool.query("INSERT INTO activity_states(workspace_id,actor_id,event_id,version,read_at) VALUES($1,$2,$4,2,'2026-01-02T00:00:00Z'),($1,$3,$4,2,'2026-01-03T00:00:00Z'),($1,$2,$5,2,'2026-01-04T00:00:00Z')",[workspace,a.id,b.id,shared,privateNote]);
   await pool.query("UPDATE activity_states SET version=3,read_at=NULL,archived_at='2026-01-05T00:00:00Z' WHERE actor_id=$1 AND event_id=$2",[a.id,shared]);
   await pool.query('UPDATE activity_states SET version=4,archived_at=NULL WHERE actor_id=$1 AND event_id=$2',[a.id,shared]);
   const before=await pool.query('SELECT workspace_id,event_id,actor_id,version,read_at,archived_at FROM activity_states ORDER BY event_id,actor_id');
   const migration=await readFile(new URL('0026_service_facts_notifications.sql',directory),'utf8');
   await pool.query('BEGIN');await pool.query(migration);await pool.query('COMMIT');
   const after=await pool.query('SELECT workspace_id,fact_id AS event_id,recipient_id AS actor_id,state_version AS version,read_at,archived_at FROM notification_recipients ORDER BY fact_id,recipient_id');assert.deepEqual(after.rows,before.rows);
   assert.equal((await pool.query("SELECT to_regclass('activity_states')::text AS old")).rows[0].old,null);
   assert.equal((await pool.query('SELECT 1 FROM service_fact_events WHERE fact_id=$1',[untouched])).rows.length,0);
   const noCore={read:async()=>{throw new Error('Legacy non-task history must not initialize or query a task core');}};
   const page=await readNotificationInbox(pool,a,workspace,noCore,{origin:'legacy_activity'});assert.equal(page.items.length,2);assert.equal(page.items.every(item=>item.target===null),true);assert.equal(page.items.find(item=>item.event.eventId===shared)?.state.version,4);
   assert.equal((await readNotificationInbox(pool,b,workspace,noCore,{origin:'legacy_activity'})).items.length,1);
   await pool.query('UPDATE memberships SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2',[workspace,b.id]);
   await assert.rejects(readNotificationInbox(pool,b,workspace,noCore,{origin:'legacy_activity'}));
   await pruneEventHistory(pool,7);assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n,0);
   assert.deepEqual((await pool.query('SELECT workspace_id,fact_id AS event_id,recipient_id AS actor_id,state_version AS version,read_at,archived_at FROM notification_recipients ORDER BY fact_id,recipient_id')).rows,after.rows);
   assert.equal((await pool.query("SELECT (migration_manifest->>'identityVersionTimePreserved')::boolean AS preserved FROM notification_activations")).rows[0].preserved,true);
  }finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
 });
});
