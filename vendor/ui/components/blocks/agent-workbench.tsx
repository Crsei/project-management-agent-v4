"use client"
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { ResizableHandle } from "../ui/resizable"
import { WorkspaceShell } from "./workspace-shell"
import { Inspector } from "./inspector"
import { AgentRunList } from "./agent-run-list"
import { AttentionQueue } from "./attention-queue"
import { Button } from "../ui/button"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import type { AgentRunSnapshot, AttentionRecord } from "../../lib/agent-board-model"
import type {
  PanelState,
  WorkbenchLayout,
  SessionSnapshot,
} from "../../lib/agent-workbench-model"
import {
  AgentConversation,
  type AgentConversationProps,
} from "./agent-workbench/conversation"
import { SessionHeader } from "./agent-workbench/navigation"
import styles from "./agent-workbench/workbench.module.css"
export * from "./agent-workbench/navigation"
export * from "./agent-workbench/context"
export * from "./agent-workbench/conversation"
export * from "./agent-workbench/composer"
export * from "./agent-workbench/review"
export * from "./agent-workbench/panels"
export * from "./agent-workbench/runtime-panel"
export function TaskInbox({
  runs,
  attention,
  selectedRunId,
  onSelect,
  onEnter,
}: {
  runs: readonly AgentRunSnapshot[]
  attention: readonly AttentionRecord[]
  selectedRunId?: string
  onSelect: (runId: string) => void
  onEnter: (runId: string) => void
}) {
  const { t } = useI18n()
  return (
    <section className={styles.section} aria-label={t("workbench.taskInbox")}>
      <h2 className={styles.heading}>{t("workbench.taskInbox")}</h2>
      <p className={styles.meta}>{t("workbench.selectionOnly")}</p>
      <AttentionQueue records={attention} onOpen={onSelect} />
      <AgentRunList
        records={runs}
        selectedRunId={selectedRunId}
        onOpen={onSelect}
      />
      {selectedRunId && (
        <Button onClick={() => onEnter(selectedRunId)}>
          {t("workbench.openSession")}
        </Button>
      )}
    </section>
  )
}
export type AgentWorkbenchProps = {
  layoutMode?: "adaptive" | "desktop"
  session: SessionSnapshot
  layout: WorkbenchLayout
  panelState: PanelState
  onPanelStateChange: (state: PanelState) => void
  navigation: ReactNode
  activityBar?: ReactNode
  activeView?: "conversation" | "workspace"
  showViewSwitch?: boolean
  onActiveViewChange?: (view: "conversation" | "workspace") => void
  workspace: ReactNode
  inspector?: ReactNode
  inspectorTitle?: ReactNode
  inspectorMode?: "metadata" | "resource"
  presentation?: "default" | "workspace"
  /** View preferences only. The caller may persist the bounded 0–1 ratio. */
  reviewSplit?: number
  onReviewSplitChange?: (ratio: number) => void
  workspaceMaximized?: boolean
  onWorkspaceMaximizedChange?: (maximized: boolean) => void
  bottom?: ReactNode
  bottomBadge?: number
  header?: ReactNode
  headerActions?: ReactNode
  toolbar?: ReactNode
  showBottomToggle?: boolean
  showReviewControls?: boolean
  composer: ReactNode
  conversation?: Omit<AgentConversationProps, "session" | "composer">
  onRename?: (title: string) => void
  className?: string
}
/** One Shell owns docking; wide review belongs to Main. Hidden panes retain their editors. */
export function AgentWorkbench({
  layoutMode = "adaptive",
  session,
  layout,
  panelState,
  onPanelStateChange,
  navigation,
  activityBar,
  activeView,
  showViewSwitch = true,
  onActiveViewChange,
  workspace,
  inspector,
  inspectorTitle,
  inspectorMode = "metadata",
  presentation = "default",
  reviewSplit,
  onReviewSplitChange,
  workspaceMaximized,
  onWorkspaceMaximizedChange,
  bottom,
  bottomBadge,
  header,
  headerActions,
  toolbar,
  showBottomToggle = true,
  showReviewControls = true,
  composer,
  conversation,
  onRename,
  className,
}: AgentWorkbenchProps) {
  const { t } = useI18n()
  const panesRef = useRef<HTMLDivElement>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [internalSplit, setInternalSplit] = useState(0.45)
  const [internalMaximized, setInternalMaximized] = useState(false)
  const maximized = workspaceMaximized ?? internalMaximized
  const requestedSplit = reviewSplit ?? internalSplit
  const split = Number.isFinite(requestedSplit)
    ? Math.max(0.2, Math.min(0.8, requestedSplit))
    : 0.45
  const available = Math.max(
    0,
    paneWidth -
      (typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches
        ? 44
        : 8),
  )
  const splitWidth = Math.max(440, Math.min(available - 480, available * split))
  const minSplitWidth = Math.max(440, available * 0.2)
  const maxSplitWidth = Math.min(available - 480, available * 0.8)
  const wideReview = layout === "review" && available >= 920 && !maximized
  useEffect(() => {
    const element = panesRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setPaneWidth(entry.contentRect.width),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  function changeSplit(ratio: number) {
    setInternalSplit(ratio)
    onReviewSplitChange?.(ratio)
  }
  function changeMaximized(value: boolean) {
    setInternalMaximized(value)
    onWorkspaceMaximizedChange?.(value)
  }
  const [pane, setPane] = useState<{
    layout: WorkbenchLayout
    view: "conversation" | "workspace"
  }>({ layout, view: "conversation" })
  const view =
    activeView ?? (pane.layout === layout ? pane.view : "conversation")
  const workspaceVisible =
    layout === "tasks" ||
    (layout === "review" && (maximized || wideReview)) ||
    (view === "workspace" && (layout === "review" || paneWidth < 920))
  const [workspaceVisited, setWorkspaceVisited] = useState(workspaceVisible)
  if (workspaceVisible && !workspaceVisited) setWorkspaceVisited(true)
  const patch = (value: Partial<PanelState>) =>
    onPanelStateChange({ ...panelState, ...value })
  return (
    <WorkspaceShell
      layoutMode={layoutMode}
      className={cn(styles.shell, className)}
      title={
        header ?? (
          <SessionHeader
            session={session}
            onRename={onRename}
            actions={headerActions}
          />
        )
      }
      sidebar={navigation}
      activityBar={activityBar}
      sidebarCollapsed={panelState.sidebarCollapsed}
      onSidebarCollapsedChange={(sidebarCollapsed) =>
        patch({ sidebarCollapsed })
      }
      inspectorOpen={panelState.inspectorOpen && layout === "conversation"}
      onInspectorOpenChange={(inspectorOpen) => patch({ inspectorOpen })}
      inspectorWidth={panelState.inspectorWidth}
      onInspectorWidthChange={(inspectorWidth) => patch({ inspectorWidth })}
      inspectorTitle={inspectorTitle ?? t("workbench.context")}
      inspector={
        <>
          {inspectorMode === "metadata" && (
            <Inspector
              object={{
                id: session.sessionId,
                title: session.title,
                kind: "Session",
                status: session.status,
                metadata: [
                  { label: "Session", value: session.sessionId },
                  { label: "Run", value: session.activeRunId },
                  { label: t("workbench.revision"), value: session.revision },
                ],
              }}
            />
          )}
          {inspector}
        </>
      }
      bottomPanel={bottom}
      bottomPanelOpen={panelState.bottomOpen}
      onBottomPanelOpenChange={(bottomOpen) => patch({ bottomOpen })}
      bottomPanelHeight={panelState.bottomHeight}
      onBottomPanelHeightChange={(bottomHeight) => patch({ bottomHeight })}
      bottomPanelResizable
      toolbar={
        toolbar || (bottom && showBottomToggle) ? (
          <>
            {toolbar}
            {bottom && showBottomToggle && (
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={panelState.bottomOpen}
                onClick={() => patch({ bottomOpen: !panelState.bottomOpen })}
              >
                {t("workbench.bottom")}
                {bottomBadge !== undefined &&
                  bottomBadge > 0 &&
                  ` (${bottomBadge})`}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className={styles.body} data-workbench-presentation={presentation}>
        {presentation === "workspace" && (
          <SessionHeader
            session={session}
            presentation="workspace"
            onRename={onRename}
            actions={headerActions}
          />
        )}
        {(showViewSwitch || (layout === "review" && showReviewControls)) && (
          <div
            className={cn(styles.toolbar, styles.viewSwitch)}
            data-review-controls={layout === "review" || undefined}
          >
            {showViewSwitch &&
              (["conversation", "workspace"] as const).map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant="ghost"
                  aria-pressed={view === v}
                  onClick={() => {
                    if (v === "conversation") changeMaximized(false)
                    setPane({ layout, view: v })
                    onActiveViewChange?.(v)
                  }}
                >
                  {v === "conversation"
                    ? t("workbench.conversation")
                    : t("workbench.details")}
                </Button>
              ))}
            {layout === "review" && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={maximized}
                  onClick={() => changeMaximized(!maximized)}
                >
                  {t(
                    maximized
                      ? "workbench.restoreEditor"
                      : "workbench.maximizeEditor",
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => changeSplit(0.45)}
                >
                  {t("workbench.resetSplit")}
                </Button>
              </>
            )}
          </div>
        )}
        <div
          ref={panesRef}
          className={styles.panes}
          data-layout={layout}
          data-view={layout === "tasks" ? "workspace" : view}
          data-maximized={maximized && layout === "review"}
          data-wide-review={wideReview}
          style={
            { "--workbench-chat-width": `${splitWidth}px` } as CSSProperties
          }
        >
          <div className={styles.chat}>
            <AgentConversation
              session={session}
              {...conversation}
              composer={composer}
            />
          </div>
          {wideReview && (
            <ResizableHandle
              unstyled
              className={styles.reviewResize}
              label={t("workbench.resizeSplit")}
              value={splitWidth}
              min={minSplitWidth}
              max={maxSplitWidth}
              onValueChange={(value) => changeSplit(value / available)}
            />
          )}
          <div className={styles.workspace}>
            {(workspaceVisible || workspaceVisited) && workspace}
          </div>
        </div>
      </div>
    </WorkspaceShell>
  )
}
