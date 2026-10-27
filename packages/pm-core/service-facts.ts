import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FileRecord } from '../pm-schema/index.ts';
import { FileRepository, revisionOf } from './repository.ts';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { maskHiddenComments, type SyntaxNode } from '../pm-markdown/syntax.ts';
const bodyParser=unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const kinds=['created','metadata_changed','content_changed','lifecycle_changed'] as const;
export const summarySchema=z.strictObject({id:z.string(),kind:z.enum(['project','work_item','milestone']),projectId:z.string().nullable(),revision:z.string(),metadata:z.string(),content:z.string(),lifecycle:z.string()});
export type CoreFactSummary=z.infer<typeof summarySchema>;
const observationSchema=z.strictObject({factId:z.uuid(),sequence:z.number().int().positive(),before:summarySchema.nullable(),after:summarySchema.nullable(),observedAt:z.iso.datetime(),reason:z.string(),changeKinds:z.array(z.enum(kinds))});
export type CoreFactObservation=z.infer<typeof observationSchema>;
const ledgerSchema=z.strictObject({version:z.literal(1),initialized:z.boolean(),sequence:z.number().int().nonnegative(),baseline:z.array(summarySchema),observations:z.array(observationSchema),acceptedFactIds:z.array(z.uuid()).default([]),lastObservedAt:z.string().nullable(),gap:z.string().nullable()});
type Ledger=z.infer<typeof ledgerSchema>;
const selectedMetadata:Record<string,true>={title:true,kind:true,project:true,parent:true,priority:true,assignee:true,owner:true,goal:true,start:true,due:true,estimated_duration_days:true,'x-pm-start':true,'x-pm-estimate':true,'x-pm-location':true,depends_on:true,cycle:true,milestone:true,module:true,requirement:true,release:true,goals:true,blocked_by:true,related_to:true,labels:true};
export function coreFactSummary(file:FileRecord):CoreFactSummary|null {
 const e=file.entity;
 if(!['project','work_item','milestone'].includes(e.entity)) return null;
 const fields=Object.fromEntries(Object.entries(e).filter(([key])=>Object.hasOwn(selectedMetadata,key)).sort(([a],[b])=>a.localeCompare(b)));
 const tree=bodyParser.parse(maskHiddenComments(e.body)) as SyntaxNode;
 const title=tree.children?.findIndex(node=>node.type==='heading'&&node.depth===1)??-1;
 if(title>=0) tree.children!.splice(title,1);
 const semantic=(node:SyntaxNode):unknown=>Object.fromEntries(Object.entries(node).filter(([key])=>!['position','data'].includes(key)).map(([key,value])=>
  [key,key==='children'?(value as SyntaxNode[]).map(semantic):key==='value'&&node.type==='text'?String(value).replace(/\s+/g,' '):value]));
 return {id:file.id,kind:e.entity as CoreFactSummary['kind'],projectId:e.entity==='project'?file.id:typeof e.project==='string'?e.project:null,revision:file.revision,
 metadata:revisionOf(JSON.stringify(fields)),content:revisionOf(JSON.stringify(semantic(tree))),lifecycle:revisionOf(JSON.stringify([e.status??null,e.archived]))};
}
export function coreChangeKinds(before:CoreFactSummary|null,after:CoreFactSummary|null):CoreFactObservation['changeKinds'] {
 if(!before) return ['created'];
 if(!after) return ['lifecycle_changed'];
 const result:CoreFactObservation['changeKinds']=[];
 if(before.metadata!==after.metadata) result.push('metadata_changed');
 if(before.content!==after.content) result.push('content_changed');
 if(before.lifecycle!==after.lifecycle) result.push('lifecycle_changed');
 return result;
}
/** Safe semantic hashes only. First valid scan is a baseline, never fabricated history. */
export class ServiceFactObservations {
 private value:Ledger;
 private readonly file='.pm/state/service-observations.json';
 private readonly repository:FileRepository;
 private revision:string|undefined;
 constructor(repository:FileRepository) {
  this.repository=repository;
  try {
   const raw=repository.read(this.file);
   this.value=ledgerSchema.parse(JSON.parse(raw));
   this.revision=revisionOf(raw);
  }
  catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;this.value={version:1,initialized:false,sequence:0,baseline:[],observations:[],acceptedFactIds:[],lastObservedAt:null,gap:null};}
 }
 private save():void {
  const raw=JSON.stringify(this.value);
  this.repository.write(this.file,raw,this.revision);
  this.revision=revisionOf(raw);
 }
 accept(before:FileRecord|undefined,after:FileRecord|undefined,factId?:string|void):void {
  this.acceptCommitted(factId, before?coreFactSummary(before):null, after?coreFactSummary(after):null);
 }
 acceptCommitted(factId:string|void,before:CoreFactSummary|null,after:CoreFactSummary|null):void {
  if(factId && this.value.acceptedFactIds.includes(factId)) return;
  const id=after?.id??before?.id;
  if(!id) return;
  this.value.baseline=this.value.baseline.filter(value=>value.id!==id);
  if(after) this.value.baseline.push(after);
  if(factId) this.value.acceptedFactIds.push(factId);
  this.save();
 }
 observe(files:FileRecord[],reason:string,valid:boolean):void {
  if(!valid) {this.value.gap='invalid_or_unavailable_source';this.save();return;}
  const now=new Date().toISOString();
  const after=files.map(coreFactSummary).filter((value):value is CoreFactSummary=>value!==null);
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
