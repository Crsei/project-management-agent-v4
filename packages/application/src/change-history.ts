import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { changeHistoryTargetSchema, type ChangeHistoryTarget, type ChangeSnapshot, type ChangeSummary, type ChangeHistoryQuery, type ChangeHistoryPage, type ChangeDetail, type ChangeCompareInput, type ChangeComparison, type ChangeAcknowledgeInput, type ChangeAcknowledgement, type TaskAttentionQuery, type TaskAttentionPage } from '../../contracts/src/change-history.ts';
import type { ReadonlyCoreSnapshot } from '../../pm-core/readonly.ts';
import type { FileRecord } from '../../pm-schema/index.ts';
import { assertProjectScope, getMembership, type Membership } from './access.ts';
import type { SqlExecutor } from './ports.ts';
import type { ExternalDocumentHistoryAddress, ExternalDocumentHistoryCapture } from './external-document-history.ts';

export const capturedChangeSchema = z.strictObject({ target: changeHistoryTargetSchema, entityKind: z.string(), projectId: z.string().nullable(), beforeKey: z.string().regex(/^[a-f0-9]{64}$/).nullable(), afterKey: z.string().regex(/^[a-f0-9]{64}$/).nullable(), completeness: z.enum(['exact','observed_endpoints','baseline','missing_before']), origin: z.enum(['manual','agent','automation','observation']), actorId: z.uuid().nullable(), changedFields: z.array(z.string()) });
export type CapturedChange = z.infer<typeof capturedChangeSchema>;
export type HistorySnapshotReader = (key: string) => ChangeSnapshot;
export function changedSnapshotFields(before: ChangeSnapshot|null, after: ChangeSnapshot|null): string[] {
 if(before?.metadata===null||after?.metadata===null)return [];
 return [...new Set([...Object.keys(before?.metadata??{}),...Object.keys(after?.metadata??{})])].filter(key=>JSON.stringify(before?.metadata?.[key])!==JSON.stringify(after?.metadata?.[key])).sort();
}
export const historyTargetKey = (target: ChangeHistoryTarget): string => target.kind==='core'?`core:${target.entityId}`:`external:${JSON.stringify([target.sourceId,target.path])}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Write = Omit<CapturedChange,'beforeKey'|'afterKey'> & { before:ChangeSnapshot|null; after:ChangeSnapshot|null; changeId:string; sourceKey:string; changeKinds:string[]; observedAt:string; occurredAt:string|null; streamKey?:string; sourceDigest?:string; beforeAddress?:ExternalDocumentHistoryAddress|null; afterAddress?:ExternalDocumentHistoryAddress|null };
/** Caller owns the workspace authorization lock and transaction. */
export async function insertChangeHistory(sql:SqlExecutor,workspaceId:string,value:Write):Promise<void> {
 const hash=value.sourceDigest??digest(value),prior=await sql.query<{source_digest:string}>('SELECT source_digest FROM change_history_entries WHERE workspace_id=$1 AND source_key=$2',[workspaceId,value.sourceKey]);
 if(prior.rows[0]) {if(prior.rows[0].source_digest!==hash)throw new DomainError('history_idempotency_conflict',undefined,409);return;}
 const key=value.streamKey??historyTargetKey(value.target);
 await sql.query(`INSERT INTO change_history_streams(workspace_id,stream_key,target,address) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT DO NOTHING`,[workspaceId,key,JSON.stringify(value.target),JSON.stringify(value.afterAddress??value.beforeAddress??null)]);
 const head=await sql.query<{head:string}>('UPDATE workspaces SET change_history_head=change_history_head+1 WHERE id=$1 RETURNING change_history_head::text AS head',[workspaceId]);
 if(!head.rows[0])throw new DomainError('not_found_or_forbidden',undefined,404);
 await sql.query(`INSERT INTO change_history_entries(workspace_id,change_id,sequence,stream_key,source_key,source_digest,target,entity_kind,project_id,change_kinds,changed_fields,origin,actor_id,occurred_at,observed_at,completeness,before_snapshot,after_snapshot,before_address,after_address,before_revision,after_revision,before_project)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23)`,[workspaceId,value.changeId,head.rows[0].head,key,value.sourceKey,hash,JSON.stringify(value.target),value.entityKind,value.projectId,value.changeKinds,value.changedFields,value.origin,value.actorId,value.occurredAt,value.observedAt,value.completeness,JSON.stringify(value.before),JSON.stringify(value.after),JSON.stringify(value.beforeAddress??null),JSON.stringify(value.afterAddress??null),value.before?.revision??null,value.after?.revision??null,typeof value.before?.metadata?.project==='string'?value.before.metadata.project:null]);
}
function unavailableHistoricalAlias(error: unknown): boolean {
 if (!(error instanceof DomainError)) return false;
 // A replaced historical root cannot authorize an alias of a newly registered root.
 // Other availability failures remain errors: do not silently split a valid stream.
 return [403, 404].includes(error.status) || (error.code === 'document_source_unavailable'
  && (error.details as { reason?: string } | undefined)?.reason === 'directory_identity_changed');
}
export async function recordExternalDocumentHistory(sql:SqlExecutor,capture:ExternalDocumentHistoryCapture,resolveAddress?:(expected:ExternalDocumentHistoryAddress)=>Promise<ExternalDocumentHistoryAddress>):Promise<void> {
 const controlled=capture.action!=='observe';
 if(controlled)await sql.query('BEGIN');
 try {
 const operationKey=capture.operationId?`external-operation:${capture.actorId}:${capture.operationId}`:null;
 if(operationKey) {
  const prior=await sql.query<{source_digest:string}>('SELECT source_digest FROM change_history_entries WHERE workspace_id=$1 AND source_key=$2',[capture.workspaceId,operationKey]);
  if(prior.rows[0]) {
   if(prior.rows[0].source_digest!==digest(capture))throw new DomainError('history_idempotency_conflict',undefined,409);
   if(controlled)await sql.query('COMMIT');
   return;
  }
 }
 const address=capture.target??capture.source,target:ChangeHistoryTarget={kind:'external',sourceId:address.sourceId,path:address.path};
 const alias=(a:ExternalDocumentHistoryAddress)=>`${a.rootIdentity}:${a.locationKey}`;
 const found=await sql.query<{stream_key:string;address:ExternalDocumentHistoryAddress}>('SELECT s.stream_key,s.address FROM change_history_aliases a JOIN change_history_streams s USING(workspace_id,stream_key) WHERE a.workspace_id=$1 AND a.alias_key=$2',[capture.workspaceId,alias(capture.source)]);
 let prior=found.rows[0];
 if(!prior&&resolveAddress) {
  const candidates=await sql.query<{stream_key:string;address:ExternalDocumentHistoryAddress;original:ExternalDocumentHistoryAddress}>(`SELECT s.stream_key,s.address,a.address AS original FROM change_history_aliases a JOIN change_history_streams s USING(workspace_id,stream_key) WHERE a.workspace_id=$1 AND a.address->>'locationKey'=$2 LIMIT 100`,[capture.workspaceId,capture.source.locationKey]);
  for(const candidate of candidates.rows) {
   try {await resolveAddress(candidate.original);prior=candidate;break;}
   catch(error){if(!unavailableHistoricalAlias(error))throw error;}
  }
 }
 const continued=prior?.address.locationKey===capture.source.locationKey;
 const streamKey=continued?prior!.stream_key:`external-stream:${digest([capture.workspaceId,alias(capture.source),capture.observedAt])}`;
 const last=await sql.query<{after_snapshot:ChangeSnapshot|null}>('SELECT after_snapshot FROM change_history_entries WHERE workspace_id=$1 AND stream_key=$2 ORDER BY sequence DESC LIMIT 1',[capture.workspaceId,streamKey]);
 const snapshot=(v:{content:string;revision:string}|null):ChangeSnapshot|null=>v?{revision:v.revision,body:v.content,raw:v.content,metadata:{}}:null;
 const after=snapshot(capture.after),before=capture.action==='observe'?last.rows[0]?.after_snapshot??null:snapshot(capture.before);
 const baseline=capture.action==='observe'&&!last.rows.length;
 // A repeated observation is not a save and does not invent intermediate edits.
 if(capture.action==='observe'&&last.rows.length&&before?.raw===after?.raw)return;
 const sourceKey=operationKey??`external-observation:${digest([streamKey,before?.revision??null,after?.revision??null,capture.observedAt])}`;
 const changeId=randomUUID();
 const changedFields=capture.action==='move'?[...(capture.source.path!==address.path?['path']:[]),...(capture.source.sourceId!==address.sourceId?['sourceId']:[])]:[];
 const changeKinds=baseline?[]:capture.action==='create'?['created']:capture.action==='delete'?['lifecycle_changed']:capture.action==='move'?['metadata_changed']:before?.raw!==after?.raw?['content_changed']:[];
 // The protected receipt proves exact bytes, not an exact filesystem commit timestamp.
 await insertChangeHistory(sql,capture.workspaceId,{changeId,sourceKey,sourceDigest:digest(capture),streamKey,target,entityKind:'external_document',projectId:address.projectId,before,after,changedFields,changeKinds,completeness:baseline?'baseline':capture.action==='observe'?'observed_endpoints':'exact',origin:capture.action==='observe'?'observation':'manual',actorId:capture.action==='observe'?null:capture.actorId,observedAt:capture.observedAt,occurredAt:null,beforeAddress:capture.source,afterAddress:address});
 for(const a of [capture.source,address])await sql.query(`INSERT INTO change_history_aliases(workspace_id,alias_key,stream_key,address) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(workspace_id,alias_key) DO UPDATE SET stream_key=excluded.stream_key,address=excluded.address`,[capture.workspaceId,alias(a),streamKey,JSON.stringify(a)]);
 await sql.query('UPDATE change_history_streams SET target=$3::jsonb,address=$4::jsonb WHERE workspace_id=$1 AND stream_key=$2',[capture.workspaceId,streamKey,JSON.stringify(target),JSON.stringify(address)]);
 if(controlled)await sql.query('COMMIT');
 }catch(error){if(controlled)await sql.query('ROLLBACK');throw error;}
}

type MetadataRow={change_id:string;sequence:string;stream_key:string;target:ChangeHistoryTarget;entity_kind:string;project_id:string|null;change_kinds:string[];changed_fields:string[];origin:ChangeSummary['origin'];actor_id:string|null;occurred_at:Date|null;observed_at:Date;completeness:ChangeSummary['completeness'];before_revision:string|null;after_revision:string|null;before_project:string|null;before_address:ExternalDocumentHistoryAddress|null;after_address:ExternalDocumentHistoryAddress|null};
type Row=MetadataRow&{before_snapshot:ChangeSnapshot|null;after_snapshot:ChangeSnapshot|null};
const metadataColumns='change_id,sequence::text,stream_key,target,entity_kind,project_id,change_kinds,changed_fields,origin,actor_id,occurred_at,observed_at,completeness,before_revision,after_revision,before_project,before_address,after_address';
const columns=`${metadataColumns},before_snapshot,after_snapshot`;
type CoreHistoryIndex={files:Map<string,FileRecord>;backlinks:Map<string,FileRecord[]>};
export type ChangeHistoryContext={sql:SqlExecutor;actor:Actor;workspaceId:string;snapshot:ReadonlyCoreSnapshot;authorizeExternal:(target:Extract<ChangeHistoryTarget,{kind:'external'}>)=>Promise<ExternalDocumentHistoryAddress>;resolveExternal:(expected:ExternalDocumentHistoryAddress)=>Promise<ExternalDocumentHistoryAddress>;coreIndex?:CoreHistoryIndex};
type Scope={stream:string;cursorKey:string;relation:ChangeSummary['relation'];projectId:string|null;authorizationKey?:string};
function coreIndex(ctx:ChangeHistoryContext):CoreHistoryIndex {
 if(ctx.coreIndex)return ctx.coreIndex;
 const files=new Map(ctx.snapshot.files.map(file=>[file.id,file])),backlinks=new Map<string,FileRecord[]>();
 for(const file of ctx.snapshot.files)if(['requirement','document'].includes(file.entity.entity))for(const id of file.entity.related_to) {
  const values=backlinks.get(id)??[];values.push(file);backlinks.set(id,values);
 }
 ctx.coreIndex={files,backlinks};return ctx.coreIndex;
}
function scopeAllowed(member:Membership,projectId:string|null):boolean {return member.projectIds===null||!!projectId&&member.projectIds.includes(projectId);}
async function memberFor(ctx:ChangeHistoryContext):Promise<Membership> {const member=await getMembership(ctx.sql,ctx.actor,ctx.workspaceId);if(!member.capabilities.includes('domain.read'))throw new DomainError('permission_denied',undefined,403);return member;}
async function resolve(ctx:ChangeHistoryContext,target:ChangeHistoryTarget,related:boolean,member:Membership):Promise<Scope[]> {
 const key=historyTargetKey(target);
 if(target.kind==='external') {
  const address=await ctx.authorizeExternal(target),alias=`${address.rootIdentity}:${address.locationKey}`;
  const stream=await ctx.sql.query<{stream_key:string;address:ExternalDocumentHistoryAddress}>('SELECT s.stream_key,s.address FROM change_history_aliases a JOIN change_history_streams s USING(workspace_id,stream_key) WHERE a.workspace_id=$1 AND a.alias_key=$2',[ctx.workspaceId,alias]);
  let row=stream.rows[0];
  if(!row) {
   const candidates=await ctx.sql.query<{stream_key:string;address:ExternalDocumentHistoryAddress;original:ExternalDocumentHistoryAddress}>(`SELECT s.stream_key,s.address,a.address AS original FROM change_history_aliases a JOIN change_history_streams s USING(workspace_id,stream_key) WHERE a.workspace_id=$1 AND a.address->>'locationKey'=$2 LIMIT 100`,[ctx.workspaceId,address.locationKey]);
   for(const candidate of candidates.rows) {
    try {await ctx.resolveExternal(candidate.original);row=candidate;break;}
    catch(error){if(!unavailableHistoricalAlias(error))throw error;}
   }
  }
  const current=row?await ctx.resolveExternal(row.address):address;
  return [{stream:row?.stream_key??`absent:${alias}`,cursorKey:row?.stream_key??key,relation:'self',projectId:address.projectId,authorizationKey:digest([address.rootIdentity,address.sourceRevision,address.locationKey,current.locationKey])}];
 }
 const index=coreIndex(ctx),file=index.files.get(target.entityId);
 if(!file||file.stale)throw new DomainError('not_found_or_forbidden',undefined,404);
 const projectId=file.entity.entity==='project'?file.id:file.entity.project??null;assertProjectScope(member,projectId);
 const result:Scope[]=[{stream:key,cursorKey:key,relation:'self',projectId}];
 if(related&&file.entity.entity==='work_item') {
  const ids=new Set([...(file.entity.requirement?[file.entity.requirement]:[]),...file.entity.related_to,...(index.backlinks.get(file.id)??[]).map(other=>other.id)]);
  for(const id of ids) {
   const other=index.files.get(id);
   if(other&&['requirement','document'].includes(other.entity.entity)&&!other.stale&&scopeAllowed(member,other.entity.project??null))result.push({stream:`core:${other.id}`,cursorKey:`${key}:related:${other.id}`,relation:other.entity.entity==='requirement'?'related_requirement':'related_document',projectId:other.entity.project??null});
  }
 }
 return result.sort((a,b)=>a.stream.localeCompare(b.stream));
}
async function readableRow(ctx:ChangeHistoryContext,row:MetadataRow,member:Membership):Promise<boolean> {
 if(row.target.kind==='core'&&!scopeAllowed(member,row.project_id))return false;
 if(row.target.kind==='core') {
  const file=coreIndex(ctx).files.get(row.target.entityId);if(!file||file.stale||!scopeAllowed(member,file.entity.entity==='project'?file.id:file.entity.project??null))return false;
  if(row.before_project&&!scopeAllowed(member,row.before_project))return false;
 } else {
  for(const address of [row.before_address,row.after_address])if(address) {
   try {const authorized=await ctx.resolveExternal(address);row.target={kind:'external',sourceId:authorized.sourceId,path:authorized.path};row.project_id=authorized.projectId;}
   catch(error){if(error instanceof DomainError&&(error.status===403||error.status===404))return false;throw error;}
  }
 }
 return true;
}
function summary(row:MetadataRow,relation:ChangeSummary['relation']='self'):ChangeSummary {return {changeId:row.change_id,sequence:row.sequence,target:row.target,entityKind:row.entity_kind,projectId:row.project_id,changeKinds:row.change_kinds,changedFields:row.changed_fields,origin:row.origin,actorId:row.actor_id,occurredAt:row.occurred_at?.toISOString()??null,observedAt:row.observed_at.toISOString(),beforeRevision:row.before_revision,afterRevision:row.after_revision,completeness:row.completeness,relation};}
async function cursors(ctx:ChangeHistoryContext,scopes:Scope[]):Promise<Map<string,string>> {const rows=await ctx.sql.query<{target_key:string;reviewed_through:string}>('SELECT target_key,reviewed_through::text FROM change_history_cursors WHERE workspace_id=$1 AND actor_id=$2 AND target_key=ANY($3::text[])',[ctx.workspaceId,ctx.actor.id,scopes.map(s=>s.cursorKey)]);return new Map(rows.rows.map(r=>[r.target_key,r.reviewed_through]));}
type ExternalBinding={before_address:ExternalDocumentHistoryAddress|null;after_address:ExternalDocumentHistoryAddress|null};
type HistoryStatistics={head:string;pending:number;reviewed:string;completeness:ChangeHistoryPage['completeness'];authorizationDigest:string|null;visibleBindings:ExternalBinding[]|null};
async function statistics(ctx:ChangeHistoryContext,scopes:Scope[],member:Membership,through?:string):Promise<HistoryStatistics> {
 if(scopes[0]?.stream.startsWith('external-stream:')||scopes[0]?.stream.startsWith('absent:')) {
  const positions=await cursors(ctx,scopes),scope=scopes[0]!,reviewed=positions.get(scope.cursorKey)??'0';
  const groups=await ctx.sql.query<{before_address:ExternalDocumentHistoryAddress|null;after_address:ExternalDocumentHistoryAddress|null;head:string;pending:number;gap:boolean;baseline:boolean}>(`SELECT before_address,after_address,max(sequence)::text AS head,count(*) FILTER(WHERE completeness<>'baseline' AND sequence>$3::bigint)::int AS pending,bool_or(completeness IN ('observed_endpoints','missing_before')) AS gap,bool_or(completeness='baseline') AS baseline FROM change_history_entries WHERE workspace_id=$1 AND stream_key=$2 AND ($4::bigint IS NULL OR sequence<=$4) GROUP BY before_address,after_address LIMIT 101`,[ctx.workspaceId,scope.stream,reviewed,through??null]);
  if(groups.rows.length>100)throw new DomainError('history_authorization_window_exceeded','Too many distinct retained source bindings for a bounded history read',503);
  let head=0n,pending=0,gap=false,baseline=false;
  const bindings=new Set<string>(),cache=new Map<string,ExternalDocumentHistoryAddress|null>(),visibleBindings:ExternalBinding[]=[];
  for(const group of groups.rows) {
   let visible=true;
   const resolved:string[]=[];
   for(const address of [group.before_address,group.after_address])if(address) {
    const key=digest(address);let allowed=cache.get(key);
    if(allowed===undefined) {
     try {allowed=await ctx.resolveExternal(address);}
     catch(error){if(!(error instanceof DomainError)||![403,404].includes(error.status))throw error;allowed=null;}
     cache.set(key,allowed);
    }
    if(!allowed){visible=false;break;}resolved.push(allowed.locationKey);
   }
   if(!visible){gap=true;continue;}
   visibleBindings.push({before_address:group.before_address,after_address:group.after_address});
   bindings.add(resolved.join(':'));head=BigInt(group.head)>head?BigInt(group.head):head;pending+=group.pending;gap||=group.gap;baseline||=group.baseline;
  }
  return {head:head.toString(),pending,reviewed,completeness:gap?'observer_gap':baseline||head===0n?'baseline_gap':'complete_since_capture',authorizationDigest:digest([...bindings].sort()),visibleBindings};
 }
 const requested=scopes.map(scope=>({...scope,revision:coreIndex(ctx).files.get(scope.stream.slice(5))?.revision??null}));
 const result=await ctx.sql.query<{head:string;pending:number;reviewed:string;gap:boolean;baseline:boolean}>(`WITH requested AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(stream text,"cursorKey" text,revision text)
 ) SELECT coalesce(max(e.sequence),0)::text AS head,
 count(e.change_id) FILTER(WHERE e.completeness<>'baseline' AND e.sequence>coalesce(c.reviewed_through,0))::int AS pending,
 coalesce(min(coalesce(c.reviewed_through,0)),0)::text AS reviewed,
 coalesce(bool_or(e.completeness IN ('missing_before','observed_endpoints') OR x.revision IS DISTINCT FROM latest.revision),true) AS gap,
 coalesce(bool_or(e.completeness='baseline'),false) AS baseline
 FROM requested x LEFT JOIN change_history_cursors c ON c.workspace_id=$1 AND c.actor_id=$2 AND c.target_key=x."cursorKey"
 LEFT JOIN LATERAL(SELECT after_revision AS revision FROM change_history_entries WHERE workspace_id=$1 AND stream_key=x.stream ORDER BY sequence DESC LIMIT 1) latest ON true
 LEFT JOIN change_history_entries e ON e.workspace_id=$1 AND e.stream_key=x.stream AND ($4::bigint IS NULL OR e.sequence<=$4)
 AND ($5::text[] IS NULL OR (e.project_id=ANY($5) AND (e.before_project IS NULL OR e.before_project=ANY($5))))`,[ctx.workspaceId,ctx.actor.id,JSON.stringify(requested),through??null,member.projectIds]);
 const row=result.rows[0]!;
 return {head:row.head,pending:row.pending,reviewed:row.reviewed,completeness:row.gap?'observer_gap':row.baseline||row.head==='0'?'baseline_gap':'complete_since_capture',authorizationDigest:null,visibleBindings:null};
}
/** Shared SQL boundary for metadata pages and bounded content endpoints; parameter numbers are internal constants. */
function historyReadScope(bindingsParameter:number,projectsParameter:number):string {
 return `($${bindingsParameter}::jsonb IS NULL OR EXISTS (
 SELECT 1 FROM jsonb_to_recordset($${bindingsParameter}::jsonb) AS allowed(before_address jsonb,after_address jsonb)
 WHERE coalesce(e.before_address,'null'::jsonb)=coalesce(allowed.before_address,'null'::jsonb)
 AND coalesce(e.after_address,'null'::jsonb)=coalesce(allowed.after_address,'null'::jsonb)))
 AND ($${projectsParameter}::text[] IS NULL OR e.target->>'kind'='external' OR
 (e.project_id=ANY($${projectsParameter}::text[]) AND (e.before_project IS NULL OR e.before_project=ANY($${projectsParameter}::text[]))))`;
}
export async function readChangeHistory(ctx:ChangeHistoryContext,input:ChangeHistoryQuery):Promise<ChangeHistoryPage> {
 const member=await memberFor(ctx),scopes=await resolve(ctx,input.target,input.includeRelated??true,member),stats=await statistics(ctx,scopes,member);
 const head=input.head??stats.head;if(BigInt(head)>BigInt(stats.head)||input.cursor&&BigInt(input.cursor)>BigInt(head))throw new DomainError('invalid_cursor',undefined,409);
 if(input.head&&input.head!==stats.head) {
  const issued=await ctx.sql.query('SELECT 1 FROM change_history_observations WHERE workspace_id=$1 AND actor_id=$2 AND target_key=$3 AND through_sequence=$4::bigint AND includes_related=$5 AND scope_digest=$6 LIMIT 1',[ctx.workspaceId,ctx.actor.id,historyTargetKey(input.target),head,input.includeRelated??true,digest([member.version,scopes,stats.authorizationDigest])]);
  if(!issued.rows.length)throw new DomainError('unobserved_history_head','The bounded head was not issued for this current source scope',409);
 }
 const limit=input.limit??50,result=await ctx.sql.query<MetadataRow>(`SELECT ${metadataColumns} FROM change_history_entries e WHERE workspace_id=$1 AND stream_key=ANY($2::text[]) AND sequence<=$3::bigint AND ($4::bigint IS NULL OR sequence<$4::bigint) AND ${historyReadScope(6,7)} ORDER BY e.sequence DESC LIMIT $5`,[ctx.workspaceId,scopes.map(s=>s.stream),head,input.cursor??null,limit,stats.visibleBindings===null?null:JSON.stringify(stats.visibleBindings),member.projectIds]);
 const items:ChangeSummary[]=[];for(const row of result.rows)if(await readableRow(ctx,row,member))items.push(summary(row,scopes.find(s=>s.stream===row.stream_key)!.relation));
 const token=randomUUID();
 await ctx.sql.query(`DELETE FROM change_history_observations WHERE token IN(SELECT token FROM change_history_observations WHERE workspace_id=$1 AND actor_id=$2 AND created_at<clock_timestamp()-interval '7 days' ORDER BY created_at LIMIT 1000)`,[ctx.workspaceId,ctx.actor.id]);
 await ctx.sql.query('INSERT INTO change_history_observations(token,workspace_id,actor_id,target_key,through_sequence,includes_related,scope_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',[token,ctx.workspaceId,ctx.actor.id,historyTargetKey(input.target),head,input.includeRelated??true,digest([member.version,scopes,stats.authorizationDigest])]);
 const bounded=await statistics(ctx,scopes,member,head);
 return {items,head,nextCursor:result.rows.length===limit?result.rows.at(-1)!.sequence:null,reviewedThrough:bounded.reviewed,pendingCount:bounded.pending,observationToken:token,completeness:bounded.completeness};
}
export async function readChangeDetail(ctx:ChangeHistoryContext,changeId:string):Promise<ChangeDetail> {
 const member=await memberFor(ctx),result=await ctx.sql.query<MetadataRow>(`SELECT ${metadataColumns} FROM change_history_entries WHERE workspace_id=$1 AND change_id=$2`,[ctx.workspaceId,changeId]),row=result.rows[0];
 if(!row||!await readableRow(ctx,row,member))throw new DomainError('not_found_or_forbidden',undefined,404);
 if(row.target.kind==='core')await resolve(ctx,row.target,false,member);
 else {
  const stream=await ctx.sql.query<{address:ExternalDocumentHistoryAddress}>('SELECT address FROM change_history_streams WHERE workspace_id=$1 AND stream_key=$2',[ctx.workspaceId,row.stream_key]);
  if(!stream.rows[0])throw new DomainError('not_found_or_forbidden',undefined,404);
  await ctx.resolveExternal(stream.rows[0].address);
 }
 const content=await ctx.sql.query<{before_snapshot:ChangeSnapshot|null;after_snapshot:ChangeSnapshot|null}>('SELECT before_snapshot,after_snapshot FROM change_history_entries WHERE workspace_id=$1 AND change_id=$2',[ctx.workspaceId,changeId]);
 const snapshots=content.rows[0];if(!snapshots)throw new DomainError('not_found_or_forbidden',undefined,404);
 return {change:summary(row),before:snapshots.before_snapshot,after:snapshots.after_snapshot};
}
export async function compareChangeHistory(ctx:ChangeHistoryContext,input:ChangeCompareInput):Promise<ChangeComparison> {
 const member=await memberFor(ctx),scopes=await resolve(ctx,input.target,false,member),scope=scopes[0]!,positions=await cursors(ctx,scopes),reviewed=positions.get(scope.cursorKey)??'0';
 const visibility=await statistics(ctx,scopes,member),bindings=visibility.visibleBindings===null?null:JSON.stringify(visibility.visibleBindings);
 if(input.through!==undefined) {
  const bound=await ctx.sql.query<{head:string}>('SELECT change_history_head::text AS head FROM workspaces WHERE id=$1',[ctx.workspaceId]);
  if(!bound.rows[0]||BigInt(input.through)>BigInt(bound.rows[0].head))throw new DomainError('invalid_history_endpoint',undefined,409);
 }
 const toResult=await ctx.sql.query<Row>(`SELECT ${columns} FROM change_history_entries e WHERE workspace_id=$1 AND stream_key=$2 AND ($3::uuid IS NULL OR change_id=$3) AND ($4::bigint IS NULL OR sequence<=$4::bigint) AND ${historyReadScope(5,6)} ORDER BY e.sequence DESC LIMIT 1`,[ctx.workspaceId,scope.stream,input.toChangeId??null,input.through??null,bindings,member.projectIds]);
 const to=toResult.rows[0];
 if(input.toChangeId&&!to)throw new DomainError('invalid_history_endpoint',undefined,409);
 const fromResult=input.fromChangeId===null?{rows:[]}:await ctx.sql.query<Row>(`SELECT ${columns} FROM change_history_entries e WHERE workspace_id=$1 AND stream_key=$2 AND (($3::uuid IS NOT NULL AND change_id=$3) OR ($3::uuid IS NULL AND sequence<=$4::bigint AND sequence<=$5::bigint)) AND ${historyReadScope(6,7)} ORDER BY e.sequence DESC LIMIT 1`,[ctx.workspaceId,scope.stream,input.fromChangeId??null,reviewed,to?.sequence??'0',bindings,member.projectIds]);
 const from=fromResult.rows[0];
 if(input.fromChangeId&&!from||from&&to&&BigInt(from.sequence)>BigInt(to.sequence))throw new DomainError('invalid_history_endpoint',undefined,409);
 for(const endpoint of [from,to])if(endpoint&&!await readableRow(ctx,endpoint,member))throw new DomainError('not_found_or_forbidden',undefined,404);
 const firstResult=await ctx.sql.query<Row>(`SELECT ${columns} FROM change_history_entries e WHERE workspace_id=$1 AND stream_key=$2 AND sequence>$3::bigint AND sequence<=$4::bigint AND ${historyReadScope(5,6)} ORDER BY e.sequence LIMIT 1`,[ctx.workspaceId,scope.stream,from?.sequence??'0',to?.sequence??'0',bindings,member.projectIds]);
 const first=firstResult.rows[0];
 if(first&&!await readableRow(ctx,first,member))throw new DomainError('not_found_or_forbidden',undefined,404);
 const continuity=await ctx.sql.query<{gap:boolean;observed:boolean;baseline:boolean}>(`WITH endpoints AS (
 SELECT completeness,before_revision,lag(after_revision,1,$5::text) OVER(ORDER BY sequence) AS previous_revision,NOT(${historyReadScope(6,7)}) AS hidden
 FROM change_history_entries e WHERE workspace_id=$1 AND stream_key=$2 AND sequence>$3::bigint AND sequence<=$4::bigint
 ) SELECT coalesce(bool_or(hidden OR completeness='missing_before' OR before_revision IS DISTINCT FROM previous_revision),false) AS gap,
 coalesce(bool_or(completeness='observed_endpoints'),false) AS observed,coalesce(bool_or(completeness='baseline'),false) AS baseline FROM endpoints`,[ctx.workspaceId,scope.stream,from?.sequence??'0',to?.sequence??'0',from?.after_snapshot?.revision??first?.before_snapshot?.revision??null,bindings,member.projectIds]);
 const state=continuity.rows[0]!;
 return {target:input.target,before:from?.after_snapshot??first?.before_snapshot??null,after:to?.after_snapshot??null,fromChangeId:from?.change_id??null,toChangeId:to?.change_id??null,head:to?.sequence??'0',completeness:!to||state.gap?'missing_before':state.observed?'observed_endpoints':state.baseline?'baseline':'exact'};
}
export async function acknowledgeChangeHistory(ctx:ChangeHistoryContext,input:ChangeAcknowledgeInput):Promise<ChangeAcknowledgement> {
 const member=await memberFor(ctx),grant=await ctx.sql.query<{through_sequence:string;includes_related:boolean;scope_digest:string}>('SELECT through_sequence::text,includes_related,scope_digest FROM change_history_observations WHERE token=$1 AND workspace_id=$2 AND actor_id=$3 AND target_key=$4',[input.observationToken,ctx.workspaceId,ctx.actor.id,historyTargetKey(input.target)]),seen=grant.rows[0];
 if(!seen||seen.through_sequence!==input.through)throw new DomainError('unobserved_history_head',undefined,409);
 const scopes=await resolve(ctx,input.target,seen.includes_related,member);
 const current=await statistics(ctx,scopes,member);
 if(digest([member.version,scopes,current.authorizationDigest])!==seen.scope_digest)throw new DomainError('history_scope_changed','Read the current related sources before acknowledging',409);
 for(const scope of scopes)await ctx.sql.query(`INSERT INTO change_history_cursors(workspace_id,actor_id,target_key,reviewed_through) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,actor_id,target_key) DO UPDATE SET reviewed_through=greatest(change_history_cursors.reviewed_through,excluded.reviewed_through)`,[ctx.workspaceId,ctx.actor.id,scope.cursorKey,input.through]);
 const stats=await statistics(ctx,await resolve(ctx,input.target,true,member),member);return {reviewedThrough:stats.reviewed,head:stats.head,pendingCount:stats.pending};
}
export async function readTaskAttention(ctx:ChangeHistoryContext,input:TaskAttentionQuery):Promise<TaskAttentionPage> {
 const member=await memberFor(ctx),tasks=ctx.snapshot.files.filter(f=>f.entity.entity==='work_item'&&!f.stale&&scopeAllowed(member,f.entity.project??null)&&(!input.projectId||f.entity.project===input.projectId)&&(!input.taskIds||input.taskIds.includes(f.id))&&(!input.afterTaskId||f.id>input.afterTaskId)).sort((a,b)=>a.id.localeCompare(b.id));
 const selected=tasks.slice(0,500),maps:{taskId:string;stream:string;cursor:string;related:boolean}[]=[];
 for(const task of selected)for(const scope of await resolve(ctx,{kind:'core',entityId:task.id},true,member))maps.push({taskId:task.id,stream:scope.stream,cursor:scope.cursorKey,related:scope.relation!=='self'});
 const result=await ctx.sql.query<{task_id:string;head:string;reviewed:string;own:number;related:number}>(`WITH requested AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x("taskId" text,stream text,cursor text,related boolean))
 SELECT x."taskId" AS task_id,coalesce(max(e.sequence),0)::text AS head,min(coalesce(c.reviewed_through,0))::text AS reviewed,
 count(e.change_id) FILTER(WHERE NOT x.related AND e.completeness<>'baseline' AND e.sequence>coalesce(c.reviewed_through,0))::int AS own,
 count(e.change_id) FILTER(WHERE x.related AND e.completeness<>'baseline' AND e.sequence>coalesce(c.reviewed_through,0))::int AS related
 FROM requested x LEFT JOIN change_history_cursors c ON c.workspace_id=$1 AND c.actor_id=$2 AND c.target_key=x.cursor
 LEFT JOIN change_history_entries e ON e.workspace_id=$1 AND e.stream_key=x.stream AND ($4::text[] IS NULL OR (e.project_id=ANY($4) AND (e.before_project IS NULL OR e.before_project=ANY($4))))
 GROUP BY x."taskId"`,[ctx.workspaceId,ctx.actor.id,JSON.stringify(maps),member.projectIds]);
 return {items:result.rows.map(r=>({taskId:r.task_id,head:r.head,reviewedThrough:r.reviewed,pendingCount:r.own+r.related,ownPendingCount:r.own,relatedPendingCount:r.related})),nextTaskId:tasks.length>500?selected.at(-1)!.id:null};
}
