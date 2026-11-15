import { useLayoutEffect, useRef, useState } from "react"
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, ClipboardList, Clock3, FileCode2, FileText, Info, Link2, MessageSquare, Paperclip, Play, Radio, RefreshCw, Send, ShieldCheck, WifiOff } from "lucide-react"
import { DEMO_SESSION_ID, DEMO_TASK_ID, DEMO_TASK_TITLE, type DemoController } from "./model"
import styles from "./agent-pages.module.css"

const SOURCE_REVISION = "r7"
const LAST_PREVIEW_STEP = 3
const longConversation = [
  ["体验观察", "手机上的附件入口应先解释支持范围。这个 Demo 不会打开文件选择器，也不会读取任何本地文件。"],
  ["边界确认", "任务引用只提供这段对话的示例上下文，不会更换 Agent 身份，不会连接项目目录。"],
  ["离线阅读", "断网时保留已经展示的示例。输入草稿仅留在当前页面内存，不自动发送、不持久化。"],
  ["状态区分", "结果未知表示尚未核对，不代表运行失败。读取失败也不代表任务执行失败。"],
  ["版本依据", "当前任务引用来自 revision r7。过期示例需要先核对，不能直接继续推进。"],
  ["验收边界", "文案预览不是实现证据；测试、构建、人工验收在这个示例中都没有执行。"],
  ["交付提示", "即使示例 Run 展示为结束，任务仍需要独立验收。本页不会更新任务状态。"],
  ["阅读位置", "你可以向上阅读这些较长的说明；新预览出现时，只有接近底部才会自动跟随。"],
] as const

function DemoNote() {
  return <div className={styles.demoNote}><Info size={16} aria-hidden="true" /><span>固定示例 · 非模型生成 · 不连接真实 Agent</span></div>
}

function AgentList({ controller }: { controller: DemoController }) {
  const [filter, setFilter] = useState("全部")
  const filters = ["全部", "待我处理", "运行中", "最近会话"]
  return <section className={styles.page} aria-labelledby="demo-agent-title">
    <header className={styles.pageHeader}><span className={styles.eyebrow}>AGENT / 示例会话</span><h1 id="demo-agent-title">把下一步，聊清楚。</h1><p>先看需要你回应的事，再继续手边的工作。</p></header>
    <DemoNote />
    <div className={styles.filters} aria-label="筛选示例会话">{filters.map((item) => <button type="button" key={item} className={filter === item ? styles.filterActive : styles.filter} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>)}</div>
    {controller.scenario === "empty" ? <div className={styles.empty}><MessageSquare size={28} aria-hidden="true" /><h2>这里暂时没有会话</h2><p>这是空内容示例。切回正常预览可查看固定会话。</p><button type="button" className={styles.secondaryButton} onClick={() => controller.setScenario("ready")}>查看示例会话</button></div> : <div className={styles.listSections}>
      {(filter === "全部" || filter === "待我处理") && <section><h2 className={styles.sectionHeading}>需要我处理 <span>1</span></h2><button type="button" className={styles.sessionCard} onClick={() => controller.navigate({ page: "chat", id: DEMO_SESSION_ID })}><span className={styles.sessionIcon}><MessageSquare size={22} aria-hidden="true" /></span><span className={styles.sessionBody}><span className={styles.sessionTop}><strong>移动体验助手</strong><span className={styles.attention}>等待补充</span></span><span>{DEMO_TASK_TITLE}</span><span className={styles.meta}>{DEMO_SESSION_ID} · 示例会话 · 刚刚</span></span><ChevronRight size={18} aria-hidden="true" /></button></section>}
      {(filter === "全部" || filter === "运行中") && <section><h2 className={styles.sectionHeading}>运行中 <span>1</span></h2><button type="button" disabled className={styles.sessionCard}><span className={styles.sessionIcon}><Radio size={22} aria-hidden="true" /></span><span className={styles.sessionBody}><span className={styles.sessionTop}><strong>项目摘要助手</strong><span className={styles.neutralBadge}>运行中示意</span></span><span>整理一周项目动态</span><span className={styles.meta}>DEMO-S02 · 仅状态展示，无可打开的对话</span></span></button></section>}
      {(filter === "全部" || filter === "最近会话") && <section><h2 className={styles.sectionHeading}>最近会话 <span>1</span></h2><button type="button" disabled className={styles.sessionCard}><span className={styles.sessionIcon}><Clock3 size={22} aria-hidden="true" /></span><span className={styles.sessionBody}><span className={styles.sessionTop}><strong>需求梳理助手</strong><span className={styles.neutralBadge}>已结束示意</span></span><span>梳理导航文案的验收范围</span><span className={styles.meta}>DEMO-S03 · 仅状态展示，无可打开的对话</span></span></button></section>}
    </div>}
    <p className={styles.footnote}>这里的状态都是样本，不代表后台正在运行。</p>
  </section>
}

