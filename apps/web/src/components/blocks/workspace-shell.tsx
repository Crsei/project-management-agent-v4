import { OverlayLayer } from "../../lib/overlay-layer"
import { useThemePortalContainer } from "../ui/theme-boundary"
import { useI18n } from "../../lib/i18n-provider"

import * as DialogPrimitive from "@radix-ui/react-dialog"
import { PanelLeftClose, PanelLeftOpen, PanelRight, X } from "lucide-react"
import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
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

/** Base UI `finalFocus` parity: hand keyboard focus back to the opener. */
function returnFocus(ref: RefObject<HTMLButtonElement | null>) {
  return (event: Event) => {
    event.preventDefault()
    ref.current?.focus({ preventScroll: true })
  }
}

export type WorkspaceShellProps = {
  /** Desktop keeps navigation and Inspector docked regardless of container width. */
  layoutMode?: "adaptive" | "desktop"
  /** Use the accessible navigation drawer on narrow screens without an activity rail. */
  mobileNavigation?: boolean
  /** Opt into a full-height sidebar with the header and toolbar in the main column. */
  headerPlacement?: "shell" | "main"
  sidebarWidth?: number
  defaultSidebarWidth?: number
  onSidebarWidthChange?: (width: number) => void
  sidebarMinWidth?: number
  sidebarMaxWidth?: number
  sidebarResizable?: boolean
  sidebarCollapsed?: boolean
  defaultSidebarCollapsed?: boolean
  onSidebarCollapsedChange?: (collapsed: boolean) => void
  /** Optional icon rail rendered in place of `sidebar` while the inline sidebar is collapsed. */
  collapsedSidebar?: ReactNode
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
  sidebar?: ReactNode
  /** Brand slot; moves the collapse control beside the brand and into the drawer header. */
  sidebarHeader?: ReactNode
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
  mobileNavigation = false,
  headerPlacement = "shell",
  title,
  activityBar,
  sidebar,
  sidebarHeader,
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
  collapsedSidebar,
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
  const drawerNavigation = mobileNavigation || activityBar !== undefined
  const portalContainer = useThemePortalContainer()

  const sidebarId = useId()
  const sidebarRef = useRef<HTMLElement>(null)
  const navigationOpenerRef = useRef<HTMLButtonElement>(null)
  const sidebarCollapseRef = useRef<HTMLButtonElement>(null)
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
  const collapseSnap = collapsedSidebar === undefined
    ? null
    : Math.max(64, Math.round(sidebarMin / 2))
  function resizeSidebar(width: number) {
    if (collapseSnap !== null && sidebarCollapsed) {
      if (width > collapseSnap) {
        setSidebarCollapsed(false)
        setSidebarWidth(Math.max(sidebarMin, Math.min(sidebarMax, width)))
      }
      return
    }
    if (collapseSnap !== null && width <= collapseSnap) {
      setSidebarCollapsed(true)
      return
    }
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
  const header = (
    <header className={cn(
      styles.header,
      "desktop-titlebar desktop-titlebar-reserve-controls",
      headerPlacement === "shell" && "desktop-titlebar-traffic-lights",
    )}>
      {sidebar !== undefined && (sidebarHeader === undefined || !sidebarInline || sidebarCollapsed) && <Button
        variant="ghost"
        size="icon"
        className={styles.sidebarToggle}
        ref={navigationOpenerRef}
        aria-label={
          (
            drawerNavigation && !sidebarInline
              ? !navigationOpen
              : sidebarCollapsed
          )
            ? t("workspaceShell.expandSidebar")
            : t("workspaceShell.collapseSidebar")
        }
        aria-expanded={
          drawerNavigation && !sidebarInline
            ? navigationOpen
            : !sidebarCollapsed
        }
        onClick={() => {
          if (drawerNavigation && !sidebarInline) setNavigationOpen(true)
          else {
            setSidebarCollapsed(!sidebarCollapsed)
            if (sidebarCollapsed && sidebarHeader !== undefined) requestAnimationFrame(() => sidebarCollapseRef.current?.focus())
          }
        }}
      >
        {(
          drawerNavigation && !sidebarInline
            ? !navigationOpen
            : sidebarCollapsed
        ) ? (
          <PanelLeftOpen />
        ) : (
          <PanelLeftClose />
        )}
      </Button>}
      <div className={styles.title}>{title}</div>
      {headerPlacement === "main" && toolbar && (
        <div className={styles.headerActions}>{toolbar}</div>
      )}
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
  )
  return (
    <div
      ref={ref}
      className={cn(styles.shell, className)}
      data-layout-mode={layoutMode}
      data-header-placement={headerPlacement}
      data-sidebar-collapsed={sidebarCollapsed}
      data-sidebar-rail={collapsedSidebar !== undefined || undefined}
      data-activity-bar={activityBar !== undefined || undefined}
      data-drawer-navigation={drawerNavigation || undefined}
      style={
        {
          ...(inspectorWidth === null
            ? {}
            : { "--inspector-current-width": `${inspectorWidth}px` }),
          "--sidebar-current-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      {headerPlacement === "shell" && header}
      <div className={styles.layout}>
        {activityBar !== undefined && (
          <div className={styles.activity}>{activityBar}</div>
        )}
        {(!drawerNavigation || sidebarInline) && sidebar !== undefined && (
          <aside
            id={sidebarId}
            ref={sidebarRef}
            className={styles.sidebar}
            aria-label={t("workspaceShell.workspaceNavigation")}
            tabIndex={0}
          >
            {sidebarCollapsed && collapsedSidebar !== undefined
              ? collapsedSidebar
              : sidebarHeader === undefined ? sidebar : <div className="flex h-full min-h-0 flex-col">
                <div className="desktop-titlebar desktop-titlebar-traffic-lights flex h-14 shrink-0 items-center justify-between gap-2 px-3">
                  {sidebarHeader}
                  <Button ref={sidebarCollapseRef} variant="ghost" size="icon" aria-label={t("workspaceShell.collapseSidebar")} aria-expanded
                    onClick={() => { setSidebarCollapsed(true); requestAnimationFrame(() => navigationOpenerRef.current?.focus()) }}>
                    <PanelLeftClose />
                  </Button>
                </div>
                <div className="min-h-0 flex-1">{sidebar}</div>
              </div>}
          </aside>
        )}
        {sidebarResizable && sidebar !== undefined && (!sidebarCollapsed || collapseSnap !== null) && (
          <ResizableHandle
            unstyled
            label={t("commonComponents.resizeSidebar")}
            controls={sidebarId}
            value={sidebarCollapsed && collapseSnap !== null ? collapseSnap : sidebarWidth}
            min={collapseSnap ?? sidebarMin}
            max={sidebarMax}
            onValueChange={resizeSidebar}
            className={styles.sidebarResize}
          />
        )}
        <div className={styles.main}>
          {headerPlacement === "main"
            ? header
            : toolbar && <div className={styles.toolbar}>{toolbar}</div>}
          <div className={styles.content} data-pm-scroll-root>{children}</div>
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
      {drawerNavigation && (
        <DialogPrimitive.Root
          open={!sidebarInline && navigationOpen}
          onOpenChange={setNavigationOpen}
        >
          <OverlayLayer>
            {(layerStyle) => (
              <DialogPrimitive.Portal
                container={portalContainer?.current ?? undefined}
              >
                <DialogPrimitive.Overlay
                  style={layerStyle}
                  className={styles.backdrop}
                />
                <DialogPrimitive.Content
                  style={layerStyle}
                  className={cn(styles.drawer, styles.navigationDrawer)}
                  onCloseAutoFocus={returnFocus(navigationOpenerRef)}
                >
                  <div className={cn(styles.inspectorHeader, sidebarHeader !== undefined && "min-h-14!")}>
                    {sidebarHeader}
                    <DialogPrimitive.Title className={sidebarHeader === undefined ? undefined : "sr-only"}>
                      {t("workspaceShell.workspaceNavigation")}
                    </DialogPrimitive.Title>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("dialog.closeDialog")}
                      onClick={() => setNavigationOpen(false)}
                    >
                      <X />
                    </Button>
                  </div>
                  <DialogPrimitive.Description className="sr-only">
                    {t("workspaceShell.workspaceNavigation")}
                  </DialogPrimitive.Description>
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
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            )}
          </OverlayLayer>
        </DialogPrimitive.Root>
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
      <DialogPrimitive.Root open={!wide && overlayOpen} onOpenChange={setOverlayOpen}>
        <OverlayLayer>
          {(layerStyle) => (
            <DialogPrimitive.Portal
              container={portalContainer?.current ?? undefined}
            >
              <DialogPrimitive.Overlay
                style={layerStyle}
                className={styles.backdrop}
              />
              <DialogPrimitive.Content
                style={layerStyle}
                className={styles.drawer}
                onCloseAutoFocus={returnFocus(openerRef)}
              >
                <div className={styles.inspectorHeader}>
                  <DialogPrimitive.Title>{inspectorTitle}</DialogPrimitive.Title>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("workspaceShell.closeInspector")}
                    onClick={() => setOverlayOpen(false)}
                  >
                    <X />
                  </Button>
                </div>
                <DialogPrimitive.Description className="sr-only">
                  {t(
                    "workspaceShell.statusMetadataAndActionsForTheSelectedObject",
                  )}
                </DialogPrimitive.Description>
                {panelBody}
                {inspectorFooter && (
                  <div className={styles.inspectorFooter}>
                    {inspectorFooter}
                  </div>
                )}
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          )}
        </OverlayLayer>
      </DialogPrimitive.Root>
    </div>
  )
}
