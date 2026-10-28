"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import {
  Activity,
  Blocks,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  CircleCheck,
  Code2,
  Cpu,
  Headphones,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
} from "@easyuse-ui/ui/components/blocks/sidebar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@easyuse-ui/ui/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import {
  categories,
  permissionCopy,
  type Category,
  type Integration,
} from "./fixtures"
import {
  checkIntegration,
  createIntegrationsState,
  disconnectIntegration,
  openIntegration,
  reloadIntegrations,
  saveIntegration,
  saveRequest,
  setPermission,
  visibleIntegrations,
  type Filter,
  type Permissions,
} from "./controller"
import { integrationLogos } from "./logos"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios
const categoryIcons: Record<Category, typeof Cpu> = {
  models: Cpu,
  development: Code2,
  design: Palette,
  knowledge: BookOpen,
  planning: CalendarDays,
  communication: MessageSquare,
  support: Headphones,
  monitoring: Activity,
}
function IntegrationIcon({ name }: { name: string }) {
  const logo = integrationLogos[name]
  return (
    <span className={styles.logo} aria-hidden="true">
      <svg viewBox={logo.viewBox} fill="currentColor">
        {logo.paths.map((path, index) => (
          <path key={index} d={path.d} fill={path.fill} />
        ))}
      </svg>
    </span>
  )
}

