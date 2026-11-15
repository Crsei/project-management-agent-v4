import { useState } from "react"
import { ArrowRight, CloudOff, Eye, LockKeyhole, RotateCcw, Smartphone } from "lucide-react"
import { MobileDemoShell } from "./shell"
import { MobilePmPages } from "./pm-pages"
import { MobileAgentPages } from "./agent-pages"
import { pageTab, type DemoController, type DemoLocation, type DemoScenario, type DemoTab, type DemoTheme } from "./model"
import styles from "./index.module.css"

interface HistoryEntry { location: DemoLocation; tab: DemoTab }
const initialHistory: HistoryEntry[] = [{ location: { page: "today" }, tab: "today" }]
const blockedStates = {
  empty: { title: "这里暂时没有内容", detail: "空内容场景：没有待处理事项不代表读取失败，也不意味着项目已经完成。" },
  loading: { title: "正在读取示例内容", detail: "加载场景保持到你主动切换，不会连接服务器，也不会用空列表代替尚未读取的内容。" },
  error: { title: "内容未能读取", detail: "读取失败不等于空项目。这里不展示虚构成功，也不会自动重发操作。" },
  forbidden: { title: "当前范围不可访问", detail: "无权限场景隐藏内容。历史链接与缓存都不能替代当前授权；演示不会发起登录或扩大权限。" },
} as const

export default function MobileDemo() {
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory)
  const [scenario, setScenario] = useState<DemoScenario>("ready")
  const [theme, setTheme] = useState<DemoTheme>("system")
  const [referencedTask, setReferencedTask] = useState(false)
  const [draft, setDraft] = useState("")
  const [previewStep, setPreviewStep] = useState(0)
  const [taskFilter, setTaskFilter] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [resetVersion, setResetVersion] = useState(0)
  const current = history[history.length - 1] ?? initialHistory[0]!
  const navigate = (location: DemoLocation) => {
    setHistory(previous => {
      const last = previous[previous.length - 1]!
      if (last.location.page === location.page && last.location.id === location.id) return previous
      const isRoot = ["today", "projects", "agent", "me"].includes(location.page)
      const tab = location.page === "task" || location.page === "changes" ? last.tab : pageTab(location.page)
      const entry = { location, tab }
      return isRoot ? [entry] : [...previous, entry]
    })
  }
  const reset = () => {
    setHistory(initialHistory)
    setScenario("ready")
    setTheme("system")
    setReferencedTask(false)
    setDraft("")
    setPreviewStep(0)
    setTaskFilter("")
    setAcknowledged(false)
    setResetVersion(value => value + 1)
  }
  const controller: DemoController = {
    ...current, scenario, navigate,
    back: () => setHistory(previous => previous.length > 1 ? previous.slice(0, -1) : initialHistory),
    setScenario, referencedTask, referenceTask: () => setReferencedTask(true),
    draft, setDraft, previewStep,
    advancePreview: () => { if (scenario === "ready" || scenario === "long") setPreviewStep(value => Math.min(value + 1, 3)) },
    taskFilter, setTaskFilter, acknowledged, acknowledge: () => setAcknowledged(true),
  }
  const blocked = scenario in blockedStates ? blockedStates[scenario as keyof typeof blockedStates] : null
  const page = current.location.page
  return <MobileDemoShell controller={controller} theme={theme} setTheme={setTheme} reset={reset}>
    <div key={resetVersion} className={styles.content}>
      {page === "me" ? <section className={styles.profile} aria-label="我的与连接说明">
        <p className={styles.eyebrow}>MOBILE COMPANION</p>
        <h1>你的随行工作空间</h1>
        <p className={styles.lead}>带走上下文，而不是把整个桌面装进口袋。</p>
        <div className={styles.identity}><span aria-hidden="true">D</span><div><strong>演示体验者</strong><p>示例身份 · 未登录真实账号</p></div></div>
        <section className={styles.card}><CloudOff aria-hidden="true" /><div><h2>没有连接任何服务</h2><p>这里不读取真实项目、会话或执行目录。所有内容都在本页内存中，刷新或重置后回到初始示例。</p></div></section>
        <section className={styles.card}><Eye aria-hidden="true" /><div><h2>阅读优先，能力分开验收</h2><p>当前可以预览导航、筛选、对话阅读与结果核对。真实发送、审批、停止、文件上传和系统推送均未接入。</p></div></section>
        <section className={styles.card}><LockKeyhole aria-hidden="true" /><div><h2>手机不是新的授权边界</h2><p>PM 工作区与 Agent 会话分开；引用任务不会改变执行目录。Agent 运行结束、变更已阅与业务任务完成是不同事实。</p></div></section>
        <section className={styles.card}><Smartphone aria-hidden="true" /><div><h2>后续建设顺序</h2><p>设计预览 → 受控只读内测 → 有限真实交互 → 按需原生客户端。远程访问、设备撤销和推送送达需要独立验证。</p></div></section>
        <fieldset className={styles.appearance}><legend>本次演示外观</legend>{(["light", "dark", "system"] as const).map(value => <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}>{value === "light" ? "浅色" : value === "dark" ? "深色" : "跟随系统"}</button>)}</fieldset>
        <p className={styles.note}>会话与持久化仍暂沿用 Agent Chat，统一设计尚未验收收口。本 Demo 不改变正式保存方式。</p>
        <button type="button" className={styles.action} onClick={reset}><RotateCcw aria-hidden="true" />重置全部演示</button>
      </section> : blocked ? <section className={styles.blocked} aria-live="polite" aria-busy={scenario === "loading"}>
        <span className={styles.stateIcon} aria-hidden="true">{scenario === "forbidden" ? <LockKeyhole /> : <CloudOff />}</span>
        <p className={styles.eyebrow}>场景预览 · 非服务响应</p><h1>{blocked.title}</h1><p>{blocked.detail}</p>
        <button type="button" className={styles.action} onClick={() => setScenario("ready")}>恢复正常预览<ArrowRight aria-hidden="true" /></button>
      </section> : ["agent", "chat", "result"].includes(page) ? <MobileAgentPages controller={controller} /> : <MobilePmPages controller={controller} />}
    </div>
  </MobileDemoShell>
}
