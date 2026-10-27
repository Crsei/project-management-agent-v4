import { useState } from 'react';
import { personalMentionToken } from '../../../../../../packages/pm-markdown/mentions.ts';
import { usePmService,usePrivateQuery } from './pm-service';
import { allowed,useText } from './pm-ui';
/** Candidate access uses the existing private query and authenticated client transport. */
export function PersonalMentionPicker({projectId,taskId,disabled=false,showHints=true,onInsert}:{projectId:string;taskId?:string|undefined;disabled?:boolean;showHints?:boolean;onInsert:(token:string)=>void}) {
 const {actor,workspace}=usePmService(),t=useText();
 const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[after,setAfter]=useState<string|undefined>();
 const eligible=!!projectId&&allowed(workspace,'directory.read',projectId)&&allowed(workspace,'domain.read',projectId);
 const query=usePrivateQuery(['pm',window.location.origin,actor?.id,workspace?.id,'mention-candidates',projectId,taskId,search,after],'directory.read',projectId,
  (client,workspaceId,signal)=>client.getMentionCandidates(workspaceId,projectId,{taskId,q:search,after,limit:20},{signal}),open&&eligible&&!disabled);
 return <div className="pm-personal-mention-picker">
  <button type="button" disabled={disabled||!eligible} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{t('提及成员','Mention a member')}</button>
  {!eligible&&showHints&&<small>{t('提及选择需要此项目目录权限；不会绕过目录搜索成员。','Mention selection requires directory access in this project; there is no directory bypass.')}</small>}
  {open&&eligible&&!disabled&&<div><label>{t('搜索当前可读此项目的成员','Search members who can currently read this project')}<input value={search} maxLength={100} onChange={event=>{setSearch(event.target.value);setAfter(undefined);}} /></label>
   {showHints&&<p><small>{t('只插入草稿；保存后才会验证和路由。提及不授予权限，也不自动关注。','Inserts into the draft only; validation and routing happen on save. Mentions grant no access and do not subscribe.')}</small></p>}
   {query.isPending&&<p role="status">{t('读取成员…','Loading members…')}</p>}
   {query.error&&<p role="alert">{t('候选读取失败，不表示没有成员。','Candidate lookup failed; this is not an empty directory.')} <button type="button" onClick={()=>{void query.refetch();}}>{t('重新读取','Retry read')}</button></p>}
   <ul>{query.data?.items.map(member=><li key={member.userId}><button type="button" onClick={()=>{onInsert(personalMentionToken(member.userId,member.name));setOpen(false);}}>{member.name}<small> · {member.userId}</small></button></li>)}</ul>
   {query.data?.items.length===0&&<p>{t('此页没有符合条件的成员。','No eligible members on this page.')}</p>}
   {after&&<button type="button" onClick={()=>setAfter(undefined)}>{t('返回首页','First page')}</button>}
   {query.data?.nextCursor&&<button type="button" onClick={()=>setAfter(query.data!.nextCursor!)}>{t('下一页','Next page')}</button>}
  </div>}
 </div>;
}
