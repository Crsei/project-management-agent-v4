import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError,type Actor } from '../../../packages/domain/src/core.ts';
import { readNotificationInbox,notificationInboxQuery } from '../../../packages/application/src/notifications.ts';
import { readMentionCandidates,mentionCandidatesQuery } from '../../../packages/application/src/notification-mentions.ts';
import { requireCapability } from '../../../packages/application/src/access.ts';
import type { NotificationCorePort } from '../../../packages/pm-core/readonly.ts';
import { requireDashboardReadSelf } from '../../../packages/application/src/dashboard-read.ts';
export function registerNotificationRoutes(app:FastifyInstance,options:{database:()=>Pool;actor:(request:FastifyRequest)=>Promise<Actor>;core:NotificationCorePort}):void {
 app.get<{Params:{workspaceId:string};Querystring:Record<string,unknown>}>('/api/v1/workspaces/:workspaceId/notification-inbox',async request=>{
  const workspaceId=z.uuid().toLowerCase().parse(request.params.workspaceId),actor=await options.actor(request);
  await requireDashboardReadSelf({sql:options.database(),actor,workspaceId});
  return readNotificationInbox(options.database(),actor,workspaceId,options.core,notificationInboxQuery.parse(request.query));
 });
 app.get<{Params:{workspaceId:string;taskId:string};Querystring:Record<string,unknown>}>('/api/v1/workspaces/:workspaceId/tasks/:taskId/mention-candidates',async request=>{
  const workspaceId=z.uuid().toLowerCase().parse(request.params.workspaceId),actor=await options.actor(request),query=mentionCandidatesQuery.parse(request.query);
  await requireCapability(options.database(),actor,workspaceId,'domain.read',query.projectId);
  const snapshot=await options.core.read(workspaceId),task=snapshot.files.find(file=>file.id===request.params.taskId);
  if(task?.entity.entity!=='work_item'||task.entity.project!==query.projectId) throw new DomainError('not_found_or_forbidden',undefined,404);
  return readMentionCandidates(options.database(),actor,workspaceId,query.projectId,query);
 });
 app.get<{Params:{workspaceId:string;projectId:string};Querystring:Record<string,unknown>}>('/api/v1/workspaces/:workspaceId/projects/:projectId/mention-candidates',async request=>{
  const workspaceId=z.uuid().toLowerCase().parse(request.params.workspaceId),actor=await options.actor(request);
  const query=mentionCandidatesQuery.parse({...request.query,projectId:request.params.projectId});
  await requireCapability(options.database(),actor,workspaceId,'domain.read',query.projectId);
  const snapshot=await options.core.read(workspaceId);
  if(!snapshot.files.some(file=>file.id===query.projectId&&file.entity.entity==='project')) throw new DomainError('not_found_or_forbidden',undefined,404);
  return readMentionCandidates(options.database(),actor,workspaceId,query.projectId,query);
 });
}
