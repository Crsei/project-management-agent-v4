import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronLeft,
  ChevronRight,
  Files,
  GitBranch,
  Globe,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@agent/components/ui/sheet";
import { InspectorScopeProvider, type InspectorScope } from "../workspace/inspector/scope";
import { useAgentText, type AgentText } from "../i18n";
import {
  EMPTY_RIGHT_PANEL_STATE,
  pmRightPanelReducer,
  pmRightPanelSurfaceTitle,
  type PmRightPanelSurface,
  type PmRightPanelSurfaceKind,
} from "./right-panel-state";
import "../../styles/inspector.css";

const FilesPanel = lazy(() => import("../workspace/inspector/files-panel").then((module) => ({ default: module.FilesPanel })));
const GitPanel = lazy(() => import("../workspace/inspector/git-panel").then((module) => ({ default: module.GitPanel })));
const BrowserPanel = lazy(() => import("../workspace/inspector/browser-panel").then((module) => ({ default: module.BrowserPanel })));

const COMPACT_WIDTH = 980;
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

type SurfaceAction = {
  kind: PmRightPanelSurfaceKind;
  label: string;
  shortcut: string;
  Icon: typeof Files;
};

type AvailableSurfaceAction = SurfaceAction & {
  available: boolean;
  disabledReason?: string;
};

type TabMenuAction = "close" | "close-others" | "close-to-right" | "close-all";

const surfaceComponent = (surface: PmRightPanelSurface) => {
  switch (surface.kind) {
    case "files":
      return FilesPanel;
    case "git":
      return GitPanel;
    case "terminal":
      return null;
    case "browser":
      return BrowserPanel;
  }
};

const surfaceIcon = (surface: PmRightPanelSurface) => {
  switch (surface.kind) {
    case "files":
      return Files;
    case "git":
      return GitBranch;
    case "terminal":
      return TerminalSquare;
    case "browser":
      return Globe;
  }
};

function focusOnMount(node: HTMLDivElement | null) {
  node?.focus();
}

function surfaceActions(t: AgentText): SurfaceAction[] {
  return [
    { kind: "browser", label: t("浏览器", "Browser"), shortcut: "B", Icon: Globe },
    { kind: "terminal", label: t("终端", "Terminal"), shortcut: "T", Icon: TerminalSquare },
    { kind: "files", label: t("文件", "Files"), shortcut: "F", Icon: Files },
    { kind: "git", label: t("Git", "Git"), shortcut: "G", Icon: GitBranch },
  ];
}

function shortcutFromEvent(event: KeyboardEvent, actions: SurfaceAction[]): SurfaceAction | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing) return undefined;
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  return actions.find((action) => action.shortcut.toLowerCase() === event.key.toLowerCase());
}

function overlayOpen(): boolean {
  return !!document.querySelector('[role="alertdialog"], [role="menu"], [role="listbox"], [role="dialog"]:not(.pm-right-panel-sheet)');
}

