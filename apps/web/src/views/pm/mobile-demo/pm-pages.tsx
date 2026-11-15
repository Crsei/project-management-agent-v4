import { useState, type ReactNode } from "react"
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, Circle, Clock3, Code2, FileText, Flag, FolderOpen, Layers3, LockKeyhole, MessageSquare, Paperclip, Search, Sparkles, Target, UserRound } from "lucide-react"
import { DEMO_PROJECT_ID, DEMO_PROJECT_TITLE, DEMO_SESSION_ID, DEMO_TASK_ID, DEMO_TASK_TITLE, type DemoController } from "./model"
import styles from "./pm-pages.module.css"

const DOCUMENT_TITLE = "移动端附件与离线说明.md"
const DOCUMENT_ID = "DEMO-DOC-01"
const LONG_TITLE = `${DEMO_TASK_TITLE}：在弱网、离线与跨设备阅读时，让每一条范围说明都清晰可追溯`
const ACCEPTANCE = [
  "说明附件仅用于当前引用范围，不自动扩展到整个项目。",
  "离线时明确显示示例快照，不暗示内容已同步或操作已提交。",
  "区分运行结果、文档已阅与任务验收；已阅不改变任务状态。",
]

function PageHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <header className={styles.heading}><p className={styles.eyebrow}>{eyebrow}</p><h1>{title}</h1>{children && <p className={styles.lead}>{children}</p>}</header>
}

function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return <div className={styles.sectionHeading}><h2>{title}</h2>{detail && <span>{detail}</span>}</div>
}

function TaskFilters({ controller }: { controller: DemoController }) {
  return <div className={styles.filters}>
    <label className={styles.search}><Search size={19} aria-hidden="true" /><span className={styles.srOnly}>搜索示例项目或任务</span><input value={controller.taskFilter} onChange={(event) => controller.setTaskFilter(event.target.value)} placeholder="搜索项目、任务或状态" type="search" /></label>
    <div className={styles.chips} aria-label="任务筛选">{[["", "全部"], ["待我处理", "待我处理"], ["进行中", "进行中"]].map(([value, label]) => <button key={label} className={styles.chip} aria-pressed={controller.taskFilter === value} onClick={() => controller.setTaskFilter(value)}>{label}</button>)}</div>
  </div>
}

function matchesTask(filter: string) {
  const haystack = `${DEMO_PROJECT_ID} ${DEMO_PROJECT_TITLE} ${DEMO_TASK_ID} ${DEMO_TASK_TITLE} ${LONG_TITLE} 进行中 待我处理 林悦 附件 离线`.toLocaleLowerCase()
  return filter.trim().toLocaleLowerCase().split(/\s+/).every((word) => haystack.includes(word))
}

function NoMatches({ controller }: { controller: DemoController }) {
  return <div className={styles.noMatches}><Search size={24} aria-hidden="true" /><p>没有匹配的示例内容</p><span>试试“附件”，或清除当前筛选。</span><button className={styles.secondary} onClick={() => controller.setTaskFilter("")}>清除筛选</button></div>
}

function TaskRow({ controller }: { controller: DemoController }) {
  return <button className={styles.taskRow} onClick={() => controller.navigate({ page: "task", id: DEMO_TASK_ID })}>
    <span className={styles.taskIcon}><Circle size={20} aria-hidden="true" /></span>
    <span className={styles.rowContent}><span className={styles.meta}>{DEMO_TASK_ID}<span className={styles.status}>进行中</span></span><strong>{controller.scenario === "long" ? LONG_TITLE : DEMO_TASK_TITLE}</strong><span className={styles.subtle}>林悦 · 示例截止 11月18日</span></span>
    <ChevronRight className={styles.chevron} size={19} aria-hidden="true" />
  </button>
}

function ChangeLink({ controller }: { controller: DemoController }) {
  return <button className={styles.documentRow} onClick={() => controller.navigate({ page: "changes", id: DOCUMENT_ID })}>
    <span className={styles.documentIcon}><FileText size={21} aria-hidden="true" /></span>
    <span className={styles.rowContent}><strong>{DOCUMENT_TITLE}</strong><span className={styles.subtle}>示例修订 r6 → r7 · +3 / −2 行</span><span className={styles.readState}>{controller.acknowledged ? "示例已阅 · 任务仍进行中" : "有一处附件范围需要你确认"}</span></span>
    <ChevronRight className={styles.chevron} size={19} aria-hidden="true" />
  </button>
}

