import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fenceRestoredWebhooks } from '../packages/application/src/webhook-restore.ts';
import type { CommandReceipt } from '../packages/domain/src/core.ts';
import type { WebhookDeliveryDetail, WebhookOverview } from '../packages/domain/src/webhooks.ts';
import { createWebhookFixture, webhookDatabaseUrl } from './webhook-fixture.ts';

test('a stopped isolated restored destination preserves identities, fences new dispatch and only reconciles history', { skip: !webhookDatabaseUrl }, async t => {
  const f=await createWebhookFixture();t.after(()=>f.close());
  const e=await f.command<{endpointId:string;version:number}>('CreateWebhookEndpoint',{targetKey:'isolated_receiver',projectIds:[f.projectId],eventTypes:['pm.task.changed.v1']});await f.enable(e.endpointId,e.version);
  f.receiver.mode='lose_response';await f.task();await f.batch();
  const original=(await f.pool.query<{id:string;payload_sha256:string}>('SELECT id,payload_sha256 FROM webhook_deliveries')).rows[0]!;
  // This schema is the disposable stopped destination under test, never a source or user database.
  const sql=await f.pool.connect();try{await sql.query('BEGIN');await fenceRestoredWebhooks(sql);await sql.query('COMMIT')}catch(error){await sql.query('ROLLBACK');throw error}finally{sql.release()}
  const overview=await f.request<WebhookOverview>(`/api/v1/workspaces/${f.workspaceId}/webhooks`);assert.equal(overview.body.restoreFenced,true);assert.equal(overview.body.loopHealthy,false);
  const currentEndpoint=overview.body.endpoints[0]!;
  const reauthorized=await f.command<{version:number}>('ReauthorizeWebhookEndpoint',{}, {id:e.endpointId,version:currentEndpoint.version});
  const enable=await f.request<CommandReceipt>(`/api/v1/workspaces/${f.workspaceId}/commands`,{method:'POST',body:{commandId:randomUUID(),commandType:'SetWebhookEndpointState',targetId:e.endpointId,expectedVersions:{[e.endpointId]:reauthorized.version},payload:{state:'enabled'}}});assert.equal(enable.body.error?.code,'webhook_restore_alignment_required');
  const create=await f.request<CommandReceipt>(`/api/v1/workspaces/${f.workspaceId}/commands`,{method:'POST',body:{commandId:randomUUID(),commandType:'CreateWebhookEndpoint',payload:{targetKey:'isolated_receiver',projectIds:[f.projectId],eventTypes:['pm.task.changed.v1']}}});assert.equal(create.body.error?.code,'webhook_restore_alignment_required');
  await f.task();await f.batch();assert.equal((await f.pool.query<{count:string}>('SELECT count(*)::text FROM webhook_deliveries')).rows[0]!.count,'1');
  const d=(await f.pool.query<{id:string;version:number}>('SELECT id,version FROM webhook_deliveries')).rows[0]!;await f.command('ReconcileWebhookDelivery',{},d);f.receiver.mode='accept';await f.batch();
  const detail=await f.request<WebhookDeliveryDetail>(`/api/v1/workspaces/${f.workspaceId}/webhook-deliveries/${original.id}`);assert.equal(detail.body.state,'accepted');assert.equal(detail.body.deliveryId,original.id);
  assert.equal((await f.pool.query<{payload_sha256:string}>('SELECT payload_sha256 FROM webhook_deliveries')).rows[0]!.payload_sha256,original.payload_sha256);assert.equal(f.receiver.requests.filter(r=>r.path==='/deliver').length,1);
  assert.equal((await f.request<WebhookOverview>(`/api/v1/workspaces/${f.workspaceId}/webhooks`)).body.restoreFenced,true);
});
