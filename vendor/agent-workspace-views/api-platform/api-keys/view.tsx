"use client"
import { useEffect, useLayoutEffect, useRef } from "react"
import {
  Copy,
  Download,
  ListFilter,
  Search,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Badge } from "@easyuse-ui/ui/components/ui/badge"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Tabs, TabsList, TabsTab } from "@easyuse-ui/ui/components/ui/tabs"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@easyuse-ui/ui/components/ui/sheet"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import {
  DataTable,
  type DataTableColumn,
} from "@easyuse-ui/ui/components/blocks/data-table"
import { DataTableControls } from "@easyuse-ui/ui/components/blocks/data-table-controls"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import styles from "./api-keys.module.css"
import { FilterToolbar } from "@easyuse-ui/ui/components/blocks/filter-toolbar"
import { Pagination } from "@easyuse-ui/ui/components/ui/pagination"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { ApPage, ApSearch, ApSelect } from "../shared"
import { useApCache, useApState } from "../state"
import { useApAccountState } from "../account-state"
import { apAsOf, apScope, apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import {
  apKeyAccessLabels,
  apKeyResources,
  apKeyResourceAccess,
  apKeyPermissionHints,
  apKeyExpirationLabel,
  apKeyExpirationOptions,
  apKeyExpiresAfter,
  apKeyPermissionLabels,
  apKeyPermissionRoleIds,
  apKeyPermissionValues,
  apKeyStatusLabels,
  formatApKeyDate,
  formatApKeyLastUsed,
  formatApKeyRevokedDate,
  formatApKeySpend,
  type ApKeyPermission,
} from "./fixtures"
import {
  apKeyExport,
  apKeyPage,
  apKeyQueryKey,
  apKeyRows,
  checkApKeyCreate,
  checkApKeyRevoke,
  closeApKeyCreate,
  closeApKeyDetail,
  closeApKeyRevoke,
  createApKeysState,
  filterApKeyRows,
  openApKeyCreate,
  openApKeyDetail,
  openApKeyRevoke,
  resolveApKeyCreate,
  resolveApKeyRevoke,
  selectApKeyFiltered,
  setApKeyDraft,
  setApKeySelection,
  sortApKeyRows,
  submitApKeyCreate,
  submitApKeyRevoke,
  updateApKeyFilter,
  type ApKeyRow,
  type ApKeysState,
} from "./controller"

const operationDelayMs = 1000

export const pageScenarios = apScenarios

/** Host provides the scenario-isolated API and account caches. */
export function RemainingPageView({ scenario }: RemainingPageProps) {
  const selected = apScenarios.find((item) => item.id === scenario)
  return <ApiKeysView scenario={selected?.id ?? "default"} />
}

export function ApiKeysView({ scenario }: { scenario: ApScenario }) {
  const { locale } = useI18n(),
    en = locale === "en"
  const [account] = useApAccountState()
  const [state, setState] = useApState("api-keys", () =>
    createApKeysState(scenario, {
      ownerMemberId: account.profile.memberId,
      projectId: apScope.projectId,
    }),
  )
  const cache = useApCache(),
    tableHost = useRef<HTMLDivElement>(null),
    createOpener = useRef<HTMLButtonElement | null>(null),
    revokeOpener = useRef<HTMLButtonElement | null>(null),
    inspectionId = useRef(state.detailKeyId)
  const loading = scenario === "loading" && !state.recovered,
    refreshError = scenario === "refresh-error" && !state.recovered,
    viewHost = useRef<HTMLDivElement>(null),
    unknown = en ? "Unknown" : "未知",
    revokeLocked = state.revoke.status === "unknown",
    createLocked =
      state.create.status === "unknown" || state.create.status === "pending"

  useEffect(() => {
    viewHost.current?.setAttribute("data-ap-hydrated", "true")
  }, [])
  const rows = apKeyRows(state, account),
    sorted = sortApKeyRows(state, filterApKeyRows(state, rows)),
    page = apKeyPage(state, sorted),
    pageRows = page.visible
  const counts: Record<ApKeysState["status"], number> = {
    all: rows.length,
    active: 0,
    expired: 0,
    revoked: 0,
  }
  for (const row of rows) counts[row.status] += 1
  const selectedSet = new Set(state.selectedIds),
    selectedTotal = state.selectedIds.length,
    selectedInFilter = sorted.filter((row) =>
      selectedSet.has(row.keyId),
    ).length,
    selectedOnPage = pageRows.filter((row) =>
      selectedSet.has(row.keyId),
    ).length,
    revocableSelected = rows.filter(
      (row) => selectedSet.has(row.keyId) && row.status === "active",
    ).length

  const tableScrollKey = `table-scroll:${apKeyQueryKey(state)}`
  useLayoutEffect(() => {
    const region =
      tableHost.current?.querySelector<HTMLElement>('[role="region"]')
    const saved = cache?.get(tableScrollKey) as
      { top: number; left: number } | undefined
    if (region) {
      region.scrollTop = saved?.top ?? 0
      region.scrollLeft = saved?.left ?? 0
    }
  }, [cache, tableScrollKey, loading])
  useEffect(() => {
    if (state.create.status === "pending") {
      const timer = setTimeout(
        () => setState(resolveApKeyCreate),
        operationDelayMs,
      )
      return () => clearTimeout(timer)
    }
  }, [
    state.create.status,
    state.create.intent,
    state.create.operationId,
    setState,
  ])
  useEffect(() => {
    if (state.revoke.status === "pending") {
      const timer = setTimeout(
        () => setState(resolveApKeyRevoke),
        operationDelayMs,
      )
      return () => clearTimeout(timer)
    }
  }, [
    state.revoke.status,
    state.revoke.intent,
    state.revoke.operationId,
    setState,
  ])

  const draft = state.create.draft,
    create = state.create,
    revoke = state.revoke,
    detail = state.detailKeyId
      ? rows.find((row) => row.keyId === state.detailKeyId)
      : null,
    created = create.createdKeyId
      ? rows.find((row) => row.keyId === create.createdKeyId)
      : null,
    // Visible while an unknown outcome waits for its receipt and while the
    // receipt query runs, so the control does not disappear mid-check.
    createCheckVisible =
      create.status === "unknown" ||
      (create.status === "pending" && create.intent === "check"),
    revokeCheckVisible =
      revoke.status === "unknown" ||
      (revoke.status === "pending" && revoke.intent === "check")
  const createStatusText = create.receiptChecked
    ? en
      ? `Receipt checked (${create.operationId}): rejected. No key was added; the original draft is retained.`
      : `已查询回执（${create.operationId}）：创建被拒绝，未加入密钥，原草稿已保留。`
    : create.status === "pending"
      ? create.intent === "check"
        ? en
          ? `Checking operation ${create.operationId ?? ""}…`
          : `正在查询操作 ${create.operationId ?? ""}…`
        : en
          ? `Creating the key (operation ${create.operationId ?? ""})…`
          : `正在创建密钥（操作 ${create.operationId ?? ""}）…`
      : create.status === "confirmed"
        ? en
          ? "Key created and added to the list."
          : "密钥已创建并加入列表。"
        : create.status === "rejected"
          ? en
            ? "Creation rejected: no secret was issued, no key was added, the draft is retained."
            : "创建被拒绝：未生成密钥、未加入列表，草稿已保留。"
          : create.status === "unknown"
            ? en
              ? `Result unknown (operation ${create.operationId ?? ""}). The original request is locked; check the result before retrying. Nothing replays automatically.`
              : `结果未知（操作 ${create.operationId ?? ""}），原始请求已锁定；请先查询结果，不会自动重放。`
            : ""
  const revokeTotal =
    revoke.request?.targetIds.length ?? revoke.targetIds.length
  const revokeStatusText = revoke.receiptChecked
    ? en
      ? `Receipt checked (${revoke.operationId}): confirmed. ${revokeTotal} keys revoked.`
      : `已查询回执（${revoke.operationId}）：确认撤销 ${revokeTotal} 个密钥。`
    : revoke.status === "pending"
      ? revoke.intent === "check"
        ? en
          ? `Checking operation ${revoke.operationId ?? ""}…`
          : `正在查询操作 ${revoke.operationId ?? ""}…`
        : en
          ? `Revoking ${revokeTotal} ${revokeTotal === 1 ? "key" : "keys"} (operation ${revoke.operationId ?? ""})…`
          : `正在撤销 ${revokeTotal} 个密钥（操作 ${revoke.operationId ?? ""}）…`
      : revoke.status === "confirmed"
        ? en
          ? `${revokeTotal} ${revokeTotal === 1 ? "key" : "keys"} revoked.`
          : `已撤销 ${revokeTotal} 个密钥。`
        : revoke.status === "unknown"
          ? en
            ? `Result unknown (operation ${revoke.operationId ?? ""}). The original target IDs are locked; check the result before retrying. Nothing replays automatically.`
            : `结果未知（操作 ${revoke.operationId ?? ""}），原始目标 ID 已锁定；请先查询结果，不会自动重放。`
          : ""
  const countText = loading
    ? en
      ? "Loading keys…"
      : "正在加载密钥…"
    : state.status === "all"
      ? `${page.total} ${en ? (page.total === 1 ? "API key" : "API keys") : "个密钥"}`
      : en
        ? `${page.total} ${state.status} ${page.total === 1 ? "key" : "keys"}`
        : `${page.total} 个${state.status === "active" ? "生效" : state.status === "expired" ? "过期" : "已撤销"}密钥`

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setState((s) => ({ ...s, notice: "copied" }))
    } catch {
      setState((s) => ({ ...s, notice: "copy-error" }))
    }
  }
  const exportKeys = () => {
    const blob = new Blob([apKeyExport(sorted)], { type: "application/json" }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a")
    link.href = url
    link.download = "api-keys-fixture.json"
    link.click()
    URL.revokeObjectURL(url)
    setState((s) => ({ ...s, notice: "exported" }))
  }

  const columns: DataTableColumn<ApKeyRow>[] = [
    {
      id: "name",
      className: styles.nameColumn,
      header: en ? "Name / owner" : "名称 / 所有者",
      primary: true,
      hideable: false,
      minWidth: 200,
      maxWidth: 340,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium" title={row.name}>
            {row.name}
          </span>
          <span
            className="text-xs text-muted-foreground"
            title={row.ownerName ?? unknown}
          >
            {row.ownerName ?? unknown}
          </span>
        </span>
      ),
    },
    {
      id: "status",
      className: styles.statusColumn,
      header: en ? "Status" : "状态",
      hideable: false,
      cell: (row) => (
        <Badge tone="neutral" className={styles.status}>
          <span
            className={
              row.status === "active" ? styles.activeDot : styles.inactiveDot
            }
            aria-hidden="true"
          />
          {apKeyStatusLabels[row.status][locale]}
        </Badge>
      ),
    },
    {
      id: "key",
      className: styles.keyColumn,
      header: en ? "Key" : "密钥",
      hideable: false,
      minWidth: 150,
      cell: (row) => (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs" data-ap-key-mask={row.keyId}>
            {row.secretMask}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              en
                ? `Copy tracking ID for ${row.name}`
                : `复制 ${row.name} 的追踪 ID`
            }
            onClick={() => void copyText(row.keyId)}
          >
            <Copy aria-hidden="true" />
          </Button>
        </span>
      ),
    },
    {
      id: "project",
      className: styles.projectColumn,
      header: en ? "Project" : "项目",
      cell: (row) => (
        <span
          className="block max-w-40 truncate text-sm"
          title={row.projectName ?? unknown}
        >
          {row.projectName ?? unknown}
        </span>
      ),
    },
    {
      id: "permissions",
      className: styles.permissionsColumn,
      header: en ? "Permissions" : "权限",
      cell: (row) =>
        row.permission ? (
          <Badge tone="neutral" className={styles.permissionBadge}>
            {apKeyPermissionLabels[row.permission][locale]}
          </Badge>
        ) : (
          <span className="text-xs">{unknown}</span>
        ),
    },
    {
      id: "expires",
      className: styles.expiresColumn,
      header: en ? "Expires" : "到期",
      cell: (row) => (
        <span className="whitespace-nowrap text-xs">
          {row.revokedAt
            ? formatApKeyRevokedDate(row.revokedAt, locale)
            : row.expiresAt
              ? formatApKeyDate(row.expiresAt, locale)
              : en
                ? "Never"
                : "从不过期"}
        </span>
      ),
    },
    {
      id: "lastUsed",
      className: styles.lastUsedColumn,
      header: en ? "Last used" : "最近使用",
      cell: (row) => (
        <span className="whitespace-nowrap text-xs">
          {formatApKeyLastUsed(row.lastUsedAt, locale)}
        </span>
      ),
    },
    {
      id: "spend",
      className: styles.spendColumn,
      header: en ? "Spend" : "花费",
      sortable: true,
      align: "right",
      cell: (row) => (
        <span className="whitespace-nowrap text-xs tabular-nums">
          {formatApKeySpend(row.spendMicroUsd, locale)}
        </span>
      ),
    },
    {
      id: "actions",
      className: styles.actionsColumn,
      header: en ? "Actions" : "操作",
      hideable: false,
      cell: (row) => (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${en ? "Revoke" : "撤销"} ${row.name}`}
          data-ap-row-revoke={row.keyId}
          disabled={
            !state.canWrite ||
            row.status !== "active" ||
            revokeLocked ||
            state.revoke.status === "pending"
          }
          onClick={(event) => {
            revokeOpener.current = event.currentTarget
            setState((s) => openApKeyRevoke(s, [row.keyId], rows))
          }}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      ),
    },
  ]

  const ownerOptions = account.members.map((member) => ({
    value: member.memberId,
    label:
      member.memberId === account.profile.memberId
        ? en
          ? `You · ${member.name}`
          : `我 · ${member.name}`
        : member.invitationState === "invited"
          ? `${member.name}（${en ? "invited" : "已邀请"}）`
          : member.name,
  }))

  return (
    <div ref={viewHost} data-ap-key-view className={styles.root}>
      <ApPage
        variant="full-width"
        pageId="api-keys"
        title={en ? "API keys" : "API 密钥"}
        description={
          en
            ? "Manage how applications and people access your AI workspace."
            : "管理应用与成员访问 AI 工作区的方式。"
        }
        actions={
          <Button
            data-ap-create-open
            size="lg"
            className={styles.primaryAction}
            ref={createOpener}
            disabled={!state.canWrite || createLocked}
            onClick={() => setState(openApKeyCreate)}
          >
            <Plus aria-hidden="true" />
            {en ? "Create key" : "创建密钥"}
          </Button>
        }
        toolbar={
          <>
            <Tabs
              value={state.status}
              onValueChange={(value) =>
                setState((s) =>
                  updateApKeyFilter(
                    s,
                    "status",
                    value as ApKeysState["status"],
                  ),
                )
              }
            >
              <TabsList
                className={styles.statusTabs}
                aria-label={en ? "Key status" : "密钥状态"}
              >
                <TabsTab
                  value="all"
                  aria-label={`${en ? "All" : "全部"} ${counts.all}`}
                >
                  {en ? "All" : "全部"}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {counts.all}
                  </span>
                </TabsTab>
                {(["active", "expired", "revoked"] as const).map((status) => (
                  <TabsTab
                    key={status}
                    value={status}
                    aria-label={`${apKeyStatusLabels[status][locale]} ${counts[status]}`}
                  >
                    {apKeyStatusLabels[status][locale]}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {counts[status]}
                    </span>
                  </TabsTab>
                ))}
              </TabsList>
            </Tabs>
            <FilterToolbar
              className={styles.filters}
              label={en ? "Key filters" : "密钥筛选"}
              summary={
                <span data-ap-result-count aria-live="polite">
                  {selectedTotal
                    ? en
                      ? selectedTotal + " selected"
                      : "已选 " + selectedTotal + " 个"
                    : countText}
                </span>
              }
              actions={
                <>
                  {state.searchOpen || state.search ? (
                    <ApSearch
                      label={
                        en
                          ? "Search name, owner, or ID…"
                          : "搜索名称、所有者或 ID…"
                      }
                      value={state.search}
                      onChange={(value) =>
                        setState((s) => updateApKeyFilter(s, "search", value))
                      }
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={en ? "Search API keys" : "搜索 API 密钥"}
                      data-ap-search-open
                      onClick={(event) => {
                        const opener = event.currentTarget
                        setState((s) => ({ ...s, searchOpen: true }))
                        requestAnimationFrame(() => {
                          if (
                            document.activeElement === document.body ||
                            document.activeElement === opener
                          )
                            viewHost.current
                              ?.querySelector<HTMLInputElement>(
                                'input[type="search"]',
                              )
                              ?.focus()
                        })
                      }}
                    >
                      <Search aria-hidden="true" />
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" data-ap-project-filter />}
                    >
                      <ListFilter aria-hidden="true" />
                      {en ? "Filter" : "筛选"}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className={styles.menu}>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel className="px-3 py-2 text-xs font-medium">
                          {en ? "Project" : "项目"}
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={state.project}
                          onValueChange={(value) =>
                            setState((s) =>
                              updateApKeyFilter(s, "project", value),
                            )
                          }
                        >
                          {[
                            {
                              projectId: "all",
                              name: en ? "All projects" : "全部项目",
                            },
                            ...account.projects,
                          ].map((project) => (
                            <DropdownMenuRadioItem
                              key={project.projectId}
                              value={project.projectId}
                              closeOnClick
                            >
                              {project.name}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    data-ap-export
                    disabled={loading || !page.total}
                    onClick={exportKeys}
                  >
                    <Download aria-hidden="true" />
                    {en ? "Export" : "导出"}
                  </Button>
                  <DataTableControls
                    variant="compact"
                    triggerLabel={
                      en ? "View / column settings" : "视图 / 列设置"
                    }
                    columns={columns.map(
                      ({ id, header, hideable, minWidth, maxWidth }) => ({
                        id,
                        label: String(header),
                        hideable,
                        minWidth,
                        maxWidth,
                      }),
                    )}
                    value={state.columns}
                    onValueChange={(columns) =>
                      setState((s) => ({ ...s, columns }))
                    }
                    actions={
                      state.columns.hiddenIds?.length ? (
                        <Button
                          variant="ghost"
                          className="justify-start"
                          onClick={() =>
                            setState((s) => ({ ...s, columns: {} }))
                          }
                        >
                          <RotateCcw aria-hidden="true" size={14} />
                          {en ? "Restore columns" : "恢复默认列"}
                        </Button>
                      ) : undefined
                    }
                  />
                </>
              }
            />
          </>
        }
      >
        {!state.canWrite && (
          <p
            data-ap-readonly-note
            className="mt-3 text-xs text-muted-foreground"
          >
            {en
              ? "Read-only scope: keys cannot be created or revoked."
              : "只读范围：无法创建或撤销密钥。"}
          </p>
        )}
        {selectedTotal > 0 && (
          <div
            data-ap-selection
            className="mt-3 flex flex-wrap items-center gap-2 text-sm"
          >
            <span aria-live="polite" className="text-muted-foreground">
              {en
                ? `${selectedTotal} selected · ${selectedInFilter} in filter · ${selectedOnPage} on page`
                : `已选 ${selectedTotal} 个 · 筛选内 ${selectedInFilter} · 当前页 ${selectedOnPage}`}
            </span>
            {page.total > selectedInFilter && (
              <Button
                variant="outline"
                size="sm"
                data-ap-select-filtered
                onClick={() => setState((s) => selectApKeyFiltered(s, sorted))}
              >
                {en
                  ? `Select all filtered (${page.total})`
                  : `全选筛选结果（${page.total}）`}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              data-ap-clear-selection
              onClick={() => setState((s) => setApKeySelection(s, []))}
            >
              {en ? "Clear selection" : "清除选择"}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-ap-revoke-selected
              disabled={
                !state.canWrite ||
                revokeLocked ||
                state.revoke.status === "pending" ||
                revocableSelected === 0
              }
              onClick={(event) => {
                revokeOpener.current = event.currentTarget
                setState((s) => openApKeyRevoke(s, s.selectedIds, rows))
              }}
            >
              {en
                ? `Revoke selected (${revocableSelected})`
                : `撤销所选（${revocableSelected}）`}
            </Button>
          </div>
        )}
        {!create.open && create.status !== "idle" && (
          <p role="status" data-ap-create-status className="mt-3 text-sm">
            {createStatusText}
            {createCheckVisible && (
              <Button
                variant="secondary"
                size="sm"
                className="ml-3"
                data-ap-check-create
                disabled={!state.canWrite || create.status === "pending"}
                onClick={() => setState(checkApKeyCreate)}
              >
                {en ? "Check result" : "查询结果"}
              </Button>
            )}
          </p>
        )}
        {!revoke.open && revoke.status !== "idle" && (
          <p role="status" data-ap-revoke-status className="mt-3 text-sm">
            {revokeStatusText}
            {revokeCheckVisible && (
              <Button
                variant="secondary"
                size="sm"
                className="ml-3"
                data-ap-check-revoke
                disabled={!state.canWrite || revoke.status === "pending"}
                onClick={() => setState(checkApKeyRevoke)}
              >
                {en ? "Check result" : "查询结果"}
              </Button>
            )}
          </p>
        )}
        {state.notice !== "idle" && (
          <p role="status" data-ap-notice className="mt-3 text-sm">
            {state.notice === "copied"
              ? en
                ? "Copied to the clipboard."
                : "已复制到剪贴板。"
              : state.notice === "copy-error"
                ? en
                  ? "Clipboard unavailable; select the value manually."
                  : "剪贴板不可用，请手动选择该内容。"
                : en
                  ? "Filtered keys exported (metadata and masks only)."
                  : "已导出筛选密钥（仅元数据与掩码）。"}
          </p>
        )}
        {loading && (
          <Button
            className="mt-4"
            variant="secondary"
            data-ap-complete-load
            onClick={() => setState((s) => ({ ...s, recovered: true }))}
          >
            {en ? "Complete simulated load" : "完成模拟加载"}
          </Button>
        )}
        <section
          className={styles.results}
          aria-labelledby="ap-keys-results-heading"
        >
          <h2 id="ap-keys-results-heading" className="sr-only">
            {en ? "API key inventory" : "API 密钥清单"}
          </h2>
          <DataRegion
            state={
              loading
                ? "loading"
                : refreshError
                  ? "error"
                  : !page.total
                    ? "empty"
                    : scenario === "missing-data"
                      ? "partial"
                      : "success"
            }
            hasContent={!loading && !!state.keys.length}
            updatedAt={apAsOf}
            error={{
              category: "network",
              message: en
                ? "The API key list refresh failed."
                : "API 密钥列表刷新失败。",
              reason: en
                ? "Previous snapshot, filters, columns and selection are retained."
                : "已有快照、筛选、列设置与选择已保留。",
            }}
            onRetry={
              refreshError
                ? () => setState((s) => ({ ...s, recovered: true }))
                : undefined
            }
            emptyTitle={
              state.keys.length
                ? en
                  ? "No matching keys"
                  : "没有匹配的密钥"
                : en
                  ? "No API keys yet"
                  : "还没有 API 密钥"
            }
            emptyDescription={
              state.keys.length
                ? en
                  ? "Adjust the search or filters to find a key."
                  : "请调整搜索或筛选以查找密钥。"
                : en
                  ? "Create a key to grant applications access. This scene starts from an empty collection."
                  : "创建密钥以授权应用访问；本场景从空集合开始。"
            }
            partialDescription={
              en
                ? "Owner and spend are unknown for some keys; unknown is not zero."
                : "部分密钥的所有者与花费未知，未知不代表为零。"
            }
          >
            <div
              ref={tableHost}
              onScrollCapture={(event) => {
                const region = event.target as HTMLElement
                if (region.getAttribute("role") === "region")
                  cache?.set(tableScrollKey, {
                    top: region.scrollTop,
                    left: region.scrollLeft,
                  })
              }}
            >
              <DataTable
                rows={pageRows}
                columns={columns}
                columnConfig={state.columns}
                getRowId={(row) => row.keyId}
                getRowLabel={(row) => row.name}
                caption={en ? "Local API key inventory" : "本地 API 密钥清单"}
                selectedIds={state.selectedIds}
                onSelectionChange={(ids) =>
                  setState((s) => setApKeySelection(s, ids))
                }
                activeRowId={state.detailKeyId}
                onActivateRow={(row) => {
                  inspectionId.current = row.keyId
                  setState((s) => openApKeyDetail(s, row.keyId))
                }}
                sort={state.sort}
                onSortChange={(sort) =>
                  setState((s) => ({ ...s, sort, page: 1 }))
                }
                stickyHeader
                className={styles.table}
              />
            </div>
          </DataRegion>
        </section>
        {!loading && (page.pageCount > 1 || page.total > 10) && (
          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-xs text-muted-foreground">
              {page.start + 1}–{page.end} / {page.total}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <ApSelect
                label={en ? "Rows per page" : "每页行数"}
                value={String(state.pageSize)}
                onChange={(value) =>
                  setState((s) => ({
                    ...s,
                    pageSize: Number(value),
                    page: 1,
                  }))
                }
                options={[5, 10, 25].map((size) => ({
                  value: String(size),
                  label: en ? `${size} rows` : `${size} 行`,
                }))}
              />
              <Pagination
                page={page.page}
                pageCount={page.pageCount}
                onPageChange={(value) =>
                  setState((s) => ({ ...s, page: value }))
                }
              />
            </div>
          </div>
        )}
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {en
            ? "Statuses are computed from the fixed snapshot 2026-10-12 (UTC), not the wall clock. Secrets are obviously invalid local demo values (example.invalid); no credential service, provider or storage is involved."
            : "状态按固定快照 2026-10-12（UTC）计算，不读取系统时钟；密钥值为无效的本地演示字符串（example.invalid），不连接任何凭据、Provider 或存储服务。"}
        </p>

        <Sheet
          open={!!state.detailKeyId}
          onOpenChange={(open) => {
            if (!open) setState(closeApKeyDetail)
          }}
        >
          <SheetContent
            side="right"
            size={448}
            className={styles.detail}
            finalFocus={() => {
              const id = inspectionId.current
              return id
                ? (tableHost.current?.querySelector<HTMLElement>(
                    `tr[data-row-id="${CSS.escape(id)}"] td:nth-of-type(2) button`,
                  ) ?? null)
                : null
            }}
          >
            <SheetHeader>
              <SheetTitle>{detail?.name ?? ""}</SheetTitle>
              <SheetDescription>
                {en
                  ? "Credential details and access scope"
                  : "凭证详情与访问范围"}
              </SheetDescription>
            </SheetHeader>
            {detail && (
              <SheetBody className="space-y-5" data-ap-key-detail>
                <div>
                  <Badge tone="neutral" className={styles.status}>
                    <span
                      className={
                        detail.status === "active"
                          ? styles.activeDot
                          : styles.inactiveDot
                      }
                      aria-hidden="true"
                    />
                    {apKeyStatusLabels[detail.status][locale]}
                  </Badge>
                </div>
                <dl className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {en ? "Tracking ID" : "追踪 ID"}
                    </dt>
                    <dd className="mt-1 break-all select-text">
                      <code data-ap-key-id>{detail.keyId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {en ? "Owner" : "所有者"}
                    </dt>
                    <dd className="mt-1 break-words">
                      {detail.ownerName ?? unknown}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {en ? "Project" : "项目"}
                    </dt>
                    <dd className="mt-1 break-words">
                      {detail.projectName ?? unknown}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {en ? "Created" : "创建时间"}
                    </dt>
                    <dd className="mt-1 break-words">
                      {formatApKeyDate(detail.createdAt, locale)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {en ? "Expires" : "到期"}
                    </dt>
                    <dd className="mt-1 break-words">
                      {detail.expiresAt
                        ? formatApKeyDate(detail.expiresAt, locale)
                        : en
                          ? "Never"
                          : "从不过期"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {en ? "Last used" : "最近使用"}
                    </dt>
                    <dd className="mt-1 break-words">
                      {formatApKeyLastUsed(detail.lastUsedAt, locale)}
                    </dd>
                  </div>
                </dl>
                <div className={styles.permissions}>
                  <h3>{en ? "Resource permissions" : "资源权限"}</h3>
                  <p className="text-xs text-muted-foreground">
                    {detail.permission
                      ? apKeyPermissionLabels[detail.permission][locale]
                      : unknown}
                  </p>
                  <dl>
                    {apKeyResources.map((resource) => (
                      <div key={resource.id}>
                        <dt>{resource.label[locale]}</dt>
                        <dd>
                          <Badge tone="neutral">
                            {detail.permission
                              ? apKeyAccessLabels[
                                  apKeyResourceAccess[detail.permission][
                                    resource.id
                                  ]
                                ][locale]
                              : unknown}
                          </Badge>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => void copyText(detail.keyId)}
                >
                  <Copy aria-hidden="true" />
                  {en ? "Copy tracking ID" : "复制追踪 ID"}
                </Button>
              </SheetBody>
            )}
          </SheetContent>
        </Sheet>

        <Dialog
          open={create.open}
          onOpenChange={(open) => {
            if (!open) setState(closeApKeyCreate)
          }}
        >
          <DialogContent
            className={styles.dialog}
            finalFocus={() => {
              const opener = createOpener.current
              if (opener?.isConnected && !opener.disabled) return opener
              return (
                viewHost.current?.querySelector<HTMLButtonElement>(
                  "[data-ap-check-create]:not(:disabled)",
                ) ??
                viewHost.current?.querySelector<HTMLButtonElement>(
                  '[role="tab"][aria-selected="true"]',
                ) ??
                null
              )
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {en ? "Create an API key" : "创建 API 密钥"}
              </DialogTitle>
              <DialogDescription>
                {en
                  ? "Choose an owner, project, and permissions for this credential."
                  : "选择该凭证的所有者、项目与权限范围。"}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              {create.phase === "form" ? (
                <>
                  <Field
                    label={en ? "Name" : "名称"}
                    required
                    error={
                      create.error === "too-short"
                        ? en
                          ? "Use at least 3 characters."
                          : "名称至少 3 个字符。"
                        : create.error === "too-long"
                          ? en
                            ? "Use at most 48 characters."
                            : "名称最多 48 个字符。"
                          : undefined
                    }
                  >
                    {(control) => (
                      <Input
                        {...control}
                        data-ap-key-name
                        placeholder={
                          en
                            ? "e.g. Production · support"
                            : "例如：Production · support"
                        }
                        value={draft.name}
                        disabled={createLocked}
                        onChange={(event) =>
                          setState((s) =>
                            setApKeyDraft(s, { name: event.target.value }),
                          )
                        }
                      />
                    )}
                  </Field>
                  <div className={styles.createFields}>
                    <div>
                      <span className="mb-1 block text-[13px] font-medium">
                        {en ? "Owned by" : "所有者"}
                      </span>
                      <ApSelect
                        label={en ? "Key owner" : "密钥所有者"}
                        value={draft.ownerMemberId}
                        disabled={createLocked}
                        onChange={(value) =>
                          setState((s) =>
                            setApKeyDraft(s, { ownerMemberId: value }),
                          )
                        }
                        options={ownerOptions}
                      />
                    </div>
                    <div>
                      <span className="mb-1 block text-[13px] font-medium">
                        {en ? "Project" : "项目"}
                      </span>
                      <ApSelect
                        label={en ? "Key project" : "密钥项目"}
                        value={draft.projectId}
                        disabled={createLocked}
                        onChange={(value) =>
                          setState((s) =>
                            setApKeyDraft(s, { projectId: value }),
                          )
                        }
                        options={account.projects.map((project) => ({
                          value: project.projectId,
                          label: project.name,
                        }))}
                      />
                    </div>
                    <div>
                      <span className="mb-1 block text-[13px] font-medium">
                        {en ? "Permissions" : "权限"}
                      </span>
                      <ApSelect
                        label={en ? "Key permissions" : "密钥权限"}
                        value={draft.permission}
                        disabled={createLocked}
                        onChange={(value) =>
                          setState((s) =>
                            setApKeyDraft(s, {
                              permission: value as ApKeyPermission,
                            }),
                          )
                        }
                        options={apKeyPermissionValues.map((permission) => ({
                          value: permission,
                          label: apKeyPermissionLabels[permission][locale],
                        }))}
                      />
                    </div>
                    <div>
                      <span className="mb-1 block text-[13px] font-medium">
                        {en ? "Expires after" : "有效期"}
                      </span>
                      <ApSelect
                        label={en ? "Key expiration" : "密钥有效期"}
                        value={String(draft.expirationDays)}
                        disabled={createLocked}
                        onChange={(value) =>
                          setState((s) =>
                            setApKeyDraft(s, { expirationDays: Number(value) }),
                          )
                        }
                        options={apKeyExpirationOptions.map((days) => ({
                          value: String(days),
                          label: apKeyExpirationLabel(days, locale),
                        }))}
                      />
                    </div>
                  </div>
                  <p
                    data-ap-key-permission-hint
                    className="text-xs text-muted-foreground"
                  >
                    {apKeyPermissionHints[draft.permission][locale]}
                  </p>
                  {create.status !== "idle" && (
                    <p role="status" data-ap-create-status className="text-sm">
                      {createStatusText}
                    </p>
                  )}
                  {createCheckVisible && create.request && (
                    <details open data-ap-create-request className="text-xs">
                      <summary>
                        {en
                          ? "Original request (not replayed)"
                          : "原始请求（不会重放）"}
                      </summary>
                      <dl className="mt-2 grid grid-cols-2 gap-2">
                        <dt>{en ? "Operation" : "操作"}</dt>
                        <dd>{create.operationId}</dd>
                        <dt>{en ? "Snapshot" : "快照"}</dt>
                        <dd>{create.requestVersion}</dd>
                        <dt>{en ? "Name" : "名称"}</dt>
                        <dd>{create.request.name}</dd>
                        <dt>{en ? "Owner" : "所有者"}</dt>
                        <dd>{create.request.ownerMemberId}</dd>
                        <dt>{en ? "Project" : "项目"}</dt>
                        <dd>{create.request.projectId}</dd>
                        <dt>{en ? "Role" : "角色"}</dt>
                        <dd>{create.request.roleId}</dd>
                        <dt>{en ? "Expires" : "到期"}</dt>
                        <dd>{create.request.expiresAt}</dd>
                      </dl>
                    </details>
                  )}
                  {createCheckVisible && (
                    <Button
                      variant="secondary"
                      data-ap-check-create
                      disabled={!state.canWrite || create.status === "pending"}
                      onClick={() => setState(checkApKeyCreate)}
                    >
                      {en ? "Check result" : "查询结果"}
                    </Button>
                  )}
                </>
              ) : (
                <div data-ap-key-created className="space-y-3">
                  <p role="status" data-ap-create-status className="text-sm">
                    {en
                      ? "Key created. This secret is displayed once and cannot be recovered later."
                      : "密钥已创建。该密钥值仅显示一次，之后无法找回。"}
                  </p>
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {en ? "Name" : "名称"}
                      </dt>
                      <dd className="mt-1 break-words">{created?.name}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {en ? "Tracking ID" : "追踪 ID"}
                      </dt>
                      <dd className="mt-1 break-all">
                        <code data-ap-key-id>{created?.keyId}</code>
                      </dd>
                    </div>
                  </dl>
                  <div className="space-y-2">
                    <span className="text-xs text-muted-foreground">
                      {en ? "Secret" : "密钥值"}
                    </span>
                    <code
                      data-ap-created-secret
                      className="block break-all rounded-md border bg-muted px-2 py-1 text-xs select-text"
                    >
                      {created?.secret}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      data-ap-copy-secret
                      onClick={() =>
                        created?.secret && void copyText(created.secret)
                      }
                    >
                      <Copy aria-hidden="true" />
                      {en ? "Copy secret" : "复制密钥值"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {en
                      ? "This value is an obviously invalid local demo string (example.invalid); the list keeps it masked."
                      : "该值是明显无效的本地演示字符串（example.invalid）；列表中始终以掩码显示。"}
                  </p>
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              {create.phase === "form" ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={create.status === "pending"}
                    onClick={() => setState(closeApKeyCreate)}
                  >
                    {en ? "Cancel" : "取消"}
                  </Button>
                  <Button
                    data-ap-create-submit
                    className={styles.primaryAction}
                    disabled={
                      !draft.name.trim() || createLocked || !state.canWrite
                    }
                    onClick={() =>
                      setState((s) =>
                        submitApKeyCreate(s, {
                          name: draft.name.trim(),
                          ownerMemberId: draft.ownerMemberId,
                          ownerInvited:
                            account.members.find(
                              (member) =>
                                member.memberId === draft.ownerMemberId,
                            )?.invitationState === "invited",
                          projectId: draft.projectId,
                          roleId: apKeyPermissionRoleIds[draft.permission],
                          expiresAt: apKeyExpiresAfter(draft.expirationDays),
                        }),
                      )
                    }
                  >
                    {en ? "Create key" : "创建密钥"}
                  </Button>
                </>
              ) : (
                <Button
                  className={styles.primaryAction}
                  onClick={() => setState(closeApKeyCreate)}
                >
                  {en ? "Done" : "完成"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={revoke.open}
          onOpenChange={(open) => {
            if (!open) setState(closeApKeyRevoke)
          }}
        >
          <DialogContent
            className={styles.dialog}
            finalFocus={() => {
              const opener = revokeOpener.current
              if (opener?.isConnected && !opener.disabled) return opener
              return (
                viewHost.current?.querySelector<HTMLButtonElement>(
                  "[data-ap-check-revoke]:not(:disabled)",
                ) ??
                opener
                  ?.closest("tr")
                  ?.querySelector<HTMLButtonElement>(
                    "td button:not(:disabled)",
                  ) ??
                viewHost.current?.querySelector<HTMLButtonElement>(
                  "[data-ap-clear-selection]",
                ) ??
                viewHost.current?.querySelector<HTMLButtonElement>(
                  '[role="tab"][aria-selected="true"]',
                ) ??
                null
              )
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {en ? "Revoke API keys?" : "撤销 API 密钥？"}
              </DialogTitle>
              <DialogDescription>
                {en
                  ? `Revocation cannot be undone. The frozen target list holds ${revokeTotal} ${revokeTotal === 1 ? "key" : "keys"}.`
                  : `撤销不可恢复；已冻结的目标列表包含 ${revokeTotal} 个密钥。`}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <ul data-ap-revoke-targets className="space-y-2 text-sm">
                {revoke.targetIds.map((keyId) => {
                  const target = rows.find((row) => row.keyId === keyId)
                  return (
                    <li key={keyId} className="flex flex-wrap gap-x-2">
                      <span className="font-medium">
                        {target?.name ?? keyId}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {keyId} · {target?.ownerName ?? unknown}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {revoke.skippedIds.length > 0 && (
                <p
                  data-ap-revoke-skipped
                  className="text-xs text-muted-foreground"
                >
                  {en
                    ? `${revoke.skippedIds.length} expired or revoked keys are not part of this revocation.`
                    : `${revoke.skippedIds.length} 个已过期或已撤销的密钥不属于本次撤销。`}
                </p>
              )}
              {revoke.status !== "idle" && (
                <p role="status" data-ap-revoke-status className="text-sm">
                  {revokeStatusText}
                </p>
              )}
              {revokeCheckVisible && (
                <Button
                  variant="secondary"
                  data-ap-check-revoke
                  disabled={!state.canWrite || revoke.status === "pending"}
                  onClick={() => setState(checkApKeyRevoke)}
                >
                  {en ? "Check result" : "查询结果"}
                </Button>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="secondary"
                disabled={revoke.status === "pending"}
                onClick={() => setState(closeApKeyRevoke)}
              >
                {en ? "Cancel" : "取消"}
              </Button>
              <Button
                variant="destructive"
                data-ap-revoke-submit
                disabled={
                  !state.canWrite ||
                  revoke.status === "pending" ||
                  revoke.status === "unknown" ||
                  revoke.targetIds.length === 0
                }
                onClick={() => setState(submitApKeyRevoke)}
              >
                {en
                  ? `Revoke ${revokeTotal} ${revokeTotal === 1 ? "key" : "keys"}`
                  : `撤销 ${revokeTotal} 个密钥`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </ApPage>
    </div>
  )
}
