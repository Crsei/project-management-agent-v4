"use client"

import { useId, useRef, useState } from "react"
import { Box, CheckCheck, Copy as CopyIcon, FileText, ListChecks, MessageSquare, PanelLeft, Plus, RefreshCw, Search, Settings2, ShieldCheck, SquarePen, X } from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import { Tabs, TabsList, TabsTab, TabsPanel } from "@easyuse-ui/ui/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@easyuse-ui/ui/components/ui/dialog"
import { ComposerInput } from "../../composer-input"
import { ComposerWorkspaceView } from "../../composer-workspace-view"
import { remainingPageScenarios, type RemainingPageProps } from "../../showcase/model"
import { RemainingPageStateProvider } from "../../showcase/state"
import { useComposer6Controller } from "./controller"
import { savedStartingPoints } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
const icons = { draft: FileText, actions: ListChecks, compare: MessageSquare, search: Search, approval: ShieldCheck, release: SquarePen }

function Composer6Page({ scenario, active, host }: RemainingPageProps) {
  const controller = useComposer6Controller(scenario, active)
  const { copy, label, state, setState, selected, draft, history: historyRef, rememberPosition } = controller
  const [collection, setCollection] = useState<"review" | "saved" | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const prefix = useId()
  const tabTitle = (id: string) => copy(state.sessions.find(session => session.id === id)!.title)
  const workbench = (
    <div className={styles.workbench} data-composer6-region="workbench">
      <aside className={styles.sidebar} hidden={!state.sidebarVisible} id={`${prefix}-navigation`} aria-label={label("工作空间导航", "Workspace navigation")}>
        <div className={styles.brand}><Box size={16} aria-hidden="true" /><div><strong>EasyuseUI</strong><small>Composer 6</small></div></div>
        <h2 className={styles.sectionLabel}>{label("操作", "Actions")}</h2>
        <div className={styles.actions}>
          <Button variant="ghost" className={styles.navAction} onClick={controller.newSession}><SquarePen />{label("新会话", "New conversation")}</Button>
          <Button variant="ghost" className={styles.navAction} onClick={() => setCollection("review")}><CheckCheck />{label("审阅队列", "Review queue")}<span className={styles.count}>{state.sessions.filter(session => session.messages.length).slice(0, 3).length}</span></Button>
          <Button variant="ghost" className={styles.navAction} onClick={() => setCollection("saved")}><CopyIcon />{label("已保存回复", "Saved responses")}<span className={styles.count}>{savedStartingPoints.length}</span></Button>
        </div>
        <div className={styles.recents}>
          <div className={styles.searchHeader}>
            {state.searchOpen ? <><Input ref={search} data-composer6-search aria-label={label("搜索最近会话", "Search recent conversations")} placeholder={label("搜索会话", "Search conversations")} value={state.query} onChange={event => controller.setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setState(previous => ({ ...previous, searchOpen: false, query: "" })); requestAnimationFrame(() => document.getElementById(`${prefix}-search-trigger`)?.focus()) } }} /><Button variant="ghost" size="icon" aria-label={label("关闭会话搜索", "Close conversation search")} onClick={() => { setState(previous => ({ ...previous, searchOpen: false, query: "" })); requestAnimationFrame(() => document.getElementById(`${prefix}-search-trigger`)?.focus()) }}><X /></Button></> : <><h2>{label("最近会话", "Recent conversations")}</h2><Button variant="ghost" size="icon" id={`${prefix}-search-trigger`} aria-label={label("搜索会话", "Search conversations")} aria-expanded={false} onClick={() => { setState(previous => ({ ...previous, searchOpen: true })); requestAnimationFrame(() => search.current?.focus()) }}><Search /></Button></>}
          </div>
          <div className={styles.recentList} aria-busy={state.dataState === "loading"}>
            {state.dataState === "loading" ? <><div className={styles.skeleton} /><div className={styles.skeleton} /><div className={styles.skeleton} /></> : controller.searchResults.map(session => <Item key={session.id} density="compact" title={copy(session.title)} ariaLabel={copy(session.title)} selected={session.id === state.selectedId} className={styles.session} onSelect={() => controller.selectSession(session)} />)}
            {state.dataState !== "loading" && !controller.searchResults.length && <p className={styles.empty}>{state.query ? label("没有匹配的会话", "No matching conversations") : label("还没有最近会话", "No recent conversations yet")}</p>}
          </div>
        </div>
        <Button variant="ghost" className={styles.settings} onClick={controller.openSettings}><Settings2 />{label("工作空间设置", "Workspace settings")}</Button>
      </aside>
      <Tabs value={state.selectedId} onValueChange={value => { const session = state.sessions.find(item => item.id === value); if (session) controller.selectSession(session) }} className={styles.main}>
        <header className={styles.tabHeader} data-composer6-region="tab-header">
          <Button variant="ghost" size="icon" aria-label={state.sidebarVisible ? label("收起侧栏", "Collapse sidebar") : label("展开侧栏", "Expand sidebar")} aria-expanded={state.sidebarVisible} aria-controls={`${prefix}-navigation`} onClick={() => controller.setSessionsVisible(value => !value)}><PanelLeft /></Button>
          <div className={styles.tabScroll}>
            <TabsList className={styles.tabs} aria-label={label("打开的聊天", "Open chats")}>
              {state.tabIds.map(id => { const session = state.sessions.find(item => item.id === id)!; return <div key={id} className={styles.tab} data-selected={id === state.selectedId}>
                <TabsTab value={id} className={styles.tabButton} data-composer6-tab={id} title={tabTitle(id)}><span className={styles.tabIcon}>{session.messages.length ? copy(session.title).slice(0, 1).toUpperCase() : <SquarePen size={14} />}</span><span>{tabTitle(id)}</span></TabsTab>
                <Button variant="ghost" size="icon-sm" className={styles.closeTab} aria-label={`${label("关闭", "Close")} ${tabTitle(id)}`} onClick={() => controller.closeTab(id)}><X /></Button>
              </div> })}
            </TabsList>
          </div>
          <Button variant="ghost" size="icon" aria-label={label("新聊天", "New chat")} onClick={controller.newSession}><Plus /></Button>
        </header>
        <div className={styles.panelInset}>
          <TabsPanel value={state.selectedId} className={styles.panel} data-composer6-region="page-panel" aria-label={copy(selected.title)}>
            {!controller.hasMessages ? <div className={styles.welcomeScroll}>
              <div className={styles.welcome} data-composer6-region="welcome">
                <h1><span>{label("你好，Robert", "Hello Robert")}</span>{label("我们要一起做什么？", "What are we working on?")}</h1>
                {state.dataState !== "ready" && <div className={styles.notice} role={state.dataState === "error" ? "alert" : "status"}><span>{state.dataState === "loading" ? label("建议与会话加载中 · 本地场景", "Loading suggestions and conversations · Local scenario") : label("刷新失败，已保留会话与草稿。", "Refresh failed. Conversations and drafts are preserved.")}</span><Button variant="outline" onClick={() => controller.dispatch({ type: "ready" })}>{state.dataState === "loading" ? label("完成示例加载", "Finish example loading") : label("重试", "Retry")}</Button></div>}
                {scenario === "readonly" && <p className={styles.readonly} role="status">{label("只读场景：可以查看会话、编辑草稿和选择模型，但不能发送。", "Read-only scenario: browse conversations, edit drafts, and choose a model; sending is unavailable.")}</p>}
                <ComposerInput controller={controller} helpId={`${prefix}-help`} options={{ leadingAction: <></>, showBlocksControl: false, hideSuggestion: true, showContextReferences: false, formLabel: { "zh-CN": "开始会话", en: "Start conversation" }, inputLabel: { "zh-CN": "消息", en: "Message" }, placeholder: { "zh-CN": "询问草稿、受众或期望的结果…", en: "Ask about a draft, audience, or outcome…" } }} />
                <section className={styles.suggestions} aria-labelledby={`${prefix}-suggestions`} data-composer6-region="suggestions">
                  <div className={styles.suggestionsHeader}><h2 id={`${prefix}-suggestions`}>{label("建议起点", "Suggested starting points")}</h2><Button variant="ghost" size="sm" disabled={state.dataState === "loading"} onClick={() => controller.dispatch({ type: "shuffle" })}><RefreshCw size={12} />{label("换一组", "Shuffle")}</Button></div>
                  {state.dataState === "loading" ? <div className={styles.skeleton} /> : <div className={styles.suggestionGrid}>{controller.startingPoints.map(item => { const Icon = icons[item.icon]; return <Button key={item.id} variant="ghost" className={styles.suggestion} disabled={!controller.canSend} onClick={() => controller.sendMessage(item.prompt)}><Icon size={16} /><span>{copy(item.title)}</span></Button> })}</div>}
                </section>
              </div>
            </div> : <>
              <div className={styles.history} ref={historyRef} onScroll={rememberPosition} role="region" aria-label={label("对话消息", "Conversation messages")} tabIndex={0} data-composer6-region="history">
                <div className={styles.messageColumn} role="log" aria-live="polite">{selected.messages.map(message => <article key={message.id} className={styles.message} data-role={message.role}><p>{copy(message.text)}</p></article>)}</div>
              </div>
              <div className={styles.threadComposer}><ComposerInput controller={controller} helpId={`${prefix}-thread-help`} options={{ leadingAction: <></>, showBlocksControl: false, hideSuggestion: true, showContextReferences: false, formLabel: { "zh-CN": "继续会话", en: "Continue conversation" }, inputLabel: { "zh-CN": "消息", en: "Message" }, placeholder: { "zh-CN": "继续提问或补充背景…", en: "Ask a follow-up or add more context…" } }} /></div>
            </>}
          </TabsPanel>
        </div>
      </Tabs>
    </div>
  )
  return <div className={styles.root} data-page="composer-6">
    <ComposerWorkspaceView controller={controller} host={host} presentation={{ showSessionNavigation: false, pageHeader: null, id: "composer-6", title: { "zh-CN": "Composer 6", en: "Composer 6" }, welcome: { title: { "zh-CN": "你好，Robert", en: "Hello Robert" }, description: { "zh-CN": "我们要一起做什么？", en: "What are we working on?" } }, renderBody: () => workbench }} />
    <Dialog open={!!collection && active} onOpenChange={open => { if (!open) setCollection(null) }}><DialogContent><DialogTitle>{collection === "review" ? label("审阅队列", "Review queue") : label("已保存回复", "Saved responses")}</DialogTitle><DialogDescription>{label("本地示例内容。打开会话或将已保存的起点作为草稿；不会访问外部服务。", "Local example content. Open a conversation or use a saved starting point as a draft; no external service is accessed.")}</DialogDescription><div className={styles.collection}>
      {collection === "review" ? state.sessions.filter(session => session.messages.length).slice(0, 3).map(session => <Item key={session.id} title={copy(session.title)} density="compact" onSelect={() => { controller.selectSession(session); setCollection(null) }} />) : savedStartingPoints.map(item => { return <Item key={item.id} title={copy(item.title)} density="compact" onSelect={() => { controller.updateDraft({ text: copy(item.prompt) }); setCollection(null); controller.focusComposer() }} /> })}
      {collection === "review" && !state.sessions.some(session => session.messages.length) && <p>{label("没有待审阅的会话。", "No conversations awaiting review.")}</p>}
    </div></DialogContent></Dialog>
    <span className="sr-only" role="status">{draft.text ? label("草稿已保留在当前聊天。", "Draft retained in the current chat.") : ""}</span>
  </div>
}

export function RemainingPageView(props: RemainingPageProps) {
  return <RemainingPageStateProvider cache={props.cache}><Composer6Page key={props.scenario} {...props} /></RemainingPageStateProvider>
}