function Today({ controller }: { controller: DemoController }) {
  return <div className={styles.page}>
    <PageHeading eyebrow="2026年11月15日 · 星期日 · 示例日期" title="早上好，林悦">把注意力留给需要你判断的事。</PageHeading>
    <div className={styles.columns}>
      <div className={styles.stack}>
        <section><SectionHeading title="需要我处理" detail="1 项示例" />
          <div className={styles.attention}>
            <div className={styles.attentionLabel}><span className={styles.smallIcon}><Paperclip size={18} aria-hidden="true" /></span>待补充 · 附件范围</div>
            <h3>这次需要参考哪些附件？</h3><p>示例 Agent 停在你的判断之前。先补充范围，再查看下一步预览。</p>
            {controller.scenario === "long" && <p>只引用移动端附件说明中与离线阅读相关的段落，不包含其他项目的设计稿、成员资料或历史讨论。即使上下文很长，也应先看清引用边界，再决定是否继续。</p>}
            <button className={styles.primary} onClick={() => controller.navigate({ page: "chat", id: DEMO_SESSION_ID })}>查看示例对话<ArrowRight size={18} aria-hidden="true" /></button>
            <span className={styles.note}>打开已有示例会话，不会发送消息。</span>
          </div>
        </section>
        <section><SectionHeading title="我的任务" detail="1 项 · 0 项完成" /><TaskFilters controller={controller} /><div className={styles.list}>{matchesTask(controller.taskFilter) ? <TaskRow controller={controller} /> : <NoMatches controller={controller} />}</div></section>
      </div>
      <aside className={styles.stack}>
        <section><SectionHeading title="最近文档变化" detail="示例快照" /><div className={styles.list}><ChangeLink controller={controller} /></div></section>
        <div className={styles.quietNote}><Clock3 size={18} aria-hidden="true" /><p>这是一份固定的工作切片。日期、任务与文档均为示例，不代表你的实时项目。</p></div>
      </aside>
    </div>
  </div>
}

function Projects({ controller }: { controller: DemoController }) {
  return <div className={styles.page}>
    <PageHeading eyebrow="PROJECTS / 项目" title="让进展清晰一点">从项目目标，走到今天要处理的任务。</PageHeading>
    <TaskFilters controller={controller} />
    <div className={styles.columns}>
      <section><SectionHeading title="我的项目" detail={matchesTask(controller.taskFilter) ? "1 个示例" : "0 个匹配"} />
        {matchesTask(controller.taskFilter) ? <button className={styles.projectCard} onClick={() => controller.navigate({ page: "project", id: DEMO_PROJECT_ID })}>
          <span className={styles.cardTop}><span className={styles.projectIcon}><Layers3 size={25} aria-hidden="true" /></span><span className={styles.status}>进行中</span></span>
          <span className={styles.meta}>{DEMO_PROJECT_ID} · 示例项目</span><strong className={styles.projectTitle}>{DEMO_PROJECT_TITLE}</strong>
          <span className={styles.projectDescription}>{controller.scenario === "long" ? "为跨设备工作的团队设计轻量陪伴体验：在手机上看清待办、读懂文档变化，并把明确的任务上下文带入已有 Agent 对话，而不是把完整的桌面交付工作台搬到小屏幕。" : "随手看进展，认真做判断。让手机成为项目的轻量陪伴。"}</span>
          <span className={styles.progressLabel}><span>样例里程碑</span><strong>1 / 3</strong></span><span className={styles.progressTrack}><span /></span>
          <span className={styles.projectFooter}><span>1 项任务 · 0 项完成</span><span>查看项目<ArrowRight size={17} aria-hidden="true" /></span></span>
        </button> : <NoMatches controller={controller} />}
      </section>
      <aside className={styles.overview}><SectionHeading title="这份项目切片" /><p>只保留与你此刻有关的内容。</p><ul className={styles.overviewList}><li><Target size={18} aria-hidden="true" /><span>1 个目标：轻量查看与判断</span></li><li><Flag size={18} aria-hidden="true" /><span>3 个样例里程碑，1 个标记完成</span></li><li><FileText size={18} aria-hidden="true" /><span>1 份关联文档，1 次示例修订</span></li></ul><p className={styles.note}>里程碑计数与任务状态分别展示，不以文档已阅推断完成。</p></aside>
    </div>
  </div>
}

