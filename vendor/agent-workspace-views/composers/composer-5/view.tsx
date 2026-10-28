"use client"

import { useEffect, useId, useRef, useState } from "react"
import { ArrowDown, Box, CalendarDays, ChevronRight, Circle, FileSpreadsheet, FileText, HardDrive, Hash, Mail, Mic, Plus, Search, SquareLibrary, Upload } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { ButtonTooltip } from "@easyuse-ui/ui/components/ui/button-tooltip"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogFooter } from "@easyuse-ui/ui/components/ui/dialog"
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@easyuse-ui/ui/components/ui/popover"
import { Suggestions } from "@easyuse-ui/ui/components/blocks/suggestions"
import { ChatMessage } from "@easyuse-ui/ui/components/blocks/chat-message"
import { MessageContent } from "@easyuse-ui/ui/components/blocks/message-content"
import { ComposerInput } from "../../composer-input"
import { ComposerWorkspaceView } from "../../composer-workspace-view"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { usePageController, type PageController } from "./controller"
import { apps, prompts, references } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
const promptIcons = [FileSpreadsheet, SquareLibrary, Mail, CalendarDays, FileText]
const appIcons = { notion: SquareLibrary, slack: Hash, linear: Circle, drive: HardDrive }

function ContextMenu({ controller: c }: { controller: PageController }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const available = references.filter(r => c.sources.connected.includes(r.app) && `${r.name} ${c.copy(r.description)}`.toLowerCase().includes(query.toLowerCase()))
  return <Popover open={open && c.active} onOpenChange={setOpen}>
    <ButtonTooltip label={c.label("添加上下文", "Add context")}>
      <PopoverTrigger render={<Button variant="ghost" size="icon" disabled={c.readonly} aria-label={c.label("添加上下文", "Add context")} />}><Plus /></PopoverTrigger>
    </ButtonTooltip>
    <PopoverContent className={styles.contextMenu} sideOffset={12} onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"))
      if (!controls.length) return
      const index = controls.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : event.key === "ArrowDown" ? (index + 1) % controls.length : (index - 1 + controls.length) % controls.length
      event.preventDefault()
      controls[next].focus()
    }}>
      <div className={styles.contextHeading}>
        <div><PopoverTitle>{c.label("添加上下文", "Add context")}</PopoverTitle><PopoverDescription>{c.label("会议、文档和已连接应用 · 本地示例", "Meetings, documents, and connected apps · Local example")}</PopoverDescription></div>
        <span aria-hidden="true">↑ ↓ Enter</span>
      </div>
      <div className={styles.contextSearch}><Search size={14} /><Input aria-label={c.label("筛选来源", "Filter sources")} value={query} onChange={e => setQuery(e.target.value)} placeholder={c.label("搜索会议或文档", "Search meetings or documents")} /></div>
      <div role="group" aria-label={c.label("可用上下文", "Available context")}>
        {available.map(r => <Button className={styles.contextRow} variant="ghost" key={r.id} aria-pressed={c.draft.contextIds.includes(r.id)} onClick={() => { c.toggleReference(r.id); setOpen(false) }}>
          <FileText size={16} /><span><strong>{r.name}</strong><small>{c.copy(r.description)}</small></span><small>{c.copy(r.kind)}</small>
        </Button>)}
        {!available.length && <p className={styles.empty}>{c.label("没有匹配的已连接来源。清除筛选，或在下方连接一个示例应用。", "No matching connected sources. Clear the filter or connect a fixture app below.")}</p>}
      </div>
      <Button variant="ghost" className={styles.contextRow} onClick={() => { setOpen(false); c.fileInput.current?.click() }}><Upload size={16} />{c.label("选择本地 CSV 描述", "Choose a local CSV descriptor")}</Button>
    </PopoverContent>
  </Popover>
}

function Sources({ controller: c }: { controller: PageController }) {
  return <div className={styles.sources} data-composer5-region="sources">
    <span>{c.label("从你的应用中获得更好的答案", "Get better answers from your apps")}</span>
    <div>{apps.map(app => {
      const Icon = appIcons[app.id]
      const connected = c.sources.connected.includes(app.id)
      const label = `${app.name} ${c.label(connected ? "已连接" : "未连接", connected ? "connected" : "not connected")}`
      return <ButtonTooltip key={app.id} label={label}><Button variant="ghost" size="icon-sm" aria-label={label} data-app={app.id} data-connected={connected} className={styles.appButton} onClick={() => c.setSourceId(app.id)}><Icon size={16} /></Button></ButtonTooltip>
    })}</div>
  </div>
}

