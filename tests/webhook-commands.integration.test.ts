import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommandReceipt } from '../packages/domain/src/core.ts';
import type { WebhookDeliveryPage, WebhookOverview } from '../packages/domain/src/webhooks.ts';
import { readWebhookConfig } from '../packages/infrastructure/src/webhook-config.ts';
import { createWebhookFixture, webhookDatabaseUrl } from './webhook-fixture.ts';

test('endpoint commands persist original receipts, enforce strict scope/unknown fields/CAS and never accept URL input', { skip: !webhookDatabaseUrl }, async t => {
  const f=await createWebhookFixture();t.after(()=>f.close()); const path=`/api/v1/workspaces/${f.workspaceId}/commands`;
  const command={commandId:randomUUID(),commandType:'CreateWebhookEndpoint',payload:{targetKey:'isolated_receiver',projectIds:[f.projectId],eventTypes:['pm.task.changed.v1']}};
  const first=await f.request<CommandReceipt>(path,{method:'POST',body:command});assert.equal(first.status,200);
  const repeated=await f.request<CommandReceipt>(path,{method:'POST',body:command});assert.deepEqual(repeated.body,first.body);
  assert.equal((await f.pool.query<{count:string}>('SELECT count(*)::text FROM webhook_endpoints')).rows[0]!.count,'1');
  const conflict=await f.request<CommandReceipt>(path,{method:'POST',body:{...command,payload:{...command.payload,eventTypes:['pm.project.changed.v1']}}});assert.equal(conflict.status,409);
  const result=first.body.result as {endpointId:string;version:number};
  const stale=await f.request<CommandReceipt>(path,{method:'POST',body:{commandId:randomUUID(),commandType:'SetWebhookEndpointState',targetId:result.endpointId,payload:{state:'retired'}}});assert.equal(stale.status,409);assert.equal(stale.body.error?.code,'version_conflict');
  const bad=await f.request<CommandReceipt>(path,{method:'POST',body:{...command,commandId:randomUUID(),payload:{...command.payload,url:'https://attacker.com/x',headers:{authorization:'never'}}}});assert.equal(bad.status,400);
  const outside=await f.request<CommandReceipt>(path,{method:'POST',body:{...command,commandId:randomUUID(),payload:{...command.payload,projectIds:['PRJ-999']}}});assert.equal(outside.status,409);
  const receipt=await f.request<CommandReceipt>(`${path}/${command.commandId}`);assert.equal(receipt.status,200);assert.deepEqual(receipt.body,first.body);
  assert.equal(f.receiver.requests.length,0);
  await f.pool.query("UPDATE memberships SET capabilities=array_remove(capabilities,'audit.read'),version=version+1 WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.actor.id]);
  assert.equal((await f.request(`${path}/${command.commandId}`)).status,403);
  assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/webhooks`)).status,403);
  assert.equal((await f.request(`/api/v1/workspaces/${randomUUID()}/webhooks`)).status,404);
});
test('paused endpoints retain new facts, activation excludes history, retired endpoints cannot restart', { skip: !webhookDatabaseUrl }, async t => {
  const f=await createWebhookFixture();t.after(()=>f.close());await f.task();
  const endpoint=await f.command<{endpointId:string;version:number}>('CreateWebhookEndpoint',{targetKey:'isolated_receiver',projectIds:[f.projectId],eventTypes:['pm.task.changed.v1']});await f.batch();assert.equal((await f.pool.query<{count:string}>('SELECT count(*)::text FROM webhook_deliveries')).rows[0]!.count,'0');
  await f.task();await f.batch();assert.equal(f.receiver.requests.length,0);assert.equal((await f.pool.query<{count:string}>('SELECT count(*)::text FROM webhook_deliveries')).rows[0]!.count,'1');
  const retired=await f.command<{version:number}>('SetWebhookEndpointState',{state:'retired'},{id:endpoint.endpointId,version:endpoint.version});
  assert.equal((await f.pool.query<{state:string}>('SELECT state FROM webhook_deliveries')).rows[0]!.state,'suppressed');
  const denied=await f.request<CommandReceipt>(`/api/v1/workspaces/${f.workspaceId}/commands`,{method:'POST',body:{commandId:randomUUID(),commandType:'SetWebhookEndpointState',targetId:endpoint.endpointId,expectedVersions:{[endpoint.endpointId]:retired.version},payload:{state:'enabled'}}});assert.equal(denied.status,409);assert.equal(denied.body.error?.code,'webhook_endpoint_retired');
  const overview=await f.request<WebhookOverview>(`/api/v1/workspaces/${f.workspaceId}/webhooks`);assert.equal(overview.body.endpoints[0]!.state,'retired');assert.equal(f.receiver.requests.length,0);
});
test('delivery pagination keeps every SQL-timestamp tie and binds its cursor to the current actor and endpoint', { skip: !webhookDatabaseUrl }, async t => {
  const f=await createWebhookFixture();t.after(()=>f.close());
  const endpoint=await f.command<{endpointId:string}>('CreateWebhookEndpoint',{targetKey:'isolated_receiver',projectIds:[f.projectId],eventTypes:['pm.task.changed.v1']});
  for(let i=0;i<5;i++) await f.task();
  await f.batch(); const ids=new Set<string>();let cursor:string|null=null;
  do {
    const path:string=`/api/v1/workspaces/${f.workspaceId}/webhooks/${endpoint.endpointId}/deliveries?limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;
    const page=await f.request<WebhookDeliveryPage>(path);assert.equal(page.status,200);for(const item of page.body.items){assert.ok(!ids.has(item.deliveryId));ids.add(item.deliveryId)}cursor=page.body.nextCursor;
  } while(cursor);
  assert.equal(ids.size,5);assert.equal(f.receiver.requests.length,0);
  const wrongActor=Buffer.from(JSON.stringify({actor:randomUUID(),workspace:f.workspaceId,endpoint:endpoint.endpointId,id:[...ids][0]})).toString('base64url');
  assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/webhooks/${endpoint.endpointId}/deliveries?cursor=${wrongActor}`)).status,400);
});
test('a deployment-approved but nonexistent core project is rejected by authoritative API validation', { skip: !webhookDatabaseUrl }, async t => {
  const f=await createWebhookFixture();t.after(()=>f.close());const target=f.config.targets[0]!;
  const manifest=join(f.root,'targets.json');
  await writeFile(manifest,JSON.stringify({schemaVersion:1,targets:[{targetKey:target.targetKey,workspaceId:f.workspaceId,projectIds:[f.projectId,'PRJ-999'],eventTypes:target.eventTypes,deliveryUrl:target.deliveryUrl,receiptBaseUrl:target.receiptBaseUrl,reconcileBaseUrl:target.reconcileBaseUrl,protocol:target.protocol,policyVersion:target.policyVersion,keyring:target.keyring}]}));
  Object.assign(f.config,readWebhookConfig({WEBHOOK_TARGETS_FILE:manifest}));assert.equal(f.config.status,'configured');
  const response=await f.request<CommandReceipt>(`/api/v1/workspaces/${f.workspaceId}/commands`,{method:'POST',body:{commandId:randomUUID(),commandType:'CreateWebhookEndpoint',payload:{targetKey:target.targetKey,projectIds:['PRJ-999'],eventTypes:['pm.task.changed.v1']}}});
  assert.equal(response.status,400);assert.equal(response.body.error?.code,'scope_mismatch');
  assert.equal((await f.pool.query<{count:string}>('SELECT count(*)::text FROM webhook_endpoints')).rows[0]!.count,'0');assert.equal(f.receiver.requests.length,0);
});
