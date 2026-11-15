import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowUpRight, Bot, Check, CircleAlert, FlaskConical, FolderKanban, Home, Monitor, Moon, RotateCcw, Settings2, ShieldCheck, Sun, UserRound, WifiOff, X } from "lucide-react"
import { scenarioLabels, type DemoScenario, type DemoShellProps, type DemoTab, type DemoTheme } from "./model"
import styles from "./shell.module.css"

const tabs = [
  { id: "today", label: "今日", icon: Home },
  { id: "projects", label: "项目", icon: FolderKanban },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "me", label: "我的", icon: UserRound },
] satisfies Array<{ id: DemoTab; label: string; icon: typeof Home }>


const scenarioDescriptions: Record<DemoScenario, string> = {
  ready: "正在浏览硬编码示例；所有操作仅在此预览内生效。",
  empty: "此场景展示没有内容，不代表读取失败或手机离线。",
  loading: "仅展示加载中的界面，不会发起真实请求。",
  error: "此场景模拟读取失败；内容状态不应被解释为没有数据。",
  offline: "此场景模拟手机离线，并非检测到你的设备已断网。",
  stale: "此场景展示过期快照，示例内容不能代表最新状态。",
  forbidden: "此场景模拟访问受限，不会检查或修改真实权限。",
  unknown: "此场景展示结果未知，不能推断为成功、失败或任务完成。",
  long: "正在展示长内容场景，用于预览阅读、换行与滚动体验。",
}

const themeOptions = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] satisfies Array<{ value: DemoTheme; label: string; icon: typeof Sun }>

