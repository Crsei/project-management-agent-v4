"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ArrowUpRight, Copy, Download, Film, Link2, Monitor, MoreHorizontal, Pause, Play, Plus, Redo2, RotateCcw, Save, Trash2, Undo2, Upload, X } from "lucide-react"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody } from "@easyuse-ui/ui/components/ui/sheet"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@easyuse-ui/ui/components/ui/dialog"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { Select, SelectTrigger, SelectContent, SelectItem } from "@easyuse-ui/ui/components/ui/select"
import { WorkflowCanvas } from "@easyuse-ui/ui/components/blocks/workflow-canvas"
import { CanvasPort } from "@easyuse-ui/ui/components/ui/canvas-port"
import type { CanvasNodeProps } from "@easyuse-ui/ui/components/ui/canvas-node"
import { CanvasConnectionForm } from "@easyuse-ui/ui/components/blocks/canvas-connection-form"
import { exportCanvasDocument } from "@easyuse-ui/ui/lib/canvas-validation"
import type { CanvasCommand, CanvasNodeRecord, CanvasSelection, CanvasDocument } from "@easyuse-ui/ui/lib/canvas-model"
import { RemainingPageStateProvider, useRemainingPageState } from "../../showcase/state"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { addBranch, commitCanvas, createCanvasState, editObject, importCanvas, redoCanvas, togglePlayback, undoCanvas } from "./controller"
import { definitions, movements, nodeDimensions, prompts, studioImage, titles } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><CreativeCanvas key={props.scenario} {...props} /></RemainingPageStateProvider>
}
function CreativeCanvas({ scenario, active, host, cache }: RemainingPageProps) {
  const { locale } = useI18n()
  const text = useCallback((zh: string, en: string) => locale === "en" ? en : zh, [locale])
  const [state, setState] = useRemainingPageState("creative-canvas:state", () => createCanvasState(scenario))
  const [modal, setModal] = useState<"reset" | "import" | "delete" | "connect" | null>(null)
  const [importDraft, setImportDraft] = useRemainingPageState("creative-canvas:import", () => "")
  const [nameDrafts, setNameDrafts] = useRemainingPageState<Record<string, string>>("creative-canvas:names", () => ({}))
  const sourceInput = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const readonly = scenario === "readonly"
  const locked = readonly || state.readState === "loading"
  const object = state.document.nodes.find(node => node.id === state.inspectorId)
  const title = useCallback((node: CanvasNodeRecord) => {
    if (titles[node.id]?.en === node.title) return titles[node.id][locale]
    if (locale === "zh-CN" && /^\d+ \/ (New direction|Motion preview)$/.test(node.title)) return node.title.replace("New direction", "新方向").replace("Motion preview", "镜头预览")
    return node.title
  }, [locale])
  const prompt = useCallback((node: CanvasNodeRecord) => prompts[node.id]?.en === node.config.text ? prompts[node.id][locale] : String(node.config.text ?? ""), [locale])
  const command = useCallback((command: CanvasCommand) => setState(previous => commitCanvas(previous, command, locked)), [setState, locked])
  const select = useCallback((selection: CanvasSelection) => setState(previous => ({ ...previous, selection })), [setState])
  const inspect = useCallback((nodeId: string) => setState(previous => ({ ...previous, inspectorId: nodeId, selection: { nodeIds: [nodeId], edgeIds: [] } })), [setState])
  const viewportChange = useCallback((viewport: NonNullable<CanvasDocument["viewport"]>) => setState(previous => ({ ...previous, document: { ...previous.document, viewport } })), [setState])
  useLayoutEffect(() => { if (active && contentRef.current) contentRef.current.scrollTop = Number(cache.get("creative-canvas:inspector-scroll") ?? 0) }, [active, cache, state.inspectorId])
  useEffect(() => {
    if (!active) return
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || !(event.target instanceof Element) || event.target.closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !locked) { event.preventDefault(); setState(previous => event.shiftKey ? redoCanvas(previous) : undoCanvas(previous)) }
      if (event.key === "Delete" && !locked && event.target.closest('[data-canvas-editor-context]') && (state.selection.nodeIds.length || state.selection.edgeIds.length)) { event.preventDefault(); setModal("delete") }
    }
    window.addEventListener("keydown", keyboard)
    return () => window.removeEventListener("keydown", keyboard)
  }, [active, locked, state.selection, setState])
  function download(content: string, name: string, type = "text/plain") {
    const url = URL.createObjectURL(new Blob([content], { type }))
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url)
  }
  async function copyPrompt() {
    if (!object) return
    try { await navigator.clipboard.writeText(prompt(object)); setState(previous => ({ ...previous, feedback: "copied", error: null })) }
    catch { setState(previous => ({ ...previous, error: text("剪贴板访问不可用。可下载文本。", "Clipboard access is unavailable. Download the text instead.") })) }
  }
  function changeImage(file: File | undefined) {
    if (!file || locked) return
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 256 * 1024) { setState(previous => ({ ...previous, error: text("请选择不超过 256 KB 的 PNG、JPEG 或 WebP 图片，以便保存在本地画布中。", "Choose a PNG, JPEG or WebP image up to 256 KB to embed in the local canvas.") })); return }
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === "string") setState(previous => editObject(previous, "source", { image: String(reader.result) }, locked)) }
    reader.onerror = () => setState(previous => ({ ...previous, error: text("无法读取此图片。画布已保留。", "The image could not be read. The canvas was preserved.") }))
    reader.readAsDataURL(file)
  }
  const source = state.document.nodes.find(node => node.type === "source")
  const image = source?.config.image && source.config.image !== "studio" ? String(source.config.image) : studioImage
  const renderNode = useCallback(({ node, selected, readOnly, definition }: CanvasNodeProps) => {
    const name = title(node), type = node.type
    const playing = state.playing.includes(node.id)
    return <article className={styles.node} style={nodeDimensions(type)} data-type={type} data-selected={selected || undefined} aria-label={text(type === "prompt" ? "提示" : type === "source" ? "来源" : "镜头预览", type === "prompt" ? "Prompt" : type === "source" ? "Source" : "Motion preview") + ": " + name}>
      <header className={styles.nodeHeading + " creative-node-heading"}><span className={styles.dot} /><span title={name}>{name}</span><Button size="icon-sm" variant="ghost" className="nodrag nopan" aria-label={text("检查 ", "Inspect ") + name} onClick={() => inspect(node.id)}><ArrowUpRight /></Button></header>
      <div className={styles.nodeBody}>
        <div className={styles.ports}>{definition?.ports.map(port => <CanvasPort key={port.id} port={port} readOnly={readOnly} />)}</div>
        {type === "prompt" ? <div className={styles.prompt}>
          <div className={styles.promptHeading}><span>{text("提示", "Prompt")}</span><span>{text("文本 → 视频", "Text → video")}</span></div>
          <Textarea className={styles.promptText + " nodrag nopan nowheel"} aria-label={text("提示文本：", "Prompt text: ") + name} value={prompt(node)} readOnly={locked} onChange={event => setState(previous => editObject(previous, node.id, { text: event.target.value }, locked))} onScroll={event => cache.set("creative-canvas:prompt-scroll:" + node.id, event.currentTarget.scrollTop)} ref={element => { if (element) { const value = Number(cache.get("creative-canvas:prompt-scroll:" + node.id) ?? 0); if (element.scrollTop !== value) element.scrollTop = value } }} />
          <div className={styles.promptMeta}><span>9:16</span><span>6s</span><span>{String(node.config.movement)}</span></div>
        </div> : <div className={styles.media} data-playing={playing && active || undefined} data-movement={String(node.config.movement ?? "push")}>
          {/* Native img accepts local data URLs; no remote media or avatar is requested. */}
          <img src={image} alt={type === "source" ? text("播客源画面 · 原创插画", "Podcast source frame · original illustration") : name} className={styles.studioImage} />
          {type === "source" ? <span className={styles.sourceStamp}>{text("源画面", "SOURCE FRAME")}</span> : <div className={styles.playbar + " nodrag nopan"}><Button size="icon-sm" variant="ghost" aria-label={text(playing ? "暂停 " : "播放 ", playing ? "Pause " : "Play ") + name} aria-pressed={playing} onClick={() => setState(previous => togglePlayback(previous, node.id))}>{playing ? <Pause /> : <Play />}</Button><span>6s · {text(movements[String(node.config.movement)]?.["zh-CN"] ?? "推近", String(node.config.movement) === "slide" ? "slide" : String(node.config.movement) === "pull" ? "pull back" : "push in")}</span><div className={styles.progress} /></div>}
        </div>}
        {type === "source" && <div className={styles.sourceFooter}><span>{text("参考图片", "Reference image")}</span><Button variant="ghost" size="icon-sm" className="nodrag nopan" disabled={locked} aria-label={text("替换源图片", "Replace source image")} onClick={() => sourceInput.current?.click()}><Upload /></Button></div>}
      </div>
    </article>
  }, [title, text, inspect, state.playing, active, prompt, locked, setState, image, cache])
  const feedback = state.feedback === "saved" ? text("已保存在内存", "Saved in memory") : state.feedback === "playing" ? text("播放样例镜头 · 未生成视频", "Playing sample motion · no video generated") : state.feedback === "stopped" ? text("样例播放已暂停", "Sample playback paused") : state.feedback === "imported" ? text("已导入本地画布", "Local canvas imported") : state.feedback === "copied" ? text("已复制文本", "Text copied") : state.document.revision === state.savedRevision ? text("已保存在内存", "Saved in memory") : text("未保存的修改", "Unsaved changes")
  return <div className={styles.workspace} data-page="creative-canvas">
    <section className={styles.main} ><header className={styles.header}><Film /><h1>{text("视频方向分支", "Video variations")}</h1><span className={styles.description}>{text("播客 / 镜头方向", "Podcast / camera directions")}</span><div className={styles.headerActions}>
      <Button variant="ghost" size="icon" aria-label={text("撤销", "Undo")} disabled={locked || !state.past.length} onClick={() => setState(undoCanvas)}><Undo2 /></Button><Button variant="ghost" size="icon" aria-label={text("重做", "Redo")} disabled={locked || !state.future.length} onClick={() => setState(redoCanvas)}><Redo2 /></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={text("工作区操作", "Workspace actions")} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onClick={() => download(exportCanvasDocument(state.document), "creative-canvas.json", "application/json")}><Download />{text("导出项目", "Export project")}</DropdownMenuItem><DropdownMenuItem disabled={locked} onClick={() => setModal("import")}><Upload />{text("导入项目", "Import project")}</DropdownMenuItem><DropdownMenuItem disabled={locked} onClick={() => setModal("connect")}><Link2 />{text("连接对象", "Connect objects")}</DropdownMenuItem><DropdownMenuItem disabled={locked || !(state.selection.nodeIds.length || state.selection.edgeIds.length)} onClick={() => setModal("delete")}><Trash2 />{text("删除所选对象", "Delete selected objects")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <Button variant="ghost" size="icon" disabled={locked} aria-label={text("保存画布", "Save canvas")} onClick={() => setState(previous => ({ ...previous, savedRevision: previous.document.revision, feedback: "saved" }))}><Save /></Button><Button variant="ghost" size="icon" disabled={locked} aria-label={text("重置示例", "Reset example")} onClick={() => setModal("reset")}><RotateCcw /></Button><Button variant="ghost" disabled={locked} onClick={() => setState(previous => addBranch(previous, locked))}><Plus />{text("分支", "Branch")}</Button><Button disabled={state.readState === "loading" || !state.document.nodes.some(node => node.type === "clip")} onClick={() => setState(previous => togglePlayback(previous))}>{state.playing.length ? <Pause /> : <Play />}{text(state.playing.length ? "暂停样例" : "运行样例", state.playing.length ? "Pause demo" : "Run demo")}</Button>
    </div><Button variant="ghost" size="icon" aria-label={text("切换主题", "Toggle theme")} onClick={() => host.setTheme(host.resolvedTheme === "dark" ? "light" : "dark")}><Monitor /></Button></header>
    {readonly && <div className={styles.notice}>{text("只读画布。仍可检查对象、调整视口和播放本地样例。", "Read-only canvas. Inspect objects, adjust the viewport and play local samples.")}</div>}
    {state.readState === "error" && <div className={styles.notice} role="alert">{text("刷新失败。保留上次读取的画布与草稿。", "Refresh failed. The last canvas and drafts were preserved.")}<Button variant="ghost" onClick={() => setState(previous => ({ ...previous, readState: "ready", error: null }))}>{text("重试读取本地样例", "Retry local fixture")}</Button></div>}
    {state.error && <div className={styles.notice} role="alert">{state.error}<Button variant="ghost" size="icon-sm" aria-label={text("关闭错误", "Dismiss error")} onClick={() => setState(previous => ({ ...previous, error: null }))}><X /></Button></div>}
    <div className={styles.canvasRegion} aria-busy={state.readState === "loading"}>
      {state.readState === "loading" ? <div className={styles.loading}><div /><div /><div /><p>{text("正在读取本地画布样例…", "Reading the local canvas fixture…")}</p><Button onClick={() => setState(previous => ({ ...previous, readState: "ready" }))}>{text("完成样例读取", "Finish fixture read")}</Button></div> : <WorkflowCanvas className={styles.canvas} document={state.document} definitions={definitions} selection={state.selection} onSelectionChange={select} onCommand={command} readOnly={locked} viewport={state.document.viewport} onViewportChange={viewportChange} onOpenNode={inspect} renderNode={renderNode} presentation="media" nodeDragHandle=".creative-node-heading" toolbarActions={<><Button variant="ghost" size="icon" disabled={locked} aria-label={text("添加视频分支", "Add video branch")} onClick={() => setState(previous => addBranch(previous, locked))}><Plus /></Button><Button variant="ghost" size="icon" disabled={locked} aria-label={text("替换源图片", "Replace source image")} onClick={() => sourceInput.current?.click()}><Upload /></Button></>} />}
      {!state.document.nodes.length && state.readState !== "loading" && <div className={styles.empty}><Film /><h2>{text("画布中还没有方向分支", "No video directions on this canvas")}</h2><p>{text("添加分支，编辑提示并预览样例镜头。", "Add a branch, edit its prompt and preview a sample motion.")}</p><Button disabled={locked} onClick={() => setState(previous => addBranch(previous, locked))}><Plus />{text("添加视频分支", "Add video branch")}</Button></div>}
    </div>
    <footer className={styles.footer}><span>{text("本地样例 · 原创插画", "Scripted demo · original illustration")}<span> · {text("拖动标题 · 连接端口", "Drag headings · connect ports")}</span></span><span role="status">{feedback}</span></footer></section>
    <input ref={sourceInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label={text("选择本地源图片", "Choose local source image")} onChange={event => { changeImage(event.target.files?.[0]); event.target.value = "" }} />
    <Sheet open={Boolean(object)} onOpenChange={open => { if (!open) setState(previous => ({ ...previous, inspectorId: null })) }}><SheetContent size={384} className={styles.inspector}><SheetHeader className={styles.inspectorHeader}><SheetTitle className={styles.inspectorTitle}>{object ? title(object) : text("对象检查器", "Object inspector")}</SheetTitle><SheetDescription className={styles.inspectorDescription}>{text("检查并编辑工作区对象。", "Inspect and edit this workspace object.")}</SheetDescription></SheetHeader><SheetBody className={styles.inspectorScroll}>{object && <div ref={contentRef} className={styles.inspectorBody} onScroll={event => cache.set("creative-canvas:inspector-scroll", event.currentTarget.scrollTop)}><p className={styles.objectStatus}><span className={styles.dot} />{text(object.type === "prompt" ? "提示" : object.type === "source" ? "来源" : "镜头预览", object.type === "prompt" ? "Prompt" : object.type === "source" ? "Source" : "Motion preview")} · {text("就绪", "Ready")}</p>
      <Field label={text("名称", "Name")} error={nameDrafts[object.id] === "" ? text("名称不能为空", "Name is required") : undefined}>{control => <Input {...control} value={nameDrafts[object.id] ?? title(object)} readOnly={locked} onChange={event => setNameDrafts(previous => ({ ...previous, [object.id]: event.target.value }))} onBlur={event => { if (!locked && event.target.value.trim() && nameDrafts[object.id] !== undefined) { setState(previous => editObject(previous, object.id, { title: event.target.value }, locked)); setNameDrafts(previous => { const next = { ...previous }; delete next[object.id]; return next }) } }} />}</Field>
      {object.type === "prompt" ? <><Field label={text("内容", "Content")}>{control => <Textarea {...control} className={styles.inspectorText} value={prompt(object)} readOnly={locked} onChange={event => setState(previous => editObject(previous, object.id, { text: event.target.value }, locked))} />}</Field><Field label={text("镜头运动", "Camera movement")}>{control => <Select value={String(object.config.movement)} disabled={locked} onValueChange={value => { if (value) setState(previous => editObject(previous, object.id, { movement: value }, locked)) }}><SelectTrigger {...control} className={styles.select}>{movements[String(object.config.movement)]?.[locale]}</SelectTrigger><SelectContent>{Object.entries(movements).map(([key, label]) => <SelectItem key={key} value={key}>{label[locale]}</SelectItem>)}</SelectContent></Select>}</Field><div className={styles.inspectorActions}><Button variant="secondary" onClick={copyPrompt}><Copy />{text("复制文本", "Copy text")}</Button><Button variant="secondary" onClick={() => download(prompt(object), object.id + ".txt")}><Download />{text("下载文本", "Download text")}</Button><Button variant="secondary" disabled={!state.document.edges.some(edge => edge.source === object.id && state.document.nodes.some(node => node.id === edge.target && node.type === "clip"))} onClick={() => { const edge = state.document.edges.find(edge => edge.source === object.id && state.document.nodes.some(node => node.id === edge.target && node.type === "clip")); if (edge) setState(previous => togglePlayback(previous, edge.target)) }}><Play />{text("播放此对象的样例", "Run from this object")}</Button></div></> : <><div className={styles.inspectorPreview}><img src={image} alt={title(object)} /></div>{object.type === "source" ? <Button variant="secondary" disabled={locked} onClick={() => sourceInput.current?.click()}><Upload />{text("替换源图片", "Replace source image")}</Button> : <Button variant="secondary" onClick={() => setState(previous => togglePlayback(previous, object.id))}>{state.playing.includes(object.id) ? <Pause /> : <Play />}{text(state.playing.includes(object.id) ? "暂停样例" : "播放样例", state.playing.includes(object.id) ? "Pause sample" : "Play sample")}</Button>}</>}
      <section className={styles.connections}><h3>{text("已连接的输入", "Connected inputs")}</h3>{state.document.edges.filter(edge => edge.target === object.id).map(edge => { const parent = state.document.nodes.find(node => node.id === edge.source); return <div key={edge.id}><Button variant="ghost" onClick={() => inspect(edge.source)}>{parent ? title(parent) : edge.source}</Button><Button variant="ghost" size="icon-sm" disabled={locked} aria-label={text("断开 ", "Disconnect ") + edge.source + text(" 到 ", " from ") + edge.target} onClick={() => command({ type: "delete", selection: { nodeIds: [], edgeIds: [edge.id] } })}><X /></Button></div> })}{!state.document.edges.some(edge => edge.target === object.id) && <p>{text("没有已连接输入", "No connected inputs")}</p>}</section>
    </div>}</SheetBody></SheetContent></Sheet>
    <Dialog open={modal !== null} onOpenChange={open => { if (!open) setModal(null) }}><DialogContent><DialogTitle>{text(modal === "reset" ? "重置本地画布？" : modal === "delete" ? "删除所选对象？" : modal === "connect" ? "连接画布对象" : "导入本地画布", modal === "reset" ? "Reset local canvas?" : modal === "delete" ? "Delete selected objects?" : modal === "connect" ? "Connect canvas objects" : "Import local canvas")}</DialogTitle><DialogDescription>{text("仅影响此页面与此场景的内存草稿，不调用外部服务。", "Only this page and scenario’s in-memory draft are affected. No external service is called.")}</DialogDescription>
      {modal === "import" && <Field id={id} label={text("画布 JSON", "Canvas JSON")}>{control => <Textarea {...control} value={importDraft} onChange={event => setImportDraft(event.target.value)} className={styles.importText} />}</Field>}
      {modal === "import" && state.error && <p role="alert">{text("导入未完成：", "Import failed: ") + state.error}</p>}
      {modal === "connect" ? <CanvasConnectionForm document={state.document} definitions={definitions} readOnly={locked} onCommand={action => { command(action); setModal(null) }} /> : <div className={styles.dialogActions}><Button variant="secondary" onClick={() => setModal(null)}>{text("取消", "Cancel")}</Button><Button disabled={locked || modal === "import" && !importDraft.trim()} onClick={() => { if (modal === "reset") setState(previous => commitCanvas(previous, { type: "replace", document: createCanvasState(scenario).document }, locked)); if (modal === "delete") command({ type: "delete", selection: state.selection }); if (modal === "import") { const next = importCanvas(state, importDraft, locked); setState(next); if (next.error) return } setModal(null) }}>{text(modal === "import" ? "导入" : modal === "delete" ? "删除" : "重置", modal === "import" ? "Import" : modal === "delete" ? "Delete" : "Reset")}</Button></div>}
    </DialogContent></Dialog>
  </div>
}
