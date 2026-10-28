import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";
import { Maximize2, Minimize2, PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ShellChrome } from "@/components/assistant-ui/elements/shell-chrome.aui";
import { ModelContextBridge } from "@/components/assistant-ui/elements/model-context-bridge.aui";
import type { ChatSettings, SettingsUpdater } from "@/hooks/use-chat-settings";
import { useProviders } from "@/hooks/use-providers";
import type { WorkspacePanel } from "@agent-workspace/contracts/workspace";
import { useWorkspace } from "./provider";
import { agentInstructions, documentContext } from "./storage";
import { PANELS, type PanelMeta } from "./panel-catalog";
import { ResourceSyncStatus } from "./resource-status";
import "@/styles/live-workspace.css";
import "@/styles/inspector.css";

const WorkflowsPanel = lazy(() =>
  import("./workflows-panel").then((module) => ({ default: module.WorkflowsPanel })),
);
const AgentsPanel = lazy(() =>
  import("./agents-panel").then((module) => ({ default: module.AgentsPanel })),
);
const DocumentsPanel = lazy(() =>
  import("./documents-panel").then((module) => ({ default: module.DocumentsPanel })),
);
const SkillsPanel = lazy(() =>
  import("./skills-panel").then((module) => ({ default: module.SkillsPanel })),
);
const RunsPanel = lazy(() =>
  import("./runs-panel").then((module) => ({ default: module.RunsPanel })),
);
const AutomationPanel = lazy(() =>
  import("./automation-panel").then((module) => ({ default: module.AutomationPanel })),
);
// The retained legacy shell has no authoritative PM scope. Inspector tools are
// available only in the scoped PM chat shell, never through a global-root fallback.
function ScopedInspectorUnavailable() {
  return <p className="live-panel-empty">请在 PM Chat 中选择工作区或项目后打开文件工具。</p>;
}

type PanelComponent = ComponentType<{ active?: boolean }>;

type PanelDefinition = PanelMeta & {
  Component: PanelComponent;
  hint: string;
  /** Fill the scroll container instead of scrolling as a document. */
  fill?: boolean;
  /** Inspector panels start wider than the resource lists. */
  wide?: boolean;
};

const PANEL_COMPONENTS: Record<WorkspacePanel, PanelComponent> = {
  workflows: WorkflowsPanel,
  agents: AgentsPanel,
  documents: DocumentsPanel,
  skills: SkillsPanel,
  runs: RunsPanel,
  automation: AutomationPanel,
  files: ScopedInspectorUnavailable,
  git: ScopedInspectorUnavailable,
  terminal: ScopedInspectorUnavailable,
  browser: ScopedInspectorUnavailable,
};

const PANEL_DETAILS: Record<WorkspacePanel, { hint: string; fill?: boolean; wide?: boolean }> = {
  workflows: { hint: "真实模型执行 · 当前会话上下文" },
  agents: { hint: "真实模型执行 · 当前会话上下文" },
  documents: { hint: "真实模型执行 · 当前会话上下文" },
  skills: { hint: "真实模型执行 · 当前会话上下文" },
  runs: { hint: "真实模型执行 · 当前会话上下文" },
  automation: { hint: "服务端常驻调度 · 按会话隔离的执行模板" },
  files: { hint: "只读浏览项目文件", wide: true },
  git: { hint: "工作区状态与差异", wide: true },
  terminal: { hint: "本机 PTY · 关闭面板即结束会话", fill: true, wide: true },
  browser: { hint: "iframe 预览 · 跨域站点可能拒绝嵌入", fill: true, wide: true },
};

const panels: PanelDefinition[] = PANELS.map((panel) => ({
  ...panel,
  ...PANEL_DETAILS[panel.id],
  Component: PANEL_COMPONENTS[panel.id],
}));

function PanelContents({ active }: { active: boolean }) {
  const { panel, ready, state } = useWorkspace();
  const [visited, setVisited] = useState<WorkspacePanel[]>([]);
  useEffect(() => {
    if (panel) setVisited((current) => (current.includes(panel) ? current : [...current, panel]));
  }, [panel]);
  if (!ready)
    return <p className="live-panel-empty">正在关联当前会话；如未能建立，请查看上方错误信息。</p>;
  const showFootnote = panels.find((item) => item.id === panel)?.group === "session";
  return (
    <>
      {panels.map(
        ({ id, label, Component }) =>
          (visited.includes(id) || id === panel) && (
            <section key={id} hidden={panel !== id} aria-label={label} className="live-panel-body">
              <Suspense fallback={<p className="live-panel-empty">正在加载面板…</p>}>
                <Component active={active && panel === id} />
              </Suspense>
            </section>
          ),
      )}
      {showFootnote && (
        <p className="live-panel-footnote">
          仅当前会话 · 服务端持久保存 · {state.agents.length} 个 Agent ·{" "}
          {state.documents.filter((document) => document.included).length} 篇引用文档
        </p>
      )}
    </>
  );
}

