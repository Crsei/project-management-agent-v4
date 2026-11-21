import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n-provider";
import {
  Bell, Brain, ChevronsDown, Circle, CircleAlert, CircleCheck, CircleDot, CircleX,
  Copy, FileCode, GitBranch, Globe, ListTodo, Maximize2, MessageSquare, Minimize2, RefreshCw,
  Route, Search, ShieldQuestion, Terminal as TerminalIcon, Wrench,
} from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { useTheme } from "@agent/hooks/use-theme";
import { Markdown } from "./markdown";
import type { AgentOutputSnapshot, GenerationOutputStatus, NativeOutputItem } from "@agent-workspace/contracts/output";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, TERMINAL_PALETTES, terminalOutputPlainText, terminalOutputSpans } from "@agent-workspace/contracts/terminal-output";
import { subscribeCommand, useGenerationOutput } from "./output-stream";
import { PmToolCard, type PmToolRecord } from "./pm-tool-card";
import { usePmToolCalls } from "./pm-tool-calls";
import { useAgentText, type AgentText } from "../i18n";
import { McpAppFrame } from "./mcp-app-frame";
import { CodeBlock, ShellCommandBlock, Trace, TraceLine, TraceRow } from "./execution-trace";
import { assistantMessageKind, canRespondToInteraction, commandText, createOutputDisclosureStore, generationIndicator, generationWorkState, isCompletedAutoApproval, isGenerationActive, isItemActive, latestReasoning, presentOutputItems, reliableDurationMs, requiresVisibleDetails, semanticToolSummary, type GenerationWorkState, type OutputPresentationRow, type ToolSummary } from "./output-presenter";
import { NativeInteraction } from "./native-interaction";
import { useComposerRequestPanelMounted } from "./composer-pending-requests";
import { ChangedFilesSummary, FileChanges } from "./native-file-changes";
import { NativePlanCard } from "./native-plan-card";
import { NativeSubagentLink } from "./native-subagent-link";
import { ItemInspectorButton } from "./item-inspector";
import "./output-timeline.css";
import { useAuiState } from "@assistant-ui/react";
import { useMessageContextDraft } from "./message-context";
import { NativeOutputContext, NativeOutputContextAction, useNativeOutputContextSource } from "./native-output-context";
import { nativeContextSourceAnchor } from "./context-source-navigation";

