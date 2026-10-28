"use client"
import {
  Component,
  lazy,
  useState,
  Suspense,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { WorkspaceShell } from "./workspace-shell"
import { AgentRunBoard } from "./agent-run-board"
import { AgentRunList } from "./agent-run-list"
import { AttentionQueue } from "./attention-queue"
import { AgentUsageSummary } from "./agent-usage-summary"
import { AgentUsageHistory } from "./agent-usage-history"
import { AgentRunVirtualList } from "./agent-run-virtual-list"
import type { AgentDependencyGraphProps } from "./agent-dependency-graph"
import { AgentBoardToolbar } from "./agent-board-toolbar"
import {
  AgentRunInspector,
  type AgentRunDetailSnapshot,
} from "./agent-run-inspector"
import { DataRegion, type DataRegionProps } from "../ui/data-region"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetBody,
} from "../ui/sheet"
import { useI18n } from "../../lib/i18n-provider"
import { dedupeAttention, filterAgentRuns } from "../../lib/agent-board-view"
import type {
  AgentBoardViewState,
  AgentRunSnapshot,
  AttentionRecord,
  UsageObservation,
  AgentRunDependency,
  AgentUsageHistoryPoint,
  AgentBoardConnection,
} from "../../lib/agent-board-model"
import type { AgentRunInspectorProps } from "./agent-run-inspector"
import styles from "./agent-board.module.css"
import p2Styles from "./agent-board-p2.module.css"
function makeDependencyView() {
  return lazy(() =>
    import("./agent-dependency-graph").then((module) => ({
      default: module.AgentDependencyGraph,
    })),
  )
}
class DependencyBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
function DependencyView(props: AgentDependencyGraphProps) {
  const { t } = useI18n()
  const [renderer, setRenderer] = useState(() => ({
    View: makeDependencyView(),
    attempt: 0,
  }))
  const View = renderer.View
  return (
    <DependencyBoundary
      key={renderer.attempt}
      fallback={
        <DataRegion
          state="error"
          error={{
            category: "network",
            message: t("agentBoardP2.graphLoadFailed"),
            reason: t("agentBoardP2.graphLoadReason"),
          }}
          onRetry={() =>
            setRenderer((before) => ({
              View: makeDependencyView(),
              attempt: before.attempt + 1,
            }))
          }
        />
      }
    >
      <Suspense fallback={<DataRegion state="loading" />}>
        <View {...props} />
      </Suspense>
    </DependencyBoundary>
  )
}
function subscribe(callback: () => void) {
  const media = window.matchMedia("(min-width:1280px)")
  media.addEventListener("change", callback)
  return () => media.removeEventListener("change", callback)
}
export type AgentBoardWorkspaceProps = {
  records: readonly AgentRunSnapshot[]
  attention: readonly AttentionRecord[]
  usage?: readonly UsageObservation[]
  dependencies?: readonly AgentRunDependency[]
  history?: readonly AgentUsageHistoryPoint[]
  listVirtualization?: {
    enabled?: boolean
    threshold?: number
    height?: number
  }
  viewState: AgentBoardViewState
  selectedRunId: string | null
  detail: AgentRunDetailSnapshot | null
  connection: AgentBoardConnection
  onViewChange: (view: AgentBoardViewState) => void
  onOpen: (runId: string | null) => void
  data?: Omit<DataRegionProps, "children" | "hasContent">
  totalCount?: number
  loadedCount?: number
  inspector?: Pick<
    AgentRunInspectorProps,
    "drafts" | "onDraftChange" | "onAction" | "canReconcile"
  >
  sidebar?: ReactNode
  exampleControls?: ReactNode
  headerActions?: ReactNode
  scopeLabel: string
  fill?: boolean
}
/** Layout and display only. URL, request generations, drafts and mutations belong to callers. */
export function AgentBoardWorkspace({
  records,
  attention,
  usage = [],
  dependencies,
  history,
  listVirtualization,
  viewState,
  selectedRunId,
  detail,
  connection,
  onViewChange,
  onOpen,
  data,
  totalCount,
  loadedCount,
  inspector,
  sidebar,
  exampleControls,
  headerActions,
  scopeLabel,
  fill,
}: AgentBoardWorkspaceProps) {
  const { t } = useI18n()
  const wide = useSyncExternalStore(
    subscribe,
    () => window.matchMedia("(min-width:1280px)").matches,
    () => false,
  )
  const opener = useRef<HTMLElement | null>(null)
  const main = useRef<HTMLDivElement>(null)
  const visible = filterAgentRuns(records, viewState)
  const runIds = new Set(visible.map((run) => run.runId))
  const virtualized =
    listVirtualization?.enabled !== false &&
    visible.length >=
      Math.max(
        1,
        Number.isFinite(listVirtualization?.threshold)
          ? listVirtualization!.threshold!
          : 200,
      )
  const requests = dedupeAttention(attention).filter(
    (item) => item.operation?.state !== "confirmed",
  )
  const matchingRequests = requests.filter((item) => runIds.has(item.runId))
  function open(id: string | null) {
    if (id) opener.current = document.activeElement as HTMLElement
    onOpen(id)
    if (!id)
      requestAnimationFrame(() =>
        (opener.current?.isConnected ? opener.current : main.current)?.focus(),
      )
  }
  const selected = selectedRunId
    ? detail?.run.runId === selectedRunId
      ? detail
      : null
    : null
  const panel = selected ? (
    <AgentRunInspector
      key={selected.run.runId}
      snapshot={selected}
      {...inspector}
      onOpen={open}
    />
  ) : (
    <DataRegion state="empty" emptyTitle={t("agentBoard.deleted")} />
  )
  return (
    <WorkspaceShell
      className={fill ? styles.fill : styles.workspace}
      title={<h1 className={styles.headerTitle}>{t("agentBoard.title")}</h1>}
      sidebar={
        sidebar ?? (
          <div className={styles.navigation}>
            <div
              className={styles.navigationBrand}
              role="img"
              aria-label={t("agentBoard.title")}
            >
              <span aria-hidden="true">A</span>
              <span aria-hidden="true" className={styles.navLabel}>
                {t("agentBoard.title")}
              </span>
            </div>
          </div>
        )
      }
      defaultSidebarCollapsed
      sidebarWidth={200}
      inspector={wide && selectedRunId ? panel : undefined}
      inspectorOpen={Boolean(selectedRunId)}
      onInspectorOpenChange={(value) => {
        if (!value) open(null)
      }}
      inspectorTitle={selected?.run.title ?? "Run"}
      toolbar={
        <AgentBoardToolbar
          records={records}
          viewState={viewState}
          onViewChange={onViewChange}
          hasDependencies={dependencies !== undefined}
        />
      }
    >
      <div
        ref={main}
        className={styles.main}
        tabIndex={-1}
        data-agent-workspace-main
      >
        <div className={styles.connection} role="status">
          <span>
            {t(
              connection.state === "connected"
                ? "agentBoard.connected"
                : "agentBoard.disconnected",
            )}{" "}
            · {connection.updatedAt}
          </span>
          {headerActions}
          <span>
            {t("agentBoard.attentionSummary", {
              count: requests.length,
              runs: new Set(requests.map((item) => item.runId)).size,
            })}
          </span>
        </div>
        {exampleControls}
        {selectedRunId && !runIds.has(selectedRunId) && (
          <p className={styles.notice}>{t("agentBoard.selectedHidden")}</p>
        )}
        <p className={styles.meta}>
          {t("agentBoard.loaded", {
            visible: visible.length,
            loaded: loadedCount ?? records.length,
            total: totalCount ?? "—",
          })}
        </p>
        <DataRegion
          {...data}
          state={
            data?.state && data.state !== "success"
              ? data.state
              : visible.length
                ? "success"
                : "empty"
          }
          hasContent={records.length > 0}
          updatedAt={connection.updatedAt}
          emptyTitle={t(
            records.length ? "agentBoard.noMatches" : "agentBoard.noRuns",
          )}
          emptyDescription={t("agentBoard.adjust")}
        >
          {viewState.view === "board" && (
            <AgentRunBoard
              records={visible}
              selectedRunId={selectedRunId}
              onOpen={open}
            />
          )}
          {viewState.view === "list" &&
            (virtualized ? (
              <AgentRunVirtualList
                records={visible}
                selectedRunId={selectedRunId}
                onOpen={open}
                height={listVirtualization?.height}
              />
            ) : (
              <div
                className={
                  listVirtualization?.height
                    ? p2Styles.virtualViewport
                    : undefined
                }
                style={
                  listVirtualization?.height
                    ? {
                        height: Math.max(
                          240,
                          Math.min(
                            900,
                            Number.isFinite(listVirtualization.height)
                              ? listVirtualization.height
                              : 560,
                          ),
                        ),
                      }
                    : undefined
                }
              >
                <AgentRunList
                  records={visible}
                  selectedRunId={selectedRunId}
                  onOpen={open}
                />
              </div>
            ))}
          {viewState.view === "inbox" && (
            <AttentionQueue
              records={matchingRequests}
              kind={viewState.inboxKind}
              onOpen={open}
            />
          )}
          {viewState.view === "insights" && (
            <>
              <AgentUsageSummary
                runs={visible}
                observations={usage}
                scopeLabel={scopeLabel}
              />
              {history && (
                <AgentUsageHistory
                  points={history}
                  scopeRunIds={[...runIds]}
                  scopeLabel={scopeLabel}
                />
              )}
            </>
          )}
          {viewState.view === "dependencies" &&
            (dependencies ? (
              <DependencyView
                records={records}
                dependencies={dependencies}
                scopeRunIds={[...runIds]}
                selectedRunId={selectedRunId}
                onOpen={open}
              />
            ) : (
              <DataRegion
                state="empty"
                emptyTitle={t("agentBoardP2.noDependencies")}
              />
            ))}
        </DataRegion>
      </div>
      {!wide && (
        <Sheet
          open={Boolean(selectedRunId)}
          onOpenChange={(value) => {
            if (!value) open(null)
          }}
        >
          <SheetContent
            size={400}
            finalFocus={() =>
              opener.current?.isConnected ? opener.current : main.current
            }
          >
            <SheetHeader>
              <SheetTitle>{selected?.run.title ?? "Run"}</SheetTitle>
            </SheetHeader>
            <SheetBody>{panel}</SheetBody>
          </SheetContent>
        </Sheet>
      )}
    </WorkspaceShell>
  )
}