export function WorkspaceSurface({
  settings,
  set,
}: {
  settings: ChatSettings;
  set: SettingsUpdater;
}) {
  const { state, threadId, panel, setPanel, storageError, actionError, update } = useWorkspace();
  const { providers, loading: providersLoading, error: providersError, refresh: refreshProviders } = useProviders();
  const { isMobile } = useSidebar();
  const [width, setWidth] = useState(520);
  const [wideOverride, setWideOverride] = useState<boolean | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const agent = state.agents.find((item) => item.id === state.activeAgentId);
  const effectiveSettings: ChatSettings = {
    ...settings,
    providerInstanceId: agent?.providerInstanceId ?? settings.providerInstanceId,
    model: agent?.model ?? settings.model,
    systemPrompt: [
      settings.systemPrompt,
      agent ? agentInstructions(agent, state) : "",
      documentContext(state),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
  const providerLabel = providers.find(
    (provider) => provider.instanceId === effectiveSettings.providerInstanceId,
  )?.label;
  const displayedModel = providerLabel
    ? `${providerLabel} · ${effectiveSettings.model}`
    : effectiveSettings.model;
  function changeComposerModel(providerInstanceId: string, model: string) {
    if (agent) {
      update((current) => ({
        ...current,
        agents: current.agents.map((item) =>
          item.id === agent.id ? { ...item, providerInstanceId, model } : item,
        ),
      }));
      return;
    }
    set({ providerInstanceId, model });
  }
  const currentPanel = panels.find((item) => item.id === panel);
  // Inspector panels default to the wide layout; the header button can override it.
  const wide = wideOverride ?? Boolean(currentPanel?.wide);
  useEffect(() => setWideOverride(null), [panel]);
  function clampWidth(next: number) {
    return Math.max(320, Math.min(800, (container.current?.clientWidth ?? 1200) - 404, next));
  }
  const notices = (
    <>
      <ResourceSyncStatus />
      {storageError && (
        <p role="alert" className="live-panel-error">
          {storageError}
        </p>
      )}
      {actionError && (
        <p role="alert" className="live-panel-error">
          {actionError}
        </p>
      )}
    </>
  );
  return (
    <>
      <ModelContextBridge settings={effectiveSettings} />
      <ShellChrome settings={settings} set={set} displayedModel={displayedModel} />
      {!isMobile && (
        <div className="live-workspace-toolbar">
          <span className="live-chat-profile" title="仅影响当前会话的后续模型请求">
            {agent ? `当前 Agent：${agent.name || "未命名"}` : "默认助手"}
            {state.documents.some((document) => document.included) &&
              ` · ${state.documents.filter((document) => document.included).length} 篇文档`}
          </span>
        </div>
      )}
      {!isMobile && notices}
      <div
        ref={container}
        className="live-workspace-layout"
        style={{ "--live-panel-width": `${width}px` } as CSSProperties}
      >
        <main className="live-chat">
          <Thread
            providerInstanceId={effectiveSettings.providerInstanceId}
            model={effectiveSettings.model}
            catalog={{ providers, loading: providersLoading, error: providersError, refresh: refreshProviders }}
            onModelChange={changeComposerModel}
          />
        </main>
        {!isMobile && (
          <>
            <div
              hidden={!panel || wide}
              className="live-workspace-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整工作区宽度"
              aria-valuemin={320}
              aria-valuemax={800}
              aria-valuenow={Math.round(width)}
              tabIndex={0}
              onPointerDown={(event) => {
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (dragging.current && container.current)
                  setWidth(
                    clampWidth(container.current.getBoundingClientRect().right - event.clientX),
                  );
              }}
              onPointerUp={(event) => {
                dragging.current = false;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                dragging.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  setWidth((current) =>
                    clampWidth(current + (event.key === "ArrowLeft" ? 24 : -24)),
                  );
                }
              }}
            />
            <aside
              id="live-workspace-panel"
              hidden={!panel}
              className={`live-workspace-panel${wide ? " live-workspace-panel--wide" : ""}`}
              aria-label="当前会话工作区"
            >
              <div className="live-workspace-heading">
                <div>
                  <h2>{currentPanel?.label}</h2>
                  <p>{currentPanel?.hint}</p>
                </div>
                <div className="live-workspace-heading-actions">
                  {currentPanel?.wide && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={wide ? "退出宽面板" : "展开为宽面板"}
                      aria-pressed={wide}
                      onClick={() => setWideOverride(!wide)}
                    >
                      {wide ? <Minimize2 /> : <Maximize2 />}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="关闭工作区"
                    onClick={() => {
                      setPanel(null);
                      setWideOverride(null);
                    }}
                  >
                    <PanelRightClose />
                  </Button>
                </div>
              </div>
              <div
                className={`live-panel-scroll${currentPanel?.fill ? " live-panel-scroll--fill" : ""}`}
              >
                <PanelContents active={Boolean(panel)} key={threadId ?? "new"} />
              </div>
            </aside>
            <nav className="live-inspector-rail" aria-label="工作区工具">
              {panels
                .filter((item) => item.group === "inspector")
                .map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    variant="ghost"
                    className="live-inspector-rail-button"
                    aria-pressed={panel === id}
                    aria-controls="live-workspace-panel"
                    title={label}
                    onClick={() => setPanel(panel === id ? null : id)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </Button>
                ))}
            </nav>
          </>
        )}
      </div>
      {isMobile && (
        <Sheet
          open={Boolean(panel)}
          onOpenChange={(open) => {
            if (!open) setPanel(null);
          }}
        >
          <SheetContent id="live-workspace-panel" className="live-workspace-mobile" side="right">
            <SheetHeader>
              <SheetTitle>{currentPanel?.label ?? "会话工作区"}</SheetTitle>
              <SheetDescription>{currentPanel?.hint ?? "当前会话上下文"}</SheetDescription>
            </SheetHeader>
            {notices}
            <div
              className={`live-panel-scroll${currentPanel?.fill ? " live-panel-scroll--fill" : ""}`}
            >
              <PanelContents active={Boolean(panel)} key={threadId ?? "new"} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
