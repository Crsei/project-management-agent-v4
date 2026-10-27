import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { NotificationInboxItem } from '../packages/domain/src/notifications.ts';
import { notificationInboxPageSchema } from '../packages/contracts/src/notifications.ts';
import { notificationItem,visibleNotifications } from '../apps/web/src/features/pm/service/notification-inbox-model.ts';
const initial={query:'',folder:'inbox' as const,unreadOnly:false,ordering:'newest' as const,unreadFirst:false};
function item(position:string,occurredAt:string|null,state:Partial<NotificationInboxItem['state']>={}):NotificationInboxItem {
 const eventId=randomUUID();return {cursor:position,event:{eventId,eventType:'WorkItem:content_changed',projectId:'PRJ-001',entityId:`TASK-${position}`,entityKind:'work_item',revision:'saved-revision',occurredAt,observedAt:'2026-10-22T00:00:00.000Z',recordedAt:'2026-10-23T00:00:00.000Z'},origin:'routed',target:{taskId:`TASK-${position}`},reasons:['watch','mention'],state:{eventId,version:1,readAt:null,archivedAt:null,...state}};
}
test('maps private CAS and merged reasons, not business revision, with truthful observation time',()=>{
 const source=item('99',null,{version:7});const mapped=notificationItem(source);
 assert.equal(mapped.version,'7');assert.equal(mapped.createdAt,source.event.observedAt);assert.match(mapped.title,/watch \+ mention/);
 const legacy={...source,origin:'legacy_activity' as const,target:null};assert.match(notificationItem(legacy).entityName,/Legacy/);
});
test('sorts by actual occurrence/observation time then numeric delivery cursor without mutating the snapshot',()=>{
 const old=item('9007199254740999','2026-10-21T00:00:00.000Z'),a=item('9',null),b=item('10',null),input=[old,b,a];
 assert.deepEqual(visibleNotifications(input,initial).map(row=>row.id),[b,a,old].map(row=>row.event.eventId));
 assert.deepEqual(visibleNotifications(input,{...initial,ordering:'oldest'}).map(row=>row.id),[old,a,b].map(row=>row.event.eventId));assert.equal(input[0],old);
});
test('unread-first, archive and search remain independent of delivery cursor and target identity',()=>{
 const read=item('1','2026-10-23T00:00:00.000Z',{readAt:'2026-10-23T01:00:00.000Z'}),unread=item('2',null),archived=item('3',null,{archivedAt:'2026-10-23T01:00:00.000Z'});
 for(const ordering of ['oldest','newest'] as const) assert.deepEqual(visibleNotifications([read,unread,archived],{...initial,ordering,unreadFirst:true}).map(row=>row.id),[unread,read].map(row=>row.event.eventId));
 assert.deepEqual(visibleNotifications([read,unread,archived],{...initial,folder:'archive',unreadOnly:true,query:'task-3'}).map(row=>row.id),[archived.event.eventId]);
});
test('strict DTO accepts legacy non-task null navigation and rejects copied bodies/recipient lists',()=>{
 const source=item('1',null),page={items:[source],cursor:'1',head:'1',membershipVersion:1,sourceCoverage:'selected_saved_facts',historyBoundary:{activatedAt:'2026-10-23T00:00:00.000Z',legacyImplicitUnreadNotImported:true},processing:{status:'pending',asOf:'2026-10-23T00:00:00.000Z'}};
 assert.equal(notificationInboxPageSchema.safeParse(page).success,true);
 assert.equal(notificationInboxPageSchema.safeParse({...page,items:[{...source,origin:'legacy_activity',target:null,event:{...source.event,entityKind:'private_note'}}]}).success,true);
 assert.equal(notificationInboxPageSchema.safeParse({...page,items:[{...source,event:{...source.event,body:'secret'}}]}).success,false);
 assert.equal(notificationInboxPageSchema.safeParse({...page,items:[{...source,recipientIds:[randomUUID()]}]}).success,false);
});
