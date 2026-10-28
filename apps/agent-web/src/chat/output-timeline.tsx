import { memo, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { MultiFileDiff } from "@pierre/diffs/react";
import "@xterm/xterm/css/xterm.css";
import { Markdown } from "../../../../vendor/agent-workspace-views/conversations/markdown";
import type { NativeInteractionResponse, NativeOutputItem } from "@agent-workspace/contracts/output";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, terminalOutputPlainText } from "@agent-workspace/contracts/terminal-output";
import { workspaceClient } from "../network";
import { subscribeCommand, useGenerationOutput } from "./output-stream";
import "./output-timeline.css";

const labels: Record<NativeOutputItem["type"], string> = {
  assistant_message: "回复", reasoning: "思考", command_execution: "命令", file_change: "文件变更", file_search: "文件搜索", web_search: "网页搜索", dynamic_tool: "工具", todo_list: "待办", proposed_plan: "计划", subagent: "子代理", approval_request: "审批", user_input_request: "需要回答", notification: "通知", error: "错误", compaction: "上下文压缩",
};
const statuses: Record<NativeOutputItem["status"], string> = { pending: "待处理", running: "进行中", waiting: "等待中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
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
        if (running) throw new Error("命令输出流已断开，正在重新连接。");
      } catch (cause) { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); retry = window.setTimeout(() => void connect(), 1000); } }
    };
    void connect();
    return () => { controller.abort(); clearTimeout(retry); resize.disconnect(); terminal.dispose(); };
  }, [generationId, item.id]);
  const copy = async () => {
    if (!ready) return;
    try {
      if (!navigator.clipboard) throw new Error("浏览器未提供剪贴板权限。");
      await navigator.clipboard.writeText(terminalOutputPlainText(output.current.text));
      setCopyError(undefined);
      setCopied(true);
    } catch (cause) { setCopyError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="native-command-output"><div ref={node} aria-label="命令终端输出" />{(truncated || item.outputTruncated) && <p>输出已截断，仅显示保留的尾部。</p>}{error && <p role="alert">输出连接中断：{error}</p>}<button type="button" disabled={!ready} onClick={() => void copy()}>复制输出</button>{copied && <span role="status">已复制</span>}{copyError && <span role="alert">复制失败：{copyError}</span>}</div>;
}
function Interaction({ generationId, item }: { generationId: string; item: NativeOutputItem }) {
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
  if (!request) return <p>请求详情不可用，无法响应。</p>;
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
    {!enabled && <p role="status">{submitted === "cancel" ? "已取消回答，等待运行继续。" : submitted === "answer" ? "响应已提交，等待运行继续。" : request.unavailableReason || (closed || request.respondable ? "请求已结束或过期，无法响应。" : "当前请求不可响应。")}</p>}
    {request.kind === "approval" && <div className="native-buttons">{request.options?.map((option) => <button key={option.id} type="button" disabled={!enabled || pending} title={option.description} onClick={() => void submit({ optionId: option.id })}>{option.label}</button>)}</div>}
    {request.kind === "user_input" && <form onSubmit={(event) => { event.preventDefault(); const combined = { ...answers }; for (const question of request.questions ?? []) { const text = freeText[question.id]?.trim(); if (text) combined[question.id] = question.multiple ? [...(Array.isArray(combined[question.id]) ? combined[question.id] as string[] : []), text] : text; } void submit({ answers: combined }); }}>
      {request.questions?.map((question) => <fieldset key={question.id} disabled={!enabled || pending}><legend>{question.title || question.prompt}</legend>{question.title && <p>{question.prompt}</p>}
        {question.options?.map((option) => <label key={option.id} className="native-option"><input type={question.multiple ? "checkbox" : "radio"} name={question.id} value={option.id} checked={question.multiple ? Array.isArray(answers[question.id]) && (answers[question.id] as string[]).includes(option.id) : answers[question.id] === option.id} onChange={(event) => { if (!question.multiple) setFreeText((previous) => ({ ...previous, [question.id]: "" })); setAnswers((previous) => ({ ...previous, [question.id]: question.multiple ? event.target.checked ? [...(Array.isArray(previous[question.id]) ? previous[question.id] as string[] : []), option.id] : (Array.isArray(previous[question.id]) ? previous[question.id] as string[] : []).filter((id) => id !== option.id) : option.id })); }} /> <span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
        {(question.allowText || !question.options?.length) && <input className="native-text-input" type={question.secret ? "password" : "text"} aria-label={question.prompt} placeholder="输入回答" value={freeText[question.id] ?? ""} onChange={(event) => { const value = event.target.value; setFreeText((previous) => ({ ...previous, [question.id]: value })); if (!question.multiple && value) setAnswers((previous) => ({ ...previous, [question.id]: "" })); }} />}
      </fieldset>)}
      <button type="submit" disabled={!enabled || pending || !request.questions?.length || request.questions.some((question) => !freeText[question.id]?.trim() && (!answers[question.id] || (Array.isArray(answers[question.id]) && !(answers[question.id] as string[]).length)))}>{pending ? "提交中…" : "提交回答"}</button>
      <button type="button" disabled={!enabled || pending} onClick={() => void submit({ cancelled: true })}>取消回答</button>
    </form>}
    {error && <p role="alert">响应未提交：{error}</p>}
  </div>;
}
function FileChanges({ item }: { item: NativeOutputItem }) {
  const changes: NonNullable<NativeOutputItem["changes"]> = item.changes?.length ? item.changes : [{ path: item.fileName || item.title || "文件", operation: "", diff: item.diff }];
  return <div>{changes.map((change, index) => <div key={`${change.path}:${index}`}><strong>{change.oldPath ? `${change.oldPath} → ` : ""}{change.path}</strong> {change.operation} {change.diff ? <Diff text={change.diff} /> : index === 0 && item.oldText !== undefined && item.newText !== undefined ? <MultiFileDiff oldFile={{ name: change.oldPath || change.path, contents: item.oldText }} newFile={{ name: change.path, contents: item.newText }} disableWorkerPool options={{ themeType: "system", diffStyle: "unified", overflow: "scroll" }} /> : index === 0 && (item.oldText !== undefined || item.newText !== undefined) ? <div className="native-before-after">{item.oldText !== undefined && <div><b>原内容</b><pre>{item.oldText}</pre></div>}{item.newText !== undefined && <div><b>新内容</b><pre>{item.newText}</pre></div>}</div> : <p>未提供差异内容。</p>}</div>)}</div>;
}
function Diff({ text }: { text: string }) {
  return <pre className="native-diff">{text.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : ""}>{line}{"\n"}</span>)}</pre>;
}
// assistant-ui replaces the live message with authoritative history at finish.
// Keep explicit expansion through that remount, without persisting output or unbounded keys.
const expandedRows = new Set<string>();
const OutputRow = memo(function OutputRow({ item, generationId }: { item: NativeOutputItem; generationId: string }) {
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
  const title = item.title || item.request?.title || item.toolName || labels[item.type];
  const body = <>
    {item.type === "reasoning" && <div className="native-prose"><Markdown content={item.text ?? ""} locale="zh-CN" streaming={item.streaming === true} /></div>}
    {item.type === "command_execution" && <>{item.input !== undefined && <pre>{printable(item.input)}</pre>}{item.exitCode !== undefined && <p>退出码：{item.exitCode}</p>}{open && <CommandOutput generationId={generationId} item={item} />}</>}
    {item.type === "file_change" && <>{(item.additions !== undefined || item.deletions !== undefined) && <p>{item.additions !== undefined && `新增 ${item.additions}`}{item.additions !== undefined && item.deletions !== undefined && " · "}{item.deletions !== undefined && `删除 ${item.deletions}`}</p>}<FileChanges item={item} /></>}
    {(item.type === "file_search" || item.type === "web_search") && <>{item.text && <p>{item.text}</p>}{item.input !== undefined && <pre>{printable(item.input)}</pre>}{item.output && <pre>{item.output}</pre>}<ul>{item.results?.map((result, index) => { const url = safeUrl(result.url); return <li key={index}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{result.title || url}</a> : <strong>{result.title || result.path || result.url || "结果"}</strong>}{result.path && <span> {result.path}{result.line !== undefined ? `:${result.line}` : ""}</span>}{result.text && <p>{result.text}</p>}</li>; })}</ul></>}
    {item.type === "dynamic_tool" && <>{item.input !== undefined && <><b>输入</b><pre>{printable(item.input)}</pre></>}{item.output !== undefined && <><b>输出</b><pre>{item.output}</pre></>}{item.text && <p>{item.text}</p>}</>}
    {(item.type === "todo_list" || item.type === "proposed_plan") && <>{item.text && <Markdown content={item.text} locale="zh-CN" />}{item.steps && <ol>{item.steps.map((step) => <li key={step.id}>{step.status === "completed" ? "✓" : step.status === "running" ? "◷" : step.status === "cancelled" ? "×" : "○"} {step.text} <small>{step.status}</small></li>)}</ol>}</>}
    {item.type === "subagent" && <>{item.model && <p>模型：{item.model}</p>}{item.childSessionId && <p>子会话：{item.childSessionId}</p>}{item.text && <p>{item.text}</p>}{item.output && <pre>{item.output}</pre>}</>}
    {(item.type === "approval_request" || item.type === "user_input_request") && <Interaction key={item.request?.id ?? item.id} generationId={generationId} item={item} />}
    {(item.type === "notification" || item.type === "error" || item.type === "compaction") && <>{item.text && <p>{item.text}</p>}{item.output && <pre>{item.output}</pre>}{item.input !== undefined && <pre>{printable(item.input)}</pre>}</>}
    {item.error && <p role="alert" className="native-error">{item.error}</p>}
  </>;
  return <section className={`native-output-card native-${item.type}`}><header>{collapsible ? <button type="button" aria-expanded={open} onClick={toggle}><span aria-hidden>{open ? "▾" : "▸"}</span> {title}</button> : <strong>{title}</strong>}<span className="native-status">{statuses[item.status]} <Duration item={item} /></span></header>{(!collapsible || open) && <div className="native-card-body">{body}</div>}</section>;
});
export function OutputTimeline({ generationId }: { generationId: string }) {
  const { snapshot, error } = useGenerationOutput(generationId);
  return <div className="native-timeline" aria-label="运行输出时间线">{error && <p role="alert">输出连接：{error}</p>}{!snapshot && !error && <p role="status">正在加载运行输出…</p>}{snapshot?.items.map((item) => <OutputRow key={item.id} item={item} generationId={generationId} />)}{snapshot && <div className="native-generation-status" role="status">{snapshot.status === "queued" ? "等待运行" : snapshot.status === "running" ? "正在运行" : snapshot.status === "completed" ? "运行完成" : snapshot.status === "failed" ? "运行失败" : snapshot.status === "cancelled" ? "运行已取消" : "运行已中断"}</div>}</div>;
}
