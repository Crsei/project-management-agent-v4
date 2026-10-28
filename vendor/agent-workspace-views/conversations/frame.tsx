"use client"
import { useId, useRef, type ReactNode } from "react"
import {
  Box,
  MessageSquare,
  PanelLeft,
  Search,
  Settings2,
  SquarePen,
} from "lucide-react"
import type { ComposerController } from "../controller"
import type { ComposerHost } from "../composer-workspace-view"
import {
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  RadioGroup,
  RadioGroupItem,
} from "./ui"
import styles from "./frame.module.css"

export function ConversationFrame({
  controller,
  host,
  showSessionNavigation,
  workspaceNavigation,
  header,
  children,
}: {
  controller: ComposerController
  host: ComposerHost
  showSessionNavigation: boolean
  workspaceNavigation?: ReactNode
  header: ReactNode
  children: ReactNode
}) {
  const { label, copy } = controller
  return (
    <>
      <aside
        className={styles.globalNav}
        data-composer-region="global-navigation"
        data-collapsed={controller.globalCollapsed}
        aria-label={label("示例导航", "Example navigation")}
      >
        <div className={styles.brand}>
          <Box size={20} aria-hidden="true" />
          {!controller.globalCollapsed && <span>EasyuseUI</span>}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label("切换全局导航", "Toggle global navigation")}
            aria-expanded={!controller.globalCollapsed}
            onClick={() => controller.setGlobalCollapsed((value) => !value)}
          >
            <PanelLeft />
          </Button>
        </div>
        <nav
          className={styles.navScroll}
          aria-label={label("页面示例", "Page examples")}
        >
          {host.navigation.map((group, index) => (
            <section className={styles.navGroup} key={index}>
              {!controller.globalCollapsed && <h2>{copy(group.title)}</h2>}
              {group.items.map((item) => (
                <Button
                  key={item.href}
                  asChild
                  variant="ghost"
                  size={controller.globalCollapsed ? "icon" : "default"}
                >
                  <host.Link
                    href={item.href}
                    prefetch={false}
                    aria-current={item.active ? "page" : undefined}
                    aria-label={copy(item.label)}
                    title={copy(item.label)}
                  >
                    <item.icon aria-hidden="true" />
                    {!controller.globalCollapsed && (
                      <span>{copy(item.label)}</span>
                    )}
                  </host.Link>
                </Button>
              ))}
            </section>
          ))}
        </nav>
        <div className={styles.navFooter}>
          <Button
            variant="ghost"
            size={controller.globalCollapsed ? "icon" : "default"}
            aria-label={label("设置", "Settings")}
            onClick={controller.openSettings}
          >
            <Settings2 />
            {!controller.globalCollapsed && label("设置", "Settings")}
          </Button>
          {!controller.globalCollapsed && (
            <small className="px-2 text-muted-foreground">
              {label(
                "本地场景 · 不执行 Agent",
                "Local fixtures · No Agent execution",
              )}
            </small>
          )}
        </div>
      </aside>
      {showSessionNavigation && controller.sessionsVisible && (
        <aside
          className={styles.sessions}
          data-composer-region="workspace-navigation"
          aria-label={label("会话导航", "Session navigation")}
        >
          {workspaceNavigation ?? (
            <>
              <div className={styles.sessionTools}>
                <Button
                  variant="outline"
                  onClick={() => controller.newSession()}
                >
                  <SquarePen />
                  {label("新会话", "New conversation")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={label("搜索会话", "Search conversations")}
                  onClick={() => controller.setDialog("search")}
                >
                  <Search />
                </Button>
              </div>
              {controller.projects.length > 1 && (
                <div
                  className="mb-3 flex flex-wrap gap-1"
                  role="group"
                  aria-label={label("项目", "Projects")}
                >
                  {controller.projects.map((project) => (
                    <Button
                      key={project.id}
                      size="sm"
                      variant="ghost"
                      aria-pressed={controller.projectId === project.id}
                      onClick={() => controller.selectProject(project.id)}
                    >
                      {project.name}
                    </Button>
                  ))}
                </div>
              )}
              <h2 className="mb-2 px-2 text-xs text-muted-foreground">
                {label("最近会话", "Recent conversations")}
              </h2>
              <div className={styles.sessionList}>
                {controller.chats.map((session) => (
                  <Button
                    key={session.id}
                    variant="ghost"
                    className={styles.session}
                    aria-current={
                      session.id === controller.selectedId ? "true" : undefined
                    }
                    onClick={() => controller.selectSession(session)}
                  >
                    <MessageSquare className="shrink-0" />
                    <span>{controller.sessionTitle(session)}</span>
                  </Button>
                ))}
              </div>
            </>
          )}
        </aside>
      )}
      <section
        className={styles.workspace}
        aria-label={label("对话工作区", "Conversation workspace")}
      >
        {header}
        <div className={styles.content}>{children}</div>
      </section>
      <ConversationDialogs controller={controller} host={host} />
    </>
  )
}