export function MobileDemoShell({ controller, children, theme, setTheme, reset }: DemoShellProps) {
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (workspaceRef.current) workspaceRef.current.scrollTop = 0
    contentRef.current?.focus({ preventScroll: true })
  }, [controller.location])
  const id = useId()
  const isDark = theme === "dark" || (theme === "system" && systemDark)
  const themeClass = isDark ? `${styles.themeDark} dark` : styles.themeLight
  const isDetail = !tabs.some((tab) => tab.id === controller.location.page)
  const scope = controller.tab === "agent"
    ? "示例范围 · 独立 Agent 目录"
    : controller.tab === "me"
      ? "示例范围 · 个人预览偏好"
      : "示例范围 · Dovspace 移动体验 / PM 工作区"
  const ScenarioIcon = controller.scenario === "offline" ? WifiOff : controller.scenario === "ready" ? FlaskConical : CircleAlert

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const update = () => setSystemDark(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  function openSettings() {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.showModal()
    closeRef.current?.focus()
  }

  function closeSettings() {
    dialogRef.current?.close()
  }

  return (
    <div className={`${styles.shell} ${themeClass}`} data-demo-theme={theme} data-demo-page={["empty", "loading", "error", "forbidden"].includes(controller.scenario) ? "state" : controller.location.page}>
      <a className={styles.skipLink} href={`#${id}-content`}>跳到预览内容</a>
      <div className={styles.boundary}>
        <ShieldCheck size={15} aria-hidden="true" />
        <span>设计预览 · 示例数据 · 未连接真实服务</span>
      </div>
      <header className={styles.header}>
        <div className={styles.brandGroup}>
          <span className={styles.brand}>Dovspace<span className={styles.brandDot} aria-hidden="true">.</span></span>
          <span className={styles.companion}>Mobile Companion</span>
        </div>
        <button type="button" className={styles.settingsButton} onClick={openSettings} aria-haspopup="dialog" aria-controls={`${id}-settings`}>
          <Settings2 size={18} aria-hidden="true" />
          <span>场景设置</span>
        </button>
      </header>
      <div className={styles.layout}>
        <aside className={styles.rail}>
          <div className={styles.railIntro}>
            <span className={styles.eyebrow}>随行，不打扰</span>
            <h2>把重要的事，<br />轻轻带在身边。</h2>
            <p>看一眼进展，读一段更新。<br />这是移动端的设计预览。</p>
          </div>
          <nav className={styles.navigation} aria-label="移动端主导航">
            {tabs.map(({ id: tab, label, icon: Icon }) => (
              <button
                key={tab}
                type="button"
                className={`${styles.navButton} ${controller.tab === tab ? styles.navActive : ""}`}
                aria-current={controller.tab === tab ? "page" : undefined}
                onClick={() => controller.navigate({ page: tab })}
              >
                <Icon size={21} strokeWidth={controller.tab === tab ? 2 : 1.7} aria-hidden="true" />
                <span>{label}</span>
                {controller.tab === tab && <span className={styles.navMarker} aria-hidden="true" />}
              </button>
            ))}
          </nav>
          <div className={styles.railNote}>
            <FlaskConical size={20} aria-hidden="true" />
            <strong>只探索界面，不执行操作</strong>
            <p>Agent 目录独立于 PM 工作区。引用任务不会改变 Agent 的身份；Run 成功也不等于任务完成。</p>
            <span>预览状态仅留在当前页面 <ArrowUpRight size={14} aria-hidden="true" /></span>
          </div>
        </aside>
        <div ref={workspaceRef} className={styles.workspace}>
          <div className={styles.pageHeader}>
            {isDetail && (
              <button type="button" className={styles.backButton} onClick={controller.back} aria-label="返回上一页">
                <ArrowLeft size={19} aria-hidden="true" />
                <span>返回</span>
              </button>
            )}
            <div className={styles.scopeGroup}>
              <p className={styles.scope}>{scope}</p>
            </div>
            <span className={styles.previewBadge}>可点击 Demo</span>
          </div>
          <div className={`${styles.scenarioBanner} ${controller.scenario !== "ready" ? styles.scenarioChanged : ""}`} role="status" aria-live="polite" aria-atomic="true">
            <ScenarioIcon size={18} aria-hidden="true" />
            <div>
              <strong>示例场景：{scenarioLabels[controller.scenario]}</strong>
              <p>{scenarioDescriptions[controller.scenario]}</p>
            </div>
          </div>
          <main ref={contentRef} id={`${id}-content`} className={styles.content} tabIndex={-1}>
            {children}
          </main>
          <footer className={styles.footer}>仅供设计体验 · 真实发送、批准、停止与删除不可用</footer>
        </div>
      </div>
      <dialog
        ref={dialogRef}
        id={`${id}-settings`}
        className={`${styles.dialog} ${themeClass}`}
        aria-labelledby={`${id}-settings-title`}
        aria-describedby={`${id}-settings-description`}
        onClose={() => returnFocusRef.current?.focus()}
      >
        <div className={styles.dialogHeader}>
          <div>
            <p className={styles.eyebrow}>PREVIEW CONTROLS</p>
            <h2 id={`${id}-settings-title`}>选择一种预览状态</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.iconButton} onClick={closeSettings} aria-label="关闭场景设置">
            <X size={21} aria-hidden="true" />
          </button>
        </div>
        <p id={`${id}-settings-description`} className={styles.dialogDescription}>只改变此 Demo 的显示，不连接服务，也不修改全站主题或偏好。</p>
        <fieldset className={styles.fieldset}>
          <legend>示例场景</legend>
          <div className={styles.scenarioOptions}>
            {(Object.entries(scenarioLabels) as Array<[DemoScenario, string]>).map(([value, label]) => (
              <label key={value} className={`${styles.choice} ${controller.scenario === value ? styles.choiceSelected : ""}`}>
                <input type="radio" name={`${id}-scenario`} value={value} checked={controller.scenario === value} onChange={() => controller.setScenario(value)} />
                <span>{label}</span>
                {controller.scenario === value && <Check size={16} aria-hidden="true" />}
              </label>
            ))}
          </div>
          <p className={styles.selectionNote} role="status">{scenarioDescriptions[controller.scenario]}</p>
        </fieldset>
        <fieldset className={styles.fieldset}>
          <legend>此预览的外观</legend>
          <div className={styles.themeOptions}>
            {themeOptions.map(({ value, label, icon: Icon }) => (
              <label key={value} className={`${styles.choice} ${styles.themeChoice} ${theme === value ? styles.choiceSelected : ""}`}>
                <input type="radio" name={`${id}-theme`} value={value} checked={theme === value} onChange={() => setTheme(value)} />
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className={styles.resetSection}>
          <div>
            <strong>重新开始体验</strong>
            <p>清空本次预览中的草稿与演示进度，恢复初始设置；不影响真实数据。</p>
          </div>
          <button type="button" className={styles.resetButton} onClick={() => { reset(); closeSettings() }}>
            <RotateCcw size={17} aria-hidden="true" />重置预览
          </button>
        </div>
        <button type="button" className={styles.doneButton} onClick={closeSettings}>返回预览</button>
      </dialog>
    </div>
  )
}
