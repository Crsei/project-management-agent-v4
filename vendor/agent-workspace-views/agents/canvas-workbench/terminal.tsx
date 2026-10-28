"use client"

import { useLayoutEffect, useRef, type ReactNode } from "react"
import { ArrowUpRight, GripVertical, ArrowUp } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { CanvasPort } from "@easyuse-ui/ui/components/ui/canvas-port"
import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import { ThemeBoundary } from "@easyuse-ui/ui/components/ui/theme-boundary"
import { ChatComposer } from "@easyuse-ui/ui/components/blocks/chat-message"
import { ToolCall } from "@easyuse-ui/ui/components/blocks/tool-call"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { redactText } from "@easyuse-ui/ui/lib/redact"
import styles from "./terminal.module.css"

export type TerminalTaskNodeProps = {
  id: string; title: string; roleLabel: string; agentName?: string; version?: string; model?: string; directory?: string;
  assignment: string; events: {id:string;kind:"text"|"command";text:string;output?:string}[]; deliverable: string; status: string;
  draft: string; onDraftChange:(value:string)=>void; onSend:(value:string)=>void; onOpen:()=>void; onOutput:()=>void;
  width: number; height: number; inputSide?:"left"|"right"; outputSide?:"left"|"right"; selected?:boolean;
  readOnly?:boolean; sendDisabled?:boolean; scrollTop?:number; onScroll?:(top:number)=>void;
  titleBarLabel?:string; introContent?:ReactNode; footerLabel?:ReactNode;
  inputOffset?:number; outputOffset?:number; showDeliverableInline?:boolean; draftDisabled?:boolean;
}
/** Terminal transcript is authored data, never a PTY or command execution surface. */
export function TerminalTaskNode({id,title,roleLabel,agentName="OpenAI Codex",version="v0.153.4",model="gpt-5.6-sol high",directory="shadcnblocks-admin",assignment,events,deliverable,status,draft,onDraftChange,onSend,onOpen,onOutput,width,height,inputSide="left",outputSide="right",selected,readOnly,sendDisabled,scrollTop,onScroll,titleBarLabel,introContent,footerLabel,inputOffset=50,outputOffset=50,showDeliverableInline=true,draftDisabled=false}:TerminalTaskNodeProps) {
  const {locale}=useI18n(),scroll=useRef<HTMLDivElement>(null),restored=useRef(false)
  const l=(zh:string,en:string)=>locale==="en"?en:zh
  useLayoutEffect(()=>{if(scroll.current&&!restored.current){scroll.current.scrollTop=scrollTop??scroll.current.scrollHeight;restored.current=true}},[scrollTop])
  useLayoutEffect(()=>{const element=scroll.current;if(element && (scrollTop===undefined || element.scrollHeight-element.clientHeight-element.scrollTop<64))element.scrollTop=element.scrollHeight},[events.length,deliverable,scrollTop])
  return <ThemeBoundary mode="scoped" theme="dark" legacyAliases className={styles.boundary} style={{width,height}}>
    <article className={styles.terminal} aria-label={roleLabel+": "+title} data-task-id={id} data-selected={selected||undefined}>
      <div className={styles.inputPort} data-side={inputSide} style={{top:inputOffset+"%"}}><CanvasPort port={{id:"in",label:"IN",direction:"input",type:"message"}} readOnly={readOnly} side={inputSide} /></div>
      <header className={styles.title+" terminal-task-drag"} title={l("拖动标题栏移动终端","Drag this title bar to move the terminal")}>
        <span className={styles.grip}><GripVertical size={12}/>{l("拖动","Drag")}</span>
        <span className={styles.lights} aria-hidden="true"><i/><i/><i/></span>
        <span className={styles.titleText}>{redactText(titleBarLabel??roleLabel+" — "+title)}</span>
        <Button className="nodrag nopan" size="icon" variant="ghost" aria-label={l("打开 ","Open ")+title} title={l("打开任务","Open task")} onClick={onOpen}><ArrowUpRight size={14}/></Button>
      </header>
      <div className={styles.intro+" nodrag nopan"}>{introContent??<div className={styles.introBox}><p>›_ <strong>{agentName}</strong> <span>({version})</span></p><dl><dt>{l("模型：","model:")}</dt><dd>{model}</dd><dt>{l("目录：","directory:")}</dt><dd>{directory}</dd></dl></div>}</div>
      <div ref={scroll} className={styles.activity+" nodrag nopan nowheel"} aria-label={title+l("活动"," activity")} onScroll={event=>onScroll?.(event.currentTarget.scrollTop)}>
        <p className={styles.assignment}><span aria-hidden="true">›</span>{redactText(assignment)}</p>
        {events.map(event=>event.kind==="command"?<div className={styles.tool} key={event.id}><ToolCall call={{id:event.id,name:redactText(event.text),status:"completed",output:event.output,arguments:{command:event.text},receipt:"authored-fixture"}} summary={<span className={styles.command}>• {redactText(event.text)} ▸</span>} renderOutput={output=><pre>{output}</pre>}/></div>:<p key={event.id}>{redactText(event.text)}</p>)}
        {deliverable&&showDeliverableInline&&<pre className={styles.output}>{redactText(deliverable)}</pre>}
      </div>
      <footer className={styles.footer+" nodrag nopan"}><div className={styles.receipt}><span><RuntimeStatusBadge status={status}/> · {l("本地示例","demo")}-{id.slice(0,3)}</span><Button variant="ghost" size="sm" onClick={onOutput} disabled={!deliverable}>{l("打开产物 ↗","Open output ↗")}</Button></div>
        <div className={styles.composer}><ChatComposer value={draft} onChange={onDraftChange} onSend={onSend} disabled={draftDisabled} sendDisabled={readOnly||sendDisabled} inputLabel={l("发送消息给 ","Message ")+title} placeholder={readOnly?l("只读终端","Read-only terminal"):l("发送后续消息 · Enter 提交","Send a follow-up · Enter to submit")} formLabel={l("终端后续消息","Terminal follow-up")} sendLabel={l("发送后续消息","Send follow-up")} sendContent={<ArrowUp size={14}/>} controls={<span>{footerLabel??<>{model} · {directory}</>}</span>}/></div>
      </footer>
      <div className={styles.outputPort} data-side={outputSide} style={{top:outputOffset+"%"}}><CanvasPort port={{id:"out",label:"OUT",direction:"output",type:"message"}} readOnly={readOnly} side={outputSide}/></div>
    </article>
  </ThemeBoundary>
}
