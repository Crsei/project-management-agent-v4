"use client"

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Download, FileText, History, MoreHorizontal, Plus, Play, Pause, Redo2, RotateCcw, Save, Sun, Moon, Undo2, Trash2, GripVertical, ArrowRight } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { NativeSelect } from "@easyuse-ui/ui/components/ui/native-select"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody } from "@easyuse-ui/ui/components/ui/sheet"
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@easyuse-ui/ui/components/ui/dialog"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { Tooltip, TooltipTrigger, TooltipContent } from "@easyuse-ui/ui/components/ui/tooltip"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { WorkflowCanvas } from "@easyuse-ui/ui/components/blocks/workflow-canvas"
import { MessageContent } from "@easyuse-ui/ui/components/blocks/message-content"
import type { CanvasNodeProps } from "@easyuse-ui/ui/components/ui/canvas-node"
import type { CanvasCommand } from "@easyuse-ui/ui/lib/canvas-model"
import { redactText } from "@easyuse-ui/ui/lib/redact"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { advancePlayback, createWorkbenchState, editWorkbench, historyEdit, startPlayback, submitFollowup, taskOutput, type WorkbenchState } from "./controller"
import { roleNames, taskDefinitions, taskFixtures, type TaskRole } from "./fixtures"
import { TerminalTaskNode } from "./terminal"
import styles from "./view.module.css"