function ConnectionNotice({ controller }: { controller: DemoController }) {
  const { scenario, setScenario } = controller
  if (scenario === "offline") return <aside className={styles.notice} aria-label="离线示例"><WifiOff size={20} aria-hidden="true" /><div><strong>当前为离线示例</strong><p>旧示例仍可阅读，草稿保留在内存。预览推进已暂停，不会自动重发。</p><button type="button" className={styles.inlineButton} onClick={() => setScenario("stale")}><RefreshCw size={16} aria-hidden="true" />预览重连</button></div></aside>
  if (scenario === "stale" || scenario === "unknown") return <aside className={styles.notice} aria-label="待核对示例"><CircleHelp size={20} aria-hidden="true" /><div><strong>{scenario === "unknown" ? "结果未知，不等于失败" : "已进入重连预览，快照仍待核对"}</strong><p>{scenario === "unknown" ? "尚未确认示例结果；保留旧内容与草稿，不将它标记为失败，也不重试发送。" : "这不是实际网络重连。先核对示例来源与版本，再恢复预览；不会自动追加或重发内容。"}</p><button type="button" className={styles.inlineButton} onClick={() => setScenario("ready")}><ShieldCheck size={16} aria-hidden="true" />核对示例结果</button><span className={styles.meta}>只切换示例状态，不推进脚本</span></div></aside>
  if (scenario === "error" || scenario === "loading" || scenario === "forbidden" || scenario === "empty") return <aside className={styles.notice}><Info size={20} aria-hidden="true" /><div><strong>{scenario === "error" ? "读取失败示例，不代表 Run 失败" : scenario === "loading" ? "加载状态示例，没有网络请求" : scenario === "forbidden" ? "无权访问状态示例" : "当前没有新的示例内容"}</strong><p>下方仅保留固定展示内容，不能继续推进。没有重试真实操作。</p><button type="button" className={styles.inlineButton} onClick={() => setScenario("ready")}>返回正常预览</button></div></aside>
  return null
}

function ToolSummary() {
  return <details className={styles.toolCard}><summary><span className={styles.toolIcon}><FileText size={18} aria-hidden="true" /></span><span><strong>读取任务说明</strong><span className={styles.meta}>工具调用样本 · 未实际执行</span></span><ChevronDown className={styles.chevron} size={18} aria-hidden="true" /></summary><div className={styles.toolContents}><h3>输入 · 硬编码示例</h3><pre>{`task_id: ${DEMO_TASK_ID}\nrevision: ${SOURCE_REVISION}\nfields: description, acceptance`}</pre><h3>结果 · 硬编码示例</h3><p>范围：附件入口说明、离线时的阅读与草稿提示。验收要求：不得读取真实文件；恢复预览不重复追加内容。</p><p className={styles.meta}>未访问目录、执行命令或读取任何业务数据。</p></div></details>
}

