export type NotificationState={eventId:string;version:number;readAt:string|null;archivedAt:string|null};
export type NotificationReason='watch'|'mention'|'legacy_activity_state';
export type NotificationOrigin='routed'|'legacy_activity';
export type NotificationInboxItem={cursor:string;event:{eventId:string;eventType:string;projectId:string|null;entityId:string;entityKind:string;revision:string|null;occurredAt:string|null;observedAt:string|null;recordedAt:string};origin:NotificationOrigin;target:{taskId:string;commentId?:string}|null;reasons:NotificationReason[];state:NotificationState};
export type NotificationInboxOptions={origin?:NotificationOrigin|undefined;after?:string|undefined;through?:string|undefined};
export type NotificationInboxPage={items:NotificationInboxItem[];cursor:string;head:string;membershipVersion:number;sourceCoverage:'selected_saved_facts';historyBoundary:{activatedAt:string;legacyImplicitUnreadNotImported:boolean};processing:{status:'current'|'pending'|'error';asOf:string}};