function Project({ controller }: { controller: DemoController }) {
  return <div className={styles.page}>
    <PageHeading eyebrow={`${DEMO_PROJECT_ID} / 示例项目`} title={DEMO_PROJECT_TITLE}>手机负责轻量查看与判断；复杂编辑留在完整工作环境。</PageHeading>
    <div className={styles.columns}>
      <div className={styles.stack}>
        <section className={styles.panel}><SectionHeading title="我们想达成什么" /><p>让成员在手机上快速找到需要自己处理的任务，读懂文档变化，并将任务上下文引用到已有 Agent 示例会话。</p><div className={styles.inlineMeta}><UserRound size={17} aria-hidden="true" />负责人 林悦<span>示例周期 11月12日—11月20日</span></div></section>
        <section><SectionHeading title="项目任务" detail="1 项 · 0 项完成" /><TaskFilters controller={controller} /><div className={styles.list}>{matchesTask(controller.taskFilter) ? <TaskRow controller={controller} /> : <NoMatches controller={controller} />}</div></section>
      </div>
      <aside className={styles.stack}>
        <section className={styles.panel}><SectionHeading title="里程碑" detail="1 / 3 完成" /><ol className={styles.milestones}><li><span className={styles.completeIcon}><Check size={18} aria-hidden="true" /></span><div><strong>明确移动端范围</strong><span>示例已完成 · 11月12日</span></div></li><li><span className={styles.activeIcon}><Circle size={18} aria-hidden="true" /></span><div><strong>补充附件与离线说明</strong><span>进行中 · 示例计划 11月18日</span></div></li><li><span className={styles.pendingIcon}><Flag size={18} aria-hidden="true" /></span><div><strong>组织体验走查</strong><span>未开始 · 示例计划 11月20日</span></div></li></ol></section>
        <section><SectionHeading title="关联文档" /><div className={styles.list}><ChangeLink controller={controller} /></div></section>
        <div className={styles.restricted}><button disabled className={styles.secondary}><LockKeyhole size={16} aria-hidden="true" />编辑项目</button><p>仅展示项目示例，不支持修改真实目标或里程碑。</p></div>
      </aside>
    </div>
  </div>
}

function Task({ controller }: { controller: DemoController }) {
  return <div className={styles.page}>
    <PageHeading eyebrow={`${DEMO_TASK_ID} / 示例任务`} title={controller.scenario === "long" ? LONG_TITLE : DEMO_TASK_TITLE}>{DEMO_PROJECT_TITLE}</PageHeading>
    <dl className={styles.taskMetadata}><div><dt>状态</dt><dd><span className={styles.status}>进行中</span></dd></div><div><dt>负责人</dt><dd><span className={styles.avatar}>林</span>林悦</dd></div><div><dt>示例截止</dt><dd>2026年11月18日</dd></div></dl>
    <p className={styles.note}>当前来源版本：r7 · 固定示例快照</p>
    <div className={styles.columns}>
      <div className={styles.stack}>
        <section className={styles.panel}><SectionHeading title="任务描述" /><p>补充附件引用边界与离线阅读说明，让用户知道 Agent 能看到什么、当前展示的是哪个版本，以及哪些操作尚未发生。</p>{controller.scenario === "long" && <p>当用户在通勤途中打开长篇项目说明，附件名称、段落标题和修订来源都可能超出一行。页面需要自然换行，保留完整语义；网络恢复前不能把快照视为最新版本，更不能将一次运行成功、一次已阅标记或一段预览回复解释为需求已经验收。</p>}</section>
        <section className={styles.panel}><SectionHeading title="验收点" detail="3 项待核对" /><ul className={styles.acceptance}>{ACCEPTANCE.map((item, index) => <li key={item}><span className={styles.number}>{String(index + 1).padStart(2, "0")}</span><p>{item}</p></li>)}</ul><p className={styles.note}>以下仅为示例标准，未进行实现验收。</p></section>
        <section className={styles.panel}><SectionHeading title="评论" detail="1 条示例" /><div className={styles.comment}><span className={styles.avatar}>周</span><div><div className={styles.commentHeading}><strong>周宁</strong><span>示例 · 11月14日 16:40</span></div><p>附件范围请再写具体一点。先明确“只引用当前任务关联文档”，离线时不要让人误以为已经提交。</p></div></div></section>
      </div>
      <aside className={styles.stack}>
        <section><SectionHeading title="关联文档" /><div className={styles.list}><ChangeLink controller={controller} /></div><button className={styles.textButton} onClick={() => controller.navigate({ page: "changes", id: DOCUMENT_ID })}>查看变更<ArrowRight size={17} aria-hidden="true" /></button></section>
        <section className={styles.referencePanel}><Sparkles size={23} aria-hidden="true" /><h2>带着上下文继续</h2><p>把这项任务作为引用，带入已有的示例对话。</p><button className={styles.primary} onClick={() => { controller.referenceTask(); controller.navigate({ page: "chat", id: DEMO_SESSION_ID }) }}><MessageSquare size={18} aria-hidden="true" />引用到 Agent</button><p className={styles.note}>仅更新演示引用，不新建真实会话、不改变 Agent 身份，也不打开交付工作台。</p></section>
        <div className={styles.restricted}><div className={styles.disabledActions}><button disabled className={styles.secondary}><LockKeyhole size={16} aria-hidden="true" />编辑任务</button><button disabled className={styles.secondary}>完成任务</button><button disabled className={styles.secondary}>删除任务</button></div><p>真实修改、完成和删除均不可用。文档已阅与运行成功都不等于任务完成。</p></div>
      </aside>
    </div>
  </div>
}