export function RemainingPageView({
  scenario,
  active,
  host,
  cache,
}: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    "agent-studio-integrations:" + scenario,
    () => createIntegrationsState(scenario),
  )
  const body = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    searchOpener = useRef<HTMLButtonElement>(null)
  const focusTarget = useRef<HTMLElement | null>(null)
  const scrollKey = "agent-studio-integrations:" + scenario + ":scroll"
  const selected = state.items.find((item) => item.id === state.selectedId)
  const draft = selected ? state.drafts[selected.id] : undefined
  const visible = visibleIntegrations(state)
  const connected = state.items.filter((item) => item.connected).length
  const loading = state.dataState === "loading"
  const currentFilter =
    state.filter === "all"
      ? label("全部连接", "All connections")
      : state.filter === "connected"
        ? label("已连接", "Connected")
        : categories.find((category) => category.id === state.filter)!.name[
            locale
          ]

  useLayoutEffect(() => {
    if (active && body.current)
      body.current.scrollTop = Number(cache.get(scrollKey) ?? 0)
  }, [active, cache, scrollKey, locale, host.resolvedTheme])
  useLayoutEffect(() => {
    if (active && state.searchOpen) search.current?.focus()
  }, [active, state.searchOpen])
  useEffect(() => {
    if (!active) return
    function key(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        state.searchOpen &&
        !state.selectedId &&
        !state.requestOpen
      ) {
        event.preventDefault()
        setState((previous) => ({ ...previous, searchOpen: false, query: "" }))
        searchOpener.current?.focus()
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [active, state.searchOpen, state.selectedId, state.requestOpen, setState])
  function filter(value: Filter) {
    setState((previous) => ({ ...previous, filter: value }))
  }
  function closeSheet() {
    setState((previous) => ({ ...previous, selectedId: null }))
    requestAnimationFrame(() => focusTarget.current?.focus())
  }
  function row(item: Integration) {
    return (
      <li key={item.id} className={styles.connectionRow}>
        <Item
          className={styles.integrationItem}
          title={<h3>{item.name}</h3>}
          description={
            <span title={item.description[locale]}>
              {item.description[locale]}
            </span>
          }
          leading={<IntegrationIcon name={item.name} />}
          trailing={
            <Button
              variant={item.connected ? "ghost" : "outline"}
              size="sm"
              disabled={loading}
              aria-label={label(
                item.connected ? "管理 " + item.name : "连接 " + item.name,
                (item.connected ? "Manage " : "Connect ") + item.name,
              )}
              onClick={(event) => {
                focusTarget.current = event.currentTarget
                setState((previous) => openIntegration(previous, item.id))
              }}
            >
              {item.connected && <Check />}
              {item.connected
                ? label("已连接", "Connected")
                : label("连接", "Connect")}
            </Button>
          }
        />
      </li>
    )
  }
  function collection(title: string, items: Integration[]) {
    return (
      <section aria-label={title} className={styles.collection}>
        <h2>{title}</h2>
        <ul className={styles.grid}>{items.map(row)}</ul>
      </section>
    )
  }
  const grouped = state.filter === "all" && !state.query.trim()
  return (
    <div
      className={styles.page}
      data-agent-integrations
      data-locale={locale}
      id={host.mainContentId}
      aria-busy={loading || undefined}
    >
      {state.navigationOpen && (
        <Sidebar
          width={234}
          label={label("连接导航", "Connections navigation")}
          className={styles.sidebar}
        >
          <SidebarHeader className={styles.sidebarHeader}>
            <span className={styles.workspaceIdentity}>
              <Blocks />
              Shadcnblocks
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={label("切换主题", "Toggle theme")}
                  />
                }
              >
                {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => host.setTheme("light")}>
                  <Sun />
                  {label("浅色", "Light")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => host.setTheme("dark")}>
                  <Moon />
                  {label("深色", "Dark")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => host.setTheme("system")}>
                  <Monitor />
                  {label("跟随系统", "System")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarHeader>
          <SidebarContent className={styles.sidebarContent}>
            <div className={styles.searchHeading}>
              <span>{label("连接", "Connections")}</span>
              <Button
                ref={searchOpener}
                variant="ghost"
                size="icon"
                aria-label={label("搜索集成", "Search integrations")}
                aria-expanded={state.searchOpen}
                onClick={() =>
                  setState((previous) => ({
                    ...previous,
                    searchOpen: !previous.searchOpen,
                  }))
                }
              >
                <Search />
              </Button>
            </div>
            {state.searchOpen && (
              <div className={styles.search}>
                <Input
                  ref={search}
                  type="search"
                  aria-label={label("搜索集成", "Search integrations")}
                  value={state.query}
                  placeholder={label("搜索集成…", "Search integrations…")}
                  onChange={(event) =>
                    setState((previous) => ({
                      ...previous,
                      query: event.target.value,
                    }))
                  }
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={label("关闭集成搜索", "Close integration search")}
                  onClick={() => {
                    setState((previous) => ({
                      ...previous,
                      searchOpen: false,
                      query: "",
                    }))
                    searchOpener.current?.focus()
                  }}
                >
                  <X />
                </Button>
              </div>
            )}
            <nav aria-label={label("连接筛选", "Connection filters")}>
              <ul className={styles.filterList}>
                <li>
                  <Item
                    density="compact"
                    selected={state.filter === "all"}
                    onSelect={() => filter("all")}
                    leading={<Blocks />}
                    title={label("全部连接", "All connections")}
                    trailing={<span>{state.items.length}</span>}
                  />
                </li>
                <li>
                  <Item
                    density="compact"
                    selected={state.filter === "connected"}
                    onSelect={() => filter("connected")}
                    leading={<Plug />}
                    title={label("已连接", "Connected")}
                    trailing={<span>{connected}</span>}
                  />
                </li>
              </ul>
              <h2 className={styles.categoryHeading}>
                {label("分类", "Categories")}
              </h2>
              <ul className={styles.filterList}>
                {categories.map((category) => {
                  const Icon = categoryIcons[category.id]
                  return (
                    <li key={category.id}>
                      <Item
                        density="compact"
                        selected={state.filter === category.id}
                        onSelect={() => filter(category.id)}
                        leading={<Icon />}
                        title={category.name[locale]}
                      />
                    </li>
                  )
                })}
              </ul>
            </nav>
          </SidebarContent>
        </Sidebar>
      )}
      <section className={styles.main}><header className={styles.header}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label("切换连接导航", "Toggle connections navigation")}
          aria-expanded={state.navigationOpen}
          onClick={() =>
            setState((previous) => ({
              ...previous,
              navigationOpen: !previous.navigationOpen,
            }))
          }
        >
          <PanelLeft />
        </Button>
        <span className={styles.divider} />
        <span>{label("集成", "Integrations")}</span>
      </header>
      <div
        ref={body}
        className={styles.scroll}
        data-integrations-scroll
        onScroll={(event) => {
          if (active) cache.set(scrollKey, event.currentTarget.scrollTop)
        }}
      >
        <div className={styles.canvas}>
          <div className={styles.pageHeading}>
            <div>
              <h1>{label("集成", "Integrations")}</h1>
              <p>
                {label("让工具协同工作。", "Your tools, working together.")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={state.readonly || loading}
              onClick={(event) => {
                focusTarget.current = event.currentTarget
                setState((previous) => ({ ...previous, requestOpen: true }))
              }}
            >
              {label("推荐应用", "Request app")}
            </Button>
          </div>
          {state.readonly && (
            <p className={styles.notice} role="status">
              {label(
                "只读工作区：可以浏览和检查示例，不能修改连接或保存应用建议。",
                "Read-only workspace: browse and inspect samples; connections and app suggestions cannot be changed.",
              )}
            </p>
          )}
          {state.dataState === "refresh-error" && (
            <div className={styles.notice} role="alert">
              <span>
                {label(
                  "刷新失败，保留了当前连接和未保存草稿。",
                  "Refresh failed. Current connections and unsaved drafts are retained.",
                )}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setState(reloadIntegrations)}
              >
                {label("重新读取本地示例", "Reload local sample")}
              </Button>
            </div>
          )}
          <section
            className={styles.banner}
            aria-label={label("工作区上下文", "Workspace context")}
          >
            <div className={styles.bannerCopy}>
              <span>
                {label(
                  "更好的上下文，更好的工作。",
                  "BETTER CONTEXT. BETTER WORK.",
                )}
              </span>
              <h2>
                {label("把工作区带入", "Bring your workspace")}
                <br />
                {label("对话之中。", "into the conversation.")}
              </h2>
              <p>
                {label(
                  connected + " 个连接已可供 Agent 使用",
                  connected + " connections ready for your agents",
                )}
              </p>
            </div>
            <div className={styles.signals}>
              <div>
                <CheckCheck />
                {label(
                  "12 条客户信号已关联来源",
                  "12 customer signals linked to their sources",
                )}
              </div>
              <div>
                <CircleCheck />
                {label("每周简报已可供审阅", "Weekly brief ready for review")}
              </div>
            </div>
          </section>
          {state.notice && (
            <p role="status" className={styles.resultNotice}>
              {state.notice === "saved"
                ? label(
                    "已保存本地示例连接；未连接外部账户。",
                    "Local demo connection saved; no external account is connected.",
                  )
                : state.notice === "disconnected"
                  ? label(
                      "已移除本地示例连接。",
                      "Local demo connection removed.",
                    )
                  : label(
                      "应用建议已保存在当前示例工作区。",
                      "App suggestion saved in this demo workspace.",
                    )}
            </p>
          )}
          {loading ? (
            <div className={styles.loading} role="status">
              <span>
                {label(
                  "正在读取连接目录…",
                  "Reading the connection directory…",
                )}
              </span>
              <div className={styles.grid}>
                {[0, 1, 2, 3, 4, 5].map((id) => (
                  <Skeleton key={id} className={styles.skeleton} />
                ))}
              </div>
              <Button
                variant="outline"
                onClick={() => setState(reloadIntegrations)}
              >
                {label("完成本地读取", "Complete local read")}
              </Button>
            </div>
          ) : (
            <div className={styles.collections}>
              {grouped ? (
                <>
                  {collection(
                    label("为工作区推荐", "Recommended for your workspace"),
                    visible.filter((item) => item.recommended),
                  )}
                  {collection(
                    label("探索更多连接", "Explore more connections"),
                    visible.filter((item) => !item.recommended),
                  )}
                </>
              ) : (
                collection(currentFilter + " · " + visible.length, visible)
              )}
              {!visible.length && (
                <div className={styles.empty}>
                  <h2>{label("没有找到连接", "No connections found")}</h2>
                  <p>
                    {state.items.length
                      ? label(
                          "尝试其他搜索或分类。",
                          "Try another search or category.",
                        )
                      : label(
                          "目录中还没有连接。可以添加应用建议。",
                          "There are no connections in the directory yet. Suggest an app to add.",
                        )}
                  </p>
                  {state.items.length > 0 && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setState((previous) => ({
                          ...previous,
                          filter: "all",
                          query: "",
                        }))
                      }
                    >
                      {label("清除筛选", "Clear filters")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {state.requests.length > 0 && (
            <section
              className={styles.requests}
              aria-label={label("应用建议", "App requests")}
            >
              <h2>{label("应用建议", "App requests")}</h2>
              <ul>
                {state.requests.map((request) => (
                  <li key={request.id}>
                    <strong>{request.name}</strong>
                    {request.purpose && <p>{request.purpose}</p>}
                    <small>
                      {label(
                        "仅保存在本地示例中",
                        "Saved in the local demo only",
                      )}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className={styles.fixtureNote}>
            {label(
              "示例连接 · 未连接任何外部账户。更改仅保存在此页面场景的内存中。",
              "Demo connections · No external account is connected. Changes last while this screen is open.",
            )}
          </p>
        </div>
      </div></section>
      <Sheet
        open={Boolean(selected) && active}
        onOpenChange={(open) => {
          if (!open) closeSheet()
        }}
      >
        <SheetContent
          size={416}
          className={styles.sheet}
          finalFocus={() => focusTarget.current}
        >
          <SheetHeader className={styles.sheetHeader}>
            <SheetTitle>{selected?.name}</SheetTitle>
            <SheetDescription>{selected?.description[locale]}</SheetDescription>
          </SheetHeader>
          {selected && draft && (
            <>
              <SheetBody className={styles.sheetBody}>
                <div className={styles.connectionSummary}>
                  <h3>
                    {selected.connected
                      ? label("已连接至 Northstar", "Connected to Northstar")
                      : label("设置示例连接", "Set up a demo connection")}
                  </h3>
                  <p>
                    {label(
                      "选择 Agent 可以访问的内容。此预览使用示例数据，不会请求凭据。",
                      "Choose what agents can access. This preview uses sample data and does not request credentials.",
                    )}
                  </p>
                </div>
                <section className={styles.permissionSection}>
                  <h3>{label("允许的操作", "Allowed actions")}</h3>
                  {(Object.keys(permissionCopy) as (keyof Permissions)[]).map(
                    (key) => (
                      <label key={key} className={styles.permission}>
                        <Checkbox
                          checked={draft.permissions[key]}
                          disabled={state.readonly}
                          onCheckedChange={(value) =>
                            setState((previous) =>
                              setPermission(previous, key, value),
                            )
                          }
                        />
                        {permissionCopy[key][locale]}
                      </label>
                    ),
                  )}
                </section>
                <section className={styles.checkSection}>
                  <h3>{label("连接检查", "Connection check")}</h3>
                  <p>
                    {label(
                      "用示例响应验证所选操作。",
                      "Verify the selected actions against a sample response.",
                    )}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setState(checkIntegration)}
                  >
                    <ShieldCheck />
                    {label("测试连接", "Test connection")}
                  </Button>
                  {draft.check && (
                    <div className={styles.checkResult} role="status">
                      <h4>
                        {label("本地示例检查结果", "Local sample check result")}
                      </h4>
                      <p>
                        {label("可读取资源：", "Readable resources: ")}
                        {draft.check.resources.length}
                      </p>
                      {draft.check.resources.length > 0 && (
                        <ul>
                          {draft.check.resources.map((resource) => (
                            <li key={resource}>{resource}</li>
                          ))}
                        </ul>
                      )}
                      <p>
                        {draft.check.drafts
                          ? label(
                              "允许创建草稿。",
                              "Draft creation is allowed.",
                            )
                          : label(
                              "不允许创建草稿。",
                              "Draft creation is not allowed.",
                            )}
                      </p>
                      <p>
                        {draft.check.approvalRequired
                          ? label(
                              "写入仍需要人工批准。",
                              "Writes still require human approval.",
                            )
                          : label("写入已禁用。", "Writes are disabled.")}
                      </p>
                      <small>
                        {label(
                          "未调用外部服务。",
                          "No external service was called.",
                        )}
                      </small>
                    </div>
                  )}
                </section>
              </SheetBody>
              <SheetFooter className={styles.sheetFooter}>
                <Button
                  disabled={state.readonly}
                  onClick={() => {
                    setState(saveIntegration)
                    requestAnimationFrame(() => focusTarget.current?.focus())
                  }}
                >
                  {label("保存连接", "Save connection")}
                </Button>
                {selected.connected && (
                  <Button
                    variant="outline"
                    disabled={state.readonly}
                    onClick={() => {
                      setState(disconnectIntegration)
                      requestAnimationFrame(() => focusTarget.current?.focus())
                    }}
                  >
                    <Trash2 />
                    {label("断开示例连接", "Disconnect in demo")}
                  </Button>
                )}
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
      <Dialog
        open={state.requestOpen && active}
        onOpenChange={(open) => {
          setState((previous) => ({ ...previous, requestOpen: open }))
          if (!open) requestAnimationFrame(() => focusTarget.current?.focus())
        }}
      >
        <DialogContent
          finalFocus={() => focusTarget.current}
          className={styles.requestDialog}
        >
          <DialogTitle>
            {label("推荐一个连接", "Request a connection")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "在此示例工作区保存应用建议。",
              "Save an app suggestion in this demo workspace.",
            )}
          </DialogDescription>
          <form
            className={styles.requestForm}
            onSubmit={(event) => {
              event.preventDefault()
              setState(saveRequest)
              requestAnimationFrame(() => focusTarget.current?.focus())
            }}
          >
            <Field label={label("应用名称", "App name")}>
              {(props) => (
                <Input
                  {...props}
                  autoFocus
                  value={state.requestDraft.name}
                  disabled={state.readonly}
                  onChange={(event) =>
                    setState((previous) => ({
                      ...previous,
                      requestDraft: {
                        ...previous.requestDraft,
                        name: event.target.value,
                      },
                    }))
                  }
                />
              )}
            </Field>
            <Field
              label={label("你会用它做什么？", "What would you use it for?")}
            >
              {(props) => (
                <Textarea
                  {...props}
                  value={state.requestDraft.purpose}
                  disabled={state.readonly}
                  onChange={(event) =>
                    setState((previous) => ({
                      ...previous,
                      requestDraft: {
                        ...previous.requestDraft,
                        purpose: event.target.value,
                      },
                    }))
                  }
                />
              )}
            </Field>
            <Button
              type="submit"
              disabled={state.readonly || !state.requestDraft.name.trim()}
            >
              <Plus />
              {label("保存建议", "Save request")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
