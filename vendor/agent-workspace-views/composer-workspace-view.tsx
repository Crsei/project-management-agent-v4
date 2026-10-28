"use client"

import {
  useId,
  type ReactNode,
  type ComponentType,
  type AnchorHTMLAttributes,
} from "react"
import {
  Bell,
  Blocks,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Download,
  Folder,
  Library,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Search,
  Settings2,
  SquarePen,
  Sun,
  Trash2,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import { ComposerInput, type ComposerInputOptions } from "./composer-input"
import styles from "./composer-workspace.module.css"

import { RuntimeStatusBadge } from "@easyuse-ui/ui/components/ui/runtime-status-badge"
import type { Copy, ChatEntry } from "./model"
import type { ComposerController } from "./controller"

export type ComposerHost = {
  Link: ComponentType<
    AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: false }
  >
  navigation: {
    title: Copy
    items: { href: string; label: Copy; icon: typeof Box; active?: boolean }[]
  }[]
  homeHref: string
  componentsHref: string
  referenceHref: string
  mainContentId?: string
  resolvedTheme?: string
  setTheme: (theme: "light" | "dark" | "system") => void
}
export type ComposerPresentation = {
  id: string
  title: Copy
  welcome: { title: Copy; description: Copy }
  headerActions?: ReactNode
  renderBody?: (canvas: ReactNode) => ReactNode
  renderHistory?: (history: ReactNode) => ReactNode
  beforeInput?: ReactNode
  afterInput?: ReactNode
  workspaceNavigation?: ReactNode
  showSessionNavigation?: boolean
  showNotifications?: boolean
  pageHeader?: ReactNode
  /** Caller-owned structured message content; navigation and scrolling stay shared. */
  renderMessage?: (message: ChatEntry) => ReactNode
  input?: ComposerInputOptions
}