function SurfacesLauncher({ actions, onAdd, t }: {
  actions: AvailableSurfaceAction[];
  onAdd: (kind: PmRightPanelSurfaceKind) => void;
  t: AgentText;
}) {
  const availableActions = actions.filter((action) => action.available);
  const [highlight, setHighlight] = useState(-1);
  const highlighted = highlight >= 0 && highlight < availableActions.length ? highlight : -1;

  const moveHighlight = (delta: number) => {
    if (availableActions.length === 0) return;
    setHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
      return (base + delta + availableActions.length) % availableActions.length;
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter") {
      if (event.target !== event.currentTarget) return;
      const action = availableActions[highlighted];
      if (!action) return;
      event.preventDefault();
      onAdd(action.kind);
    }
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || overlayOpen()) return;
      const target = event.composedPath()[0] ?? event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      const action = shortcutFromEvent(event, availableActions);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      onAdd(action.kind);
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [availableActions, onAdd]);

  return <div
    ref={focusOnMount}
    tabIndex={0}
    onKeyDown={handleKeyDown}
    aria-label={t("打开一个面板", "Open a surface")}
    data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
    className="pm-right-panel-launcher"
  >
    <div className="pm-right-panel-launcher-inner">
      <h3>{t("打开一个面板", "Open a surface")}</h3>
      <div className="pm-right-panel-launcher-list">
        {actions.map((action) => {
          const Icon = action.Icon;
          if (!action.available) {
            return <div key={action.kind} className="pm-right-panel-launcher-item" aria-disabled="true" title={action.disabledReason}>
              <Icon aria-hidden="true" />
              <span>{action.label}</span>
              <kbd className="pm-right-panel-kbd">{action.shortcut}</kbd>
            </div>;
          }
          const index = availableActions.indexOf(action);
          return <button
            key={action.kind}
            type="button"
            className="pm-right-panel-launcher-item"
            data-highlight={highlighted === index || undefined}
            onMouseEnter={() => setHighlight(index)}
            onMouseLeave={() => setHighlight((current) => current === index ? -1 : current)}
            onClick={() => onAdd(action.kind)}
          >
            <Icon aria-hidden="true" />
            <span>{action.label}</span>
            <kbd className="pm-right-panel-kbd">{action.shortcut}</kbd>
          </button>;
        })}
      </div>
    </div>
  </div>;
}

function RightPanelTab({ surface, title, active, canCloseOthers, canCloseRight, onActivate, onAction, t }: {
  surface: PmRightPanelSurface;
  title: string;
  active: boolean;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  onActivate: () => void;
  onAction: (action: TabMenuAction, surface: PmRightPanelSurface) => void;
  t: AgentText;
}) {
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({ id: surface.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: surface.id });
  const Icon = surfaceIcon(surface);
  return <div
    ref={(node) => { setNodeRef(node); setDropRef(node); }}
    {...listeners}
    style={{ transform: CSS.Translate.toString(transform) }}
    className="pm-right-panel-tab"
    data-active={active || undefined}
    data-dragging={isDragging || undefined}
    data-drop-target={isOver || undefined}
    onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
    onAuxClick={(event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onAction("close", surface);
    }}
  >
    <ContextMenu>
      <ContextMenuTrigger asChild tabIndex={-1}>
        <div className="pm-right-panel-tab-inner">
          <button
            type="button"
            className="pm-right-panel-tab-icon"
            aria-label={t(`关闭 ${title}`, `Close ${title}`)}
            title={t(`关闭 ${title}`, `Close ${title}`)}
            onClick={(event) => { event.stopPropagation(); onAction("close", surface); }}
          >
            <Icon className="pm-right-panel-tab-glyph" aria-hidden="true" />
            <X className="pm-right-panel-tab-x" aria-hidden="true" />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className="pm-right-panel-tab-label"
            title={title}
            onClick={onActivate}
          >{title}</button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="pm-right-panel-menu" aria-label={t(`${title} 的操作`, `${title} actions`)}>
        <ContextMenuItem onSelect={() => onAction("close", surface)}>{t("关闭", "Close")}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOthers} onSelect={() => onAction("close-others", surface)}>{t("关闭其他", "Close others")}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseRight} onSelect={() => onAction("close-to-right", surface)}>{t("关闭右侧", "Close to the right")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onAction("close-all", surface)}>{t("全部关闭", "Close all")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </div>;
}