const labels = (t: AgentText): Record<NativeOutputItem["type"], string> => ({
  assistant_message: t("回复", "Reply"), reasoning: t("思考", "Thinking"), command_execution: t("命令", "Command"), file_change: t("文件变更", "File change"), file_search: t("文件搜索", "File search"), web_search: t("网页搜索", "Web search"), dynamic_tool: t("工具", "Tool"), todo_list: t("待办", "To-do"), proposed_plan: t("计划", "Plan"), subagent: t("子代理", "Subagent"), approval_request: t("审批", "Approval"), user_input_request: t("需要回答", "Input needed"), notification: t("通知", "Notification"), error: t("错误", "Error"), compaction: t("上下文压缩", "Compaction"),
});
function safeUrl(value?: string) {
  // oxlint-disable-next-line no-control-regex -- reject ambiguous/control-bearing provider URLs before URL parsing.
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}
function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}
function Duration({ item, generationStatus }: { item: NativeOutputItem; generationStatus: GenerationOutputStatus }) {
  const [now, setNow] = useState(Date.now());
  const running = item.timing?.source === "provider" && isItemActive(item) && isGenerationActive(generationStatus) && !item.completedAt;
  useEffect(() => { if (!running || !item.startedAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running, item.startedAt]);
  const duration = reliableDurationMs(item, generationStatus, now);
  return duration === undefined ? null : <span>{duration < 100 ? "<0.1" : (duration / 1000).toFixed(1)}s</span>;
}
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
/** Bottom-of-turn activity line. The ticking number is never used for provider claims. */
function WorkingRow({ state }: { state: GenerationWorkState }) {
  const t = useAgentText();
  const [now, setNow] = useState(Date.now());
  const startedAt = state.kind === "working" ? state.startedAt : undefined;
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt ? Math.max(0, now - Date.parse(startedAt)) : undefined;
  const label = state.kind === "queued" ? t("等待运行…", "Queued…") : state.kind === "compacting" ? t("正在压缩上下文…", "Compacting…") : t("正在工作", "Working");
  return <div className="native-working-row" data-state={state.kind}>
    <span role="status" className="sr-only">{label}</span>
    <span aria-hidden="true" className="native-working-label">
      <span className="native-shimmer">{label}</span>
      {elapsed !== undefined && <span className="native-working-elapsed"> · {formatElapsed(elapsed)}</span>}
    </span>
  </div>;
}
function CommandOutput({ generationId, item }: { generationId: string; item: NativeOutputItem }) {
  const t = useAgentText();
  const { theme } = useTheme();
  const viewport = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(!!item.outputTruncated);
  const [copyError, setCopyError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const output = useRef(EMPTY_TERMINAL_OUTPUT);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [follow, text]);
  useEffect(() => {
    setReady(false);
    setText("");
    output.current = EMPTY_TERMINAL_OUTPUT;
    const controller = new AbortController();
    let retry: number | undefined;
    let running = true;
    const connect = async () => {
      try {
        await subscribeCommand(generationId, item.id, controller.signal, (frame) => {
          setError(undefined); setTruncated(frame.truncated); running = frame.running;
          output.current = appendTerminalOutput(frame.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : output.current, frame.text);
          setText(output.current.text);
          setReady(true);
        });
        if (running) throw new Error(t("命令输出流已断开，正在重新连接。", "Command output stream disconnected, reconnecting."));
      } catch (cause) {
        if (!controller.signal.aborted) {
          output.current = EMPTY_TERMINAL_OUTPUT;
          setText(""); setReady(false);
          setError(cause instanceof Error ? cause.message : String(cause));
          retry = window.setTimeout(() => void connect(), 1000);
        }
      }
    };
    void connect();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [generationId, item.id, t]);
  const copy = async () => {
    if (!ready) return;
    try {
      if (!navigator.clipboard) throw new Error(t("浏览器未提供剪贴板权限。", "Clipboard access is not available in this browser."));
      await navigator.clipboard.writeText(terminalOutputPlainText(output.current.text));
      setCopyError(undefined);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (cause) { setCopyError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="native-command-output" data-expanded={expanded || undefined}>
    <div className="native-command-toolbar">
      <Button size="icon-xs" variant="ghost" aria-label={t("复制输出", "Copy output")} title={copied ? t("已复制", "Copied") : t("复制输出", "Copy output")} disabled={!ready} onClick={() => void copy()}>
        {copied ? <CircleCheck aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label={follow ? t("停止贴底跟随", "Stop following output") : t("贴底跟随输出", "Follow output")} title={follow ? t("正在贴底跟随", "Following output") : t("贴底跟随", "Follow output")} aria-pressed={follow} data-active={follow || undefined} onClick={() => setFollow(value => !value)}>
        <ChevronsDown aria-hidden="true" />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label={expanded ? t("收起输出面板", "Collapse output panel") : t("展开输出面板", "Expand output panel")} title={expanded ? t("收起输出面板", "Collapse output panel") : t("展开输出面板", "Expand output panel")} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </Button>
    </div>
    <div ref={viewport} className="native-terminal-viewport" aria-label={t("命令终端输出", "Command terminal output")}
      onScroll={event => {
        const element = event.currentTarget;
        setFollow(element.scrollHeight - element.scrollTop - element.clientHeight <= 8);
      }}>
      {text
        ? terminalOutputSpans(text, TERMINAL_PALETTES[theme]).map((span, index) =>
          span.style === null ? span.text : <span key={index} style={span.style}>{span.text}</span>)
        : !ready && !error && <span className="native-output-placeholder">{t("等待输出…", "Waiting for output…")}</span>}
    </div>
    {(truncated || item.outputTruncated) && <p className="native-output-truncated">{t("更早的输出未显示。", "Earlier output not shown.")}</p>}
    {error && <p role="alert">{t("输出连接中断：", "Output connection interrupted: ")}{error}</p>}
    {copied && <span role="status" className="sr-only">{t("已复制", "Copied")}</span>}
    {copyError && <span role="alert">{t("复制失败：", "Copy failed: ")}{copyError}</span>}
  </div>;
}
// assistant-ui replaces live output with authoritative history at finish.
const disclosures = createOutputDisclosureStore();
function useOutputDisclosure(generationId: string, items: NativeOutputItem[], defaultOpen: boolean, group = false) {
  const rowKeys = items.map(item => JSON.stringify([generationId, item.id]));
  const keys = group ? rowKeys.map(key => `group:${key}`) : rowKeys;
  const [localOpen, setOpen] = useState<boolean | undefined>(undefined);
  const fallback = localOpen ?? defaultOpen;
  const open = disclosures.read(keys, group ? disclosures.read(rowKeys, fallback) : fallback);
  const change = (next: boolean) => { disclosures.set(keys, next); setOpen(next); };
  return [open, change] as const;
}
function traceStatusFor(status: NativeOutputItem["status"]): "running" | "error" | "pending" | undefined {
  if (status === "failed" || status === "interrupted") return "error";
  if (status === "running") return "running";
  if (status === "pending" || status === "waiting") return "pending";
  return undefined;
}
function outputIcon(type: NativeOutputItem["type"]) {
  switch (type) {
    case "assistant_message": return <MessageSquare aria-hidden="true" />;
    case "reasoning": return <Brain aria-hidden="true" />;
    case "command_execution": return <TerminalIcon aria-hidden="true" />;
    case "file_change": return <FileCode aria-hidden="true" />;
    case "file_search": return <Search aria-hidden="true" />;
    case "web_search": return <Globe aria-hidden="true" />;
    case "dynamic_tool": return <Wrench aria-hidden="true" />;
    case "todo_list": return <ListTodo aria-hidden="true" />;
    case "proposed_plan": return <Route aria-hidden="true" />;
    case "subagent": return <GitBranch aria-hidden="true" />;
    case "approval_request":
    case "user_input_request": return <ShieldQuestion aria-hidden="true" />;
    case "notification": return <Bell aria-hidden="true" />;
    case "error": return <CircleAlert aria-hidden="true" />;
    case "compaction": return <RefreshCw aria-hidden="true" />;
  }
}
function toolActionLabels(t: AgentText): Record<ToolSummary["action"], string> {
  return { read: t("读取", "Read"), edit: t("编辑", "Edit"), search: t("搜索", "Search"), web: t("网页搜索", "Web search"), command: t("执行命令", "Command"), tool: t("工具调用", "Tool"), subagent: t("子代理", "Subagent"), approval: t("已自动批准", "Auto-approved") };
}
function toolTitle(item: NativeOutputItem, t: AgentText) {
  const summary = semanticToolSummary(item);
  return <span className="native-tool-summary"><span className="native-tool-action">{toolActionLabels(t)[summary.action]}</span>{summary.target && <span className="native-tool-target" title={summary.target}>{summary.target}</span>}</span>;
}
function toolGroupTitle(items: NativeOutputItem[], t: AgentText) {
  const counts = new Map<ToolSummary["action"], number>();
  for (const item of items) { const action = semanticToolSummary(item).action; counts.set(action, (counts.get(action) ?? 0) + 1); }
  const names = toolActionLabels(t);
  return [...counts].map(([action, count]) => `${names[action]} ${count}`).join(" · ");
}
function OutputInteraction({ generationId, item, generationStatus }: { generationId: string; item: NativeOutputItem; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const composerMounted = useComposerRequestPanelMounted(generationId);
  return canRespondToInteraction(item, generationStatus) && composerMounted
    ? <a className="native-request-location" href={`#native-requests-${generationId}`}>{t("等待你的响应 — 在输入框上方回答", "Awaiting your response — answer above the composer")}</a>
    : <NativeInteraction key={item.request?.id ?? item.id} generationId={generationId} item={item} generationStatus={generationStatus} />;
}
const OutputRow = memo(function OutputRow({ item, generationId, generationStatus, parentIds }: { item: NativeOutputItem; generationId: string; generationStatus: GenerationOutputStatus; parentIds: ReadonlySet<string> }) {
  const t = useAgentText();
  const { locale } = useI18n();
  const markdownLocale = locale === "en" ? "en" : "zh-CN";
  const visible = requiresVisibleDetails(item) || item.type === "proposed_plan";
  const [open, change] = useOutputDisclosure(generationId, [item], visible || (isGenerationActive(generationStatus) && isItemActive(item)));
  useNativeOutputContextSource(generationId, [item.id], change);
  const sourceId = nativeContextSourceAnchor(generationId, item.id);
  // Child items carry provider parent references; indent only when that parent is rendered here.
  const parented = !!item.parentItemId && item.parentItemId !== item.id && parentIds.has(item.parentItemId);
  const inspector = <ItemInspectorButton item={item} generationId={generationId} generationStatus={generationStatus} />;
  if (item.visibility === "redacted" || item.visibility === "unavailable") {
    return <div id={sourceId} className="native-output-card" data-visibility={item.visibility} role="status">
      {item.visibility === "redacted" ? t("内容已不可访问。", "This content is no longer accessible.") : t("暂时无法核验内容访问权限。", "Content access cannot be verified right now.")}
    </div>;
  }
  if (item.type === "assistant_message") {
    const kind = assistantMessageKind(item);
    return <div id={sourceId} className={`native-answer${kind === "progress" ? " native-progress" : ""}`} data-phase={item.phase ?? "unknown"}>
      {kind === "progress" && <span className="native-progress-label">{t("进度更新", "Progress update")}</span>}
      <Markdown content={item.text ?? ""} locale={markdownLocale} streaming={item.streaming === true && isGenerationActive(generationStatus)} />
      <div className="native-answer-actions"><NativeOutputContextAction item={item} generationId={generationId} settled={!isGenerationActive(generationStatus)} />{inspector}</div>
      {item.error && <p role="alert" className="native-error">{item.error}</p>}
    </div>;
  }
  const semantic = ["command_execution", "file_change", "file_search", "web_search", "dynamic_tool", "subagent"].includes(item.type) || isCompletedAutoApproval(item);
  const title = semantic ? toolTitle(item, t) : item.title || item.request?.title || item.toolName || labels(t)[item.type];
  const ended = !isGenerationActive(generationStatus) && isItemActive(item);
  const status = ended ? undefined : traceStatusFor(item.status);
  const meta = <>
    <Duration item={item} generationStatus={generationStatus} />
    {item.exitCode !== undefined && <span> · exit {item.exitCode}</span>}
    {item.type === "file_change" && (item.additions !== undefined || item.deletions !== undefined) && <span>{item.additions !== undefined && ` · +${item.additions}`}{item.deletions !== undefined && ` · −${item.deletions}`}</span>}
  </>;
  const body = <>
    <NativeOutputContextAction item={item} generationId={generationId} settled={!isGenerationActive(generationStatus)} />
    {item.status === "unknown" && <p role="status">{t("业务结果尚未确认；只能核对原操作，不能重复执行。", "The business outcome is unconfirmed. Reconcile the original operation; do not execute it again.")}</p>}
    {item.type === "reasoning" && <div className="native-prose"><Markdown content={item.text ?? ""} locale={markdownLocale} streaming={item.streaming === true && isGenerationActive(generationStatus)} /></div>}
    {item.type === "command_execution" && (open || visible) && <>{commandText(item) && <div className="native-command-input"><ShellCommandBlock command={commandText(item)!} /></div>}<CommandOutput generationId={generationId} item={item} /></>}
    {item.type === "file_change" && <FileChanges item={item} />}
    {(item.type === "file_search" || item.type === "web_search") && <>{item.text && <p>{item.text}</p>}{item.input !== undefined && <CodeBlock code={printable(item.input)} wrap />}{item.output && <CodeBlock code={item.output} wrap />}<ul>{item.results?.map((result, index) => { const url = safeUrl(result.url); return <li key={index}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{result.title || url}</a> : <strong>{result.title || result.path || result.url || t("结果", "Result")}</strong>}{result.path && <span> {result.path}{result.line !== undefined ? `:${result.line}` : ""}</span>}{result.text && <p>{result.text}</p>}</li>; })}</ul></>}
    {item.type === "dynamic_tool" && <>{item.input !== undefined && <><b>{t("输入", "Input")}</b><CodeBlock code={printable(item.input)} wrap /></>}{item.output !== undefined && <><b>{t("输出", "Output")}</b><CodeBlock code={item.output} wrap /></>}{item.text && <p>{item.text}</p>}</>}
    {item.type === "todo_list" && <>{item.text && <Markdown content={item.text} locale={markdownLocale} />}{item.steps && <Trace nested>{item.steps.map(step => <TraceLine key={step.id} icon={step.status === "completed" ? <CircleCheck aria-hidden="true" /> : step.status === "running" ? <CircleDot aria-hidden="true" /> : step.status === "cancelled" ? <CircleX aria-hidden="true" /> : <Circle aria-hidden="true" />} title={step.text} status={step.status === "completed" ? undefined : step.status === "running" ? "running" : "pending"} />)}</Trace>}</>}
    {item.type === "proposed_plan" && <NativePlanCard key={item.id} item={item} generationId={generationId} generationStatus={generationStatus} />}
    {item.type === "subagent" && <><NativeSubagentLink generationId={generationId} item={item} />{item.text && <p>{item.text}</p>}{item.output && <CodeBlock code={item.output} wrap />}</>}
    {(item.type === "approval_request" || item.type === "user_input_request") && <OutputInteraction generationId={generationId} item={item} generationStatus={generationStatus} />}
    {(item.type === "notification" || item.type === "error" || item.type === "compaction") && <>{item.text && <p>{item.text}</p>}{item.output && <CodeBlock code={item.output} wrap />}{item.input !== undefined && <CodeBlock code={printable(item.input)} wrap />}</>}
    {item.error && <p role="alert" className="native-error">{item.error}</p>}
  </>;
  if (visible) return <section id={sourceId} className={`native-visible-details native-${item.type}${parented ? " native-parented" : ""}`}>
    <div className="native-visible-header"><TraceLine icon={outputIcon(item.type)} title={title} description={meta} status={status} />{inspector}</div>
    {item.mcpApp && <McpAppFrame key={JSON.stringify(item.mcpApp.producing)} app={item.mcpApp} generationStatus={generationStatus} />}
    <div className="native-card-body">{body}</div>
  </section>;
  return <div id={sourceId} className={parented ? "native-parented" : undefined}><TraceRow
    className={`native-${item.type}${isGenerationActive(generationStatus) && isItemActive(item) ? " native-active-tool" : ""}`}
    icon={outputIcon(item.type)}
    title={title}
    description={meta}
    status={status}
    open={open}
    onOpenChange={change}
    actions={inspector}
  >
    {item.mcpApp && <McpAppFrame key={JSON.stringify(item.mcpApp.producing)} app={item.mcpApp} generationStatus={generationStatus} />}
    <div className="native-card-body">{body}</div>
  </TraceRow></div>;
});
function OutputGroup({ row, generationId, generationStatus, parentIds }: { row: Extract<OutputPresentationRow, { kind: "reasoning" | "tools" }>; generationId: string; generationStatus: GenerationOutputStatus; parentIds: ReadonlySet<string> }) {
  const t = useAgentText();
  const { locale } = useI18n();
  const [open, change] = useOutputDisclosure(generationId, row.items, false, true);
  useNativeOutputContextSource(generationId, row.items.map(item => item.id), change, row.kind === "reasoning");
  const active = isGenerationActive(generationStatus) && row.items.some(isItemActive);
  const thought = row.kind === "reasoning" ? latestReasoning(row.items) : undefined;
  const detailsRef = useRef<HTMLDivElement>(null);
  const followLive = useRef(true);
  // Follow live provider output only while the group is open and the reader stays at the bottom.
  useLayoutEffect(() => { if (open) followLive.current = true; }, [open]);
  useLayoutEffect(() => {
    if (!open || !active || !followLive.current || !detailsRef.current) return;
    detailsRef.current.scrollTop = detailsRef.current.scrollHeight;
  }, [open, active, row.items]);
  if (row.kind === "tools" && row.items.length === 1) return <OutputRow item={row.items[0]!} generationId={generationId} generationStatus={generationStatus} parentIds={parentIds} />;
  const counts = {
    completed: row.items.filter(item => item.status === "completed").length,
    running: isGenerationActive(generationStatus) ? row.items.filter(item => item.status === "running").length : 0,
    pending: isGenerationActive(generationStatus) ? row.items.filter(item => item.status === "pending").length : 0,
    cancelled: row.items.filter(item => item.status === "cancelled").length,
  };
  const title = row.kind === "reasoning"
    ? <span className="native-reasoning-summary"><span className="native-activity-label">{thought?.streaming ? <span className="native-shimmer">{t("正在思考", "Thinking")}</span> : t("思考", "Thought")}</span>{thought?.preview && <span className="native-reasoning-preview">{thought.preview}</span>}</span>
    : toolGroupTitle(row.items, t);
  const summary = row.kind === "tools"
    ? [counts.running && t(`${counts.running} 进行中`, `${counts.running} running`), counts.pending && t(`${counts.pending} 待处理`, `${counts.pending} pending`), counts.completed && t(`${counts.completed} 已完成`, `${counts.completed} completed`), counts.cancelled && t(`${counts.cancelled} 已取消`, `${counts.cancelled} cancelled`)].filter(Boolean).join(" · ")
    : active ? t("进行中", "Running") : undefined;
  return <TraceRow className={`native-activity-group native-${row.kind}-group`} icon={row.kind === "reasoning" ? <Brain aria-hidden="true" /> : <Wrench aria-hidden="true" />} title={title} trailing={summary && <span className="native-group-counts">{summary}</span>} status={active ? "running" : undefined} open={open} onOpenChange={change}>
    <div ref={detailsRef} className="native-group-details" data-live={active || undefined} onScroll={event => {
      const node = event.currentTarget;
      followLive.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    }}>
      {row.kind === "reasoning" ? row.items.map(item => <div key={item.id} id={nativeContextSourceAnchor(generationId, item.id)} className="native-prose native-reasoning-part"><Markdown content={item.text ?? ""} locale={locale === "en" ? "en" : "zh-CN"} streaming={item.streaming === true && isGenerationActive(generationStatus)} /><NativeOutputContextAction item={item} generationId={generationId} settled={!isGenerationActive(generationStatus)} /><Duration item={item} generationStatus={generationStatus} /></div>) : <Trace nested>{row.items.map(item => <OutputRow key={item.id} item={item} generationId={generationId} generationStatus={generationStatus} parentIds={parentIds} />)}</Trace>}
    </div>
  </TraceRow>;
}

/** Props-only consumer seam for isolated browser harnesses; no scenario data or network fallback. */
export function OutputTimelineView({ snapshot, error, calls = [], callsError, onUpdateCall }: { snapshot?: AgentOutputSnapshot; error?: string; calls?: PmToolRecord[]; callsError?: string; onUpdateCall: (record: PmToolRecord) => void }) {
  const t = useAgentText();
  const rows = useMemo(() => presentOutputItems(snapshot?.items ?? [], calls.map(call => call.operationId)), [snapshot?.items, calls]);
  const records = new Map(calls.map(call => [call.operationId, call]));
  const parentIds = useMemo(() => new Set((snapshot?.items ?? []).map(item => item.id)), [snapshot?.items]);
  const rendered = new Set(rows.filter(row => row.kind === "pm_tool").map(row => row.operationId));
  const indicator = snapshot && generationIndicator(snapshot.status, snapshot.items);
  const work = snapshot ? generationWorkState(snapshot.status, snapshot.items) : undefined;
  const indicatorText = indicator === "queued" ? t("等待运行", "Queued") : indicator === "processing" ? t("正在处理…", "Processing…") : indicator === "failed" ? t("运行失败", "Run failed") : indicator === "cancelled" ? t("运行已取消", "Run cancelled") : t("运行已中断", "Run interrupted");
  return <div className="native-timeline" aria-label={t("运行输出时间线", "Run output timeline")}>
    {error && <p role="alert">{t("输出连接：", "Output connection: ")}{error}</p>}
    {callsError && <p role="alert">{t("PM 工具记录读取失败：", "Failed to load PM tool records: ")}{callsError}</p>}
    {!snapshot && !error && <p role="status">{t("正在加载运行输出…", "Loading run output…")}</p>}
    {snapshot && rows.map(row => {
      if (row.kind === "pm_tool") {
        const record = records.get(row.operationId);
        return record ? <PmToolCard key={row.key} record={record} onUpdate={onUpdateCall} /> : <section key={row.key} className="native-output-card"><header><strong>{row.item.toolName || t("PM 工具", "PM tool")}</strong><span>{callsError ? t("记录不可用", "Records unavailable") : t("正在读取操作记录…", "Loading operation records…")}</span></header></section>;
      }
      return row.kind === "item" ? <OutputRow key={row.key} item={row.item} generationId={snapshot.generationId} generationStatus={snapshot.status} parentIds={parentIds} /> : <OutputGroup key={row.key} row={row} generationId={snapshot.generationId} generationStatus={snapshot.status} parentIds={parentIds} />;
    })}
    {calls.filter(call => !rendered.has(call.operationId)).map(call => <PmToolCard key={`pm:${call.operationId}`} record={call} onUpdate={onUpdateCall} />)}
    {snapshot && <ChangedFilesSummary items={snapshot.items} storageKey={`${snapshot.threadId}:${snapshot.generationId}`} />}
    {work ? <WorkingRow state={work} /> : indicator && <div className="native-system-divider" data-tone={indicator === "failed" ? "error" : indicator === "interrupted" ? "warning" : undefined} role={indicator === "failed" ? "alert" : "status"}>
      <span aria-hidden="true" />
      <span>{indicatorText}</span>
      <span aria-hidden="true" />
    </div>}
  </div>;
}

export function OutputTimeline({ generationId }: { generationId: string }) {
  const { snapshot, error } = useGenerationOutput(generationId);
  const draft = useMessageContextDraft();
  const messageId = useAuiState(state => state.optional.message?.id);
  const toolCalls = usePmToolCalls();
  const calls = useMemo(() => toolCalls?.items.filter(call => call.generationId === generationId) ?? [], [toolCalls?.items, generationId]);
  const refreshCalls = toolCalls?.refresh;
  const pmOutputVersion = JSON.stringify(snapshot?.items.filter(item => item.id.startsWith("pm-tool:")).map(item => [item.id, item.status, item.output]) ?? []);
  useEffect(() => { if (pmOutputVersion !== "[]") refreshCalls?.(); }, [refreshCalls, pmOutputVersion]);
  return <NativeOutputContext.Provider value={snapshot && messageId ? { draft, threadId: snapshot.threadId, messageId } : null}><OutputTimelineView snapshot={snapshot} error={error} calls={calls} callsError={toolCalls?.error} onUpdateCall={record => toolCalls?.update(record)} /></NativeOutputContext.Provider>;
}