function Changes({ controller }: { controller: DemoController }) {
  const [mode, setMode] = useState<"reading" | "code">("reading")
  return <div className={styles.page}>
    <PageHeading eyebrow={`${DOCUMENT_ID} / 示例文档变更`} title="把变化看明白">{DOCUMENT_TITLE}</PageHeading>
    <div className={styles.revision}><FileText size={18} aria-hidden="true" /><span>来源：固定示例快照<br /><strong>r6 → r7</strong></span><span className={styles.revisionCount}>+3 / −2 行</span></div>
    <p className={styles.note}>示例修订时间：2026年11月14日 16:20 · 周宁。不代表实时文件，也不会写入仓库。</p>
    <div className={styles.diffLayout}>
      <section className={styles.diffPanel}>
        <div className={styles.diffToolbar}><h2>修订对比</h2><div className={styles.modeSwitch} aria-label="变更阅读方式"><button aria-pressed={mode === "reading"} onClick={() => setMode("reading")}><FileText size={16} aria-hidden="true" />阅读</button><button aria-pressed={mode === "code"} onClick={() => setMode("code")}><Code2 size={16} aria-hidden="true" />代码</button></div></div>
        {mode === "reading" ? <article className={styles.markdown}><h3>附件与离线阅读</h3><p>明确本次任务的上下文范围，避免把预览误认为真实执行。</p><div className={styles.removed}><span>删除 · 旧版本</span><del>Agent 可以参考项目中的附件。</del></div><div className={styles.added}><span>新增 · 当前示例版本</span><ins>Agent 仅引用当前任务已明确选择的附件范围。</ins><ins>范围未确认前，停留在“待补充”状态。</ins></div><h4>离线时会发生什么</h4><div className={styles.removed}><span>删除 · 旧版本</span><del>离线操作将在联网后自动提交。</del></div><div className={styles.added}><span>新增 · 当前示例版本</span><ins>离线仅展示快照；恢复网络后仍需重新确认，不自动提交。</ins></div>{controller.scenario === "long" && <p>阅读提示：长说明用于检视窄屏排版。跨设备查看时，先核对修订编号，再确认引用的具体附件与段落；这条提示不属于上述五行变更，也不改变示例增删计数。</p>}</article> : <div className={styles.codeDiff} role="region" aria-label="单栏 Markdown 代码差异"><div className={styles.codeLine}><span>1</span><code>  # 附件与离线阅读</code></div><div className={styles.codeRemoved}><span>2</span><code>- Agent 可以参考项目中的附件。</code></div><div className={styles.codeAdded}><span>2</span><code>+ Agent 仅引用当前任务已明确选择的附件范围。</code></div><div className={styles.codeAdded}><span>3</span><code>+ 范围未确认前，停留在“待补充”状态。</code></div><div className={styles.codeLine}><span>4</span><code>  ## 离线时会发生什么</code></div><div className={styles.codeRemoved}><span>4</span><code>- 离线操作将在联网后自动提交。</code></div><div className={styles.codeAdded}><span>5</span><code>+ 离线仅展示快照；恢复网络后仍需重新确认，不自动提交。</code></div></div>}
      </section>
      <aside className={styles.stack}><section className={styles.panel}><SectionHeading title="阅读后，再做判断" /><p>本次修订收紧了附件范围，并移除了离线自动提交的表述。</p><div className={styles.relatedTask}><FolderOpen size={18} aria-hidden="true" /><span>关联 {DEMO_TASK_ID}<br />{DEMO_TASK_TITLE}</span></div><p className={styles.note}>关联任务：进行中。标记已阅只改变本次演示的阅读状态，不是批准、验收或完成。</p><button className={styles.primary} onClick={controller.acknowledge} disabled={controller.acknowledged}>{controller.acknowledged ? <CheckCheck size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}{controller.acknowledged ? "已标记示例已阅" : "标记示例已阅"}</button><p className={styles.readState} role="status">{controller.acknowledged ? "本次演示已阅 · 任务状态未改变" : "尚未标记示例已阅"}</p><button className={styles.secondary} onClick={controller.back}><ArrowLeft size={17} aria-hidden="true" />返回来源页面</button></section><div className={styles.restricted}><button disabled className={styles.secondary}><LockKeyhole size={16} aria-hidden="true" />批准并应用变更</button><p>仅可阅读固定示例；真实批准、应用与文件修改不可用。</p></div></aside>
    </div>
  </div>
}

export function MobilePmPages({ controller }: { controller: DemoController }) {
  switch (controller.location.page) {
    case "today": return <Today controller={controller} />
    case "projects": return <Projects controller={controller} />
    case "project": return <Project controller={controller} />
    case "task": return <Task controller={controller} />
    case "changes": return <Changes controller={controller} />
    default: return null
  }
}