function ConversationDialogs({
  controller,
  host,
}: {
  controller: ComposerController
  host: ComposerHost
}) {
  const id = useId()
  const returnFocus = useRef<HTMLElement | null>(null)
  const { label, dialog } = controller
  const title =
    dialog === "search"
      ? label("搜索会话", "Search conversations")
      : dialog === "rename"
        ? label("重命名会话", "Rename conversation")
        : dialog === "clear"
          ? label("清空会话", "Clear conversation")
          : dialog === "notifications"
            ? label("本地通知", "Local notifications")
            : label("工作区设置", "Workspace settings")
  return (
    <Dialog
      open={Boolean(dialog) && controller.active}
      onOpenChange={(open) => {
        if (!open) controller.setDialog(null)
      }}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
        }}
        onCloseAutoFocus={(event) => {
          if (controller.active && returnFocus.current?.isConnected) {
            event.preventDefault()
            returnFocus.current.focus({ preventScroll: true })
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {dialog === "clear"
              ? label(
                  "仅清除当前本地会话的消息，输入草稿保留；不会调用服务。",
                  "Clears only this local conversation's messages, preserving its draft; no service call.",
                )
              : label(
                  "所有设置与编辑均为本地示例，不更改 Agent 服务。",
                  "All settings and edits are local examples; no Agent service changes.",
                )}
          </DialogDescription>
        </DialogHeader>
        {dialog === "search" && (
          <>
            <Label htmlFor={`${id}-search`}>
              {label("标题关键词", "Title keywords")}
            </Label>
            <Input
              id={`${id}-search`}
              value={controller.query}
              onChange={(event) => controller.setQuery(event.target.value)}
            />
            <div className={styles.dialogList}>
              {controller.searchResults.map((session) => (
                <Button
                  key={session.id}
                  variant="ghost"
                  onClick={() => {
                    controller.selectSession(session)
                    controller.setDialog(null)
                  }}
                >
                  {controller.sessionTitle(session)}
                </Button>
              ))}
              {!controller.searchResults.length && (
                <p role="status">
                  {label("没有匹配的会话。", "No matching conversations.")}
                </p>
              )}
            </div>
          </>
        )}
        {dialog === "rename" && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (controller.renameValue.trim()) {
                controller.renameSession(
                  controller.selectedId,
                  controller.renameValue.trim(),
                )
                controller.setDialog(null)
              }
            }}
          >
            <Label htmlFor={`${id}-rename`}>
              {label("会话标题", "Conversation title")}
            </Label>
            <Input
              id={`${id}-rename`}
              value={controller.renameValue}
              onChange={(event) =>
                controller.setRenameValue(event.target.value)
              }
              required
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => controller.setDialog(null)}
              >
                {label("取消", "Cancel")}
              </Button>
              <Button type="submit" disabled={!controller.renameValue.trim()}>
                {label("保存", "Save")}
              </Button>
            </DialogFooter>
          </form>
        )}
        {dialog === "clear" && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => controller.setDialog(null)}
            >
              {label("取消", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!controller.clearSession}
              onClick={() => {
                controller.clearSession?.(controller.selectedId)
                controller.setDialog(null)
              }}
            >
              {label("清除本地消息", "Clear local messages")}
            </Button>
          </DialogFooter>
        )}
        {dialog === "settings" && (
          <div className={styles.settings}>
            <fieldset>
              <legend>{label("语言", "Language")}</legend>
              <RadioGroup
                value={controller.locale}
                onValueChange={(value) => {
                  if (value === "zh-CN" || value === "en")
                    controller.setLocale(value)
                }}
                className="flex"
              >
                <Label>
                  <RadioGroupItem value="zh-CN" />
                  简体中文
                </Label>
                <Label>
                  <RadioGroupItem value="en" />
                  English
                </Label>
              </RadioGroup>
            </fieldset>
            <fieldset>
              <legend>{label("主题", "Theme")}</legend>
              <RadioGroup
                value={host.resolvedTheme === "dark" ? "dark" : "light"}
                onValueChange={(value) => {
                  if (value === "light" || value === "dark")
                    host.setTheme(value)
                }}
                className="flex"
              >
                <Label>
                  <RadioGroupItem value="light" />
                  {label("浅色", "Light")}
                </Label>
                <Label>
                  <RadioGroupItem value="dark" />
                  {label("深色", "Dark")}
                </Label>
              </RadioGroup>
            </fieldset>
            <p className="text-sm text-muted-foreground">
              {label(
                "Enter 发送，Shift+Enter 换行。主题与语言切换不会写入服务。",
                "Enter to send, Shift+Enter for a new line. Theme and language changes do not write to services.",
              )}
            </p>
          </div>
        )}
        {dialog === "notifications" && (
          <p>
            {controller.feedback ||
              label("没有本地通知。", "No local notifications.")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
