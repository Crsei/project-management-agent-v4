import { z } from 'zod';
import { addedPersonalMentions } from '../../pm-markdown/mentions.ts';
import { DomainError,type Actor } from '../../domain/src/core.ts';
import { requireCapability } from './access.ts';
import type { SqlExecutor } from './ports.ts';
export async function validateNewMentions(sql:SqlExecutor,workspaceId:string,projectId:string,before:string,after:string):Promise<string[]> {
 let ids:string[];
 try { ids=addedPersonalMentions(before,after); } catch { throw new DomainError('mention_limit_exceeded','At most 50 distinct personal mentions are allowed',422); }
 if(!ids.length) return ids;
 const rows=await sql.query<{user_id:string}>(`SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=ANY($2::uuid[])
 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids))`,[workspaceId,ids,projectId]);
 if(rows.rows.length!==ids.length) throw new DomainError('mention_not_eligible','One or more new mentions are not eligible for this project',422);
 return ids;
}
export const mentionCandidatesQuery=z.strictObject({projectId:z.string().min(1),q:z.string().max(100).default(''),after:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(50).default(20)});
export async function readMentionCandidates(sql:SqlExecutor,actor:Actor,workspaceId:string,projectId:string,options:{q?:string|undefined;after?:string|undefined;limit?:number|undefined}={}) {
 await requireCapability(sql,actor,workspaceId,'domain.read',projectId);
 await requireCapability(sql,actor,workspaceId,'directory.read',projectId);
 const parsed=mentionCandidatesQuery.parse({...options,projectId});
 const rows=await sql.query<{user_id:string;name:string}>(`SELECT m.user_id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1
 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $2=ANY(m.project_ids))
 AND ($3::uuid IS NULL OR m.user_id>$3::uuid) AND strpos(lower(u.name),lower($4))>0 ORDER BY m.user_id LIMIT $5`,[workspaceId,projectId,parsed.after??null,parsed.q,parsed.limit+1]);
 const items=rows.rows.slice(0,parsed.limit).map(row=>({userId:row.user_id,name:row.name}));
 return {items,nextCursor:rows.rows.length>parsed.limit?items.at(-1)!.userId:null};
}
