import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { MultiFileDiff } from "@pierre/diffs/react";
import {
  Bell, Brain, Circle, CircleAlert, CircleCheck, CircleDot, CircleX,
  Copy, FileCode, GitBranch, Globe, ListTodo, MessageSquare, RefreshCw,
  Route, Search, ShieldQuestion, Terminal as TerminalIcon, Wrench,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@agent/components/ui/button";
import { Markdown } from "./markdown";
import type { AgentOutputSnapshot, GenerationOutputStatus, NativeInteractionResponse, NativeOutputItem } from "@agent-workspace/contracts/output";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, terminalOutputPlainText } from "@agent-workspace/contracts/terminal-output";
import { workspaceClient } from "../network";
import { subscribeCommand, useGenerationOutput } from "./output-stream";
import { PmToolCard, type PmToolRecord } from "./pm-tool-card";
import { usePmToolCalls } from "./pm-tool-calls";
import { useAgentText, type AgentText } from "../i18n";
import { McpAppFrame } from "./mcp-app-frame";
import { CodeBlock, Trace, TraceLine, TraceRow, TraceStatusBadge } from "./execution-trace";
import { assistantMessageKind, canRespondToInteraction, createOutputDisclosureStore, generationIndicator, isGenerationActive, isItemActive, presentOutputItems, reasoningPreview, reliableDurationMs, requiresVisibleDetails, type OutputPresentationRow } from "./output-presenter";
import "./output-timeline.css";