function WorkspaceBody({ controller: c }: { controller: PageController }) {
  const { history } = c
  const id = useId()
  const carousel = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  useEffect(() => {
    const rail = carousel.current
    if (!rail) return
    const observer = new ResizeObserver(() => setHasOverflow(rail.scrollWidth > rail.clientWidth))
    observer.observe(rail)
    return () => observer.disconnect()
  }, [c.locale, c.hasMessages, c.suggestionsVisible])
  return <div className={styles.body} data-history={c.hasMessages} data-composer5-region="body">
    {c.hasMessages && <div ref={history} onScroll={c.rememberPosition} className={styles.history} role="region" aria-label={c.label("对话记录", "Conversation history")} tabIndex={0}>
      {c.selected.messages.map(message => <div className={styles.message} key={message.id}>
        <ChatMessage id={message.id} role={message.role === "assistant" ? "agent" : "user"} author={message.role === "assistant" ? c.label("工作空间助手 · 本地示例", "Workspace assistant · Local example") : undefined} content={c.copy(message.text)} renderContent={content => <MessageContent content={content} />}>
          {!!message.contexts?.length && <div className={styles.citations} aria-label={c.label("引用来源", "Cited sources")}>{message.contexts.map(name => {
            const reference = references.find(r => r.name === name)
            return reference ? <Button size="sm" variant="secondary" key={name} onClick={() => c.setReferenceId(reference.id)}><FileText size={14} />{name}</Button> : <span key={name}>{name}</span>
          })}</div>}
        </ChatMessage>
      </div>)}
    </div>}
    <section className={styles.workspaceContent} aria-label={c.label("工作空间助手", "Workspace assistant")}>
      {!c.hasMessages && <>
        <div className={styles.welcome}>
          <Box className={styles.assistantLogo} aria-hidden="true" />
          <h1>{c.label("你想完成什么？", "What would you like to accomplish?")}</h1>
          <p>{c.label("跨会议、文档和已连接的工作空间提问。", "Ask across your meetings, documents, and connected workspace.")}</p>
        </div>
        {c.suggestionsVisible && <div className={styles.suggestionRail} data-selected={c.suggestion} data-composer5-region="suggestions">
          <div ref={carousel} className={styles.suggestionScroll}>
            <Suggestions className={styles.suggestions} disabled={c.readonly} items={prompts.map((p, i) => { const Icon = promptIcons[i]; return { id: p.id, label: c.copy(p.label), prompt: c.copy(p.prompt), icon: <><Icon /><ArrowDown className={styles.promptArrow} /></>, disabledReason: c.label("只读场景不能更改建议", "Suggestions cannot change in the read-only scenario") } })} onSelect={item => c.choosePrompt(item.id)} />
          </div>
          {hasOverflow && <ButtonTooltip label={c.label("显示更多建议", "Show more suggestions")}><Button variant="secondary" size="icon-sm" className={styles.moreSuggestions} aria-label={c.label("显示更多建议", "Show more suggestions")} onClick={() => { const rail = carousel.current; if (rail) rail.scrollTo({ left: rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1 ? 0 : rail.scrollLeft + rail.clientWidth * 0.6, behavior: "auto" }) }}><ChevronRight /></Button></ButtonTooltip>}
        </div>}
      </>}
      {(c.readState !== "ready" || c.readonly || c.notice) && <div role={c.readState === "error" ? "alert" : "status"} className={styles.notice}>
        <span>{c.readonly ? c.label("只读预览：草稿保留，不能发送或修改来源。", "Read-only preview: draft preserved; sending and source changes are unavailable.") : c.readState === "loading" ? c.label("正在加载示例来源；已有草稿保留。", "Loading fixture sources; your draft is preserved.") : c.readState === "error" ? c.label("刷新失败。仍显示上一次来源和草稿。", "Refresh failed. The last sources and draft remain visible.") : c.notice && c.copy(c.notice)}</span>
        {c.readState !== "ready" && <Button variant="secondary" onClick={() => c.setReadState("ready")}>{c.label(c.readState === "loading" ? "完成示例加载" : "重试示例读取", c.readState === "loading" ? "Finish fixture loading" : "Retry fixture read")}</Button>}
      </div>}
      <div data-composer5-region="composer">
        <ComposerInput controller={c} helpId={`${id}-submit-help`} options={{ hideSuggestion: true, showBlocksControl: false, formLabel: { "zh-CN": "开始工作空间会话", en: "Start a workspace session" }, inputLabel: { "zh-CN": "向工作空间助手发送消息", en: "Message the workspace assistant" }, placeholder: { "zh-CN": "询问项目、会议或文档", en: "Ask about a project, meeting, or document" }, leadingAction: <ContextMenu controller={c} />, tools: <ButtonTooltip label={c.label("使用语音输入", "Use voice input")}><Button variant="ghost" size="icon" disabled={c.readonly} aria-label={c.label("使用语音输入", "Use voice input")} onClick={() => c.setVoiceOpen(true)}><Mic /></Button></ButtonTooltip> }} />
        <Sources controller={c} />
      </div>
    </section>
  </div>
}

