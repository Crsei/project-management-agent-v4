"use client"
import { OverlayLayer } from "../../lib/overlay-layer"
import { useThemePortalContainer } from "../ui/theme-boundary"
import { useI18n } from "../../lib/i18n-provider"

import { Dialog } from "@base-ui/react/dialog"
import { PanelLeftClose, PanelLeftOpen, PanelRight, X } from "lucide-react"
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { ResizableHandle } from "../ui/resizable"
import styles from "./workspace-shell.module.css"

function useLayoutValue<T>(
  value: T | undefined,
  initial: T,
  onChange?: (value: T) => void,
) {
  const [internal, setInternal] = useState(initial)
  const current = value === undefined ? internal : value
  function change(next: T | ((before: T) => T)) {
    const resolved =
      typeof next === "function" ? (next as (before: T) => T)(current) : next
    if (Object.is(current, resolved)) return
    if (value === undefined) setInternal(resolved)
    onChange?.(resolved)
  }
  return [current, change] as const
}

export type WorkspaceShellProps = {
  /** Desktop keeps navigation and Inspector docked regardless of container width. */
  layoutMode?: "adaptive" | "desktop"
  sidebarWidth?: number
  defaultSidebarWidth?: number
  onSidebarWidthChange?: (width: number) => void
  sidebarMinWidth?: number
  sidebarMaxWidth?: number
  sidebarResizable?: boolean
  sidebarCollapsed?: boolean
  defaultSidebarCollapsed?: boolean
  onSidebarCollapsedChange?: (collapsed: boolean) => void
  inspectorOpen?: boolean
  defaultInspectorOpen?: boolean
  onInspectorOpenChange?: (open: boolean) => void
  inspectorOverlayOpen?: boolean
  defaultInspectorOverlayOpen?: boolean
  onInspectorOverlayOpenChange?: (open: boolean) => void
  inspectorWidth?: number
  defaultInspectorWidth?: number
  onInspectorWidthChange?: (width: number) => void
  bottomPanelOpen?: boolean
  defaultBottomPanelOpen?: boolean
  onBottomPanelOpenChange?: (open: boolean) => void
  bottomPanelHeight?: number
  defaultBottomPanelHeight?: number
  onBottomPanelHeightChange?: (height: number) => void
  title: ReactNode
  /** Optional 48px activity rail. Without it, the original navigation layout is retained. */
  activityBar?: ReactNode
  sidebar: ReactNode
  children: ReactNode
  toolbar?: ReactNode
  inspector?: ReactNode
  inspectorTitle?: ReactNode
  inspectorFooter?: ReactNode
  bottomPanel?: ReactNode
  bottomPanelResizable?: boolean
  bottomPanelCollapsed?: boolean
  className?: string
}