function Chat({ controller }: { controller: DemoController }) {
  const [localPanel, setLocalPanel] = useState<"attachment" | "reference" | null>(null)
  const [newContent, setNewContent] = useState(false)
  const [longHistory, setLongHistory] = useState(false)
  const transcript = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const isLong = controller.scenario === "long"
  const showLong = isLong || longHistory
  const step = Math.min(controller.previewStep, LAST_PREVIEW_STEP)
  const canAdvance = (controller.scenario === "ready" || isLong) && step < LAST_PREVIEW_STEP
  useLayoutEffect(() => {
    if (showLong) setLongHistory(true)
    const element = transcript.current
    if (!element) return
    if (nearBottom.current) {
      element.scrollTop = element.scrollHeight
      setNewContent(false)
    } else {
      setNewContent(true)
    }
  }, [step, showLong])
  function scrollToLatest() {
    const element = transcript.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    nearBottom.current = true
    setNewContent(false)
  }
  if (controller.location.id && controller.location.id !== DEMO_SESSION_ID) return <section className={styles.page}><h1>此会话仅有列表样本</h1><p>没有对应的可打开对话，不会显示另一段会话代替。</p><button type="button" className={styles.secondaryButton} onClick={() => controller.navigate({ page: "agent" })}>返回会话列表</button></section>
  return <section className={`${styles.page} ${styles.chatPage}`} aria-labelledby="demo-chat-title">
    <header className={styles.chatHeader}><div><h1 id="demo-chat-title">移动体验助手</h1><p>{DEMO_SESSION_ID} · 固定脚本会话</p></div><span className={styles.attention}>示例</span></header>
    <DemoNote />
    <div className={styles.contextStrip}>{controller.referencedTask ? <button type="button" className={styles.referenceChip} onClick={() => controller.navigate({ page: "task", id: DEMO_TASK_ID })}><Link2 size={14} aria-hidden="true" />引用 {DEMO_TASK_ID} · revision {SOURCE_REVISION}<ChevronRight size={14} aria-hidden="true" /></button> : <span className={styles.meta}>未添加任务引用 · 当前为通用演示上下文</span>}<span className={styles.environment}>执行环境：演示，不连接目录</span></div>
    <ConnectionNotice controller={controller} />
    <div className={styles.transcriptWrap}>
      <div className={styles.transcript} ref={transcript} role="region" aria-label="固定示例对话，可滚动阅读" tabIndex={0} onScroll={() => { const element = transcript.current; if (!element) return; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; if (nearBottom.current) setNewContent(false) }}>
        <p className={styles.dateSeparator}>今天 · 以下均为预写样本</p>
        <article className={`${styles.message} ${styles.userMessage}`}><span className={styles.messageLabel}>示例提问 · 非实际发送</span><p>帮我看看移动端附件和离线说明，哪些地方还需要补充？</p></article>
        <article className={styles.message}><span className={styles.messageLabel}>助手回复样本</span><p>先把使用边界说清楚。附件入口应告诉用户「这里能做什么」，离线状态则要明确「什么会被保留」。</p><p>我会以 {controller.referencedTask ? `${DEMO_TASK_ID} · revision ${SOURCE_REVISION} 的示例引用` : "这段固定的移动端说明样本"} 为依据，不读取真实项目。</p></article>
        <ToolSummary />
        {showLong && longConversation.map(([title, text], index) => <article className={styles.message} key={title}><span className={styles.messageLabel}>长对话样本 {index + 1} · {title}</span><p>{text}</p></article>)}
        <article className={styles.waitingCard}><span className={styles.cardKicker}><CircleHelp size={18} aria-hidden="true" />等待补充信息 · 状态样本</span><h2>离线时，草稿应如何呈现？</h2><p>示例建议：只保留当前页面内存中的草稿，清楚提示刷新后会丢失；不自动恢复发送。</p><span className={styles.meta}>下方输入不会发送给模型。预览下一步只展示预写的补充说明。</span></article>
        {step >= 1 && <article className={`${styles.message} ${styles.userMessage}`}><span className={styles.messageLabel}>脚本第 1 步 · 并未发送</span><p>采用「仅当前页面内存保留」的说明，不读真实附件，不自动重发。</p><span className={styles.meta}>此段为固定脚本，不是输入框内容。</span></article>}
        {step >= 2 && <article className={styles.message}><span className={styles.messageLabel}>脚本第 2 步 · 依据样本</span><p>已展示文案建议样本：附件入口先说明边界；离线后保留阅读位置与草稿，先核对再继续预览。</p><p className={styles.meta}>来源：任务说明样本 {DEMO_TASK_ID} · revision {SOURCE_REVISION}。没有执行修改或测试。</p></article>}
        {step >= 3 && <article className={styles.message}><span className={styles.messageLabel}>脚本第 3 步 · 结束状态示意</span><p>这段固定预览已结束。没有真实 Run 被启动或结束，任务也没有被标记为完成。</p></article>}
        <button type="button" className={styles.resultLink} onClick={() => controller.navigate({ page: "result", id: DEMO_SESSION_ID })}><BookOpen size={19} aria-hidden="true" /><span><strong>查看结果与依据样本</strong><span className={styles.meta}>来源版本、文案预览与未验证项</span></span><ArrowRight size={18} aria-hidden="true" /></button>
      </div>
      {newContent && <button type="button" className={styles.newContent} onClick={scrollToLatest}><ArrowDown size={16} aria-hidden="true" />有新内容 · 查看预览</button>}
    </div>
    <div className={styles.composer}>
      {localPanel && <aside className={styles.localPanel} aria-label={localPanel === "attachment" ? "附件说明" : "引用说明"}><div><strong>{localPanel === "attachment" ? "附件仅作入口展示" : "引用固定任务样本"}</strong><button type="button" className={styles.inlineButton} onClick={() => setLocalPanel(null)}>收起</button></div><p>{localPanel === "attachment" ? "此处不打开文件选择器、不读取真实文件、不上传。示例附件：移动端说明.md（仅名称展示）。" : `可引用 ${DEMO_TASK_ID} · revision ${SOURCE_REVISION}。只改变示例上下文，不更换 Agent 目录身份，也不连接执行环境。`}</p>{localPanel === "reference" && <button type="button" className={styles.secondaryButton} onClick={() => { controller.referenceTask(); setLocalPanel(null) }}>{controller.referencedTask ? "保留此示例引用" : "使用此示例引用"}</button>}</aside>}
      <label className={styles.composerLabel} htmlFor="demo-agent-draft">草稿 · 仅当前页面内存</label>
      <textarea id="demo-agent-draft" rows={2} value={controller.draft} onChange={(event) => controller.setDraft(event.target.value)} placeholder="写下想补充的内容，不会发送…" aria-describedby="demo-composer-help" />
      <div className={styles.composerActions}><div className={styles.composerTools}><button type="button" className={styles.iconButton} aria-label="查看附件入口说明" aria-expanded={localPanel === "attachment"} onClick={() => setLocalPanel(localPanel === "attachment" ? null : "attachment")}><Paperclip size={20} aria-hidden="true" /></button><button type="button" className={styles.iconButton} aria-label="查看示例任务引用" aria-expanded={localPanel === "reference"} onClick={() => setLocalPanel(localPanel === "reference" ? null : "reference")}><Link2 size={20} aria-hidden="true" /></button></div><button type="button" disabled className={styles.disabledSend}><Send size={16} aria-hidden="true" />发送</button><button type="button" disabled={!canAdvance} className={styles.primaryButton} onClick={() => { if (canAdvance) controller.advancePreview() }}><Play size={15} aria-hidden="true" />{step >= LAST_PREVIEW_STEP ? "预览已结束" : "预览下一步"}</button></div>
      <p id="demo-composer-help" className={styles.composerHelp}>发送未接入。预览仅推进固定脚本，不提交草稿；刷新后草稿丢失。</p>
    </div>
    <details className={styles.advanced}><summary>高级操作 <ChevronDown size={16} aria-hidden="true" /></summary><p>真实运行能力未接入。本页不能批准、停止或删除运行，也不会创建业务对象。</p><div className={styles.disabledActions}><button type="button" disabled>批准执行</button><button type="button" disabled>停止运行</button><button type="button" disabled>删除会话</button></div></details>
  </section>
}