function SourceDialog({ controller: c }: { controller: PageController }) {
  const app = apps.find(a => a.id === c.sourceId)
  const connected = app ? c.sources.connected.includes(app.id) : false
  return <Dialog open={Boolean(app) && c.active} onOpenChange={open => { if (!open) c.setSourceId(null) }}>
    <DialogContent>
      <DialogTitle>{app?.name}</DialogTitle>
      <DialogDescription>{c.label("仅连接内存中的示例来源；不登录、授权或访问外部应用。", "Connects in-memory fixture sources only; no sign-in, authorization, or external app access.")}</DialogDescription>
      <div className={styles.sourceList}>
        <p>{c.label(connected ? "示例来源已连接" : "示例来源未连接", connected ? "Fixture source connected" : "Fixture source not connected")}</p>
        {references.filter(r => r.app === app?.id).map(r => <Button className={styles.contextRow} variant="ghost" key={r.id} onClick={() => c.setReferenceId(r.id)}><FileText /><span><strong>{r.name}</strong><small>{c.copy(r.description)}</small></span><ChevronRight /></Button>)}
      </div>
      <DialogFooter><Button variant="secondary" onClick={() => c.setSourceId(null)}>{c.label("关闭", "Close")}</Button><Button disabled={c.readonly} onClick={() => { if (app) c.toggleConnection(app.id) }}>{c.label(connected ? "断开示例来源" : "连接示例来源", connected ? "Disconnect fixture source" : "Connect fixture source")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function RemainingPageView(props: RemainingPageProps) {
  const c = usePageController(props)
  const { fileInput } = c
  const reference = references.find(r => r.id === c.referenceId)
  return <>
    <ComposerWorkspaceView controller={c} host={props.host} presentation={{ id: "composer-5", title: { "zh-CN": "Composer 5", en: "Composer 5" }, welcome: { title: { "zh-CN": "你想完成什么？", en: "What would you like to accomplish?" }, description: { "zh-CN": "跨会议、文档和已连接的工作空间提问。", en: "Ask across your meetings, documents, and connected workspace." } }, renderBody: () => <WorkspaceBody controller={c} /> }} />
    <input type="file" accept=".csv,text/csv" hidden ref={fileInput} aria-label={c.label("选择本地 CSV 描述", "Choose a local CSV descriptor")} onChange={e => c.addFiles(e.target.files)} />
    <SourceDialog controller={c} />
    <Dialog open={Boolean(reference) && c.active} onOpenChange={open => { if (!open) c.setReferenceId(null) }}><DialogContent><DialogTitle>{reference?.name}</DialogTitle><DialogDescription>{c.label("固定示例来源。正文可以阅读；没有读取外部应用。", "Fixed fixture source. Readable content; no external app was read.")}</DialogDescription><div className={styles.referenceContent}>{reference && <MessageContent content={c.copy(reference.content)} />}</div><DialogFooter><Button disabled={c.readonly || !reference || !c.sources.connected.includes(reference.app)} onClick={() => { if (reference) c.toggleReference(reference.id); c.setReferenceId(null); c.setSourceId(null) }}>{c.label(reference && c.draft.contextIds.includes(reference.id) ? "移除引用" : "用于当前问题", reference && c.draft.contextIds.includes(reference.id) ? "Remove reference" : "Use for this question")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={c.voiceOpen && c.active} onOpenChange={c.setVoiceOpen}><DialogContent><DialogTitle>{c.label("语音输入 · 示例转录", "Voice input · Example transcript")}</DialogTitle><DialogDescription>{c.label("不会访问麦克风。编辑示例转录后将其插入草稿。", "No microphone access. Edit the example transcript, then insert it into your draft.")}</DialogDescription><Textarea className={styles.transcript} value={c.transcript} onChange={e => c.setTranscript(e.target.value)} aria-label={c.label("示例转录", "Example transcript")} /><DialogFooter><Button variant="secondary" onClick={() => c.setVoiceOpen(false)}>{c.label("取消", "Cancel")}</Button><Button disabled={!c.transcript.trim() || c.readonly} onClick={c.useTranscript}>{c.label("插入草稿", "Insert into draft")}</Button></DialogFooter></DialogContent></Dialog>
  </>
}
