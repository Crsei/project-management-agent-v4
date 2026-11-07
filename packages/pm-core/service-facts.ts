import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { statusCategory, type FileRecord, type ProtocolConfiguration } from '../pm-schema/index.ts';
import { FileRepository, revisionOf } from './repository.ts';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { maskHiddenComments, type SyntaxNode } from '../pm-markdown/syntax.ts';
import { retainCoreSnapshot } from './change-snapshots.ts';
const bodyParser=unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const kinds=['created','metadata_changed','content_changed','lifecycle_changed'] as const;
export const summarySchema=z.strictObject({id:z.string(),kind:z.enum(['project','work_item','milestone','requirement','document']),projectId:z.string().nullable(),revision:z.string(),metadata:z.string(),content:z.string(),lifecycle:z.string(),dependencies:z.string().optional(),snapshotKey:z.string().regex(/^[a-f0-9]{64}$/).optional(),extendedMetadata:z.string().optional(),statusCategory:z.string().optional()});
export type CoreFactSummary=z.infer<typeof summarySchema>;
const observationSchema=z.strictObject({factId:z.uuid(),sequence:z.number().int().positive(),before:summarySchema.nullable(),after:summarySchema.nullable(),observedAt:z.iso.datetime(),reason:z.string(),changeKinds:z.array(z.enum(kinds))});
export type CoreFactObservation=z.infer<typeof observationSchema>;
const ledgerSchema=z.strictObject({version:z.literal(1),initialized:z.boolean(),sequence:z.number().int().nonnegative(),baseline:z.array(summarySchema),observations:z.array(observationSchema),acceptedFactIds:z.array(z.uuid()).default([]),lastObservedAt:z.string().nullable(),gap:z.string().nullable()});
type Ledger=z.infer<typeof ledgerSchema>;
const selectedMetadata:Record<string,true>={title:true,kind:true,project:true,parent:true,priority:true,assignee:true,owner:true,goal:true,start:true,due:true,estimated_duration_days:true,'x-pm-start':true,'x-pm-estimate':true,'x-pm-location':true,depends_on:true,cycle:true,milestone:true,module:true,requirement:true,release:true,goals:true,blocked_by:true,related_to:true,labels:true};
export function coreFactSummary(file:FileRecord,configuration?:ProtocolConfiguration,snapshotKey?:string):CoreFactSummary|null {
 const e=file.entity;
 if(!['project','work_item','milestone','requirement','document'].includes(e.entity)) return null;
 const fields=Object.fromEntries(Object.entries(e).filter(([key])=>Object.hasOwn(selectedMetadata,key)).sort(([a],[b])=>a.localeCompare(b)));
 const tree=bodyParser.parse(maskHiddenComments(e.body)) as SyntaxNode;
 const title=tree.children?.findIndex(node=>node.type==='heading'&&node.depth===1)??-1;
 if(title>=0) tree.children!.splice(title,1);
 const semantic=(node:SyntaxNode):unknown=>Object.fromEntries(Object.entries(node).filter(([key])=>!['position','data'].includes(key)).map(([key,value])=>
  [key,key==='children'?(value as SyntaxNode[]).map(semantic):key==='value'&&node.type==='text'?String(value).replace(/\s+/g,' '):value]));
 const extended=Object.fromEntries(Object.entries(e).filter(([key])=>!['body','links','checklist','views','status','archived'].includes(key)).sort(([a],[b])=>a.localeCompare(b)));
 const category=statusCategory(e,configuration);
 return {id:file.id,kind:e.entity as CoreFactSummary['kind'],projectId:e.entity==='project'?file.id:typeof e.project==='string'?e.project:null,revision:file.revision,
 metadata:revisionOf(JSON.stringify(fields)),content:revisionOf(JSON.stringify(semantic(tree))),lifecycle:revisionOf(JSON.stringify([e.status??null,e.archived])),dependencies:revisionOf(JSON.stringify(e.blocked_by)),
 extendedMetadata:revisionOf(JSON.stringify(extended)),...(snapshotKey?{snapshotKey}:{}),...(category?{statusCategory:category}:{})};
}
export function coreChangeKinds(before:CoreFactSummary|null,after:CoreFactSummary|null):CoreFactObservation['changeKinds'] {
 if(!before) return ['created'];
 if(!after) return ['lifecycle_changed'];
 const result:CoreFactObservation['changeKinds']=[];
 if(before.metadata!==after.metadata||(before.extendedMetadata&&after.extendedMetadata&&before.extendedMetadata!==after.extendedMetadata)) result.push('metadata_changed');
 if(before.content!==after.content) result.push('content_changed');
 if(before.lifecycle!==after.lifecycle) result.push('lifecycle_changed');
 return result;
}
/** Private observed endpoints plus semantic hashes. First valid scan is a baseline, never fabricated history. */
export class ServiceFactObservations {
 private value:Ledger;
 private readonly file='.pm/state/service-observations.json';
 private readonly repository:FileRepository;
 private revision:string|undefined;
 private configurationKey:string|undefined;
 private readonly acceptedFactIds:Set<string>;
 constructor(repository:FileRepository) {
  this.repository=repository;
  try {
   const raw=repository.read(this.file);
   this.value=ledgerSchema.parse(JSON.parse(raw));
   this.revision=revisionOf(raw);
  }
  catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;this.value={version:1,initialized:false,sequence:0,baseline:[],observations:[],acceptedFactIds:[],lastObservedAt:null,gap:null};}
  this.acceptedFactIds=new Set(this.value.acceptedFactIds);
 }
 private save():void {
  const raw=JSON.stringify(this.value);
  this.repository.write(this.file,raw,this.revision);
  this.revision=revisionOf(raw);
 }
 accept(before:FileRecord|undefined,after:FileRecord|undefined,factId?:string|void,configuration?:ProtocolConfiguration):void {
  const previous=before?coreFactSummary(before,configuration):null,next=after?coreFactSummary(after,configuration):null;
  if(previous&&before)previous.snapshotKey=retainCoreSnapshot(this.repository,before);
  if(next&&after)next.snapshotKey=retainCoreSnapshot(this.repository,after);
  this.acceptCommitted(factId,previous,next);
 }
 acceptCommitted(factId:string|void,before:CoreFactSummary|null,after:CoreFactSummary|null):void {
  if(factId && this.acceptedFactIds.has(factId)) return;
  const id=after?.id??before?.id;
  if(!id) return;
  this.value.baseline=this.value.baseline.filter(value=>value.id!==id);
  if(after) this.value.baseline.push(after);
  this.value.baseline.sort((a,b)=>a.id.localeCompare(b.id));
  if(factId) {this.value.acceptedFactIds.push(factId);this.acceptedFactIds.add(factId);}
  this.save();
 }
 observe(files:FileRecord[],reason:string,valid:boolean,configuration?:ProtocolConfiguration):void {
  if(!valid) {if(this.value.gap!=='invalid_or_unavailable_source'){this.value.gap='invalid_or_unavailable_source';this.save();}return;}
  const now=new Date().toISOString(),previousById=new Map(this.value.baseline.map(value=>[value.id,value])),configurationKey=configuration?revisionOf(JSON.stringify(configuration)):'default',configurationChanged=this.configurationKey!==configurationKey;
  this.configurationKey=configurationKey;
  const after=files.map(file=>{
   const previous=previousById.get(file.id);
   if(!configurationChanged&&previous?.revision===file.revision&&previous.snapshotKey&&previous.extendedMetadata&&previous.statusCategory===statusCategory(file.entity,configuration))return previous;
   if(!['project','work_item','milestone','requirement','document'].includes(file.entity.entity))return null;
   return coreFactSummary(file,configuration,retainCoreSnapshot(this.repository,file));
  }).filter((value):value is CoreFactSummary=>value!==null);
  if(this.value.initialized&&this.value.gap===null&&this.value.baseline.length===after.length&&after.every((value,index)=>value===this.value.baseline[index]||JSON.stringify(value)===JSON.stringify(this.value.baseline[index])))return;
  if(this.value.initialized) {
   const previous=new Map(this.value.baseline.map(value=>[value.id,value]));
   const current=new Map(after.map(value=>[value.id,value]));
   for(const id of [...new Set([...previous.keys(),...current.keys()])].sort()) {
    const before=previous.get(id)??null,next=current.get(id)??null;
    if(before?.revision===next?.revision) continue;
    this.value.observations.push({factId:randomUUID(),sequence:++this.value.sequence,before,after:next,observedAt:now,reason,changeKinds:coreChangeKinds(before,next)});
   }
  }
  this.value.initialized=true;this.value.baseline=after;this.value.lastObservedAt=now;this.value.gap=null;this.save();
 }
 snapshot():Ledger {return structuredClone(this.value);}
}
export function readServiceFactObservations(root:string):Ledger {return new ServiceFactObservations(new FileRepository(root)).snapshot();}
