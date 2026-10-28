import type { CanvasCommand, CanvasDocument, CanvasSelection } from "@easyuse-ui/ui/lib/canvas-model"
import type { UiMessage } from "@easyuse-ui/ui/lib/i18n-core"
import { applyCanvasCommand } from "@easyuse-ui/ui/lib/canvas-commands"
import { createTaskDocument, sharedBrief, taskDefinitions, taskFixtures, type Copy, type TaskRole, type TerminalEvent } from "./fixtures.ts"

export type TaskRuntime = { status: "idle" | "queued" | "running" | "completed" | "failed"; visibleEvents: number; followups: TerminalEvent[] }
export type RunRecord = { id: number; status: "completed" | "cancelled"; outputs: { id: string; title: string; output: Copy }[] }
export type WorkbenchState = {
  document: CanvasDocument; selection: CanvasSelection; past: CanvasDocument[]; future: CanvasDocument[];
  brief: Copy; briefDraft?: string; drafts: Record<string,string>; scroll: Record<string,number>; runtime: Record<string,TaskRuntime>;
  playing: boolean; runId: number; history: RunRecord[]; saved?: CanvasDocument; readState: "ready" | "loading" | "error"; notice: string; noticeI18n?: UiMessage;
}
export function createWorkbenchState(scenario: string): WorkbenchState {
  const document = createTaskDocument()
  if (scenario === "empty") { document.nodes=[]; document.edges=[] }
  if (scenario === "long-content") document.nodes[0].title = "Map the onboarding flow, invitation expiry, role boundaries, organization access and complete recovery paths"
  return { document, selection: {nodeIds:[],edgeIds:[]}, past: [], future: [], brief: sharedBrief, drafts: {}, scroll: {}, runtime: Object.fromEntries(document.nodes.map(node=>[node.id,{status:scenario === "failed" && node.id === "review" ? "failed" : "completed", visibleEvents:taskFixtures.find(task=>task.id===node.id)?.events.length ?? 0,followups:[]}])), playing:false,runId:1,history:[], readState:scenario === "loading" ? "loading" : scenario === "refresh-error" ? "error" : "ready",notice:"" }
}
export function editWorkbench(state: WorkbenchState, command: CanvasCommand, readOnly = false): WorkbenchState {
  const result=applyCanvasCommand(state.document,command,taskDefinitions,{readOnly})
  if (!result.ok) return {...state,notice:result.message,noticeI18n:result.messageI18n}
  const runtime = {...state.runtime}
  for (const node of result.document.nodes) {
    const prior=state.document.nodes.find(previous=>previous.id===node.id)
    if (!runtime[node.id] || prior?.config.role!==node.config.role) runtime[node.id]={status:"idle",visibleEvents:0,followups:[]}
  }
  return {...state,document:result.document,selection:result.selection,past:[...state.past.slice(-49),state.document],future:[],runtime,playing:false,notice:"",noticeI18n:undefined}
}
export function historyEdit(state:WorkbenchState,direction:"undo"|"redo",readOnly=false):WorkbenchState {
  const source=direction==="undo"?state.past:state.future
  if(readOnly||!source.length)return state
  const document=source.at(-1)!
  return {...state,document,selection:{nodeIds:[],edgeIds:[]},past:direction==="undo"?state.past.slice(0,-1):[...state.past,state.document],future:direction==="redo"?state.future.slice(0,-1):[...state.future,state.document],playing:false}
}
export function taskOutput(state:WorkbenchState,id:string):Copy {
  const node=state.document.nodes.find(node=>node.id===id)
  const task=taskFixtures.find(task=>task.role===node?.config.role)
  return task?.deliverable ?? {en:"No deliverable. Replay the local script after assigning this task a role.","zh-CN":"暂无产物。指定任务角色后重播本地脚本。"}
}
export function startPlayback(state:WorkbenchState,readOnly=false):WorkbenchState {
  if(readOnly||!state.document.nodes.length)return state
  const history=state.document.nodes.some(node=>state.runtime[node.id]?.status==="completed")?[...state.history,{id:state.runId,status:"completed" as const,outputs:state.document.nodes.filter(node=>state.runtime[node.id]?.status==="completed").map(node=>({id:node.id,title:node.title,output:taskOutput(state,node.id)}))}].slice(-20):state.history
  return {...state,playing:true,runId:state.runId+1,history,runtime:Object.fromEntries(state.document.nodes.map(node=>[node.id,{status:"queued",visibleEvents:0,followups:state.runtime[node.id]?.followups ?? []}]))}
}
export function advancePlayback(state:WorkbenchState,runId=state.runId):WorkbenchState {
  if(!state.playing||runId!==state.runId)return state
  const runtime={...state.runtime}
  for(const node of state.document.nodes){
    const current=runtime[node.id]
    if(!current||current.status==="completed"||current.status==="failed")continue
    const deps=state.document.edges.filter(edge=>edge.target===node.id)
    if(deps.some(edge=>runtime[edge.source]?.status!=="completed"))continue
    const task=taskFixtures.find(task=>task.role===node.config.role)
    const count=task?.events.length ?? 1
    runtime[node.id]=current.status==="queued"?{...current,status:"running"}:current.visibleEvents<count?{...current,visibleEvents:current.visibleEvents+1}:{...current,status:"completed"}
  }
  return {...state,runtime,playing:!state.document.nodes.every(node=>runtime[node.id]?.status==="completed")}
}
export function submitFollowup(state:WorkbenchState,id:string,value:string,readOnly=false):WorkbenchState {
  const message=value.trim(),node=state.document.nodes.find(node=>node.id===id),current=state.runtime[id]
  if(readOnly||!message||!node||!current||state.playing)return state
  const role=node.config.role as TaskRole
  const responses:Record<TaskRole,Copy>={research:{en:"Authored research follow-up: preserve valid invite entries, distinguish delivery failures from expiry, and make Admin permissions explicit. This response is a local script, not a model interpretation of your message.","zh-CN":"预设研究回复：保留有效邀请条目，区分发送失败和过期，并明确管理员权限。这是本地脚本，不是模型对消息的理解。"},design:{en:"Authored design follow-up: use Field errors per email, Member as the default, and return focus to Invite people. The existing deliverable remains unchanged; no repository edits occur.","zh-CN":"预设设计回复：逐邮箱显示 Field 错误，默认成员角色，并将焦点返回邀请按钮。现有产物保持不变，不修改仓库。"},review:{en:"Authored review follow-up: verify keyboard order, duplicate emails, expired invitations, and owner-only Admin access. These are fixture observations, not newly executed checks.","zh-CN":"预设审阅回复：检查键盘顺序、重复邮箱、邀请过期和所有者专属管理员权限。这些是示例记录，并未重新执行检查。"}}
  const followups=[...current.followups,{id:id+"-question-"+current.followups.length,kind:"text" as const,text:{en:"› "+message,"zh-CN":"› "+message}},{id:id+"-answer-"+current.followups.length,kind:"text" as const,text:responses[role] ?? responses.research}]
  return {...state,drafts:{...state.drafts,[id]:""},runtime:{...state.runtime,[id]:{...current,followups}},notice:""}
}
