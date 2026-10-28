import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,unlink,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe,it } from 'node:test';
import { z } from 'zod';
import { CoreWorkspacePool } from '../apps/api/src/core-routes.ts';
import { CoreFactImporter } from '../apps/api/src/core-fact-importer.ts';
import { CoreCommandJournal } from '../apps/api/src/core-journal.ts';
import { routeNotificationBatch,retryNotificationFact,fenceRestoredNotifications } from '../packages/application/src/notification-routing.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import type { Command,Entity } from '../packages/domain/src/core.ts';
import type { NotificationInboxItem,NotificationInboxPage } from '../packages/domain/src/notifications.ts';
import type { FileRecord } from '../packages/pm-schema/index.ts';
import { personalMentionToken } from '../packages/pm-markdown/mentions.ts';
import { createDashboardFixture,dashboardDatabaseUrl,type DashboardFixture } from './dashboard-fixture.ts';
import { notificationStateSchema } from '../packages/contracts/src/notifications.ts';
import { patchMarkdown } from '../packages/pm-markdown/index.ts';
async function setup(f:DashboardFixture) {
 const project=await f.command<Entity>('CreateProject',{name:'Notification project',goal:'',ownerId:f.owner.id,completionCriteria:[]});
 const task=await f.command<Entity>('CreateWorkItem',{title:'Saved task',description:'Initial body',acceptanceCriteria:[]},{extra:{projectId:project.id}});
 return {project,task};
}
async function grant(f:DashboardFixture,userId:string,projectId:string,capabilities=['domain.read','intent.propose']) {
 return f.command<{version:number}>('SetWorkspaceMember',{userId,capabilities,projectIds:[projectId]});
}
async function drain(f:DashboardFixture) {
 const port=readonlyCorePort(id=>join(f.coreRoot,id));
 for(let n=0;n<50;n++) {const result=await routeNotificationBatch(f.pool,port,`test-${randomUUID()}`,{jobLimit:20,candidateLimit:2});if(!result.jobs)return;}
 throw new Error('Routing did not settle within bounded fixture drain');
}
async function inbox(f:DashboardFixture,cookie=f.ownerCookie):Promise<NotificationInboxItem[]> {
 let page=(await f.request<NotificationInboxPage>(`/api/v1/workspaces/${f.workspaceId}/notification-inbox`,{cookie})).body;
 const items=[...page.items],head=page.head,member=page.membershipVersion;
 while(BigInt(page.cursor)<BigInt(head)) {const prior=page.cursor;page=(await f.request<NotificationInboxPage>(`/api/v1/workspaces/${f.workspaceId}/notification-inbox?after=${prior}&through=${head}`,{cookie})).body;assert.ok(BigInt(page.cursor)>BigInt(prior));assert.equal(page.membershipVersion,member);items.push(...page.items);}
 return items;
}
function stateCommand(item:NotificationInboxItem,change:{read:boolean}|{archived:boolean}):Command {
 return {commandId:randomUUID(),commandType:'read' in change?'SetNotificationRead':'SetNotificationArchived',targetId:item.event.eventId,expectedVersions:{[item.event.eventId]:item.state.version},payload:change};
}
describe('durable selected notifications through real core, SQL commands and read-only Worker', {skip:!dashboardDatabaseUrl},()=>{
 it('freezes explicit watches/new mentions, merges reasons, excludes the actor and never auto-subscribes', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {task,project}=await setup(f);
  const watch=await f.member('Watcher'),mention=await f.member('Mention only'),both=await f.member('Both reasons'),late=await f.member('Late watcher');
  for(const member of [watch,mention,both,late])await grant(f,member.user.id,project.id);
  for(const member of [watch,both])await f.command('WatchTask',{taskId:task.id},{cookie:member.cookie,extra:{projectId:project.id}});
  await f.command('WatchTask',{taskId:task.id},{extra:{projectId:project.id}});
  const countBefore=(await f.pool.query("SELECT count(*)::int AS n FROM dashboard_records WHERE kind='task_watch'")).rows[0].n;
  const command:Command={commandId:randomUUID(),commandType:'CreateTaskComment',targetId:task.id,projectId:project.id,payload:{content:`Real saved comment ${personalMentionToken(mention.user.id,'中文')} ${personalMentionToken(both.user.id,'Same name')} ${personalMentionToken(f.owner.id,'Self')}`}};
  const saved=await f.send(command);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.deepEqual((await f.send(command)).body,saved.body);
  const savedComment=z.object({id:z.uuid()}).parse(saved.body.result);
  await f.command('WatchTask',{taskId:task.id},{cookie:late.cookie,extra:{projectId:project.id}});
  await drain(f);
  const rows=await f.pool.query<{recipient_id:string;reason_set:string[]}>('SELECT r.recipient_id,r.reason_set FROM notification_recipients r JOIN service_fact_events f USING(workspace_id,fact_id) WHERE f.entity_id=$1',[savedComment.id]);
  assert.deepEqual(rows.rows.map(row=>row.recipient_id).sort(),[watch.user.id,mention.user.id,both.user.id].sort());
  assert.deepEqual(rows.rows.find(row=>row.recipient_id===both.user.id)?.reason_set,['watch','mention']);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM dashboard_records WHERE kind='task_watch'")).rows[0].n,countBefore+1);
  const received=(await inbox(f,mention.cookie))[0]!;assert.equal(received.target?.taskId,task.id);assert.equal(received.target?.commentId,savedComment.id);
  assert.equal((await inbox(f)).length,0);assert.equal((await inbox(f,late.cookie)).length,0);
 });
 it('rechecks original watch identity, authorizes added mention IDs only, and rolls invalid saves back', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {task,project}=await setup(f),member=await f.member('Revocable mention');await grant(f,member.user.id,project.id);
  const watch=await f.command<{id:string;version:number}>('WatchTask',{taskId:task.id},{cookie:member.cookie,extra:{projectId:project.id}});
  await f.command('CreateTaskComment',{content:'watch-only fact'},{extra:{targetId:task.id,projectId:project.id}});
  await f.command('UnwatchTask',{}, {cookie:member.cookie,extra:{targetId:watch.id,projectId:project.id,expectedVersions:{[watch.id]:watch.version}}});
  await drain(f);assert.equal((await inbox(f,member.cookie)).length,0);
  const token=personalMentionToken(member.user.id,'Member');
  const comment=await f.command<{id:string;version:number}>('CreateTaskComment',{content:token},{extra:{targetId:task.id,projectId:project.id}});
  await f.pool.query('UPDATE users SET disabled_at=clock_timestamp() WHERE id=$1',[member.user.id]);
  const edited=await f.command<{id:string;version:number}>('UpdateTaskComment',{commentId:comment.id,content:`Unchanged historical identity ${token}`},{extra:{targetId:task.id,projectId:project.id,expectedVersions:{[comment.id]:comment.version}}});assert.equal(edited.version,2);
  const before=(await f.pool.query('SELECT count(*)::int AS n FROM service_fact_events')).rows[0].n;
  const rejected=await f.send({commandId:randomUUID(),commandType:'CreateTaskComment',targetId:task.id,projectId:project.id,payload:{content:personalMentionToken(randomUUID(),'Unknown')}});
  assert.equal(rejected.body.error?.code,'mention_not_eligible');assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM service_fact_events')).rows[0].n,before);
  await drain(f);assert.equal((await f.pool.query('SELECT 1 FROM notification_recipients WHERE recipient_id=$1',[member.user.id])).rows.length,0);
 });
 it('enforces personal CAS, no-op state, atomic private invalidation and current original-receipt authorization after move/delete', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {task,project}=await setup(f),member=await f.member('Inbox owner');await grant(f,member.user.id,project.id);
  await f.command('CreateTaskComment',{content:personalMentionToken(member.user.id,'Reader')},{extra:{targetId:task.id,projectId:project.id}});await drain(f);
  const received=(await inbox(f,member.cookie))[0]!,input=stateCommand(received,{read:true});
  const saved=await f.send(input,{cookie:member.cookie});assert.equal(saved.status,200,JSON.stringify(saved.body));const state=notificationStateSchema.parse(saved.body.result);assert.equal(state.version,2);
  assert.deepEqual((await f.send(input,{cookie:member.cookie})).body,saved.body);
  assert.equal((await f.send(stateCommand(received,{archived:true}),{cookie:member.cookie})).status,409);
  const current={...received,state};const noop=await f.send(stateCommand(current,{read:true}),{cookie:member.cookie});assert.equal(notificationStateSchema.parse(noop.body.result).version,2);
  const invalidations=await f.pool.query("SELECT payload,audience_actor_id FROM outbox WHERE aggregate_kind='notification_state' AND command_id=$1",[input.commandId]);assert.deepEqual(invalidations.rows,[{payload:{},audience_actor_id:member.user.id}]);
  const second=await f.command<Entity>('CreateProject',{name:'Other scope',goal:'',ownerId:f.owner.id,completionCriteria:[]});
  const file=(await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${task.id}`)).body;
  assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/core/entities/${task.id}`,{method:'PATCH',body:{revision:file.revision,changes:{project:second.id}}})).status,200);
  assert.equal((await inbox(f,member.cookie)).length,0);
  assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${input.commandId}`,{cookie:member.cookie})).status,404);
  assert.equal((await f.send(input,{cookie:member.cookie})).status,404);
  const moved=(await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${task.id}`)).body;
  const archived=await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${task.id}/archive`,{method:'POST',body:{revision:moved.revision}});
  assert.equal(archived.status,200);
  const deletion=await f.request<{error:{code:string}}>(`/api/v1/workspaces/${f.workspaceId}/core/entities/${task.id}`,{method:'DELETE',body:{revision:archived.body.revision}});
  assert.equal(deletion.status,422);
  assert.equal(deletion.body.error.code,'DELETE_REFERENCED');
  // Retained SQL history blocks API deletion; external Markdown loss must still redact.
  await unlink(join(f.coreRoot,f.workspaceId,archived.body.path));
  assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/commands/${input.commandId}`,{cookie:member.cookie})).status,404);
 });
 it('captures command/native project, task and milestone revisions, without source prose or native PM receipts', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {task,project}=await setup(f);
  await f.command('CreateMilestone',{title:'Milestone secret title',criteria:[]},{extra:{projectId:project.id}});
  const base=`/api/v1/workspaces/${f.workspaceId}/core`,key=randomUUID();
  const native=await f.request<FileRecord>(`${base}/entities`,{method:'POST',headers:{'Idempotency-Key':key},body:{entity:'work_item',title:'Native secret title',project:project.id,body:'Private body never enters source'}});assert.equal(native.status,200);
  const patch=await f.request<FileRecord>(`${base}/entities/${task.id}`,{method:'PATCH',body:{revision:(await f.request<FileRecord>(`${base}/files/${task.id}`)).body.revision,changes:{priority:'high'}}});assert.equal(patch.status,200);
  const facts=await f.pool.query('SELECT * FROM service_fact_events WHERE workspace_id=$1 ORDER BY fact_sequence',[f.workspaceId]);
  assert.ok(['project','work_item','milestone'].every(kind=>facts.rows.some(row=>row.entity_kind===kind&&row.source_kind==='command')));
  assert.ok(facts.rows.some(row=>row.entity_id===native.body.id&&row.after_revision===native.body.revision&&row.source_kind==='core_http'));
  assert.ok(facts.rows.some(row=>row.entity_id===task.id&&row.change_kinds.includes('metadata_changed')));
  assert.equal(/secret title|Private body/.test(JSON.stringify(facts.rows)),false);
  assert.equal(facts.rows.filter(row=>row.source_kind!=='legacy_activity').every(row=>row.observed_at!==null),true);
  const original=new CoreCommandJournal(join(f.coreRoot,f.workspaceId)).entries().find(entry=>entry.kind==='http_completed'&&entry.targetId===native.body.id);assert.ok(original);
  assert.equal((await f.pool.query('SELECT 1 FROM command_receipts WHERE command_id::text=$1',[original.commandId])).rows.length,0);
 });
 it('recovers file-before-SQL failure by original fact identity, never rewriting the Markdown or resetting a delivered state', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {project}=await setup(f);
  await f.pool.query(`CREATE FUNCTION reject_service_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_kind='work_item' THEN RAISE EXCEPTION 'isolated fact failure';END IF;RETURN NEW;END $$; CREATE TRIGGER reject_service_fact BEFORE INSERT ON service_fact_events FOR EACH ROW EXECUTE FUNCTION reject_service_fact()`);
  const key=randomUUID(),base=`/api/v1/workspaces/${f.workspaceId}/core`;
  const response=await f.request(`${base}/entities`,{method:'POST',headers:{'Idempotency-Key':key},body:{entity:'work_item',project:project.id,title:'Saved despite SQL failure'}});assert.equal(response.status,503);
  const journal=new CoreCommandJournal(join(f.coreRoot,f.workspaceId)),entry=journal.entries().find(value=>value.kind==='fact_completed'&&value.captured.fact.sourceKind==='core_http');assert.ok(entry&&entry.kind==='fact_completed');
  await f.app.close();await f.pool.query('DROP TRIGGER reject_service_fact ON service_fact_events;DROP FUNCTION reject_service_fact()');
  const rawPath=join(f.coreRoot,f.workspaceId,'work-items',`${entry.captured.fact.entityId}.md`),raw=await readFile(rawPath,'utf8');
  const workspaces=new CoreWorkspacePool(f.coreRoot);t.after(()=>workspaces.close());const importer=new CoreFactImporter(f.pool,workspaces);
  await importer.importWorkspace(f.workspaceId);await importer.importWorkspace(f.workspaceId);
  assert.equal(await readFile(rawPath,'utf8'),raw);
  const facts=await f.pool.query('SELECT fact_id,after_revision FROM service_fact_events WHERE source_kind=\'core_http\' AND entity_id=$1',[entry.captured.fact.entityId]);assert.deepEqual(facts.rows,[{fact_id:entry.captured.fact.factId,after_revision:entry.captured.fact.afterRevision}]);
  assert.equal((await f.pool.query('SELECT 1 FROM service_fact_events WHERE source_kind=\'core_observation\' AND entity_id=$1',[entry.captured.fact.entityId])).rows.length,0);
 });
 it('imports only a real observed offline A-to-C difference, with unknown author/time and no mention expansion', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {task,project}=await setup(f),member=await f.member('Observation watcher');await grant(f,member.user.id,project.id);
  await f.command('WatchTask',{taskId:task.id},{cookie:member.cookie,extra:{projectId:project.id}});
  const file=(await f.request<FileRecord>(`/api/v1/workspaces/${f.workspaceId}/core/files/${task.id}`)).body;
  await f.app.close();const filename=join(f.coreRoot,f.workspaceId,file.path);
  await writeFile(filename,file.raw.replace('Initial body','Unobserved intermediate B'));
  await writeFile(filename,file.raw.replace('Initial body',`Final C ${personalMentionToken(f.owner.id,'No trusted external mention')}`));
  const workspaces=new CoreWorkspacePool(f.coreRoot);t.after(()=>workspaces.close());const importer=new CoreFactImporter(f.pool,workspaces);
  await importer.importWorkspace(f.workspaceId);await importer.importWorkspace(f.workspaceId);await drain(f);
  const rows=await f.pool.query('SELECT f.occurred_at,i.actor_id,i.new_mention_ids FROM service_fact_events f JOIN notification_fact_inputs i USING(workspace_id,fact_id) WHERE f.source_kind=\'core_observation\' AND f.entity_id=$1',[task.id]);
  assert.deepEqual(rows.rows,[{occurred_at:null,actor_id:null,new_mention_ids:[]}]);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM notification_recipients WHERE recipient_id=$1',[member.user.id])).rows[0].n,1);
 });
 it('rolls a recipient page back on real SQL failure, recovers expired leases, and never resets state on duplicate delivery', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {task,project}=await setup(f),member=await f.member('Failure recipient');await grant(f,member.user.id,project.id);
  const comment=await f.command<{id:string}>('CreateTaskComment',{content:personalMentionToken(member.user.id,'Recipient')},{extra:{targetId:task.id,projectId:project.id}});
  const fact=(await f.pool.query<{fact_id:string}>('SELECT fact_id FROM service_fact_events WHERE entity_id=$1',[comment.id])).rows[0]!.fact_id;
  await f.pool.query(`CREATE FUNCTION reject_notification_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_kind='notification_state' THEN RAISE EXCEPTION 'isolated recipient page failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_notification_invalidation BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_notification_invalidation()`);
  const port=readonlyCorePort(id=>join(f.coreRoot,id));
  const failed=await routeNotificationBatch(f.pool,port,'failed-test',{jobLimit:20});assert.equal(failed.delivered,0);
  assert.equal((await f.pool.query('SELECT 1 FROM notification_recipients WHERE fact_id=$1',[fact])).rows.length,0);
  assert.equal((await f.pool.query('SELECT attempts FROM notification_route_jobs WHERE fact_id=$1',[fact])).rows[0].attempts,1);
  await f.pool.query('DROP TRIGGER reject_notification_invalidation ON outbox;DROP FUNCTION reject_notification_invalidation()');
  await f.pool.query("UPDATE notification_route_jobs SET state='running',lease_owner='dead-worker',lease_until=clock_timestamp()-interval '1 second',lease_epoch=17 WHERE fact_id=$1",[fact]);
  await drain(f);const received=(await inbox(f,member.cookie))[0]!;
  const archived=await f.send(stateCommand(received,{archived:true}),{cookie:member.cookie});assert.equal(archived.status,200);const state=notificationStateSchema.parse(archived.body.result);
  const cursor=(await f.pool.query('SELECT notification_head::text AS head FROM workspaces WHERE id=$1',[f.workspaceId])).rows[0].head;
  await f.pool.query("UPDATE notification_route_jobs SET state='failed',candidate_after='',lease_owner=NULL,lease_until=NULL WHERE fact_id=$1",[fact]);
  await retryNotificationFact(f.pool,f.workspaceId,fact,process.getuid?.()??0);await drain(f);
  assert.deepEqual((await inbox(f,member.cookie))[0]?.state,state);
  assert.equal((await f.pool.query('SELECT notification_head::text AS head FROM workspaces WHERE id=$1',[f.workspaceId])).rows[0].head,cursor);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM notification_route_retries WHERE fact_id=$1',[fact])).rows[0].n,1);
  const restore=await f.pool.connect();
  try {
   await restore.query('BEGIN');
   const old=await restore.query<{lease_epoch:string}>("UPDATE notification_route_jobs SET state='running',lease_owner='pre-restore',lease_until=clock_timestamp()+interval '1 minute' WHERE fact_id=$1 RETURNING lease_epoch::text",[fact]);
   await fenceRestoredNotifications(restore);
   const stale=await restore.query("UPDATE notification_route_jobs SET state='completed' WHERE fact_id=$1 AND lease_owner='pre-restore' AND lease_epoch=$2",[fact,old.rows[0]!.lease_epoch]);
   assert.equal(stale.rowCount,0);
   const preserved=await restore.query('SELECT state_version,read_at,archived_at FROM notification_recipients WHERE fact_id=$1',[fact]);
   assert.equal(preserved.rows[0].state_version,state.version);assert.equal(preserved.rows[0].archived_at.toISOString(),state.archivedAt);
   await restore.query('COMMIT');
  }catch(error){await restore.query('ROLLBACK');throw error;}finally{restore.release();}
 });
 it('keeps genuine native A-to-B-to-A-to-B saves distinct while the same explicit native key replays once', { timeout: 180_000 }, async t=>{
  const f=await createDashboardFixture({ signal: t.signal });t.after(()=>f.close());const {task}=await setup(f),base=`/api/v1/workspaces/${f.workspaceId}/core`;
  const original=(await f.request<FileRecord>(`${base}/files/${task.id}`)).body,rawB=patchMarkdown(original.raw,{priority:'high'});
  const key=randomUUID(),first=await f.request<FileRecord>(`${base}/files/${task.id}`,{method:'PUT',headers:{'Idempotency-Key':key},body:{raw:rawB,revision:original.revision}});assert.equal(first.status,200);
  assert.equal((await f.request(`${base}/files/${task.id}`,{method:'PUT',headers:{'Idempotency-Key':key},body:{raw:rawB,revision:original.revision}})).status,200);
  const back=await f.request<FileRecord>(`${base}/files/${task.id}`,{method:'PUT',headers:{'Idempotency-Key':randomUUID()},body:{raw:original.raw,revision:first.body.revision}});assert.equal(back.status,200);
  const last=await f.request<FileRecord>(`${base}/files/${task.id}`,{method:'PUT',headers:{'Idempotency-Key':randomUUID()},body:{raw:rawB,revision:back.body.revision}});assert.equal(last.status,200);
  const facts=await f.pool.query<{fact_id:string}>("SELECT fact_id FROM service_fact_events WHERE entity_id=$1 AND source_kind='core_http' AND before_revision=$2 AND after_revision=$3",[task.id,original.revision,first.body.revision]);
  assert.equal(facts.rows.length,2);assert.equal(new Set(facts.rows.map(row=>row.fact_id)).size,2);
 });
});