/** The chat right panel: a surface tab strip over the active surface or the launcher. */
export function PmRightPanel({
  threadId,
  disabled,
  open,
  onOpenChange,
  maximized,
  onMaximizedChange,
  inspectorScope,
  terminalSurface,
  terminalVisible,
  terminalAvailable,
  onOpenTerminal,
  onAttachImage,
}: {
  threadId?: string;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  maximized: boolean;
  onMaximizedChange: (maximized: boolean) => void;
  inspectorScope?: InspectorScope;
  terminalSurface?: ReactNode;
  terminalVisible: boolean;
  terminalAvailable: boolean;
  onOpenTerminal: () => void;
  onAttachImage?: (file: File) => void | Promise<void>;
}) {
  const t = useAgentText();
  const [state, dispatch] = useReducer(pmRightPanelReducer, EMPTY_RIGHT_PANEL_STATE);
  const [width, setWidth] = useState(440);
  const [availableWidth, setAvailableWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scroll, setScroll] = useState({ hasOverflow: false, canLeft: false, canRight: false });
  const marker = useRef<HTMLSpanElement>(null);
  const aside = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const id = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const compact = availableWidth <= COMPACT_WIDTH;
  const maxWidth = Math.floor(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availableWidth * 0.45)));
  const visibleWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, width));
  const clampWidth = (next: number) => Math.max(MIN_WIDTH, Math.min(maxWidth, next));
  const actions = useMemo<AvailableSurfaceAction[]>(() => surfaceActions(t).map((action) => ({
    ...action,
    available: action.kind === "browser" ? true : action.kind === "terminal" ? terminalAvailable : !disabled,
    disabledReason: action.kind === "terminal" && !terminalAvailable
      ? t("先打开一个终端", "Open a terminal first")
      : action.kind !== "browser" && action.kind !== "terminal" && disabled
        ? t("先创建代码文件夹中的会话", "Start a session in a code folder first")
        : undefined,
  })), [t, disabled, terminalAvailable]);
  const active = state.surfaces.find((surface) => surface.id === state.activeId) ?? null;
  const shown = open;
  const inline = shown && !compact;

  useEffect(() => {
    if (terminalVisible) dispatch({ type: "add", kind: "terminal" });
  }, [terminalVisible]);
  useEffect(() => {
    const shell = marker.current?.parentElement;
    if (!shell) return;
    const measure = () => {
      const shellWidth = shell.getBoundingClientRect().width;
      const sidebar = shell.querySelector<HTMLElement>(":scope > .pm-agent-sidebar");
      const sidebarWidth = sidebar && getComputedStyle(sidebar).display !== "none" ? sidebar.getBoundingClientRect().width : 0;
      setAvailableWidth(shellWidth > 0 ? Math.max(0, Math.min(window.innerWidth, shellWidth - sidebarWidth)) : window.innerWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (!open) setMenuOpen(false);
  }, [open]);

  useEffect(() => {
    if (compact && maximized) onMaximizedChange(false);
  }, [compact, maximized, onMaximizedChange]);

  const updateScroll = useCallback(() => {
    const viewport = tabsRef.current;
    if (!viewport) return;
    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > 1;
    const canLeft = hasOverflow && viewport.scrollLeft > 1;
    const canRight = hasOverflow && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1;
    setScroll((current) => current.hasOverflow === hasOverflow && current.canLeft === canLeft && current.canRight === canRight
      ? current
      : { hasOverflow, canLeft, canRight });
  }, []);

  useEffect(() => {
    const viewport = tabsRef.current;
    if (!viewport || !inline) return;
    const content = viewport.firstElementChild;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(viewport);
    if (content) observer.observe(content);
    viewport.addEventListener("scroll", updateScroll, { passive: true });
    updateScroll();
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", updateScroll);
    };
  }, [inline, state.surfaces.length, updateScroll]);

  useEffect(() => {
    const viewport = tabsRef.current;
    if (!viewport || !inline) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      const previous = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft !== previous) {
        event.preventDefault();
        updateScroll();
      }
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [inline, updateScroll]);

  useEffect(() => {
    if (!state.activeId || !scroll.hasOverflow) return;
    tabsRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeId, scroll.hasOverflow]);

  const addSurface = useCallback((kind: PmRightPanelSurfaceKind) => {
    dispatch({ type: "add", kind });
    if (kind === "terminal") onOpenTerminal();
    setMenuOpen(false);
  }, [onOpenTerminal]);

  const handleTabAction = (action: TabMenuAction, surface: PmRightPanelSurface) => {
    switch (action) {
      case "close":
        dispatch({ type: "close", id: surface.id });
        break;
      case "close-others":
        dispatch({ type: "close-others", id: surface.id });
        break;
      case "close-to-right":
        dispatch({ type: "close-to-right", id: surface.id });
        break;
      case "close-all":
        dispatch({ type: "close-all" });
        break;
    }
  };

  const handleDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    const toIndex = state.surfaces.findIndex((surface) => surface.id === over.id);
    if (toIndex >= 0) dispatch({ type: "move", id: String(dragged.id), toIndex });
  };

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabsRef.current;
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({ left: direction * Math.max(120, viewport.clientWidth * 0.75), behavior: reduceMotion ? "auto" : "smooth" });
  };

  const closePanel = () => {
    onOpenChange(false);
    onMaximizedChange(false);
  };

  if (!inline && !shown) return <span ref={marker} hidden aria-hidden="true" />;

  const tabbar = <div className="pm-right-panel-tabbar" data-right-panel-tabbar>
    <div ref={tabsRef} className="pm-right-panel-tabs" role="tablist" aria-label={t("右侧面板", "Right panel")} data-right-panel-tab-list>
      <div className="pm-right-panel-tab-track">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {state.surfaces.map((surface, index) => <RightPanelTab
            key={surface.id}
            surface={surface}
            title={pmRightPanelSurfaceTitle(surface, t)}
            active={surface.id === state.activeId}
            canCloseOthers={state.surfaces.length > 1}
            canCloseRight={index < state.surfaces.length - 1}
            onActivate={() => dispatch({ type: "activate", id: surface.id })}
            onAction={handleTabAction}
            t={t}
          />)}
        </DndContext>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            className="pm-right-panel-control pm-right-panel-add"
            aria-label={t("添加面板", "Add panel surface")}
            title={t("添加面板", "Add panel surface")}
          ><Plus /></DropdownMenuTrigger>
          <DropdownMenuContent
            className="pm-right-panel-menu"
            side="bottom"
            align="start"
            sideOffset={12}
            onKeyDownCapture={(event) => {
              if (event.nativeEvent.isComposing) return;
              const action = shortcutFromEvent(event.nativeEvent, actions.filter((entry) => entry.available));
              if (!action) return;
              event.preventDefault();
              event.stopPropagation();
              addSurface(action.kind);
            }}
          >
            <DropdownMenuLabel className="pm-right-panel-menu-label">{t("添加面板", "Add panel")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {actions.map((action) => {
              const Icon = action.Icon;
              return <DropdownMenuItem
                key={action.kind}
                className="pm-right-panel-menu-item"
                disabled={!action.available}
                title={action.disabledReason}
                onSelect={() => { if (action.available) addSurface(action.kind); }}
              >
                <Icon aria-hidden="true" />
                <span>{action.label}</span>
                <kbd className="pm-right-panel-kbd">{action.shortcut}</kbd>
              </DropdownMenuItem>;
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    {scroll.hasOverflow && <div className="pm-right-panel-scroll-controls" role="group" aria-label={t("滚动面板标签", "Scroll panel tabs")}>
      <button type="button" className="pm-right-panel-control" aria-label={t("向左滚动标签", "Scroll tabs left")} title={t("向左滚动标签", "Scroll tabs left")} disabled={!scroll.canLeft} onClick={() => scrollTabs(-1)}><ChevronLeft /></button>
      <button type="button" className="pm-right-panel-control" aria-label={t("向右滚动标签", "Scroll tabs right")} title={t("向右滚动标签", "Scroll tabs right")} disabled={!scroll.canRight} onClick={() => scrollTabs(1)}><ChevronRight /></button>
    </div>}
    {!compact && <button
      type="button"
      className="pm-right-panel-control"
      aria-label={maximized ? t("恢复面板大小", "Restore panel size") : t("最大化面板", "Maximize panel")}
      aria-pressed={maximized}
      title={maximized ? t("恢复面板大小", "Restore panel size") : t("最大化面板", "Maximize panel")}
      onClick={() => onMaximizedChange(!maximized)}
    >{maximized ? <Minimize2 /> : <Maximize2 />}</button>}
    <button type="button" className="pm-right-panel-control" aria-label={t("关闭右侧面板", "Close right panel")} title={t("关闭右侧面板", "Close right panel")} onClick={closePanel}><PanelRightClose /></button>
  </div>;

  const content = active
    ? <InspectorScopeProvider scope={inspectorScope ?? { threadId }}>
      {state.surfaces.map((surface) => {
        const Component = surfaceComponent(surface);
        const surfaceActive = surface.id === active.id;
        return <section
          key={surface.id}
          id={`${id}-surface-${surface.id.replace(/[^\w-]/g, "-")}`}
          className="pm-right-panel-surface"
          data-kind={surface.kind}
          hidden={!surfaceActive}
          aria-label={pmRightPanelSurfaceTitle(surface, t)}
        >
          <Suspense fallback={<p role="status" className="pm-right-panel-loading">{t("正在加载面板…", "Loading panel…")}</p>}>
            {surface.kind === "terminal" ? surfaceActive && terminalVisible ? terminalSurface : <p className="inspector-empty">{t("终端已停靠底部或已分离。", "Terminal is docked below or detached.")}<button type="button" onClick={onOpenTerminal}>{t("在此附加", "Attach here")}</button></p> : Component ? surface.kind === "browser" ? <BrowserPanel active={surfaceActive} onAttachImage={onAttachImage} onTitleChange={(title) => dispatch({ type: "title", id: surface.id, title })} /> : <Component active={surfaceActive} /> : null}
          </Suspense>
        </section>;
      })}
    </InspectorScopeProvider>
    : <SurfacesLauncher actions={actions} onAdd={addSurface} t={t} />;

  if (compact) {
    return <>
      <span ref={marker} hidden aria-hidden="true" />
      <Sheet open={shown} onOpenChange={(next) => { if (!next) closePanel(); }}>
        <SheetContent side="right" showCloseButton={false} className="pm-right-panel-sheet">
          <SheetHeader className="pm-right-panel-sheet-header">
            <SheetTitle className="sr-only">{t("右侧面板", "Right panel")}</SheetTitle>
            {tabbar}
          </SheetHeader>
          <div className="pm-right-panel-content">{content}</div>
        </SheetContent>
      </Sheet>
    </>;
  }

  if (!shown) return <span ref={marker} hidden aria-hidden="true" />;

  return <>
    <span ref={marker} hidden aria-hidden="true" />
    {!maximized && <div
      className="pm-right-panel-resizer"
      role="separator"
      aria-label={t("调整右侧面板宽度", "Resize right panel")}
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={Math.round(visibleWidth)}
      tabIndex={0}
      onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (dragging.current && aside.current) setWidth(clampWidth(aside.current.getBoundingClientRect().right - event.clientX)); }}
      onPointerUp={(event) => { dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { dragging.current = false; }}
      onLostPointerCapture={() => { dragging.current = false; }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setWidth(clampWidth(visibleWidth + (event.key === "ArrowLeft" ? 24 : -24)));
      }}
    />}
    <aside
      id={`${id}-right-panel`}
      ref={aside}
      className="pm-right-panel"
      style={maximized ? undefined : { width: visibleWidth }}
      data-maximized={maximized || undefined}
      aria-label={t("右侧面板", "Right panel")}
    >
      {tabbar}
      <div className="pm-right-panel-content">{content}</div>
    </aside>
  </>;
}

export type { PmRightPanelSurface, PmRightPanelSurfaceKind } from "./right-panel-state";
