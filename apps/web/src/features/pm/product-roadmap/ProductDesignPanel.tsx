import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { type CommandReceipt } from '@contracts';
import { usePmCommand, usePmService } from '../service/pm-service';
import { entitySchema, makeCommand } from '../service/pm-ui';
import { designBundleSchema, type DesignBundle } from '../../../../../../packages/contracts/src/product-design';
import type { RoadmapPlan } from '../../../../../../packages/contracts/src/product-roadmap';
import { AgentRoadmapPlanner } from './AgentRoadmapPlanner';
import { candidateAssets, createDesignZip, type DesignCandidate } from './design-candidate';
import { designText, previewDocument } from './design-preview';

const recoverySchema=z.object({commandId:z.uuid(),phase:z.enum(['stage','register']),name:z.string(),uploadId:z.uuid().optional(),title:z.string().max(200).optional(),notes:z.string().max(6000).optional()});
export function DesignPreview({assets}:{assets:DesignBundle['assets']}){
  const [selected,setSelected]=useState('');const asset=assets.find(a=>a.name===selected)??assets.find(a=>a.mediaType==='text/html')??assets[0];
  if(!asset)return null;
  return <section className="product-design-preview" aria-label="设计预览"><label>查看页面或素材<select value={asset.name} onChange={e=>setSelected(e.target.value)}>{assets.map(a=><option key={a.name} value={a.name}>{a.name}</option>)}</select></label>
    {asset.mediaType.startsWith('image/')?<img alt={asset.name} src={`data:${asset.mediaType};base64,${asset.base64}`} />:asset.mediaType==='text/html'?<iframe title={`设计预览：${asset.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={previewDocument(asset,assets)} />:<pre>{designText(asset.base64)}</pre>}
    <p className="roadmap-muted">仅预览设计，不代表产品功能已实现。HTML 静态展示；脚本、表单提交、外部资源和跨页面跳转不执行。</p>
  </section>;
}
export function ProductDesignPanel({plan,revision,storageKey,workspaceId,projectId,disabled,onChange}:{plan:RoadmapPlan;revision:string;storageKey:string;workspaceId:string;projectId:string;disabled:boolean;onChange:(next:RoadmapPlan)=>void}){
  const {client,workspace,capabilities}=usePmService(),command=usePmCommand();
  const [bundle,setBundle]=useState<DesignBundle|null>(null),[candidate,setCandidate]=useState<DesignCandidate|null>(null),[title,setTitle]=useState(plan.design?.title??''),[notes,setNotes]=useState(plan.design?.notes??'');
  const [error,setError]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[recoveryBroken,setRecoveryBroken]=useState(false),[files,setFiles]=useState<{id:string;name:string}[]>([]),[fileId,setFileId]=useState('');
  const [staged,setStaged]=useState<{id:string;name:string}|null>(null),[recovery,setRecovery]=useState<z.infer<typeof recoverySchema>|null>(null);
  const alive=useRef(true),flight=useRef(false),sequence=useRef(0);const recoveryKey=`${storageKey}:design-upload`;
  const blocked=disabled||busy||command.pending||!!command.unknownCommand;const uploadBlocked=blocked||recoveryBroken||!workspace?.capabilities.includes('delivery.write')||!capabilities?.business.enabled;
  async function load(id:string){
    const serial=++sequence.current;setError('');
    const response=await fetch(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/product-roadmap/design/${id}`,{credentials:'same-origin',signal:AbortSignal.timeout(20000)});
    const value=await response.json();if(!response.ok)throw new Error(value.error?.message??'设计暂不可访问。');const next=designBundleSchema.parse(value);
    if(!alive.current||sequence.current!==serial)return;
    if(plan.design?.versionId===id&&plan.design.sha256!==next.sha256)throw new Error('已采用设计的内容校验不一致。');
    setBundle(next);setCandidate(null);setTitle(plan.design?.versionId===id?plan.design.title:next.fileName);setNotes(plan.design?.versionId===id?plan.design.notes:'');
  }
  useEffect(()=>{alive.current=true;try{const raw=sessionStorage.getItem(recoveryKey);if(raw){const value=recoverySchema.parse(JSON.parse(raw));setRecovery(value);if(value.uploadId)setStaged({id:value.uploadId,name:value.name});}}catch{setRecoveryBroken(true);setError('上传恢复记录损坏，请在项目文件中核对，不能自动重复上传。');}
    if(plan.design)void load(plan.design.versionId).catch(e=>{if(alive.current)setError(String(e));});return()=>{alive.current=false;sequence.current++;};},[]);
  async function work(action:()=>Promise<void>){if(flight.current)return;flight.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive.current)setError(String(e));}finally{flight.current=false;if(alive.current)setBusy(false);}}
  function remember(value:z.infer<typeof recoverySchema>){sessionStorage.setItem(recoveryKey,JSON.stringify(value));setRecovery(value);}
  function forget(){sessionStorage.removeItem(recoveryKey);setRecovery(null);}
  async function registered(receipt:CommandReceipt){if(receipt.status!=='committed')throw new Error('文件登记未提交，请查看原收据。');const version=z.object({artifactVersion:entitySchema}).parse(receipt.result).artifactVersion;forget();setStaged(null);await load(version.id);setStatus('已保存为项目文件；请预览后采用到画布。');}
  async function register(upload:{id:string;name:string},metadata?:{title:string;notes:string}){
    const entity=await client.getEntity(workspaceId,upload.id);if(!alive.current)return;const request=makeCommand('RegisterArtifact',{title:upload.name,kind:'product-design',uploadId:upload.id},undefined,projectId,[entity]);
    remember({commandId:request.commandId,phase:'register',name:upload.name,uploadId:upload.id,...metadata});await registered(await command.execute(request));if(metadata&&alive.current){setTitle(metadata.title);setNotes(metadata.notes);}
  }
  async function upload(file:File,metadata?:{title:string;notes:string}){
    if(uploadBlocked||recovery||staged)return;
    await work(async()=>{
      if(!file.size||file.size>8*1024*1024||!(/\.(zip|png|jpg|jpeg|webp|svg|html|htm)$/i.test(file.name)))throw new Error('请选择8 MiB以内的ZIP、图片或HTML。');
      const contentBase64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.onerror=()=>reject(new Error('读取文件失败。'));reader.readAsDataURL(file);});
      if(!alive.current)return;
      const request=makeCommand('StageUpload',{fileName:file.name,mediaType:file.type||'application/octet-stream',contentBase64},undefined,projectId);
      remember({commandId:request.commandId,phase:'stage',name:file.name,...metadata});const receipt=await command.execute(request);
      if(receipt.status!=='committed')throw new Error('暂存未提交，请核对原收据。');
      const entity=z.object({upload:entitySchema}).parse(receipt.result).upload,ready={id:entity.id,name:file.name};
      remember({commandId:request.commandId,phase:'stage',name:file.name,uploadId:entity.id,...metadata});if(!alive.current)return;setStaged(ready);await register(ready,metadata);
    });
  }
  async function reconcile(){await work(async()=>{
    const receipt=command.unknownCommand?await command.reconcile():recovery?await client.getCommandReceipt(workspaceId,recovery.commandId):null;
    if(!receipt||receipt.commandId!==recovery?.commandId){setStatus('请到项目文件核对原命令；不会重放上传。');return;}
    if(receipt.status!=='committed'){if(recovery.uploadId){remember({...recovery,phase:'stage'});setStaged({id:recovery.uploadId,name:recovery.name});}else forget();setStatus('原请求已拒绝，可重新选择文件或继续登记。');return;}
    if(recovery.phase==='register'){const meta=recovery;await registered(receipt);if(meta.title){setTitle(meta.title);setNotes(meta.notes??'');}}else {const entity=z.object({upload:entitySchema}).parse(receipt.result).upload;const ready={id:entity.id,name:recovery.name};remember({...recovery,uploadId:entity.id});setStaged(ready);setStatus('暂存已确认，请继续登记，不会再次上传。');}
  });}
  async function list(){await work(async()=>{const items:{id:string;name:string}[]=[];let after:string|undefined;do{const page=await client.listEntities(workspaceId,{kind:'artifact_version',projectId,limit:100,...(after?{after}:{})});for(const item of page.items){const name=String(item.data.fileName??'');if(/\.(zip|png|jpg|jpeg|webp|svg|html|htm)$/i.test(name))items.push({id:item.id,name});}after=page.nextCursor??undefined;}while(after);if(alive.current){setFiles(items);setStatus(items.length?'请选择要预览的文件版本。':'本项目还没有可用的设计资料。');}});}
  return <div className="roadmap-fields product-design-panel">
    <p>{plan.design?`当前采用：${plan.design.title} · 版本 ${plan.design.versionId.slice(0,8)}`:'尚未采用设计。先上传资料或生成草稿，预览后再采用。'}</p>
    {!disabled&&<><label>上传设计资料<input type="file" accept=".zip,.png,.jpg,.jpeg,.webp,.svg,.html,.htm" disabled={uploadBlocked||!!recovery||!!staged} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(file);}} /></label><p className="roadmap-muted">支持图片、HTML 页面或 ZIP 设计包（最大 8 MiB，单项素材最大 2 MiB）。资料保存在本项目，预览并采用后全部功能节点共用。</p>
      {recovery&&<button disabled={busy} onClick={()=>void reconcile()}>核对原上传结果（不重传）</button>}{staged&&recovery?.phase==='stage'&&<button disabled={uploadBlocked} onClick={()=>void work(()=>register(staged,recovery.title?{title:recovery.title,notes:recovery.notes??''}:undefined))}>继续登记已暂存文件</button>}
      <div className="roadmap-actions"><button disabled={blocked} onClick={()=>void list()}>从项目文件选择</button><Link to={`/pm/${workspaceId}/projects/${projectId}?tab=files`}>查看项目文件</Link></div>
      {files.length>0&&<><label>已有资料<select value={fileId} onChange={e=>setFileId(e.target.value)}><option value="">选择不可变文件版本</option>{files.map(f=><option key={f.id} value={f.id}>{f.name} · {f.id.slice(0,8)}</option>)}</select></label><button disabled={blocked||!fileId} onClick={()=>void work(()=>load(fileId))}>读取并预览</button></>}
      <details><summary>通过对话生成设计草稿</summary><AgentRoadmapPlanner plan={plan} revision={revision} storageKey={storageKey} workspaceId={workspaceId} projectId={projectId} disabled={blocked} onApply={()=>{}} onDesignCandidate={value=>{sequence.current++;setCandidate(value);setBundle(null);setTitle(value.title);setNotes(value.notes);setStatus('设计候选已生成，尚未上传或采用。');}} /></details>
    </>}
    {candidate&&<><DesignPreview assets={candidateAssets(candidate)} /><button disabled={uploadBlocked||!!recovery||!!staged} onClick={()=>void upload(new File([createDesignZip(candidate)],'product-design.zip',{type:'application/zip'}),{title:candidate.title,notes:candidate.notes})}>保存设计包并预览采用</button><p>系统直接打包，无需下载后重新上传；该步骤只保存设计文件。</p></>}
    {bundle&&<><DesignPreview assets={bundle.assets}/>{bundle.unsupported.length>0&&<p>未预览的文件（不会执行）：{bundle.unsupported.join('、')}</p>}<label>设计名称<input maxLength={200} value={title} disabled={disabled} onChange={e=>setTitle(e.target.value)}/></label><label>体验说明（可选）<textarea rows={3} maxLength={6000} value={notes} disabled={disabled} placeholder="补充整体氛围、页面关系和关键交互；技术要求不放在这里。" onChange={e=>setNotes(e.target.value)}/></label>
      {!disabled&&<button className="primary" disabled={blocked||!title.trim()} onClick={()=>{onChange({...plan,design:{versionId:bundle.versionId,sha256:bundle.sha256,title:title.trim(),notes}});setStatus('已采用到本机画布草稿，请保存画布。运行时冻结版本，不会随其他上传变化。');}}>采用到画布草稿</button>}
      <a href={`/api/v1/workspaces/${workspaceId}/artifact-versions/${bundle.versionId}/content`} download>下载原始设计资料</a>
    </>}
    {plan.design&&!disabled&&<button disabled={blocked} onClick={()=>{const next={...plan};delete next.design;onChange(next);setBundle(null);setStatus('已从草稿取消采用；未删除项目文件或历史版本。');}}>取消采用当前设计</button>}
    {status&&<p role="status">{status}</p>}{error&&<p role="alert" className="roadmap-error">{error}</p>}
    <details><summary>技术约束（原有内容保留）</summary><p>技术和运行要求与产品视觉设计分开，不需要在每个功能节点重复填写。</p><textarea aria-label="技术约束" rows={5} value={plan.brief.sharedContract} disabled={disabled} maxLength={6000} onChange={e=>onChange({...plan,brief:{...plan.brief,sharedContract:e.target.value}})}/></details>
  </div>;
}
