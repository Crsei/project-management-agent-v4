import { parseDocument } from 'yaml';
import { parseMarkdown } from '../pm-markdown/index.ts';
import { defaultConfiguration,parseConfiguration,type FileRecord,type ProtocolConfiguration } from '../pm-schema/index.ts';
import { validateRelations } from '../pm-schema/relations.ts';
import { FileRepository,revisionOf } from './repository.ts';
export type ReadonlyCoreSnapshot={files:FileRecord[];fingerprint:string;configuration?:ProtocolConfiguration};
import { DurableState } from './state.ts';
import { ProjectLocations } from './project-locations.ts';
/** Pure file reads. Never initializes Workspace, state, cache, directories, or watchers. */
export function readCurrentCore(root:string):ReadonlyCoreSnapshot {
 const repository=new FileRepository(root);
 const readOptional=(relative:string):string|null=>{try{return repository.read(relative);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
 const locationsRaw=readOptional('.pm/state/project-locations.json');
 new ProjectLocations(root).assertSettled();
 const configurationRaw=readOptional('.pm/config.yaml'),stateRaw=readOptional('.pm/state/state.json');
 let config=defaultConfiguration;
 if(configurationRaw!==null){const doc=parseDocument(configurationRaw,{uniqueKeys:true});if(doc.errors.length) throw new Error('Invalid configuration');config=parseConfiguration(doc.toJS({maxAliasCount:50}));}
 const state=new DurableState(repository,true);
 if(state.transaction||state.migrationProjection) throw new Error('core_recovery_pending');
 const collected=repository.collect();
 if(collected.errors.length) throw new Error('core_source_unavailable');
 const files=collected.files.map(file=>{const entity=parseMarkdown(file.raw,config),known=state.identity(file.path);
  if(state.deleted(entity.id)||known&&(known.id!==entity.id||known.entity&&known.entity!==entity.entity)) throw new Error('core_identity_invalid');
  return {...file,id:entity.id,entity,revision:revisionOf(file.raw)};});
 if(validateRelations(files,config).some(issue=>issue.severity==='error') || new Set(files.map(file=>file.id)).size!==files.length) throw new Error('core_source_invalid');
 // Re-read after parsing: external concurrent replacement cannot masquerade as a stable batch.
 const final=repository.collect(),byPath=new Map(files.map(file=>[file.path,file.revision]));
 if(final.errors.length||final.files.length!==files.length||final.files.some(file=>byPath.get(file.path)!==revisionOf(file.raw))
  || readOptional('.pm/config.yaml')!==configurationRaw||readOptional('.pm/state/state.json')!==stateRaw||readOptional('.pm/state/project-locations.json')!==locationsRaw) throw new Error('core_source_changed');
 return {files,configuration:config,fingerprint:revisionOf(JSON.stringify(files.map(file=>[file.id,file.revision]).sort()))};
}
export type NotificationCorePort={read(workspaceId:string):Promise<ReadonlyCoreSnapshot>};
export function readonlyCorePort(rootFor:(workspaceId:string)=>string):NotificationCorePort {return {read:async workspaceId=>readCurrentCore(rootFor(workspaceId))};}