function Result({ controller }: { controller: DemoController }) {
  const [view, setView] = useState<"document" | "diff">("document")
  return <section className={styles.page} aria-labelledby="demo-result-title">
    <header className={styles.resultHeader}><div><span className={styles.eyebrow}>RESULT / 结果样本</span><h1 id="demo-result-title">说明更清楚，边界不模糊。</h1></div></header>
    <DemoNote />
    <ConnectionNotice controller={controller} />
    <article className={styles.conclusion}><span className={styles.cardKicker}><Check size={18} aria-hidden="true" />结论 · 固定文案建议</span><h2>先解释附件，再交代离线。</h2><p>附件入口说明「不读取、不上传」；离线说明「可继续阅读、草稿仅在内存保留」。恢复预览前先核对，不自动重发。</p><div className={styles.resultBoundary}><Info size={18} aria-hidden="true" /><strong>Run 结束 ≠ 任务完成</strong><span>这是结束状态样本，不是执行证明。任务没有被更新，仍需独立验收。</span></div></article>
    <div className={styles.resultGrid}><article className={styles.card}><h2><Link2 size={18} aria-hidden="true" />依据与版本</h2><dl className={styles.sources}><div><dt>任务说明</dt><dd>{DEMO_TASK_ID} · revision {SOURCE_REVISION}</dd></div><div><dt>会话样本</dt><dd>{DEMO_SESSION_ID} · 固定脚本 v1</dd></div><div><dt>工具结果</dt><dd>预写样本，未执行调用</dd></div><div><dt>内容新鲜度</dt><dd>{controller.scenario === "stale" || controller.scenario === "unknown" || controller.scenario === "offline" ? "旧示例 · 待核对" : "静态示例 · 非实时数据"}</dd></div></dl></article><article className={styles.card}><h2><ClipboardList size={18} aria-hidden="true" />检查与验收</h2><ul className={styles.checks}><li><span>文案内容</span><span className={styles.neutralBadge}>仅示例</span></li><li><span>代码修改与构建</span><span className={styles.attention}>未执行</span></li><li><span>测试与设备验证</span><span className={styles.attention}>未验证</span></li><li><span>任务验收</span><span className={styles.attention}>未进行</span></li></ul><p className={styles.meta}>没有提交、测试日志或部署结果可作为完成证据。</p></article></div>
    <article className={styles.previewCard}><div className={styles.previewHeader}><h2><FileCode2 size={18} aria-hidden="true" />建议内容预览</h2><div className={styles.viewSwitch} aria-label="预览形式"><button type="button" aria-pressed={view === "document"} onClick={() => setView("document")}>文档</button><button type="button" aria-pressed={view === "diff"} onClick={() => setView("diff")}>单栏 Diff</button></div></div><p className={styles.meta}>移动端说明.md · 虚构文件名，未写入项目</p>{view === "document" ? <div className={styles.document}><h3>附件与离线使用说明</h3><h4>附件入口</h4><p>当前为可点击演示。附件入口只展示说明，不读取设备文件，也不会上传任何内容。</p><h4>离线阅读与草稿</h4><p>离线时可继续查看已展示的示例。草稿仅保留在当前页面内存中，刷新或离开演示后可能丢失。</p><h4>恢复预览</h4><p>先预览重连，再核对示例结果。核对不会重新发送草稿，也不会自动追加会话内容。</p></div> : <div className={styles.diff} aria-label="文案建议单栏差异，减号为移除，加号为新增"><div className={styles.diffFile}>移动端说明.md · 文案差异样本</div><pre className={styles.removed}>- 点击附件上传文件。</pre><pre className={styles.added}>+ 附件仅作入口展示，不读取或上传真实文件。</pre><pre className={styles.removed}>- 重连后自动继续。</pre><pre className={styles.added}>+ 离线时草稿仅保留在当前页面内存中。</pre><pre className={styles.added}>+ 先核对示例结果，再手动预览下一步；不自动重发。</pre></div>}</article>
    <button type="button" className={styles.primaryButton} onClick={() => controller.navigate({ page: "task", id: DEMO_TASK_ID })}><ArrowLeft size={17} aria-hidden="true" />回到任务 {DEMO_TASK_ID}</button>
    <p className={styles.footnote}>仅返回任务详情，不修改状态、不批准结果。</p>
  </section>
}

export function MobileAgentPages({ controller }: { controller: DemoController }) {
  if (controller.location.page === "chat") return <Chat controller={controller} />
  if (controller.location.page === "result") return <Result controller={controller} />
  return <AgentList controller={controller} />
}
