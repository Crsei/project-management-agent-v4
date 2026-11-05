import { memo, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { MultiFileDiff } from "@pierre/diffs/react";
import "@xterm/xterm/css/xterm.css";
import { Markdown } from "../../../../../../../vendor/agent-workspace-views/conversations/markdown";
import type { GenerationOutputStatus, NativeInteractionResponse, NativeOutputItem } from "@agent-workspace/contracts/output";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, terminalOutputPlainText } from "@agent-workspace/contracts/terminal-output";
import { workspaceClient } from "../network";
import { subscribeCommand, useGenerationOutput } from "./output-stream";
import { PmToolCard } from "./pm-tool-card";
import { usePmToolCalls } from "./pm-tool-calls";
import { useAgentText, type AgentText } from "../i18n";
import { McpAppFrame } from "./mcp-app-frame";
import "./output-timeline.css";

const labels = (t: AgentText): Record<NativeOutputItem["type"], string> => ({
  assistant_message: t("回复", "Reply"), reasoning: t("思考", "Thinking"), command_execution: t("命令", "Command"), file_change: t("文件变更", "File change"), file_search: t("文件搜索", "File search"), web_search: t("网页搜索", "Web search"), dynamic_tool: t("工具", "Tool"), todo_list: t("待办", "To-do"), proposed_plan: t("计划", "Plan"), subagent: t("子代理", "Subagent"), approval_request: t("审批", "Approval"), user_input_request: t("需要回答", "Input needed"), notification: t("通知", "Notification"), error: t("错误", "Error"), compaction: t("上下文压缩", "Compaction"),
});
const statuses = (t: AgentText): Record<NativeOutputItem["status"], string> => ({ pending: t("待处理", "Pending"), running: t("进行中", "Running"), waiting: t("等待中", "Waiting"), completed: t("已完成", "Completed"), failed: t("失败", "Failed"), cancelled: t("已取消", "Cancelled"), interrupted: t("已中断", "Interrupted") });
function safeUrl(value?: string) {
  // oxlint-disable-next-line no-control-regex -- reject ambiguous/control-bearing provider URLs before URL parsing.
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}
function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}
function Duration({ item }: { item: NativeOutputItem }) {
  const [now, setNow] = useState(Date.now());
  const running = item.status === "running" || item.status === "waiting" || item.status === "pending";
  useEffect(() => { if (!running || !item.startedAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running, item.startedAt]);
  if (!item.startedAt) return null;
  const start = Date.parse(item.startedAt), end = item.completedAt ? Date.parse(item.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return <span>{Math.max(0, Math.floor((end - start) / 1000))}s</span>;
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
      } catch (cause) { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); retry = window.setTimeout(() => void connect(), 1000); } }
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
    } catch (cause) { setCopyError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="native-command-output"><div ref={node} aria-label={t("命令终端输出", "Command terminal output")} />{(truncated || item.outputTruncated) && <p>{t("输出已截断，仅显示保留的尾部。", "Output truncated; only the retained tail is shown.")}</p>}{error && <p role="alert">{t("输出连接中断：", "Output connection interrupted: ")}{error}</p>}<button type="button" disabled={!ready} onClick={() => void copy()}>{t("复制输出", "Copy output")}</button>{copied && <span role="status">{t("已复制", "Copied")}</span>}{copyError && <span role="alert">{t("复制失败：", "Copy failed: ")}{copyError}</span>}</div>;
}
function Interaction({ generationId, item }: { generationId: string; item: NativeOutputItem }) {
  const t = useAgentText();
  const request = item.request;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<"answer" | "cancel">();
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string>();
  const active = item.status === "waiting" || item.status === "pending" || item.status === "running";
  useEffect(() => {
    if (!request?.respondable || !active) {
      setAnswers({});
      setFreeText({});
    }
  }, [request?.respondable, request?.id, active]);
  if (!request) return <p>{t("请求详情不可用，无法响应。", "Request details unavailable; cannot respond.")}</p>;
  const enabled = request.respondable && active && !submitted && !closed;
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
  return <div data-native-context-menu>{changes.map((change, index) => <div key={`${change.path}:${index}`}><strong>{change.oldPath ? `${change.oldPath} → ` : ""}{change.path}</strong> {change.operation} {change.diff ? <Diff text={change.diff} /> : index === 0 && item.oldText !== undefined && item.newText !== undefined ? <MultiFileDiff oldFile={{ name: change.oldPath || change.path, contents: item.oldText }} newFile={{ name: change.path, contents: item.newText }} disableWorkerPool options={{ themeType: "system", diffStyle: "unified", overflow: "scroll" }} /> : index === 0 && (item.oldText !== undefined || item.newText !== undefined) ? <div className="native-before-after">{item.oldText !== undefined && <div><b>{t("原内容", "Original")}</b><pre>{item.oldText}</pre></div>}{item.newText !== undefined && <div><b>{t("新内容", "New")}</b><pre>{item.newText}</pre></div>}</div> : <p>{t("未提供差异内容。", "No diff content provided.")}</p>}</div>)}</div>;
}
function Diff({ text }: { text: string }) {
  return <pre className="native-diff">{text.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : ""}>{line}{"\n"}</span>)}</pre>;
}
// assistant-ui replaces the live message with authoritative history at finish.
// Keep explicit expansion through that remount, without persisting output or unbounded keys.
const expandedRows = new Set<string>();
const OutputRow = memo(function OutputRow({ item, generationId, generationStatus }: { item: NativeOutputItem; generationId: string; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const expansionKey = JSON.stringify([generationId, item.id]);
  const [open, setOpen] = useState(() => expandedRows.has(expansionKey));
  const toggle = () => {
    if (open) expandedRows.delete(expansionKey);
    else {
      expandedRows.add(expansionKey);
      if (expandedRows.size > 256) expandedRows.delete(expandedRows.values().next().value!);
    }
    setOpen(!open);
  };
  if (item.type === "assistant_message") return <div className="native-answer"><Markdown content={item.text ?? ""} locale="zh-CN" streaming={item.streaming === true} />{item.error && <p role="alert" className="native-error">{item.error}</p>}</div>;
  const collapsible = item.type === "reasoning" || item.type === "command_execution" || item.type === "dynamic_tool" || item.type === "file_change";
  const title = item.title || item.request?.title || item.toolName || labels(t)[item.type];
  const body = <>
    {item.type === "reasoning" && <div className="native-prose"><Markdown content={item.text ?? ""} locale="zh-CN" streaming={item.streaming === true} /></div>}
    {item.type === "command_execution" && <>{item.input !== undefined && <pre>{printable(item.input)}</pre>}{item.exitCode !== undefined && <p>{t("退出码：", "Exit code: ")}{item.exitCode}</p>}{open && <CommandOutput generationId={generationId} item={item} />}</>}
    {item.type === "file_change" && <>{(item.additions !== undefined || item.deletions !== undefined) && <p>{item.additions !== undefined && t(`新增 ${item.additions}`, `+${item.additions} added`)}{item.additions !== undefined && item.deletions !== undefined && " · "}{item.deletions !== undefined && t(`删除 ${item.deletions}`, `-${item.deletions} deleted`)}</p>}<FileChanges item={item} /></>}
    {(item.type === "file_search" || item.type === "web_search") && <>{item.text && <p>{item.text}</p>}{item.input !== undefined && <pre>{printable(item.input)}</pre>}{item.output && <pre>{item.output}</pre>}<ul>{item.results?.map((result, index) => { const url = safeUrl(result.url); return <li key={index}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{result.title || url}</a> : <strong>{result.title || result.path || result.url || t("结果", "Result")}</strong>}{result.path && <span> {result.path}{result.line !== undefined ? `:${result.line}` : ""}</span>}{result.text && <p>{result.text}</p>}</li>; })}</ul></>}
    {item.type === "dynamic_tool" && <>{item.input !== undefined && <><b>{t("输入", "Input")}</b><pre>{printable(item.input)}</pre></>}{item.output !== undefined && <><b>{t("输出", "Output")}</b><pre>{item.output}</pre></>}{item.text && <p>{item.text}</p>}</>}
    {(item.type === "todo_list" || item.type === "proposed_plan") && <>{item.text && <Markdown content={item.text} locale="zh-CN" />}{item.steps && <ol>{item.steps.map((step) => <li key={step.id}>{step.status === "completed" ? "✓" : step.status === "running" ? "◷" : step.status === "cancelled" ? "×" : "○"} {step.text} <small>{step.status}</small></li>)}</ol>}</>}
    {item.type === "subagent" && <>{item.model && <p>{t("模型：", "Model: ")}{item.model}</p>}{item.childSessionId && <p>{t("子会话：", "Child session: ")}{item.childSessionId}</p>}{item.text && <p>{item.text}</p>}{item.output && <pre>{item.output}</pre>}</>}
    {(item.type === "approval_request" || item.type === "user_input_request") && <Interaction key={item.request?.id ?? item.id} generationId={generationId} item={item} />}
    {(item.type === "notification" || item.type === "error" || item.type === "compaction") && <>{item.text && <p>{item.text}</p>}{item.output && <pre>{item.output}</pre>}{item.input !== undefined && <pre>{printable(item.input)}</pre>}</>}
    {item.error && <p role="alert" className="native-error">{item.error}</p>}
  </>;
  return <section className={`native-output-card native-${item.type}`}><header>{collapsible ? <button type="button" aria-expanded={open} onClick={toggle}><span aria-hidden>{open ? "▾" : "▸"}</span> {title}</button> : <strong>{title}</strong>}<span className="native-status">{statuses(t)[item.status]} <Duration item={item} /></span></header>{item.mcpApp && <McpAppFrame key={JSON.stringify(item.mcpApp.producing)} app={item.mcpApp} generationStatus={generationStatus} />}{(!collapsible || open) && <div className="native-card-body">{body}</div>}</section>;
});
export function OutputTimeline({ generationId }: { generationId: string }) {
  const t = useAgentText();
  const { snapshot, error } = useGenerationOutput(generationId);
  const toolCalls = usePmToolCalls();
  const calls = toolCalls?.items.filter(call => call.generationId === generationId) ?? [];
  const callsError = toolCalls?.error;
  const refreshCalls = toolCalls?.refresh;
  const pmOutputVersion = JSON.stringify(snapshot?.items.filter(item => item.id.startsWith("pm-tool:")).map(item => [item.id, item.status, item.output]) ?? []);
  useEffect(() => { if (pmOutputVersion !== "[]") refreshCalls?.(); }, [refreshCalls, pmOutputVersion]);
  const rendered = new Set<string>();
  const bridgeOperations = new Set(snapshot?.items.filter(item => item.id.startsWith("pm-tool:")).map(item => item.id.slice("pm-tool:".length)) ?? []);
  return <div className="native-timeline" aria-label={t("运行输出时间线", "Run output timeline")}>
    {error && <p role="alert">{t("输出连接：", "Output connection: ")}{error}</p>}
    {callsError && <p role="alert">{t("PM 工具记录读取失败：", "Failed to load PM tool records: ")}{callsError}</p>}
    {!snapshot && !error && <p role="status">{t("正在加载运行输出…", "Loading run output…")}</p>}
    {snapshot?.items.map(item => {
      let operationId = item.id.startsWith("pm-tool:") ? item.id.slice("pm-tool:".length) : undefined;
      if (!operationId && item.type === "dynamic_tool" && item.output) {
        try {
          const value: unknown = JSON.parse(item.output);
          if (value && typeof value === "object" && "operationId" in value && typeof value.operationId === "string") {
            const id = value.operationId;
            if (bridgeOperations.has(id) || calls.some(call => call.operationId === id)) operationId = id;
          }
        } catch { /* Non-PM native output retains its normal rendering. */ }
        if (operationId && bridgeOperations.has(operationId)) return null;
      }
      const record = operationId && calls.find(call => call.operationId === operationId);
      if (record) {
        if (rendered.has(record.operationId)) return null;
        rendered.add(record.operationId);
        return <PmToolCard key={item.id} record={record} onUpdate={toolCalls!.update} />;
      }
      if (operationId) return <section key={item.id} className="native-output-card"><header><strong>{item.toolName || t("PM 工具", "PM tool")}</strong><span>{callsError ? t("记录不可用", "Records unavailable") : t("正在读取操作记录…", "Loading operation records…")}</span></header></section>;
      return <OutputRow key={item.id} item={item} generationId={generationId} generationStatus={snapshot.status} />;
    })}
    {calls.filter(call => !rendered.has(call.operationId)).map(call => <PmToolCard key={call.operationId} record={call} onUpdate={toolCalls!.update} />)}
    {snapshot && <div className="native-generation-status" role="status">{snapshot.status === "queued" ? t("等待运行", "Queued") : snapshot.status === "running" ? t("正在运行", "Running") : snapshot.status === "completed" ? t("运行完成", "Run completed") : snapshot.status === "failed" ? t("运行失败", "Run failed") : snapshot.status === "cancelled" ? t("运行已取消", "Run cancelled") : t("运行已中断", "Run interrupted")}</div>}
  </div>;
}
