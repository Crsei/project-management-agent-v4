"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, ArrowUp, ArrowUpDown, ChevronDown, FileJson, Files, FileText, MessageSquare, Monitor, Moon, PanelRightClose, PanelRightOpen, RotateCcw, Search, Table2, X } from "lucide-react"
import { ChatComposer, Conversation, type ChatMessageProps } from "@easyuse-ui/ui/components/blocks/chat-message"
import { MessageContent } from "@easyuse-ui/ui/components/blocks/message-content"
import { DataTable } from "@easyuse-ui/ui/components/blocks/data-table"
import { FileViewer } from "@easyuse-ui/ui/components/blocks/agent-workbench/review"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@easyuse-ui/ui/components/ui/input-group"
import { ResizableHandle } from "@easyuse-ui/ui/components/ui/resizable"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@easyuse-ui/ui/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@easyuse-ui/ui/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@easyuse-ui/ui/components/ui/tooltip"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { parseResourceCsv, type ResourceSnapshot } from "@easyuse-ui/ui/lib/workbench-resource-model"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { cabinetConversations, cabinetFiles, type Deliverable } from "./fixtures"
import { createCabinetState, createdTime, fileSize, openDeliverable, sendCabinetQuestion, sourceConversation, visibleDeliverables } from "./controller"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