export function ComposerWorkspaceView({
  controller,
  host,
  presentation,
}: {
  controller: ComposerController
  host: ComposerHost
  presentation?: ComposerPresentation
}) {
  const {
    locale,
    setLocale,
    copy,
    label,
    globalCollapsed,
    setGlobalCollapsed,
    sessionsVisible,
    setSessionsVisible,
    renameSession,
    clearSession,
    selectedId,
    projectId,
    dialog,
    setDialog,
    query,
    setQuery,
    renameValue,
    setRenameValue,
    suggestionsVisible,
    setSuggestionsVisible,
    feedback,
    history,
    selected,
    hasMessages,
    chats,
    searchResults,
    sessionTitle,
    selectSession,
    newSession,
    selectProject,
    rememberPosition,
    exportConversation,
    openSettings,
    projects,
    runtime,
  } = controller
  const { Link, navigation, resolvedTheme, setTheme } = host
  const prefix = useId()
  const id = (name: string) =>
    name === "main-content" && host.mainContentId
      ? host.mainContentId
      : `${prefix}-${name}`
  const themeIcon = resolvedTheme === "dark" ? <Moon /> : <Monitor />
  const historyContent = (
    <div
      data-composer-region="history"
      ref={history}
      onScroll={rememberPosition}
      className={`${styles.history} relative`}
      hidden={!hasMessages}
      role="region"
      aria-label={label("对话记录", "Conversation history")}
      tabIndex={0}
    >
      {selected.messages.map((message) =>
        presentation?.renderMessage ? (
          <div key={message.id}>{presentation.renderMessage(message)}</div>
        ) : (
          <article
            key={message.id}
            className={styles.message}
            data-role={message.role}
          >
            <div className={styles.messageLabel}>
              {message.role === "assistant" && (
                <Box size={16} aria-hidden="true" />
              )}
              {message.role === "user"
                ? label("你", "You")
                : message.role === "system"
                  ? label("系统", "System")
                  : message.role === "tool"
                    ? label("工具", "Tool")
                    : "EasyuseUI"}
              {message.role === "assistant" && controller.messageMode === "demo" && (
                <span className={styles.exampleLabel}>
                  {label("示例回复", "Example response")}
                </span>
              )}
            </div>
            <p className={styles.messageText}>{copy(message.text)}</p>
            {!!message.contexts?.length && (
              <div className={styles.messageContexts}>
                {label("上下文引用", "Context references")}:{" "}
                {message.contexts.join(" · ")}
              </div>
            )}
          </article>
        ),
      )}
    </div>
  )
  const canvas = (
    <div
      className={`${styles.canvas} ${!hasMessages ? styles.emptyCanvas : ""}`}
    >
      {presentation?.renderHistory
        ? presentation.renderHistory(historyContent)
        : historyContent}
      <div
        data-composer-region="input-container"
        className={!hasMessages ? styles.home : styles.conversationComposer}
      >
        <div className={styles.welcome} hidden={hasMessages}>
          <Box className={styles.welcomeLogo} aria-hidden="true" />
          <h1>
            {presentation
              ? copy(presentation.welcome.title)
              : label("我们来构建什么？", "What should we build?")}
          </h1>
          <p>
            {presentation
              ? copy(presentation.welcome.description)
              : label(
                  "描述一个管理界面、组件，或工作流程。",
                  "Describe an admin screen, component, or workflow.",
                )}
          </p>
        </div>
        {presentation?.beforeInput}
        <ComposerInput
          controller={controller}
          helpId={id("composer-submit-help")}
          options={presentation?.input}
        />
        {presentation?.afterInput}
      </div>
    </div>
  )
  return (
    <div
      className={styles.workspace}
      data-composer-workspace
      data-composer-layout="conversation-dual-sidebar"
      data-page={presentation?.id ?? "composer"}
    >
      <aside
        data-composer-region="site-navigation"
        className={styles.globalSidebar}
        data-collapsed={globalCollapsed}
        aria-label={label("站点导航", "Site navigation")}
      >
        <div className={styles.brandHeader}>
          <Link
            href={host.homeHref}
            className={styles.brand}
            aria-label={label("EasyuseUI 首页", "EasyuseUI home")}
            prefetch={false}
          >
            <span className={styles.brandMark}>
              <Box size={20} aria-hidden="true" />
            </span>
            <span className={styles.brandText}>
              <strong>EasyuseUI</strong>
              <small>Vite + React · UI Lab</small>
            </span>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className={styles.iconButton}
            aria-label={
              globalCollapsed
                ? label("展开站点导航", "Expand site navigation")
                : label("折叠站点导航", "Collapse site navigation")
            }
            aria-expanded={!globalCollapsed}
            aria-controls={id("composer-site-nav")}
            onClick={() => setGlobalCollapsed((value) => !value)}
          >
            <PanelLeft />
          </Button>
        </div>
        <nav className={styles.sidebarScroll} id={id("composer-site-nav")}>
          {navigation.map((group) => (
            <section
              className={styles.globalGroup}
              key={group.title.en}
              aria-label={copy(group.title)}
            >
              <h2 className={styles.sectionTitle}>{copy(group.title)}</h2>
              <ul className={styles.navList}>
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      prefetch={false}
                      href={item.href}
                      className={styles.navLink}
                      aria-current={item.active ? "page" : undefined}
                      aria-label={
                        globalCollapsed ? copy(item.label) : undefined
                      }
                      title={globalCollapsed ? copy(item.label) : undefined}
                    >
                      <item.icon aria-hidden="true" />
                      <span className={styles.navText}>{copy(item.label)}</span>
                      <ChevronRight
                        className={styles.navChevron}
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <div className={styles.account}>
          <Button
            variant="ghost"
            className={styles.accountButton}
            aria-label={label("工作空间设置", "Workspace settings")}
            onClick={openSettings}
          >
            <span className={styles.avatar}>EU</span>
            <span className={styles.accountText}>
              <strong>EasyuseUI</strong>
              <small>{controller.messageMode === "demo" ? label("本地预览", "Local preview") : label("工作空间", "Workspace")}</small>
            </span>
            <ChevronsUpDown className={styles.accountChevron} />
          </Button>
        </div>
      </aside>

      {presentation?.showSessionNavigation !== false && (<aside
        data-composer-region="session-navigation"
        className={styles.sessionSidebar}
        id={id("composer-session-nav")}
        hidden={!sessionsVisible}
        aria-label={label("工作空间导航", "Workspace navigation")}
      >
        <div className={styles.teamHeader}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className={styles.teamButton}
                  aria-label={label("切换工作空间", "Switch workspace")}
                />
              }
            >
              <span className={styles.teamMark}>
                <Box size={16} aria-hidden="true" />
              </span>
              <span>EasyuseUI</span>
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent className={styles.menu}>
              <DropdownMenuGroup>
                <DropdownMenuLabel className={styles.menuHeading}>
                  {label("工作空间", "Workspaces")}
                </DropdownMenuLabel>
                {projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={() => selectProject(project.id)}
                  >
                    <Folder size={16} />
                    {project.name}
                    {projectId === project.id && <Check size={14} />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openSettings}>
                <Settings2 size={16} />
                {label("工作空间设置", "Workspace settings")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {presentation?.showNotifications !== false && (<Button
            variant="ghost"
            size="icon"
            className={`${styles.iconButton} ${styles.notification}`}
            aria-label={label("通知", "Notifications")}
            onClick={() => setDialog("notifications")}
          >
            <Bell />
          </Button>)}
        </div>
        {presentation?.workspaceNavigation !== undefined ? presentation.workspaceNavigation : (<div className={styles.sidebarScroll}>
          <section
            className={styles.sessionGroup}
            aria-labelledby={id("composer-actions-label")}
          >
            <h2
              className={styles.sectionTitle}
              id={id("composer-actions-label")}
            >
              {label("操作", "Actions")}
            </h2>
            <ul className={styles.navList}>
              <li>
                <Button
                  variant="ghost"
                  className={styles.navButton}
                  data-active={!hasMessages}
                  onClick={() => newSession()}
                >
                  <SquarePen />
                  {label("新会话", "New session")}
                </Button>
              </li>
              <li>
                <Button
                  variant="ghost"
                  className={styles.navButton}
                  onClick={() => {
                    setQuery("")
                    setDialog("search")
                  }}
                >
                  <Search />
                  {label("搜索会话", "Search sessions")}
                </Button>
              </li>
              <li>
                <Link
                  className={styles.navLink}
                  href={host.componentsHref}
                  prefetch={false}
                >
                  <Blocks aria-hidden="true" />
                  {label("浏览组件", "Browse blocks")}
                </Link>
              </li>
              <li>
                <Link
                  className={styles.navLink}
                  href={host.referenceHref}
                  prefetch={false}
                >
                  <Library aria-hidden="true" />
                  {label("参考资料", "Reference library")}
                </Link>
              </li>
            </ul>
          </section>
          <section
            className={styles.sessionGroup}
            aria-labelledby={id("composer-projects-label")}
          >
            <h2
              className={styles.sectionTitle}
              id={id("composer-projects-label")}
            >
              {label("工作空间", "Workspaces")}
            </h2>
            <ul className={styles.navList}>
              {projects.map((project) => (
                <li key={project.id}>
                  <Button
                    variant="ghost"
                    className={styles.navButton}
                    aria-pressed={projectId === project.id}
                    onClick={() => selectProject(project.id)}
                  >
                    <Folder />
                    <span className={styles.navText}>{project.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
          <section
            className={styles.sessionGroup}
            aria-labelledby={id("composer-chats-label")}
          >
            <h2 className={styles.sectionTitle} id={id("composer-chats-label")}>
              {label("对话", "Chats")}
            </h2>
            <ul className={styles.navList}>
              {chats.map((session) => (
                <li key={session.id}>
                  <Button
                    variant="ghost"
                    className={styles.navButton}
                    aria-pressed={selectedId === session.id}
                    title={sessionTitle(session)}
                    onClick={() => selectSession(session)}
                  >
                    <MessageSquare />
                    <span className={styles.navText}>
                      {sessionTitle(session)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            {!chats.length && (
              <p className={styles.emptyChats}>
                {label("开始你的第一段对话", "Start your first conversation")}
              </p>
            )}
          </section>
        </div>)}
      </aside>)}

      <main className={styles.main} id={id("main-content")} tabIndex={-1}>
        {presentation?.pageHeader !== undefined ? presentation.pageHeader : (<header
          data-composer-region="page-header"
          className={styles.mainHeader}
        >
          <Button
            variant="ghost"
            size="icon"
            className={styles.iconButton}
            aria-label={
              sessionsVisible
                ? label("收起会话导航", "Hide session navigation")
                : label("展开会话导航", "Show session navigation")
            }
            aria-expanded={sessionsVisible}
            aria-controls={id("composer-session-nav")}
            onClick={() => setSessionsVisible((value) => !value)}
          >
            <PanelLeft />
          </Button>
          <span className={styles.headerDivider} />
          <span
            className={styles.sessionTitle}
            title={
              hasMessages
                ? copy(selected.title)
                : presentation
                  ? copy(presentation.title)
                  : "Agent Workspace"
            }
          >
            {hasMessages
              ? copy(selected.title)
              : presentation
                ? copy(presentation.title)
                : "Agent Workspace"}
          </span>
          <div className={styles.headerActions}>
            {presentation?.headerActions}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className={styles.iconButton}
                    aria-label={label("切换主题", "Toggle theme")}
                  />
                }
              >
                {themeIcon}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setTheme("light")}>
                  <Sun size={16} />
                  {label("浅色", "Light")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                  <Moon size={16} />
                  {label("深色", "Dark")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <Monitor size={16} />
                  {label("跟随系统", "System")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className={styles.iconButton}
                    aria-label={label("会话操作", "Session actions")}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent className={styles.menu}>
                <DropdownMenuItem
                  disabled={!hasMessages}
                  onClick={exportConversation}
                >
                  <Download size={16} />
                  {label("导出对话", "Export conversation")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setRenameValue(copy(selected.title))
                    setDialog("rename")
                  }}
                >
                  <SquarePen size={16} />
                  {label("重命名会话", "Rename session")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasMessages || !clearSession}
                  onClick={() => setDialog("clear")}
                >
                  <Trash2 size={16} />
                  {label("清空对话", "Clear conversation")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setSuggestionsVisible((value) => !value)}
                >
                  {suggestionsVisible && <Check size={16} />}
                  {label("提示建议", "Prompt suggestions")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={openSettings}>
                  <Settings2 size={16} />
                  {label("设置", "Settings")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>)}

        {runtime && (
          <div className={styles.runtimeNotice} role="status">
            <RuntimeStatusBadge status={runtime.status} />
            <span>{copy(runtime.message)}</span>
          </div>
        )}
        {presentation?.renderBody ? presentation.renderBody(canvas) : canvas}
      </main>

      <Dialog
        open={dialog !== null && controller.active}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent>
          <DialogTitle>
            {dialog === "search"
              ? label("搜索会话", "Search sessions")
              : dialog === "rename"
                ? label("重命名会话", "Rename session")
                : dialog === "clear"
                  ? label("清空对话？", "Clear conversation?")
                  : dialog === "notifications"
                    ? label("通知", "Notifications")
                    : label("工作空间设置", "Workspace settings")}
          </DialogTitle>
          <DialogDescription>
            {dialog === "search"
              ? label(
                  "搜索当前工作空间中的对话。",
                  "Search conversations in the current workspace.",
                )
              : dialog === "clear"
                ? label(
                    "清空当前会话的消息，保留未发送的草稿。此操作无法撤销。",
                    "Clear messages from this session and keep your unsent draft. This cannot be undone.",
                  )
                : dialog === "rename"
                  ? label(
                      "为这段对话设置一个容易辨认的名字。",
                      "Give this conversation a recognizable name.",
                    )
                  : dialog === "notifications"
                    ? label("没有新通知。", "You’re all caught up.")
                    : controller.messageMode === "demo"
                      ? label(
                          "外观与语言是本地偏好。当前对话使用示例数据。",
                          "Appearance and language are local preferences. Conversations use example data.",
                        )
                      : label("外观与语言是本地偏好。", "Appearance and language are local preferences.")}
          </DialogDescription>
          {dialog === "search" && (
            <div className={styles.dialogBody}>
              <Input
                aria-label={label("搜索会话名称", "Search session names")}
                placeholder={label("输入会话名称…", "Search by session name…")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className={styles.searchResults}>
                {searchResults.map((session) => (
                  <Button
                    key={session.id}
                    variant="ghost"
                    className={styles.searchResult}
                    onClick={() => {
                      selectSession(session)
                      setDialog(null)
                    }}
                  >
                    <MessageSquare />
                    <span>{sessionTitle(session)}</span>
                  </Button>
                ))}
                {!searchResults.length && (
                  <p className={styles.emptyChats}>
                    {label("没有找到匹配的会话", "No matching sessions")}
                  </p>
                )}
              </div>
            </div>
          )}
          {dialog === "rename" && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (!renameValue.trim()) return
                renameSession(selectedId, renameValue.trim())
                setDialog(null)
              }}
            >
              <div className={styles.dialogBody}>
                <Input
                  aria-label={label("会话名称", "Session name")}
                  value={renameValue}
                  maxLength={80}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
              </div>
              <div className={styles.dialogFooter}>
                <Button type="submit" disabled={!renameValue.trim()}>
                  {label("保存", "Save")}
                </Button>
              </div>
            </form>
          )}
          {dialog === "clear" && (
            <div className={styles.dialogFooter}>
              <Button variant="outline" onClick={() => setDialog(null)}>
                {label("取消", "Cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={!clearSession}
                onClick={() => {
                  clearSession?.(selectedId)
                  setDialog(null)
                }}
              >
                {label("清空对话", "Clear conversation")}
              </Button>
            </div>
          )}
          {dialog === "settings" && (
            <div className={styles.dialogBody}>
              <div className={styles.settingsRow}>
                <span>{label("语言", "Language")}</span>
                <div className={styles.settingButtons}>
                  <Button
                    variant="outline"
                    aria-pressed={locale === "zh-CN"}
                    onClick={() => setLocale("zh-CN")}
                  >
                    中文
                  </Button>
                  <Button
                    variant="outline"
                    aria-pressed={locale === "en"}
                    onClick={() => setLocale("en")}
                  >
                    English
                  </Button>
                </div>
              </div>
              <div className={styles.settingsRow}>
                <span>{label("外观", "Appearance")}</span>
                <div className={styles.settingButtons}>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={label("浅色", "Light")}
                    onClick={() => setTheme("light")}
                  >
                    <Sun />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={label("深色", "Dark")}
                    onClick={() => setTheme("dark")}
                  >
                    <Moon />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={label("跟随系统", "System")}
                    onClick={() => setTheme("system")}
                  >
                    <Monitor />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <div className={styles.status} role="status">
        {feedback}
      </div>
    </div>
  )
}