const labels = (t: AgentText): Record<NativeOutputItem["type"], string> => ({
  assistant_message: t("回复", "Reply"), reasoning: t("思考", "Thinking"), command_execution: t("命令", "Command"), file_change: t("文件变更", "File change"), file_search: t("文件搜索", "File search"), web_search: t("网页搜索", "Web search"), dynamic_tool: t("工具", "Tool"), todo_list: t("待办", "To-do"), proposed_plan: t("计划", "Plan"), subagent: t("子代理", "Subagent"), approval_request: t("审批", "Approval"), user_input_request: t("需要回答", "Input needed"), notification: t("通知", "Notification"), error: t("错误", "Error"), compaction: t("上下文压缩", "Compaction"),
});
const statuses = (t: AgentText): Record<NativeOutputItem["status"], string> => ({ pending: t("待处理", "Pending"), running: t("进行中", "Running"), waiting: t("等待中", "Waiting"), completed: t("已完成", "Completed"), failed: t("失败", "Failed"), cancelled: t("已取消", "Cancelled"), interrupted: t("已中断", "Interrupted"), unknown: t("待核实", "Awaiting reconciliation") });
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
function CommandOutput({ generationId, item }: { generationId: string; item: NativeOutputItem }) {
  const t = useAgentText();
  const node = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(!!item.outputTruncated);
  const [copyError, setCopyError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const output = useRef(EMPTY_TERMINAL_OUTPUT);
  useEffect(() => {
    if (!node.current) return;
    setReady(false);
    output.current = EMPTY_TERMINAL_OUTPUT;
    const terminal = new Terminal({ convertEol: true, disableStdin: true, scrollback: 4000, fontSize: 12, theme: { background: "#17191d", foreground: "#e9edf3" } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(node.current); fit.fit();
    const resize = new ResizeObserver(() => fit.fit()); resize.observe(node.current);
    const controller = new AbortController();
    let retry: number | undefined;
    let running = true;
    const connect = async () => {
      try {
        await subscribeCommand(generationId, item.id, controller.signal, (frame) => {
          setError(undefined); setTruncated(frame.truncated); running = frame.running;
          if (frame.kind === "replace") terminal.reset();
          output.current = appendTerminalOutput(frame.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : output.current, frame.text);
          terminal.write(frame.text);
          setReady(true);
        });
        if (running) throw new Error(t("命令输出流已断开，正在重新连接。", "Command output stream disconnected, reconnecting."));
      } catch (cause) { if (!controller.signal.aborted) { terminal.reset(); output.current = EMPTY_TERMINAL_OUTPUT; setReady(false); setError(cause instanceof Error ? cause.message : String(cause)); retry = window.setTimeout(() => void connect(), 1000); } }
    };
    void connect();
    return () => { controller.abort(); clearTimeout(retry); resize.disconnect(); terminal.dispose(); };
  }, [generationId, item.id]);
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
  return <div className="native-command-output">
    <Button className="native-command-copy" size="icon-xs" variant="ghost" aria-label={t("复制输出", "Copy output")} disabled={!ready} onClick={() => void copy()}>
      {copied ? <CircleCheck aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
    <div ref={node} aria-label={t("命令终端输出", "Command terminal output")} />
    {(truncated || item.outputTruncated) && <p>{t("输出已截断，仅显示保留的尾部。", "Output truncated; only the retained tail is shown.")}</p>}
    {error && <p role="alert">{t("输出连接中断：", "Output connection interrupted: ")}{error}</p>}
    {copied && <span role="status" className="sr-only">{t("已复制", "Copied")}</span>}
    {copyError && <span role="alert">{t("复制失败：", "Copy failed: ")}{copyError}</span>}
  </div>;
}
function Interaction({ generationId, item, generationStatus }: { generationId: string; item: NativeOutputItem; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const request = item.request;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<"answer" | "cancel">();
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string>();
  const active = isItemActive(item) && isGenerationActive(generationStatus);
  useEffect(() => {
    if (!request?.respondable || !active) {
      setAnswers({});
      setFreeText({});
    }
  }, [request?.respondable, request?.id, active]);
  if (!request) return <p>{t("请求详情不可用，无法响应。", "Request details unavailable; cannot respond.")}</p>;
  const enabled = canRespondToInteraction(item, generationStatus) && !submitted && !closed;
  const submit = async (response: NativeInteractionResponse) => {
    if (!enabled || pending) return;
    setPending(true); setError(undefined);
    try {
      await workspaceClient.json(`/api/chat/generations/${encodeURIComponent(generationId)}/requests/${encodeURIComponent(request.id)}/respond`, { method: "POST", body: JSON.stringify(response) });
      setAnswers({}); setFreeText({});
      setSubmitted(response.cancelled ? "cancel" : "answer");
    } catch (cause) {
      if (cause instanceof WorkspaceClientError && cause.code === "native_interaction_closed") {
        setAnswers({}); setFreeText({}); setClosed(true);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setPending(false); }
  };
  return <div className="native-interaction">
    {request.detail && <p>{request.detail}</p>}
    {!enabled && <p role="status">{submitted === "cancel" ? t("已取消回答，等待运行继续。", "Response cancelled; waiting for the run to continue.") : submitted === "answer" ? t("响应已提交，等待运行继续。", "Response submitted; waiting for the run to continue.") : request.unavailableReason || (closed || request.respondable ? t("请求已结束或过期，无法响应。", "This request has ended or expired and cannot be answered.") : t("当前请求不可响应。", "This request cannot be answered."))}</p>}
    {request.kind === "approval" && <div className="native-buttons">{request.options?.map((option) => <button key={option.id} type="button" disabled={!enabled || pending} title={option.description} onClick={() => void submit({ optionId: option.id })}>{option.label}</button>)}</div>}
    {request.kind === "user_input" && <form onSubmit={(event) => { event.preventDefault(); const combined = { ...answers }; for (const question of request.questions ?? []) { const text = freeText[question.id]?.trim(); if (text) combined[question.id] = question.multiple ? [...(Array.isArray(combined[question.id]) ? combined[question.id] as string[] : []), text] : text; } void submit({ answers: combined }); }}>
      {request.questions?.map((question) => <fieldset key={question.id} disabled={!enabled || pending}><legend>{question.title || question.prompt}</legend>{question.title && <p>{question.prompt}</p>}
        {question.options?.map((option) => <label key={option.id} className="native-option"><input type={question.multiple ? "checkbox" : "radio"} name={question.id} value={option.id} checked={question.multiple ? Array.isArray(answers[question.id]) && (answers[question.id] as string[]).includes(option.id) : answers[question.id] === option.id} onChange={(event) => { if (!question.multiple) setFreeText((previous) => ({ ...previous, [question.id]: "" })); setAnswers((previous) => ({ ...previous, [question.id]: question.multiple ? event.target.checked ? [...(Array.isArray(previous[question.id]) ? previous[question.id] as string[] : []), option.id] : (Array.isArray(previous[question.id]) ? previous[question.id] as string[] : []).filter((id) => id !== option.id) : option.id })); }} /> <span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
        {(question.allowText || !question.options?.length) && <input className="native-text-input" type={question.secret ? "password" : "text"} aria-label={question.prompt} placeholder={t("输入回答", "Type your answer")} value={freeText[question.id] ?? ""} onChange={(event) => { const value = event.target.value; setFreeText((previous) => ({ ...previous, [question.id]: value })); if (!question.multiple && value) setAnswers((previous) => ({ ...previous, [question.id]: "" })); }} />}
      </fieldset>)}
      <button type="submit" disabled={!enabled || pending || !request.questions?.length || request.questions.some((question) => !freeText[question.id]?.trim() && (!answers[question.id] || (Array.isArray(answers[question.id]) && !(answers[question.id] as string[]).length)))}>{pending ? t("提交中…", "Submitting…") : t("提交回答", "Submit answer")}</button>
      <button type="button" disabled={!enabled || pending} onClick={() => void submit({ cancelled: true })}>{t("取消回答", "Cancel answer")}</button>
    </form>}
    {error && <p role="alert">{t("响应未提交：", "Response not submitted: ")}{error}</p>}
  </div>;
}
function FileChanges({ item }: { item: NativeOutputItem }) {
  const t = useAgentText();
  const changes: NonNullable<NativeOutputItem["changes"]> = item.changes?.length ? item.changes : [{ path: item.fileName || item.title || t("文件", "File"), operation: "", diff: item.diff }];
  return <div data-native-context-menu className="native-changes">
    {changes.map((change, index) => <div key={`${change.path}:${index}`} className="native-change">
      <div className="native-change-path"><strong>{change.oldPath ? `${change.oldPath} → ` : ""}{change.path}</strong>{change.operation && <span>{change.operation}</span>}</div>
      {change.diff ? <Diff text={change.diff} /> : index === 0 && item.oldText !== undefined && item.newText !== undefined ? <MultiFileDiff oldFile={{ name: change.oldPath || change.path, contents: item.oldText }} newFile={{ name: change.path, contents: item.newText }} disableWorkerPool options={{ themeType: "system", diffStyle: "unified", overflow: "scroll" }} /> : index === 0 && (item.oldText !== undefined || item.newText !== undefined) ? <div className="native-before-after">{item.oldText !== undefined && <div><b>{t("原内容", "Original")}</b><CodeBlock code={item.oldText} lineNumbers /></div>}{item.newText !== undefined && <div><b>{t("新内容", "New")}</b><CodeBlock code={item.newText} lineNumbers /></div>}</div> : <p>{t("未提供差异内容。", "No diff content provided.")}</p>}
    </div>)}
  </div>;
}
function Diff({ text }: { text: string }) {
  const rows = text.split("\n")
    .filter(line => !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map(line => ({ text: line, kind: line.startsWith("+") ? "added" as const : line.startsWith("-") ? "removed" as const : "context" as const }));
  return <CodeBlock rows={rows} lineNumbers />;
}
// assistant-ui replaces live output with authoritative history at finish.
const disclosures = createOutputDisclosureStore();
function useOutputDisclosure(generationId: string, items: NativeOutputItem[], defaultOpen: boolean, group = false) {
  const rowKeys = items.map(item => JSON.stringify([generationId, item.id]));
  const keys = group ? rowKeys.map(key => `group:${key}`) : rowKeys;
  const [localOpen, setOpen] = useState(defaultOpen);
  const open = disclosures.read(keys, group ? disclosures.read(rowKeys, localOpen) : localOpen);
  const change = (next: boolean) => { disclosures.set(keys, next); setOpen(next); };
  return [open, change] as const;
}
function commandText(item: NativeOutputItem) {
  const input = item.input;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "command" in input && typeof input.command === "string") return input.command;
  return undefined;
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
const OutputRow = memo(function OutputRow({ item, generationId, generationStatus }: { item: NativeOutputItem; generationId: string; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const visible = requiresVisibleDetails(item);
  const [open, change] = useOutputDisclosure(generationId, [item], visible || (isGenerationActive(generationStatus) && isItemActive(item)));
  if (item.visibility === "redacted" || item.visibility === "unavailable") {
    return <div className="native-output-card" data-visibility={item.visibility} role="status">
      {item.visibility === "redacted" ? t("内容已不可访问。", "This content is no longer accessible.") : t("暂时无法核验内容访问权限。", "Content access cannot be verified right now.")}
    </div>;
  }
  if (item.type === "assistant_message") {
    const kind = assistantMessageKind(item);
    return <div className={`native-answer${kind === "progress" ? " native-progress" : ""}`} data-phase={item.phase ?? "unknown"}>
      {kind === "progress" && <span className="native-progress-label">{t("进度更新", "Progress update")}</span>}
      <Markdown content={item.text ?? ""} locale="zh-CN" streaming={item.streaming === true && isGenerationActive(generationStatus)} />
      {item.error && <p role="alert" className="native-error">{item.error}</p>}
    </div>;
  }
  const title = (item.type === "command_execution" ? commandText(item) : undefined) || item.title || item.request?.title || item.toolName || labels(t)[item.type];
  const ended = !isGenerationActive(generationStatus) && isItemActive(item);
  const status = ended ? undefined : traceStatusFor(item.status);
  const tone = ended ? "neutral" : item.status === "completed" ? "success" : item.status === "failed" || item.status === "interrupted" ? "error" : item.status === "running" ? "running" : item.status === "waiting" || item.status === "unknown" ? "warning" : item.status === "pending" ? "pending" : "neutral";
  const meta = <>
    <Duration item={item} generationStatus={generationStatus} />
    {item.exitCode !== undefined && <span> · exit {item.exitCode}</span>}
    {item.type === "file_change" && (item.additions !== undefined || item.deletions !== undefined) && <span> · +{item.additions ?? 0} −{item.deletions ?? 0}</span>}
  </>;
  const body = <>
    {item.status === "unknown" && <p role="status">{t("业务结果尚未确认；只能核对原操作，不能重复执行。", "The business outcome is unconfirmed. Reconcile the original operation; do not execute it again.")}</p>}
    {item.type === "reasoning" && <div className="native-prose"><Markdown content={item.text ?? ""} locale="zh-CN" streaming={item.streaming === true} /></div>}
    {item.type === "command_execution" && (open || visible) && <CommandOutput generationId={generationId} item={item} />}
    {item.type === "file_change" && <FileChanges item={item} />}
    {(item.type === "file_search" || item.type === "web_search") && <>{item.text && <p>{item.text}</p>}{item.input !== undefined && <CodeBlock code={printable(item.input)} wrap />}{item.output && <CodeBlock code={item.output} wrap />}<ul>{item.results?.map((result, index) => { const url = safeUrl(result.url); return <li key={index}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{result.title || url}</a> : <strong>{result.title || result.path || result.url || t("结果", "Result")}</strong>}{result.path && <span> {result.path}{result.line !== undefined ? `:${result.line}` : ""}</span>}{result.text && <p>{result.text}</p>}</li>; })}</ul></>}
    {item.type === "dynamic_tool" && <>{item.input !== undefined && <><b>{t("输入", "Input")}</b><CodeBlock code={printable(item.input)} wrap /></>}{item.output !== undefined && <><b>{t("输出", "Output")}</b><CodeBlock code={item.output} wrap /></>}{item.text && <p>{item.text}</p>}</>}
    {(item.type === "todo_list" || item.type === "proposed_plan") && <>{item.text && <Markdown content={item.text} locale="zh-CN" />}{item.steps && <Trace nested>{item.steps.map(step => <TraceLine key={step.id} icon={step.status === "completed" ? <CircleCheck aria-hidden="true" /> : step.status === "running" ? <CircleDot aria-hidden="true" /> : step.status === "cancelled" ? <CircleX aria-hidden="true" /> : <Circle aria-hidden="true" />} title={step.text} status={step.status === "completed" ? undefined : step.status === "running" ? "running" : "pending"} />)}</Trace>}</>}
    {item.type === "subagent" && <>{item.model || item.childSessionId ? <Trace nested>{item.model && <TraceLine icon={<Wrench aria-hidden="true" />} title={t("模型", "Model")} description={item.model} />}{item.childSessionId && <TraceLine icon={<GitBranch aria-hidden="true" />} title={t("子会话", "Child session")} description={item.childSessionId} />}</Trace> : null}{item.text && <p>{item.text}</p>}{item.output && <CodeBlock code={item.output} wrap />}</>}
    {(item.type === "approval_request" || item.type === "user_input_request") && <Interaction key={item.request?.id ?? item.id} generationId={generationId} item={item} generationStatus={generationStatus} />}
    {(item.type === "notification" || item.type === "error" || item.type === "compaction") && <>{item.text && <p>{item.text}</p>}{item.output && <CodeBlock code={item.output} wrap />}{item.input !== undefined && <CodeBlock code={printable(item.input)} wrap />}</>}
    {item.error && <p role="alert" className="native-error">{item.error}</p>}
  </>;
  const badge = <TraceStatusBadge status={status} tone={tone}>{ended ? t("运行已结束", "Run ended") : statuses(t)[item.status]}</TraceStatusBadge>;
  if (visible) return <section className={`native-visible-details native-${item.type}`}>
    <TraceLine icon={outputIcon(item.type)} title={title} description={meta} status={status} trailing={badge} />
    {item.mcpApp && <McpAppFrame key={JSON.stringify(item.mcpApp.producing)} app={item.mcpApp} generationStatus={generationStatus} />}
    <div className="native-card-body">{body}</div>
  </section>;
  return <TraceRow
    className={`native-${item.type}`}
    icon={outputIcon(item.type)}
    title={title}
    description={meta}
    status={status}
    trailing={badge}
    open={open}
    onOpenChange={change}
  >
    {item.mcpApp && <McpAppFrame key={JSON.stringify(item.mcpApp.producing)} app={item.mcpApp} generationStatus={generationStatus} />}
    <div className="native-card-body">{body}</div>
  </TraceRow>;
});
function OutputGroup({ row, generationId, generationStatus }: { row: Extract<OutputPresentationRow, { kind: "reasoning" | "tools" }>; generationId: string; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const [open, change] = useOutputDisclosure(generationId, row.items, false, true);
  const active = isGenerationActive(generationStatus) && row.items.some(isItemActive);
  if (row.kind === "tools" && row.items.length === 1) return <OutputRow item={row.items[0]!} generationId={generationId} generationStatus={generationStatus} />;
  const counts = {
    completed: row.items.filter(item => item.status === "completed").length,
    running: isGenerationActive(generationStatus) ? row.items.filter(item => item.status === "running").length : 0,
    pending: isGenerationActive(generationStatus) ? row.items.filter(item => item.status === "pending").length : 0,
    cancelled: row.items.filter(item => item.status === "cancelled").length,
  };
  const title = row.kind === "reasoning"
    ? <span className="native-reasoning-summary"><span className="native-activity-label">{t("思考记录", "Reasoning")}</span><span className="native-reasoning-preview">{reasoningPreview(row.items)}</span></span>
    : t(`${row.items.length} 项操作`, `${row.items.length} actions`);
  const summary = row.kind === "tools"
    ? [counts.running && t(`${counts.running} 进行中`, `${counts.running} running`), counts.pending && t(`${counts.pending} 待处理`, `${counts.pending} pending`), counts.completed && t(`${counts.completed} 已完成`, `${counts.completed} completed`), counts.cancelled && t(`${counts.cancelled} 已取消`, `${counts.cancelled} cancelled`)].filter(Boolean).join(" · ")
    : active ? t("进行中", "Running") : undefined;
  return <TraceRow className={`native-activity-group native-${row.kind}-group`} icon={row.kind === "reasoning" ? <Brain aria-hidden="true" /> : <Wrench aria-hidden="true" />} title={title} trailing={summary && <span className="native-group-counts">{summary}</span>} status={active ? "running" : undefined} open={open} onOpenChange={change}>
    {row.kind === "reasoning" ? row.items.map(item => <div key={item.id} className="native-prose native-reasoning-part"><Markdown content={item.text ?? ""} locale="zh-CN" streaming={item.streaming === true && isGenerationActive(generationStatus)} /><Duration item={item} generationStatus={generationStatus} /></div>) : <Trace nested>{row.items.map(item => <OutputRow key={item.id} item={item} generationId={generationId} generationStatus={generationStatus} />)}</Trace>}
  </TraceRow>;
}

/** Props-only consumer seam for isolated browser harnesses; no scenario data or network fallback. */
export function OutputTimelineView({ snapshot, error, calls = [], callsError, onUpdateCall }: { snapshot?: AgentOutputSnapshot; error?: string; calls?: PmToolRecord[]; callsError?: string; onUpdateCall: (record: PmToolRecord) => void }) {
  const t = useAgentText();
  const rows = useMemo(() => presentOutputItems(snapshot?.items ?? [], calls.map(call => call.operationId)), [snapshot?.items, calls]);
  const records = new Map(calls.map(call => [call.operationId, call]));
  const rendered = new Set(rows.filter(row => row.kind === "pm_tool").map(row => row.operationId));
  const indicator = snapshot && generationIndicator(snapshot.status, snapshot.items);
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
      return row.kind === "item" ? <OutputRow key={row.key} item={row.item} generationId={snapshot.generationId} generationStatus={snapshot.status} /> : <OutputGroup key={row.key} row={row} generationId={snapshot.generationId} generationStatus={snapshot.status} />;
    })}
    {calls.filter(call => !rendered.has(call.operationId)).map(call => <PmToolCard key={`pm:${call.operationId}`} record={call} onUpdate={onUpdateCall} />)}
    {indicator && <div className="native-generation-status" role={indicator === "failed" ? "alert" : "status"}>{indicatorText}</div>}
  </div>;
}

export function OutputTimeline({ generationId }: { generationId: string }) {
  const { snapshot, error } = useGenerationOutput(generationId);
  const toolCalls = usePmToolCalls();
  const calls = useMemo(() => toolCalls?.items.filter(call => call.generationId === generationId) ?? [], [toolCalls?.items, generationId]);
  const refreshCalls = toolCalls?.refresh;
  const pmOutputVersion = JSON.stringify(snapshot?.items.filter(item => item.id.startsWith("pm-tool:")).map(item => [item.id, item.status, item.output]) ?? []);
  useEffect(() => { if (pmOutputVersion !== "[]") refreshCalls?.(); }, [refreshCalls, pmOutputVersion]);
  return <OutputTimelineView snapshot={snapshot} error={error} calls={calls} callsError={toolCalls?.error} onUpdateCall={record => toolCalls?.update(record)} />;
}