export const pageScenarios = [...remainingPageScenarios,{id:"failed",name:{"zh-CN":"任务失败",en:"Failed task"}}] as const
export function RemainingPageView(props:RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><Workbench key={props.scenario} {...props}/></RemainingPageStateProvider>
}
function IconAction({label,children,...props}:{label:string;children:ReactNode}&React.ComponentProps<typeof Button>) {
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={label} {...props}/>}>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}
function download(name:string,value:string) {
  const url=URL.createObjectURL(new Blob([redactText(value)],{type:"text/plain;charset=utf-8"})),anchor=document.createElement("a")
  anchor.href=url;anchor.download=name;anchor.click();URL.revokeObjectURL(url)
}
function Workbench({scenario,active,host}:RemainingPageProps) {
  const {locale,resolve}=useI18n(),l=(zh:string,en:string)=>locale==="en"?en:zh
  const [state,setState]=useRemainingPageState("canvas-workbench:"+scenario,()=>createWorkbenchState(scenario))
  const [panel,setPanel]=useRemainingPageState<string|null>("canvas-workbench:"+scenario+":panel",()=>null)
  const [confirmReset,setConfirmReset]=useState(false),[editor,setEditor]=useRemainingPageState<{id:string;title:string;assignment:string;error:string}|null>("canvas-workbench:"+scenario+":editor",()=>null)
  const canvas=useRef<HTMLDivElement>(null)
  const readOnly=scenario==="readonly",locked=readOnly||state.readState==="loading"
  function edit(command:CanvasCommand){setState(current=>editWorkbench(current,command,locked))}
  function localizedTitle(id:string,title:string){const fixture=taskFixtures.find(task=>task.id===id);return fixture&&fixture.title.en===title?fixture.title[locale]:title}
  function localizedAssignment(id:string,assignment:string){const fixture=taskFixtures.find(task=>task.id===id);return fixture&&fixture.assignment.en===assignment?fixture.assignment[locale]:assignment}
  useLayoutEffect(()=>{
    const element=canvas.current
    if(!active||!element||state.document.viewport||!state.document.nodes.length||state.readState==="loading")return
    const fit=()=>{
      if(!element.clientWidth||!element.clientHeight)return
      const margin=element.clientHeight*.045,zoom=Math.min((element.clientWidth-60)/1180,(element.clientHeight-margin*2)/1010,1)
      setState(current=>current.document.viewport?current:{...current,document:{...current.document,viewport:{x:(element.clientWidth-1180*zoom)/2,y:margin,zoom:Math.max(.25,zoom)}}})
    }
    const observer=new ResizeObserver(fit)
    observer.observe(element)
    fit()
    return()=>observer.disconnect()
  },[active,state.readState,state.document.nodes.length,state.document.viewport,setState])
  useEffect(()=>{if(!active||!state.playing)return;const runId=state.runId,timer=setInterval(()=>setState(current=>advancePlayback(current,runId)),650);return()=>clearInterval(timer)},[active,state.playing,state.runId,setState])
  useEffect(()=>{
    if(!active)return
    function key(event:KeyboardEvent){const target=event.target as HTMLElement;if(event.isComposing||target.closest("input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]")||!target.closest("[data-workbench-canvas]"))return
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"){event.preventDefault();setState(current=>historyEdit(current,event.shiftKey?"redo":"undo",locked))}
      if((event.key==="Delete"||event.key==="Backspace")&&!locked){event.preventDefault();setState(current=>editWorkbench(current,{type:"delete",selection:current.selection},locked))}
    }
    window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)
  },[active,locked,setState])
  function openTask(id:string){const node=state.document.nodes.find(node=>node.id===id);if(!node)return;setEditor(current=>current?.id===id&&current.error?current:{id,title:node.title,assignment:String(node.config.assignment??""),error:""});setPanel(id)}
  function saveEditor(){if(!editor||panel!==editor.id||locked)return;const node=state.document.nodes.find(node=>node.id===editor.id);if(!node)return
    if(!editor.title.trim()||!editor.assignment.trim()){setEditor({...editor,error:l("标题和任务说明不能为空。","Title and assignment are required.")});return}
    if(node.title!==editor.title||node.config.assignment!==editor.assignment)edit({type:"configure",nodeId:node.id,title:editor.title.trim(),config:{...node.config,assignment:editor.assignment.trim()}})
  }
  function addTask(){if(locked)return;const id="task-"+crypto.randomUUID();setState(current=>editWorkbench(current,{type:"add",node:{id,type:"terminal-task",title:l("新任务","New task"),position:{x:100,y:80},config:{role:"research",assignment:l("描述此 Agent 应完成的工作。","Describe the work this agent should do.")}}}));setEditor({id,title:l("新任务","New task"),assignment:l("描述此 Agent 应完成的工作。","Describe the work this agent should do."),error:""});setPanel(id)}
  function exportOutputs(){download("team-outputs.md",state.document.nodes.filter(node=>state.runtime[node.id]?.status==="completed").map(node=>"# "+localizedTitle(node.id,node.title)+"\n\n"+taskOutput(state,node.id)[locale]).join("\n\n---\n\n"))}
  function replay(){setState(current=>startPlayback(current,locked))}
  function renderTerminal({node,selected}:CanvasNodeProps){const role=(node.config.role??"research") as TaskRole,fixture=taskFixtures.find(task=>task.role===role)??taskFixtures[0],runtime=state.runtime[node.id]??{status:"idle",visibleEvents:0,followups:[]},title=localizedTitle(node.id,node.title)
    const events=[...fixture.events.slice(0,runtime.visibleEvents),...runtime.followups].map(event=>({...event,text:event.text[locale]}))
    const isMain=node.id==="design"
    return <TerminalTaskNode id={node.id} title={title} roleLabel={isMain?l("主 Agent","main"):l("子 Agent · ","sub-agent · ")+roleNames[role][locale]} width={isMain?600:500} height={isMain?1010:480} inputSide={node.id==="review"?"left":"right"} outputSide={node.id==="research"?"left":"right"} inputOffset={isMain?24:50} outputOffset={isMain?76:50} selected={selected} assignment={localizedAssignment(node.id,String(node.config.assignment??""))} events={events} deliverable={runtime.status==="completed"?taskOutput(state,node.id)[locale]:runtime.status==="failed"?l("任务失败：示例权限审查未完成。可重播本地脚本；现有记录保留。","Task failed: the fixture permissions review did not complete. Replay the local script; existing evidence is retained."):""} status={runtime.status} draft={state.drafts[node.id]??""} onDraftChange={value=>setState(current=>({...current,drafts:{...current.drafts,[node.id]:value}}))} onSend={value=>setState(current=>submitFollowup(current,node.id,value,locked))} onOpen={()=>openTask(node.id)} onOutput={()=>{openTask(node.id)}} readOnly={locked} sendDisabled={state.playing} scrollTop={state.scroll[node.id]} onScroll={top=>setState(current=>current.scroll[node.id]===top?current:{...current,scroll:{...current.scroll,[node.id]:top}})}/>
  }
  const selectedNode=state.document.nodes.find(node=>node.id===panel),out=selectedNode?taskOutput(state,selectedNode.id)[locale]:""
  return <section className={styles.workbench} aria-label={l("子 Agent 画布工作台","Subagent canvas workbench")}>
    <header className={styles.header}><div className={styles.identity}><h1>{l("子 Agent 画布","Subagent canvas")}</h1><p>{l("团队入职","Team onboarding")} · {state.document.nodes.length} {l("个终端","terminals")}</p></div>
      <Button variant="ghost" onClick={()=>setPanel("brief")}><FileText size={16}/>{l("共享简报","Shared brief")}</Button>
      <div className={styles.actions}><IconAction label={l("保存布局","Save layout")} disabled={locked} onClick={()=>setState(current=>({...current,saved:structuredClone(current.document),noticeI18n:undefined,notice:l("布局已保存到本页内存。刷新后清除。","Layout saved in page memory. Refresh clears it.")}))}><Save size={16}/></IconAction>
      <IconAction label={l("撤销编辑","Undo edit")} disabled={locked||!state.past.length} onClick={()=>setState(current=>historyEdit(current,"undo",locked))}><Undo2 size={16}/></IconAction>
      <IconAction label={l("重做编辑","Redo edit")} disabled={locked||!state.future.length} onClick={()=>setState(current=>historyEdit(current,"redo",locked))}><Redo2 size={16}/></IconAction>
      <IconAction label={l("运行历史","Run history")} onClick={()=>setPanel("history")}><History size={16}/></IconAction>
      <IconAction label={l("导出产物","Export outputs")} disabled={!state.document.nodes.some(node=>state.runtime[node.id]?.status==="completed")} onClick={exportOutputs}><Download size={16}/></IconAction>
      <IconAction label={l("重置示例","Reset example")} disabled={locked} onClick={()=>setConfirmReset(true)}><RotateCcw size={16}/></IconAction></div>
      <Button variant="outline" disabled={locked} onClick={addTask}><Plus size={16}/>{l("添加任务","Add task")}</Button>
      <Button disabled={locked||!state.document.nodes.length} onClick={()=>state.playing?setState(current=>({...current,playing:false})):replay()}>{state.playing?<Pause size={16}/>:<Play size={16}/>} {state.playing?l("暂停演示","Pause playback"):l("重播团队","Replay team")}</Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label={l("画布操作","Canvas actions")}/>}><MoreHorizontal size={16}/></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={()=>setPanel("brief")}>{l("共享简报与场景","Shared brief & scenario")}</DropdownMenuItem><DropdownMenuItem disabled={locked} onClick={addTask}>{l("添加任务","Add task")}</DropdownMenuItem><DropdownMenuItem disabled={locked||!state.past.length} onClick={()=>setState(current=>historyEdit(current,"undo",locked))}>{l("撤销编辑","Undo edit")}</DropdownMenuItem><DropdownMenuItem onClick={exportOutputs} disabled={!state.document.nodes.length}>{l("导出团队产物","Export team outputs")}</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem disabled={locked||!state.document.nodes.length} onClick={replay}>{l("重新加载回放","Reload playback")}</DropdownMenuItem><DropdownMenuItem disabled={locked||!state.saved} onClick={()=>state.saved&&edit({type:"replace",document:state.saved})}>{l("恢复保存的布局","Restore saved layout")}</DropdownMenuItem><DropdownMenuItem onClick={()=>setPanel("tasks")}>{l("任务列表与键盘连接","Task list & keyboard connections")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <IconAction label={l("切换主题","Toggle theme")} onClick={()=>host.setTheme(host.resolvedTheme==="dark"?"light":"dark")}>{host.resolvedTheme==="dark"?<Moon size={16}/>:<Sun size={16}/>}</IconAction>
    </header>
    {readOnly&&<p className={styles.notice}>{l("只读：可浏览、缩放和编辑消息草稿；不能更改任务或提交。","Read only: browse, zoom and draft messages; task edits and submission are unavailable.")}</p>}
    {state.readState==="error"&&<div role="alert" className={styles.error}>{l("刷新失败，保留已加载的任务与产物。","Refresh failed. Loaded tasks and outputs are retained.")}<Button variant="ghost" onClick={()=>setState(current=>({...current,readState:"ready"}))}>{l("重试本地读取","Retry local read")}</Button></div>}
    <div className={styles.canvas} ref={canvas} data-workbench-canvas tabIndex={0}>
      {state.readState==="loading"?<div role="status" aria-busy="true" className={styles.empty}><div className={styles.skeleton}/>{l("正在读取示例任务…","Loading fixture tasks…")}<Button onClick={()=>setState(current=>({...current,readState:"ready"}))}>{l("加载本地快照","Load local snapshot")}</Button></div>:!state.document.nodes.length?<div className={styles.empty}><Plus size={20}/><h2>{l("尚无任务","No tasks yet")}</h2><p>{l("添加任务并连接产物，组织你的子 Agent 团队。","Add tasks and connect deliverables to organize your subagent team.")}</p><Button onClick={addTask}>{l("添加任务","Add task")}</Button></div>:state.document.viewport?<WorkflowCanvas document={state.document} definitions={taskDefinitions} selection={state.selection} onSelectionChange={selection=>setState(current=>({...current,selection}))} onCommand={edit} readOnly={locked} renderNode={renderTerminal} showBackground={false} showMiniMap={false} controlsVariant="minimal-horizontal" nodeDragHandle=".terminal-task-drag" defaultInteractionMode="select" viewport={state.document.viewport} onViewportChange={viewport=>setState(current=>({...current,document:{...current.document,viewport}}))} onOpenNode={openTask}/>:null} 
      {!!state.document.nodes.length&&state.readState!=="loading"&&<div className={styles.hint}><GripVertical size={14}/>{l("拖动标题栏移动","Drag the title bar to move")}<span>{l("拖动","Drag")} <strong>OUT</strong> <ArrowRight size={14}/> <strong>IN</strong> {l("连接","to connect")}</span></div>}
    </div>
    <footer className={styles.status}><Button variant="ghost" size="sm" onClick={()=>setPanel("brief")}>• {l("脚本演示","Scripted demo")}</Button><span>· {l("模拟活动 · 无模型调用","Mock activity · No model calls")}</span><span className={styles.teamStatus}>{state.playing?l("团队回放中","Team playback running"):state.document.nodes.length&&state.document.nodes.every(node=>state.runtime[node.id]?.status==="completed")?l("团队已完成","Team completed"):l("团队已就绪","Team ready")}</span></footer>
    {state.notice&&<p role="status" className={styles.notice}>{resolve(state.noticeI18n,state.notice)}</p>}
    <Sheet open={Boolean(panel)} onOpenChange={open=>{if(!open){saveEditor();setPanel(null)}}}><SheetContent size={576} className={styles.sheet}><SheetHeader><SheetTitle>{panel==="brief"?l("共享简报","Shared brief"):panel==="history"?l("运行历史","Run history"):panel==="tasks"?l("任务与连接","Tasks & connections"):selectedNode?localizedTitle(selectedNode.id,selectedNode.title):l("任务","Task")}</SheetTitle><SheetDescription>{panel==="brief"?l("三个 Codex 终端协作完成团队入职流程。","Three Codex terminals work together on the team onboarding flow."):panel==="history"?l("此页面内存中的最近脚本运行。","Recent scripted runs in this page’s memory."):l("为 Agent 分配明确任务，并选择输入产物。","Give this agent a focused assignment and choose its inputs.")}</SheetDescription></SheetHeader>
      <SheetBody className={styles.sheetBody}>{panel==="brief"?<><Field label={l("团队应完成什么？","What should the team accomplish?")}>{props=><Textarea {...props} readOnly={locked} value={state.briefDraft??state.brief[locale]} onChange={event=>setState(current=>({...current,briefDraft:event.target.value}))}/>}</Field><section className={styles.briefInfo}><h3>{l("脚本展示","Scripted showcase")}</h3><p>shadcnblocks-admin</p><p>{l("此公开展示使用预先编写的对话、命令输出和审查结果。回放完全在浏览器内运行，无账户、仓库连接或模型请求。","This public showcase uses authored dialogue, command output, and review results. Playback runs entirely in your browser. No account, repository connection, or model request is used.")}</p><Button variant="outline" disabled={locked||!state.document.nodes.length} onClick={replay}><RotateCcw size={16}/>{l("重新加载回放","Reload playback")}</Button></section><p>{l("编辑与回放按场景隔离。后续消息使用角色对应的预设回复，不执行输入内容。","Edits and playback are isolated per scenario. Follow-ups play authored responses for the selected role; input is never executed.")}</p></>:panel==="history"?<>{[...state.history,{id:state.runId,status:state.playing?"cancelled" as const:"completed" as const,outputs:state.document.nodes.filter(node=>state.runtime[node.id]?.status==="completed").map(node=>({id:node.id,title:localizedTitle(node.id,node.title),output:taskOutput(state,node.id)}))}].reverse().map(run=><details key={run.id} open={run.id===state.runId}><summary>{l("运行","Run")} {run.id} · {run.id===state.runId?l("当前","Current"):l("历史","History")}</summary>{run.outputs.length?run.outputs.map(output=><section key={output.id}><h3>{output.title}</h3><MessageContent content={output.output[locale]}/></section>):<p>{l("尚无完成的产物。","No completed outputs yet.")}</p>}</details>)}</>:panel==="tasks"?<div className={styles.taskList}>{state.document.nodes.map(node=><section key={node.id}><Button variant="ghost" onClick={()=>openTask(node.id)}>{localizedTitle(node.id,node.title)}</Button><TaskDependencies state={state} id={node.id} locked={locked} onEdit={edit}/></section>)}</div>:selectedNode&&editor?<><Field label={l("任务标题","Task title")} error={editor.error}>{props=><Input {...props} readOnly={locked} value={localizedTitle(editor.id,editor.title)} onChange={event=>setEditor({...editor,title:event.target.value})} onBlur={saveEditor}/>}</Field><Field label={l("角色 · Codex","Role · Codex")}>{props=><NativeSelect {...props} aria-label={l("Agent 角色","Agent role")} disabled={locked} value={String(selectedNode.config.role)} onChange={event=>edit({type:"configure",nodeId:selectedNode.id,title:selectedNode.title,config:{...selectedNode.config,role:event.target.value}})}>{Object.entries(roleNames).map(([role,name])=><option value={role} key={role}>{name[locale]}</option>)}</NativeSelect>}</Field><Field label={l("任务说明","Assignment")} error={editor.error}>{props=><Textarea {...props} readOnly={locked} value={localizedAssignment(editor.id,editor.assignment)} onChange={event=>setEditor({...editor,assignment:event.target.value})} onBlur={saveEditor}/>}</Field><TaskDependencies state={state} id={selectedNode.id} locked={locked} onEdit={edit}/><section className={styles.deliverable}><header><h3>{l("产物","Deliverable")}</h3><RuntimeStatusBadge status={state.runtime[selectedNode.id]?.status??"idle"}/></header><p>{l("会话","Session")} demo-{selectedNode.id}</p>{state.runtime[selectedNode.id]?.status==="completed"?<><MessageContent content={out}/><Button variant="outline" onClick={()=>download(selectedNode.id+"-output.md",out)}><Download size={16}/>{l("下载产物","Download output")}</Button></>:<p>{l("此任务尚未生成产物。可重播本地团队脚本。","This task has no completed deliverable. Replay the local team script.")}</p>}</section><Button variant="destructive" disabled={locked} onClick={()=>{edit({type:"delete",selection:{nodeIds:[selectedNode.id],edgeIds:[]}});setPanel(null);setEditor(null)}}><Trash2 size={16}/>{l("移除任务","Remove task")}</Button></>:null}</SheetBody></SheetContent></Sheet>
    <Dialog open={confirmReset} onOpenChange={setConfirmReset}><DialogContent><DialogTitle>{l("重置示例？","Reset example?")}</DialogTitle><DialogDescription>{l("清除当前场景的任务编辑、消息草稿、产物和回放历史，恢复三个初始终端。","Clear task edits, message drafts, outputs and playback history for this scenario and restore the three initial terminals.")}</DialogDescription><DialogFooter><Button variant="outline" onClick={()=>setConfirmReset(false)}>{l("取消","Cancel")}</Button><Button variant="destructive" onClick={()=>{setState(createWorkbenchState(scenario));setEditor(null);setPanel(null);setConfirmReset(false)}}>{l("重置示例","Reset example")}</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
function TaskDependencies({state,id,locked,onEdit}:{state:WorkbenchState;id:string;locked:boolean;onEdit:(command:CanvasCommand)=>void}) {
  const {locale,resolve}=useI18n()
  return <fieldset className={styles.dependencies}><legend>{locale==="en"?"Wait for these deliverables":"等待以下产物"}</legend>{state.document.nodes.filter(node=>node.id!==id).map(node=>{const edge=state.document.edges.find(edge=>edge.source===node.id&&edge.target===id),fixture=taskFixtures.find(task=>task.id===node.id),title=fixture&&fixture.title.en===node.title?fixture.title[locale]:node.title;return <label key={node.id}><Checkbox checked={Boolean(edge)} disabled={locked} onCheckedChange={checked=>onEdit(checked?{type:"connect",edge:{id:node.id+"-"+id,source:node.id,sourcePort:"out",target:id,targetPort:"in"}}:{type:"delete",selection:{nodeIds:[],edgeIds:edge?[edge.id]:[]}})}/>{title}</label>})}{state.notice&&<p role="alert">{resolve(state.noticeI18n,state.notice)}</p>}</fieldset>
}