export function WorkspaceShell({
  layoutMode = "adaptive",
  title,
  activityBar,
  sidebar,
  children,
  toolbar,
  inspector,
  inspectorTitle = "Inspector",
  inspectorFooter,
  bottomPanel,
  bottomPanelResizable = false,
  bottomPanelCollapsed,
  sidebarWidth: controlledSidebarWidth,
  defaultSidebarWidth = 256,
  onSidebarWidthChange,
  sidebarMinWidth = 200,
  sidebarMaxWidth = 400,
  sidebarResizable = false,
  sidebarCollapsed: controlledSidebar,
  defaultSidebarCollapsed = false,
  onSidebarCollapsedChange,
  inspectorOpen: controlledInspector,
  defaultInspectorOpen = true,
  onInspectorOpenChange,
  inspectorOverlayOpen: controlledOverlay,
  defaultInspectorOverlayOpen = false,
  onInspectorOverlayOpenChange,
  inspectorWidth: controlledWidth,
  defaultInspectorWidth,
  onInspectorWidthChange,
  bottomPanelOpen: controlledBottom,
  defaultBottomPanelOpen = true,
  onBottomPanelOpenChange,
  bottomPanelHeight: controlledHeight,
  defaultBottomPanelHeight = 240,
  onBottomPanelHeightChange,
  className,
}: WorkspaceShellProps) {
  const { t } = useI18n()
  const portalContainer = useThemePortalContainer()

  const sidebarId = useId()
  const sidebarRef = useRef<HTMLElement>(null)
  const navigationOpenerRef = useRef<HTMLButtonElement>(null)
  const [requestedSidebarWidth, setSidebarWidth] = useLayoutValue(
    controlledSidebarWidth,
    defaultSidebarWidth,
    onSidebarWidthChange,
  )
  const sidebarMin = Number.isFinite(sidebarMinWidth)
    ? Math.max(48, sidebarMinWidth)
    : 200
  const sidebarMax = Number.isFinite(sidebarMaxWidth)
    ? Math.max(sidebarMin, sidebarMaxWidth)
    : Math.max(sidebarMin, 400)
  const sidebarWidth = Math.max(
    sidebarMin,
    Math.min(
      sidebarMax,
      Number.isFinite(requestedSidebarWidth) ? requestedSidebarWidth : 256,
    ),
  )
  function resizeSidebar(width: number) {
    setSidebarWidth(Math.max(sidebarMin, Math.min(sidebarMax, width)))
  }
  const ref = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [measuredWide, setWide] = useState(false)
  const [measuredSidebarInline, setSidebarInline] = useState(false)
  const wide = layoutMode === "desktop" || measuredWide
  const sidebarInline = layoutMode === "desktop" || measuredSidebarInline
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useLayoutValue(
    controlledSidebar,
    defaultSidebarCollapsed,
    onSidebarCollapsedChange,
  )
  const [inspectorOpen, setInspectorOpen] = useLayoutValue(
    controlledInspector,
    defaultInspectorOpen,
    onInspectorOpenChange,
  )
  const [overlayOpen, setOverlayOpen] = useLayoutValue(
    controlledOverlay,
    defaultInspectorOverlayOpen,
    onInspectorOverlayOpenChange,
  )
  const [requestedWidth, setInspectorWidth] = useLayoutValue<number | null>(
    controlledWidth,
    defaultInspectorWidth ?? null,
    onInspectorWidthChange
      ? (value) => {
          if (value !== null) onInspectorWidthChange(value)
        }
      : undefined,
  )
  const [requestedHeight, setBottomHeight] = useLayoutValue(
    controlledHeight,
    defaultBottomPanelHeight,
    onBottomPanelHeightChange,
  )
  const [bottomOpen, setBottomOpen] = useLayoutValue(
    controlledBottom ??
      (bottomPanelCollapsed === undefined ? undefined : !bottomPanelCollapsed),
    defaultBottomPanelOpen,
    onBottomPanelOpenChange,
  )
  const bottomHeight = Math.min(
    400,
    Math.max(200, Number.isFinite(requestedHeight) ? requestedHeight : 240),
  )
  const [limits, setLimits] = useState({ min: 280, max: 360, initial: 320 })

  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => {
      const isWide = entry.contentRect.width >= 1280
      setWide(isWide)
      setSidebarInline(entry.contentRect.width >= 1024)
      if (ref.current) {
        const css = getComputedStyle(ref.current)
        setLimits({
          min:
            Number.parseFloat(
              css.getPropertyValue("--workspace-inspector-min"),
            ) || 280,
          max:
            Number.parseFloat(
              css.getPropertyValue("--workspace-inspector-max"),
            ) || 360,
          initial:
            Number.parseFloat(
              css.getPropertyValue("--workspace-inspector-width"),
            ) || 320,
        })
      }
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])

  const inspectorWidth =
    requestedWidth === null
      ? null
      : Math.min(
          limits.max,
          Math.max(
            limits.min,
            Number.isFinite(requestedWidth) ? requestedWidth : limits.initial,
          ),
        )

  function resize(width: number) {
    const { min, max } = limits
    setInspectorWidth(Math.min(max, Math.max(min, width)))
  }
  const docked = wide && inspectorOpen && inspector !== undefined
  const panelBody = <div className={styles.inspectorBody}>{inspector}</div>
  return (
    <div
      ref={ref}
      className={cn(styles.shell, className)}
      data-layout-mode={layoutMode}
      data-sidebar-collapsed={sidebarCollapsed}
      data-activity-bar={activityBar !== undefined || undefined}
      style={
        {
          ...(inspectorWidth === null
            ? {}
            : { "--inspector-current-width": `${inspectorWidth}px` }),
          "--sidebar-current-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <header className={styles.header}>
        <Button
          variant="ghost"
          size="icon"
          className={styles.sidebarToggle}
          ref={navigationOpenerRef}
          aria-label={
            (
              activityBar !== undefined && !sidebarInline
                ? !navigationOpen
                : sidebarCollapsed
            )
              ? t("workspaceShell.expandSidebar")
              : t("workspaceShell.collapseSidebar")
          }
          aria-expanded={
            activityBar !== undefined && !sidebarInline
              ? navigationOpen
              : !sidebarCollapsed
          }
          onClick={() =>
            activityBar !== undefined && !sidebarInline
              ? setNavigationOpen(true)
              : setSidebarCollapsed(!sidebarCollapsed)
          }
        >
          {(
            activityBar !== undefined && !sidebarInline
              ? !navigationOpen
              : sidebarCollapsed
          ) ? (
            <PanelLeftOpen />
          ) : (
            <PanelLeftClose />
          )}
        </Button>
        <div className={styles.title}>{title}</div>
        {inspector !== undefined && (
          <Button
            ref={openerRef}
            variant="ghost"
            size="icon"
            aria-label={
              docked
                ? t("workspaceShell.collapseInspector")
                : t("workspaceShell.openInspector")
            }
            aria-expanded={wide ? docked : overlayOpen}
            onClick={() =>
              wide ? setInspectorOpen(!inspectorOpen) : setOverlayOpen(true)
            }
          >
            <PanelRight />
          </Button>
        )}
      </header>
      <div className={styles.layout}>
        {activityBar !== undefined && (
          <div className={styles.activity}>{activityBar}</div>
        )}
        {(activityBar === undefined || sidebarInline) && (
          <aside
            id={sidebarId}
            ref={sidebarRef}
            className={styles.sidebar}
            aria-label={t("workspaceShell.workspaceNavigation")}
            tabIndex={0}
          >
            {sidebar}
          </aside>
        )}
        {sidebarResizable && !sidebarCollapsed && (
          <ResizableHandle
            unstyled
            label={t("commonComponents.resizeSidebar")}
            controls={sidebarId}
            value={sidebarWidth}
            min={sidebarMin}
            max={sidebarMax}
            onValueChange={resizeSidebar}
            className={styles.sidebarResize}
          />
        )}
        <div className={styles.main}>
          {toolbar && <div className={styles.toolbar}>{toolbar}</div>}
          <div className={styles.content}>{children}</div>
        </div>
        {docked && (
          <aside
            ref={panelRef}
            className={styles.inspector}
            aria-label="Inspector"
            data-inspector-docked
          >
            <ResizableHandle
              unstyled
              reverse
              value={inspectorWidth ?? limits.initial}
              min={limits.min}
              max={limits.max}
              onValueChange={resize}
              label={t("workspaceShell.resizeInspectorWidth")}
              className={styles.resizeHandle}
            />
            <div className={styles.inspectorHeader}>
              <h2>{inspectorTitle}</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("workspaceShell.closeInspector")}
                onClick={() => {
                  setInspectorOpen(false)
                  openerRef.current?.focus()
                }}
              >
                <X />
              </Button>
            </div>
            {panelBody}
            {inspectorFooter && (
              <div className={styles.inspectorFooter}>{inspectorFooter}</div>
            )}
          </aside>
        )}
      </div>
      {activityBar !== undefined && (
        <Dialog.Root
          open={!sidebarInline && navigationOpen}
          onOpenChange={setNavigationOpen}
        >
          <OverlayLayer>
            {(layerStyle) => (
              <Dialog.Portal container={portalContainer}>
                <Dialog.Backdrop
                  style={layerStyle}
                  className={styles.backdrop}
                />
                <Dialog.Popup
                  style={layerStyle}
                  className={cn(styles.drawer, styles.navigationDrawer)}
                  finalFocus={navigationOpenerRef}
                >
                  <div className={styles.inspectorHeader}>
                    <Dialog.Title>
                      {t("workspaceShell.workspaceNavigation")}
                    </Dialog.Title>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("dialog.closeDialog")}
                      onClick={() => setNavigationOpen(false)}
                    >
                      <X />
                    </Button>
                  </div>
                  <Dialog.Description className="sr-only">
                    {t("workspaceShell.workspaceNavigation")}
                  </Dialog.Description>
                  <div
                    className={styles.inspectorBody}
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          "[data-navigation-close]",
                        )
                      )
                        setNavigationOpen(false)
                    }}
                  >
                    {sidebar}
                  </div>
                </Dialog.Popup>
              </Dialog.Portal>
            )}
          </OverlayLayer>
        </Dialog.Root>
      )}
      {bottomPanel && (
        <section
          className={styles.bottom}
          aria-label={t("workspaceShell.bottomWorkspacePanel")}
          data-collapsed={!bottomOpen}
          style={
            bottomPanelResizable && bottomOpen
              ? { height: bottomHeight }
              : undefined
          }
        >
          {bottomPanelResizable && bottomOpen && (
            <ResizableHandle
              unstyled
              reverse
              axis="vertical"
              value={bottomHeight}
              min={200}
              max={400}
              onValueChange={setBottomHeight}
              label={t("workspaceShell.resizeBottomPanelHeight")}
              className={styles.bottomResize}
            />
          )}
          {bottomPanelCollapsed === undefined && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={bottomOpen}
              onClick={() => setBottomOpen(!bottomOpen)}
            >
              {t(
                bottomOpen
                  ? "workspaceShell.collapseBottomPanel"
                  : "workspaceShell.expandBottomPanel",
              )}
            </Button>
          )}
          {bottomPanelCollapsed !== undefined || bottomOpen
            ? bottomPanel
            : null}
        </section>
      )}
      <Dialog.Root open={!wide && overlayOpen} onOpenChange={setOverlayOpen}>
        <OverlayLayer>
          {(layerStyle) => (
            <Dialog.Portal container={portalContainer}>
              <Dialog.Backdrop style={layerStyle} className={styles.backdrop} />
              <Dialog.Popup
                style={layerStyle}
                className={styles.drawer}
                finalFocus={openerRef}
              >
                <div className={styles.inspectorHeader}>
                  <Dialog.Title>{inspectorTitle}</Dialog.Title>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("workspaceShell.closeInspector")}
                    onClick={() => setOverlayOpen(false)}
                  >
                    <X />
                  </Button>
                </div>
                <Dialog.Description className="sr-only">
                  {t(
                    "workspaceShell.statusMetadataAndActionsForTheSelectedObject",
                  )}
                </Dialog.Description>
                {panelBody}
                {inspectorFooter && (
                  <div className={styles.inspectorFooter}>
                    {inspectorFooter}
                  </div>
                )}
              </Dialog.Popup>
            </Dialog.Portal>
          )}
        </OverlayLayer>
      </Dialog.Root>
    </div>
  )
}
