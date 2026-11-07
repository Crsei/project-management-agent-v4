// Adapted from t3code d53873b6 apps/web/src/components/chat/McpAppFrame.tsx.
// Original host/sandbox helpers are retained through client-runtime. MIT; LICENSE.t3code.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAui, useAuiState } from "@assistant-ui/react";
import type { McpAppMetadata, McpAppSnapshot, McpAppToolResult, McpAppToolsResult, McpAppResourceResult } from "@agent-workspace/contracts/mcp-apps";
import type { GenerationOutputStatus } from "@agent-workspace/contracts/output";
import { WorkspaceClientError, makeMcpAppHost, McpAppHostRefusal, mcpAppStyleVariables, mcpResourceBytes, clampMcpAppHeight, MCP_APP_DEFAULT_HEIGHT, MCP_APP_MAX_HEIGHT, mcpAppAllowAttribute, type McpAppDisplayMode, type McpAppHost } from "@agent-workspace/client-runtime";
import { useTheme } from "@agent/hooks/use-theme";
import { canSendThread, threadExecutionSelection, usePmChatState } from "../pm/state";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { bindMcpAppDocument, makeMcpAppDocumentBridge } from "./mcp-app-document-bridge";
import "./mcp-app-frame.css";

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const PAGE_ACTIVATION_MS = 5000;
const fullscreenSupported = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function McpAppFrame({ app, generationStatus }: { app: McpAppMetadata; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const aui = useAui();
  const state = usePmChatState();
  const localId = useAuiState(s => s.threads.mainThreadId);
  const remoteId = useAuiState(s => s.threads.threadItems.find(item => item.id === s.threads.mainThreadId)?.remoteId);
  const threadRunning = useAuiState(s => s.thread.isRunning);
  const executionSelection = threadExecutionSelection(localId, remoteId);
  const selectedProvider = state.providers.find(provider => provider.instanceId === app.producing.providerInstanceId);
  const { theme } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<McpAppHost | null>(null);
  const documentBridgeRef = useRef<ReturnType<typeof makeMcpAppDocumentBridge> | null>(null);
  const [snapshot, setSnapshot] = useState<McpAppSnapshot>();
  const [error, setError] = useState<string>();
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  const [width, setWidth] = useState(0);
  const [mode, setMode] = useState<McpAppDisplayMode>("inline");
  const [closed, setClosed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const [toolDefinition, setToolDefinition] = useState<unknown>();
  const loads = useRef(0);
  const lastPageInputAt = useRef(Number.NEGATIVE_INFINITY);
  const target = `/api/mcp-apps/${encodeURIComponent(app.producing.threadId)}/${encodeURIComponent(app.producing.itemId)}`;
  const targetKey = JSON.stringify([app.producing, executionSelection]);
  const capturedDocument = useMemo<{ binding?: ReturnType<typeof bindMcpAppDocument>; error?: string }>(() => {
    if (!snapshot) return {};
    try { return { binding: bindMcpAppDocument(snapshot.html, window.location.origin) }; }
    catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [snapshot, generation, targetKey]);
  const documentBinding = capturedDocument.binding;
  const bound = remoteId === app.producing.threadId && !state.providerError && !!selectedProvider?.nativeSessionReady && (selectedProvider.revision === undefined || selectedProvider.revision === app.producing.instanceRevision) && state.threads.get(remoteId)?.settings.providerInstanceId === app.producing.providerInstanceId;
  // Tool completion precedes retained-session handoff. Only the producing
  // generation's terminal output confirms that handoff, not thread.isRunning.
  const ready = generationStatus === "completed";
  const latest = useRef({ theme, width, mode, app, bound: bound && ready, toolDefinition, localId, remoteId, state });
  latest.current = { theme, width, mode, app, bound: bound && ready, toolDefinition, localId, remoteId, state };

  useLayoutEffect(() => {
    const box = boxRef.current; if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(entries => { if (entries[0]) setWidth(Math.round(entries[0].contentRect.width)); });
    observer.observe(box); return () => observer.disconnect();
  }, [closed, snapshot, invalid]);

  useEffect(() => {
    if (!bound || !ready || closed || invalid) return;
    const abort = new AbortController();
    let first = snapshot === undefined;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        // Revalidate authority without repeatedly downloading up to 5 MiB of captured HTML.
        if (!first) { await workspaceClient.json<McpAppToolsResult>(`${target}/tools`, { signal: abort.signal }); return; }
        const value = await workspaceClient.json<McpAppSnapshot>(`${target}/snapshot`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        if (JSON.stringify(value.app.producing) !== JSON.stringify(app.producing) || value.app.attachmentId !== app.attachmentId) throw new Error("App producing identity changed.");
        if (first) { first = false; setSnapshot(value); setError(undefined); }
      } catch (cause) {
        if (abort.signal.aborted) return;
        hostRef.current?.dispose(); setInvalid(true); setMode("inline"); setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 15_000);
    const onRestart = (event: Event) => {
      if ((event as CustomEvent<{ threadId: string }>).detail?.threadId !== app.producing.threadId) return;
      hostRef.current?.dispose(); setInvalid(true); setMode("inline"); setError(t("原生 session 已重启，此 App 已失效。", "The native session restarted; this App is no longer valid."));
    };
    window.addEventListener("agent-native-session-restarted", onRestart);
    return () => { abort.abort(); clearInterval(timer); window.removeEventListener("agent-native-session-restarted", onRestart); };
  }, [targetKey, bound, ready, closed, invalid, generation, threadRunning]);

  useEffect(() => {
    if (bound || state.loading || state.providersLoading) return;
    hostRef.current?.dispose(); setInvalid(true); setMode("inline");
    setError(t("App 的作用域、Provider 或 session 已改变。历史工具文本仍可阅读。", "This App's scope, provider or session changed. Historical tool text remains readable."));
  }, [bound, state.loading, state.providersLoading]);

  useEffect(() => {
    const note = () => { lastPageInputAt.current = performance.now(); };
    const types = ["pointerdown", "pointerup", "touchend", "keydown"] as const;
    for (const type of types) window.addEventListener(type, note, true);
    return () => { for (const type of types) window.removeEventListener(type, note, true); };
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !fullscreenSupported) return;
    if (mode === "fullscreen" && !box.matches(":popover-open")) box.showPopover();
    if (mode !== "fullscreen" && box.matches(":popover-open")) box.hidePopover();
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setMode("inline"); };
    const resize = () => hostRef.current?.updateHostContext();
    const focus = (event: FocusEvent) => { if (mode === "fullscreen" && event.target instanceof Node && !box.contains(event.target)) setMode("inline"); };
    window.addEventListener("keydown", onKey); window.addEventListener("resize", resize); document.addEventListener("focusin", focus);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("resize", resize); document.removeEventListener("focusin", focus); if (box.matches(":popover-open")) box.hidePopover(); };
  }, [mode, snapshot]);

  // Install the one-use port listener during commit, before any injected document script can post.
  useLayoutEffect(() => {
    if (!snapshot || !documentBinding || !bound || !ready || closed || invalid) return;
    const abort = new AbortController();
    let alive = true;
    loads.current = 0;
    const assertLive = () => { if (!alive || !latest.current.bound || abort.signal.aborted) throw new McpAppHostRefusal("This App is no longer active."); };
    const request = async <T,>(suffix: string, body?: unknown): Promise<T> => {
      assertLive();
      try {
        const value = await workspaceClient.json<T>(`${target}/${suffix}`, { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
        assertLive(); return value;
      } catch (cause) {
        if (cause instanceof WorkspaceClientError && [401, 403, 404, 409, 410].includes(cause.status)) { hostRef.current?.dispose(); setInvalid(true); setMode("inline"); }
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
        throw new McpAppHostRefusal(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const ask = async (message: string) => {
      assertLive(); flushSync(() => setMode("inline"));
      const answer = window.confirm(message); assertLive(); return answer;
    };
    const host = makeMcpAppHost({
      app, hostVersion: "4",
      post: message => { if (alive) documentBridge?.post(message); },
      hostContext: () => {
        const current = latest.current;
        const style = getComputedStyle(document.documentElement);
        const variables = Object.fromEntries(["--background", "--card", "--muted", "--foreground", "--muted-foreground", "--border", "--input", "--ring", "--font-sans", "--font-mono", "--radius"].map(name => [name, style.getPropertyValue(name).trim()]));
        return { theme: current.theme, styles: { variables: mcpAppStyleVariables(variables) }, displayMode: current.mode, availableDisplayModes: fullscreenSupported ? ["inline", "fullscreen"] : ["inline"], containerDimensions: current.mode === "fullscreen" ? { width: frameRef.current?.clientWidth || innerWidth, height: frameRef.current?.clientHeight || innerHeight } : { width: current.width, maxHeight: MCP_APP_MAX_HEIGHT }, platform: "web", locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, userAgent: "project-management-agent/4", deviceCapabilities: { touch: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches }, ...(current.toolDefinition === undefined ? {} : { toolInfo: { tool: current.toolDefinition } }) };
      },
      callTool: async ({ name, arguments: args }) => {
        const { tools } = await request<McpAppToolsResult>("tools");
        const info = tools.find(tool => tool.name === name);
        if (!info?.callable) throw new McpAppHostRefusal("This App cannot call that tool.");
        if (!info.readOnly && !await ask(t(`允许 ${app.server} 执行 ${info.title ?? name}？\n${JSON.stringify(args, null, 2)}`, `Allow ${app.server} to run ${info.title ?? name}?\n${JSON.stringify(args, null, 2)}`))) throw new McpAppHostRefusal("Declined by the user.");
        return request<McpAppToolResult>("call", { name, arguments: args });
      },
      readResource: ({ uri }) => request<McpAppResourceResult>("resource", { uri }),
      updateModelContext: async context => { await request("context", context); },
      openLink: async value => {
        assertLive();
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || document.activeElement !== frameRef.current || !navigator.userActivation?.isActive || performance.now() - lastPageInputAt.current < PAGE_ACTIVATION_MS) throw new McpAppHostRefusal("Links open only from a click in this App.");
        window.open(url.href, "_blank", "noopener,noreferrer");
      },
      sendMessage: async text => {
        if (!await ask(t(`明确发送此 App 消息并运行模型？\n${text}`, `Send this App message and run the model?\n${text}`))) throw new McpAppHostRefusal("Declined by the user.");
        assertLive();
        const current = latest.current;
        const thread = current.state.threads.get(current.remoteId ?? "");
        const runtime = aui.thread.getState();
        if (!thread || runtime.isRunning || runtime.isLoading || runtime.isDisabled || runtime.isSendDisabled || !canSendThread(current.localId, current.remoteId, thread.settings.providerInstanceId, thread.settings.model, thread.settings.modelOptions)) throw new McpAppHostRefusal("Messages are not available in this session.");
        aui.thread.append({ role: "user", content: [{ type: "text", text }] });
      },
      requestDisplayMode: async next => {
        assertLive();
        const another = document.querySelector("[data-mcp-app-fullscreen]");
        if (next === "fullscreen" && (document.activeElement !== frameRef.current || !navigator.userActivation?.isActive || performance.now() - lastPageInputAt.current < PAGE_ACTIVATION_MS || document.querySelector("[role='dialog'],[aria-modal='true']") || another && another !== boxRef.current)) return latest.current.mode;
        setMode(next); return next;
      },
      downloadFile: async files => {
        if (!await ask(t(`保存来自 ${app.server} 的文件：${files.map(file => file.name).join(", ")}？`, `Save files from ${app.server}: ${files.map(file => file.name).join(", ")}?`))) throw new McpAppHostRefusal("Declined by the user.");
        let total = 0;
        for (const file of files) {
          assertLive();
          const content = file._tag === "link" ? (await request<McpAppResourceResult>("resource", { uri: file.uri })).contents[0] : undefined;
          const bytes = file._tag === "embedded" ? file.bytes : mcpResourceBytes(content);
          if (!bytes) throw new McpAppHostRefusal(`${file.name} has no contents.`);
          total += bytes.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) throw new McpAppHostRefusal("Download exceeds 25 MiB.");
          const declared = content && typeof content === "object" && "mimeType" in content && typeof content.mimeType === "string" ? content.mimeType : undefined;
          saveBlob(new Blob([bytes.slice()], { type: declared ?? file.mimeType ?? "application/octet-stream" }), file.name);
        }
      },
      onRequestTeardown: () => { if (latest.current.mode === "fullscreen") setMode("inline"); else void host.teardown().then(() => { if (alive) setClosed(true); }); },
      onSizeChanged: size => { if (latest.current.mode !== "fullscreen" && size.height !== undefined) setHeight(clampMcpAppHeight(size.height)); },
    });
    const documentBridge = makeMcpAppDocumentBridge({
      capability: documentBinding.capability,
      source: () => frameRef.current?.contentWindow ?? null,
      receive: message => { if (alive) host.receive(message); },
      invalidated: () => {
        alive = false; abort.abort(); host.dispose();
        setInvalid(true); setMode("inline");
        setError(t("App 原始文档已离开或无法证明仍然有效，交互已停止。", "The original App document left or could no longer attest its identity; interaction stopped."));
      },
    });
    documentBridgeRef.current = documentBridge;
    hostRef.current = host;
    host.setToolCall({ arguments: snapshot.toolInput, result: snapshot.toolResult });
    void request<McpAppToolsResult>("tools").then(value => { if (alive) setToolDefinition(value.tools.find(tool => tool.name === app.tool)?.tool); }).catch(() => {});
    const receive = (event: MessageEvent) => documentBridge?.receive(event);
    window.addEventListener("message", receive);
    return () => {
      alive = false; abort.abort(); documentBridge?.dispose(); host.dispose();
      window.removeEventListener("message", receive);
      if (documentBridgeRef.current === documentBridge) documentBridgeRef.current = null;
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [snapshot, documentBinding, targetKey, bound, ready, closed, invalid]);

  useEffect(() => { hostRef.current?.updateHostContext(); }, [theme, width, mode, toolDefinition]);
  const close = () => { setMode("inline"); void (hostRef.current?.teardown() ?? Promise.resolve()).then(() => setClosed(true)); };
  if (closed) return <div className="mcp-app-notice">{t("App 已关闭。", "App closed.")}<button type="button" onClick={() => { setSnapshot(undefined); setClosed(false); setInvalid(false); setGeneration(value => value + 1); }}>{t("重新读取 App", "Reopen App")}</button></div>;
  if (invalid || error && !snapshot) return <p className="mcp-app-notice" role="alert">{error ?? t("App 已失效，历史输出保留。", "App is no longer active; historical output is preserved.")}</p>;
  if (generationStatus === "queued" || generationStatus === "running") return <p role="status">{t("原生工具已返回，等待本轮完成后连接 App。", "The native tool returned; waiting for this turn to complete before connecting the App.")}</p>;
  if (!ready) return <p className="mcp-app-notice" role="alert">{t("产生此 App 的运行未成功完成，交互不可用。历史工具文本仍可阅读。", "The producing turn did not complete successfully; App interaction is unavailable. Historical tool text remains readable.")}</p>;
  if (capturedDocument.error) return <p className="mcp-app-notice" role="alert">{capturedDocument.error}</p>;
  if (!snapshot || !documentBinding) return <p role="status">{t("正在读取私有 MCP App…", "Loading private MCP App…")}</p>;
  return <section className="mcp-app-row" style={{ height: height + 34 }} aria-label={`${app.server} App`}>
    <div ref={boxRef} {...(fullscreenSupported ? { popover: "manual" as const } : {})} data-mcp-app-fullscreen={mode === "fullscreen" ? "" : undefined} className="mcp-app-box" data-border={app.prefersBorder === true}>
      <header><strong>{app.server}</strong><span>{mode === "fullscreen" ? <button type="button" onClick={() => setMode("inline")}>{t("退出全屏", "Exit fullscreen")}</button> : fullscreenSupported && <button type="button" onClick={() => setMode("fullscreen")}>{t("全屏", "Fullscreen")}</button>}<button type="button" onClick={close}>{t("关闭 App", "Close App")}</button></span></header>
      <iframe ref={frameRef} srcDoc={documentBinding.html} title={`${app.server} App`} sandbox="allow-scripts allow-forms" allow={mcpAppAllowAttribute(app.permissions)} referrerPolicy="no-referrer" onLoad={() => { loads.current += 1; if (loads.current > 1) documentBridgeRef.current?.invalidate(); }} style={{ colorScheme: theme }} />
      {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