function IconAction({ label, children, onClick, disabled, buttonRef }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; buttonRef?: React.RefObject<HTMLButtonElement | null> }) {
  return <Tooltip><TooltipTrigger render={<Button ref={buttonRef} variant="ghost" size="icon" aria-label={label} disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
}

function FileContent({ file, locale }: { file: Deliverable; locale: "zh-CN" | "en" }) {
  const content = file.content[locale]
  const resource: ResourceSnapshot = { projectId: "documents-fixture", sessionId: file.conversationId, resourceId: file.id, revision: "prepared-1", name: file.name, path: file.name, mediaType: file.renderer === "json" ? "application/json" : "text/plain", renderer: file.renderer, availability: "available", dataState: "success", complete: true, text: content }
  if (file.renderer === "markdown") return <MessageContent content={content} className={styles.documentMarkdown} />
  if (file.renderer === "csv") {
    const parsed = parseResourceCsv(content)
    const [head = [], ...rows] = parsed.rows
    return <><h1>{file.title[locale]}</h1><p>{rows.length} {locale === "en" ? "rows" : "行"} · {head.length} {locale === "en" ? "columns" : "列"}</p><DataTable rows={rows.map((cells, index) => ({ id: String(index), cells }))} columns={head.map((header, index) => ({ id: String(index), header, cell: (row: { cells: string[] }) => row.cells[index] }))} getRowId={row => row.id} getRowLabel={row => row.cells.join(", ")} caption={file.title[locale]} maxHeight={400} /><p className={styles.previewNote}>{locale === "en" ? "Showing the complete file. Download to continue working in a spreadsheet." : "已显示完整文件。下载后可在电子表格中继续处理。"}</p></>
  }
  return <><h1>{file.title[locale]}</h1><FileViewer resource={resource} revision={resource.revision} /></>
}

function CabinetPage({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => locale === "en" ? en : zh
  const [state, setState] = useRemainingPageState("deliverable-file-cabinet:" + scenario, () => createCabinetState(scenario))
  const [resetOpen, setResetOpen] = useState(false)
  const [downloadError, setDownloadError] = useState("")
  const root = useRef<HTMLDivElement>(null)
  const split = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const conversationRoot = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const lastOpenedFile = useRef<string | null>(null)
  const [splitWidth, setSplitWidth] = useState(0)
  const conversation = cabinetConversations.find(item => item.id === state.conversationId) ?? cabinetConversations[0]
  const selected = state.files.find(item => item.id === state.selectedFileId)
  const filtered = visibleDeliverables(state, locale)
  const ownFileCount = state.files.filter(item => item.conversationId === state.conversationId).length
  const draft = state.drafts[state.conversationId] ?? ""
  const previewKey = "file:" + state.selectedFileId
  const conversationKey = "conversation:" + state.conversationId
  const retained = useRef(state)
  useLayoutEffect(() => { retained.current = state }, [state])
  const restoreFileFocus = () => requestAnimationFrame(() => {
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-file-id="${lastOpenedFile.current}"] td:first-child button`)
    if (button) button.focus()
    else toggle.current?.focus()
  })
  useEffect(() => {
    const element = split.current
    if (!element) return
    const observer = new ResizeObserver(entries => setSplitWidth(entries[0].contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!active) return
    if (list.current) list.current.scrollTop = retained.current.positions.list ?? 0
    if (preview.current) preview.current.scrollTop = retained.current.positions[previewKey] ?? 0
    const history = conversationRoot.current?.querySelector<HTMLElement>("[tabindex]")
    if (history) history.scrollTop = retained.current.positions[conversationKey] ?? 0
    const textarea = root.current?.querySelector("textarea")
    const selection = retained.current.selections[state.conversationId]
    if (selection && textarea) textarea.setSelectionRange(selection.start, selection.end)
  }, [active, previewKey, conversationKey, state.panelOpen, state.conversationId, locale])

  useEffect(() => {
    if (!active) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !state.selectedFileId || (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]'))) return
      setState(previous => ({ ...previous, selectedFileId: null }))
      requestAnimationFrame(() => {
        const button = list.current?.querySelector<HTMLButtonElement>(`[data-file-id="${lastOpenedFile.current}"] td:first-child button`)
        if (button) button.focus()
        else toggle.current?.focus()
      })
    }
    window.addEventListener("keydown", onEscape)
    return () => window.removeEventListener("keydown", onEscape)
  }, [active, state.selectedFileId, setState])

  const fileUrl = useMemo(() => selected && typeof window !== "undefined" ? URL.createObjectURL(new Blob([selected.content[locale]], { type: "text/plain;charset=utf-8" })) : null, [selected, locale])
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl) }, [fileUrl])

  function download(file: Deliverable) {
    try {
      const mime = file.renderer === "json" ? "application/json" : file.renderer === "csv" ? "text/csv" : file.renderer === "markdown" ? "text/markdown" : "text/plain"
      const url = URL.createObjectURL(new Blob([file.content[locale]], { type: mime + ";charset=utf-8" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = file.name
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setDownloadError("")
    } catch {
      setDownloadError(label("浏览器无法准备下载。文件仍可阅读，请重试。", "The browser could not prepare the download. The file remains readable; try again."))
    }
  }

  const messages: ChatMessageProps[] = state.files.length ? [
    { id: conversation.id + "-request", role: "user", author: "", content: conversation.prompt[locale] },
    { id: conversation.id + "-response", role: "agent", author: "EasyuseUI AI", content: conversation.response[locale], renderContent: content => <MessageContent content={content} />, children: <Button variant="secondary" className={styles.viewFiles} onClick={() => setState(previous => ({ ...previous, panelOpen: true, selectedFileId: null, query: "", typeFilter: "all", conversationFilter: previous.conversationId }))}><Files aria-hidden="true" />{label("查看 " + ownFileCount + " 份产物", "View " + ownFileCount + " deliverables")}<ArrowUpRight aria-hidden="true" /></Button> },
  ] : []
  for (const message of state.messages[state.conversationId] ?? []) messages.push({ id: message.id, role: "user", author: "", content: message.prompt }, { id: message.id + "-reply", role: "agent", author: "EasyuseUI AI", content: message.reply[locale], renderContent: content => <MessageContent content={content} /> })

  const panelWidth = Math.max(360, Math.min(Math.max(360, splitWidth - 320), splitWidth * state.panelRatio))
  return <div className={styles.page} ref={root} data-remaining-page="deliverable-file-cabinet">
    <header className={styles.pageHeader}>
      <h1>{label("交付产物", "Deliverables")}</h1>
      <div className={styles.actions}>
        <Button ref={toggle} variant="ghost" onClick={() => setState(previous => ({ ...previous, panelOpen: !previous.panelOpen }))} aria-expanded={state.panelOpen} aria-controls="deliverable-cabinet-panel">{state.panelOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}{state.panelOpen ? label("隐藏文件", "Hide files") : label("打开文件", "Open files")}</Button>
        <IconAction label={label("重置产物示例", "Reset deliverables demo")} onClick={() => setResetOpen(true)}><RotateCcw /></IconAction>
        <IconAction label={label("切换主题", "Toggle theme")} onClick={() => host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")}>{host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}</IconAction>
      </div>
    </header>
    <div className={styles.split} ref={split}>
      <section className={styles.chat} aria-label={label("产物会话", "Deliverable conversation")}>
        <header className={styles.regionHeader}><h2 title={conversation.title[locale]}>{conversation.title[locale]}</h2></header>
        <div ref={conversationRoot} className={styles.conversation} onScrollCapture={event => {
          const element = event.target as HTMLElement
          if (!element.hasAttribute("tabindex")) return
          setState(previous => ({ ...previous, positions: { ...previous.positions, [conversationKey]: element.scrollTop } }))
        }}>
          <Conversation presentation="workspace" layout="fill" initialScroll="top" messages={messages} revision={messages.length} className={styles.messageList} data={{ state: state.readState === "loading" ? "loading" : messages.length ? "success" : "empty", emptyTitle: label("暂无产物会话", "No deliverable conversation yet"), emptyDescription: label("加载示例文件以探索跨会话的产物与下载。", "Load the prepared files to explore cross-conversation deliverables and downloads."), loadingLabel: label("正在读取示例会话", "Reading prepared conversation") }} />
        </div>
        <div className={styles.composerDock} onSelectCapture={() => {
          const field = root.current?.querySelector("textarea")
          if (field) setState(previous => ({ ...previous, selections: { ...previous.selections, [previous.conversationId]: { start: field.selectionStart, end: field.selectionEnd } } }))
        }}>
          {selected && <Button variant="secondary" size="sm" className={styles.summarize} disabled={state.readonly || state.readState === "loading"} onClick={() => {
            setState(previous => ({ ...previous, drafts: { ...previous.drafts, [previous.conversationId]: label("总结这份文件：", "Summarize this file: ") + selected.name } }))
            root.current?.querySelector("textarea")?.focus()
          }}>{label("总结这份文件", "Summarize this file")}</Button>}
          <ChatComposer presentation="workspace" inputLabel={label("产物问题", "Deliverable question")} formLabel={label("询问产物", "Ask about deliverables")} placeholder={selected ? label("询问这份文件…", "Ask about this file…") : label("询问这些产物…", "Ask about the deliverables…")} sendContent={<ArrowUp aria-hidden="true" />} value={draft} onChange={value => setState(previous => ({ ...previous, drafts: { ...previous.drafts, [previous.conversationId]: value } }))} onSend={() => setState(sendCabinetQuestion)} disabled={state.readonly || state.readState === "loading"} controls={<span>{selected?.name ?? label(ownFileCount + " 份文件在此会话中", ownFileCount + " files in this conversation")}</span>} sendLabel={label("发送消息", "Send message")} />
          <p>{state.readonly ? label("只读：可查看和下载，不能发送消息。", "Read only: review and download files; sending is unavailable.") : label("预先准备的示例文件与本地回复", "Prepared demo files and local replies")}</p>
        </div>
      </section>
      {state.panelOpen && <>
        <ResizableHandle className={styles.handle} unstyled reverse value={panelWidth} min={360} max={Math.max(360, splitWidth - 320)} label={label("调整产物文件柜宽度", "Resize deliverable file cabinet")} controls="deliverable-cabinet-panel" onValueChange={width => setState(previous => ({ ...previous, panelRatio: width / splitWidth }))} />
        <section className={styles.cabinet} id="deliverable-cabinet-panel" aria-label={label("文件柜", "File cabinet")} style={{ width: splitWidth ? panelWidth : "62%" } as CSSProperties}>
          {selected ? <>
            <header className={styles.regionHeader}>
              <div className={styles.fileTitle}><IconAction label={label("返回文件", "Back to files")} onClick={() => { setState(previous => ({ ...previous, selectedFileId: null })); restoreFileFocus() }}><ArrowLeft /></IconAction><h2 title={selected.name}>{selected.name}</h2></div>
              <div className={styles.actions}>
                {fileUrl && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" nativeButton={false} role="link" render={<a href={fileUrl} target="_blank" rel="noopener noreferrer" />} aria-label={label("在新标签页打开文件", "Open file in new tab")} />}><ArrowUpRight /></TooltipTrigger><TooltipContent>{label("在新标签页打开文件", "Open file in new tab")}</TooltipContent></Tooltip>}
                <IconAction label={label("下载 ", "Download ") + selected.name} onClick={() => download(selected)}><ArrowDownToLine /></IconAction>
                <IconAction label={label("关闭文件柜", "Close file cabinet")} onClick={() => { setState(previous => ({ ...previous, panelOpen: false })); toggle.current?.focus() }}><PanelRightClose /></IconAction>
              </div>
            </header>
            <div ref={preview} className={styles.previewScroll} tabIndex={0} aria-label={label("文件预览", "File preview")} onScroll={event => setState(previous => ({ ...previous, positions: { ...previous.positions, [previewKey]: event.currentTarget.scrollTop } }))}>
              <div className={styles.previewMeta}><span>{selected.renderer.toUpperCase()} · {fileSize(selected, locale)} · {label("今天", "Today")}, {createdTime(selected)}</span><Button variant="ghost" size="sm" onClick={() => setState(sourceConversation)}><MessageSquare aria-hidden="true" />{label("来源会话", "Source conversation")}</Button></div>
              <article className={styles.document}><FileContent file={selected} locale={locale} /></article>
              <p className={styles.source}>{label("来自", "From")} “{cabinetConversations.find(item => item.id === selected.conversationId)?.title[locale]}”</p>
            </div>
          </> : <>
            <header className={styles.regionHeader}>
              <div className={styles.fileTitle}><Files aria-hidden="true" /><h2>{label("文件", "Files")}</h2><span className={styles.count}>{state.files.length}</span></div>
              <div className={styles.actions}>
                <Select value={state.conversationFilter} onValueChange={value => setState(previous => ({ ...previous, conversationFilter: value ?? "all" }))}>
                  <SelectTrigger className={styles.conversationFilter} aria-label={label("按会话筛选", "Filter by conversation")}><SelectValue>{state.conversationFilter === "all" ? label("所有会话", "All conversations") : cabinetConversations.find(item => item.id === state.conversationFilter)?.title[locale]}</SelectValue><ChevronDown size={14} /></SelectTrigger>
                  <SelectContent><SelectItem value="all">{label("所有会话", "All conversations")}</SelectItem>{cabinetConversations.map(item => <SelectItem key={item.id} value={item.id}>{item.title[locale]}</SelectItem>)}</SelectContent>
                </Select>
                <IconAction label={label("关闭文件柜", "Close file cabinet")} onClick={() => { setState(previous => ({ ...previous, panelOpen: false })); toggle.current?.focus() }}><PanelRightClose /></IconAction>
              </div>
            </header>
            <div className={styles.filters}>
              <InputGroup className={styles.search}><InputGroupAddon><Search size={16} aria-hidden="true" /></InputGroupAddon><InputGroupInput value={state.query} onChange={event => setState(previous => ({ ...previous, query: event.target.value }))} aria-label={label("搜索产物", "Search deliverables")} placeholder={label("搜索文件…", "Search files…")} />{state.query && <Button variant="ghost" size="icon-sm" aria-label={label("清除搜索", "Clear search")} onClick={() => setState(previous => ({ ...previous, query: "" }))}><X /></Button>}</InputGroup>
              <Select value={state.typeFilter} onValueChange={value => setState(previous => ({ ...previous, typeFilter: value as "all" | "documents" | "data" }))}>
                <SelectTrigger className={styles.typeFilter} aria-label={label("筛选文件类型", "Filter file type")}><SelectValue>{state.typeFilter === "all" ? label("所有类型", "All types") : state.typeFilter === "data" ? label("数据", "Data") : label("文档", "Documents")}</SelectValue><ChevronDown size={14} /></SelectTrigger>
                <SelectContent><SelectItem value="all">{label("所有类型", "All types")}</SelectItem><SelectItem value="documents">{label("文档", "Documents")}</SelectItem><SelectItem value="data">{label("数据", "Data")}</SelectItem></SelectContent>
              </Select>
              <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={label("文件排序", "Sort files")} />}><ArrowUpDown /></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuGroup><DropdownMenuRadioGroup value={state.sort} onValueChange={value => setState(previous => ({ ...previous, sort: value as "newest" | "name" }))}><DropdownMenuRadioItem value="newest" closeOnClick>{label("最新优先", "Newest first")}</DropdownMenuRadioItem><DropdownMenuRadioItem value="name" closeOnClick>{label("名称 A–Z", "Name A–Z")}</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
            </div>
            <div className={styles.listScroll} ref={list} tabIndex={0} aria-label={label("产物文件列表", "Deliverable file list")} onScroll={event => setState(previous => ({ ...previous, positions: { ...previous.positions, list: event.currentTarget.scrollTop } }))}>
              <DataRegion state={state.readState === "loading" ? "loading" : state.readState === "error" ? "error" : filtered.length ? "success" : "empty"} hasContent={state.files.length > 0} rowHeight={64} loadingLabel={label("正在读取预先准备的文件", "Reading prepared files")} error={{ category: "request", message: label("刷新失败，已有文件仍然可用。", "Refresh failed; existing files are still available."), reason: label("固定示例读取失败；草稿、筛选与阅读位置均已保留。", "Fixed fixture read failed; drafts, filters and reading positions are preserved.") }} onRetry={() => setState(previous => ({ ...previous, files: previous.files.length ? previous.files : cabinetFiles, readState: "ready" }))} emptyTitle={state.files.length ? label("没有匹配的文件", "No matching files") : label("还没有文件", "No files yet")} emptyDescription={state.files.length ? label("尝试其他搜索词，或清除筛选。", "Try another search or clear the filters.") : label("产物会在所属会话中生成，并集中展示在这里。", "Deliverables created in your conversations will appear here.")} emptyAction={<Button variant="secondary" onClick={() => setState(previous => ({ ...previous, query: "", typeFilter: "all", conversationFilter: "all", files: previous.files.length ? previous.files : cabinetFiles, readState: "ready" }))}>{state.files.length ? label("清除筛选", "Clear filters") : label("加载示例文件", "Load prepared files")}</Button>}>
                <p className={styles.listSummary}>{filtered.length} {label("份文件", "files")} · {state.sort === "newest" ? label("最新优先", "Newest first") : label("名称 A–Z", "Name A–Z")}</p>
                <Table className={styles.fileTable} aria-label={label("跨会话产物", "Cross-conversation deliverables")}><TableHeader><TableRow><TableHead>{label("文件", "File")}</TableHead><TableHead>{label("创建时间", "Created")}</TableHead><TableHead>{label("大小", "Size")}</TableHead><TableHead><span className="sr-only">{label("下载", "Download")}</span></TableHead></TableRow></TableHeader><TableBody>{filtered.map(file => <TableRow key={file.id} data-file-id={file.id}><TableCell><button className={styles.fileButton} onClick={() => { lastOpenedFile.current = file.id; setState(previous => openDeliverable(previous, file.id)); requestAnimationFrame(() => preview.current?.focus()) }}><span className={styles.fileIcon}>{file.renderer === "csv" ? <Table2 /> : file.renderer === "json" ? <FileJson /> : <FileText />}</span><span className={styles.fileIdentity}><strong title={file.name}>{file.name}</strong><small>{cabinetConversations.find(item => item.id === file.conversationId)?.title[locale]}</small></span></button></TableCell><TableCell>{createdTime(file)}</TableCell><TableCell>{fileSize(file, locale)}</TableCell><TableCell><IconAction label={label("下载 ", "Download ") + file.name} onClick={() => download(file)}><ArrowDownToLine /></IconAction></TableCell></TableRow>)}</TableBody></Table>
              </DataRegion>
              {state.readState === "loading" && <Button variant="secondary" onClick={() => setState(previous => ({ ...previous, files: cabinetFiles, readState: "ready" }))}>{label("载入示例文件", "Load prepared files")}</Button>}
            </div>
            <footer className={styles.cabinetFooter}>{label("文件来自 2 个会话 · 本地示例", "Files generated in 2 conversations · Local demo")}</footer>
          </>}
          {downloadError && <p role="alert" className={styles.downloadError}>{downloadError}</p>}
        </section>
      </>}
    </div>
    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent><DialogHeader><DialogTitle>{label("重置产物示例？", "Reset deliverables demo?")}</DialogTitle><DialogDescription>{label("仅重置当前场景的草稿、会话回复、筛选和阅读位置。不会删除真实文件。", "Reset only this scenario’s drafts, replies, filters and reading positions. No real files will be deleted.")}</DialogDescription></DialogHeader><DialogBody><p>{label("其他页面和场景不会受影响。", "Other pages and scenarios are unaffected.")}</p></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setResetOpen(false)}>{label("取消", "Cancel")}</Button><Button onClick={() => { setState(createCabinetState(scenario)); setResetOpen(false) }}>{label("重置本地示例", "Reset local demo")}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><CabinetPage key={props.scenario} {...props} /></RemainingPageStateProvider>
}
