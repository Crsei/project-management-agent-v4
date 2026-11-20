import { useEffect, useState } from "react";
import { ExternalLink, FileSearch, Image as ImageIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n-provider";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { GenerationOutputStatus, NativeOutputItem } from "@agent-workspace/contracts/output";
import { useAgentText, type AgentText } from "../i18n";
import { workspaceClient } from "../network";
import { inspectUrl } from "../workspace/inspector/api";
import { useChatActions } from "./chat-actions";
import { normalizeChatFilePath } from "./chat-actions-policy";
import { CodeBlock, TraceStatusBadge, type TraceBadgeTone } from "./execution-trace";
import { markdownMediaCandidate, markdownMediaKind } from "./markdown-rich-policy";
import { FileChanges } from "./native-file-changes";
import { NativeSubagentLink } from "./native-subagent-link";
import { formatElapsedMs, structuredText, tokenizeJson, visibleCommandText } from "./output-detail-model";
import { commandText, reliableDurationMs } from "./output-presenter";
import "./item-inspector.css";

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

const TYPE_LABEL: Record<NativeOutputItem["type"], readonly [string, string]> = {
  assistant_message: ["回复", "Reply"],
  reasoning: ["思考", "Thinking"],
  command_execution: ["命令", "Command"],
  file_change: ["文件变更", "File change"],
  file_search: ["文件搜索", "File search"],
  web_search: ["网页搜索", "Web search"],
  dynamic_tool: ["工具", "Tool"],
  todo_list: ["待办", "To-do"],
  proposed_plan: ["计划", "Plan"],
  subagent: ["子代理", "Subagent"],
  approval_request: ["审批", "Approval"],
  user_input_request: ["需要回答", "Input needed"],
  notification: ["通知", "Notification"],
  error: ["错误", "Error"],
  compaction: ["上下文压缩", "Compaction"],
};

const STATUS_LABEL: Record<NativeOutputItem["status"], readonly [string, string]> = {
  pending: ["待处理", "Pending"],
  running: ["进行中", "Running"],
  waiting: ["等待中", "Waiting"],
  completed: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  cancelled: ["已取消", "Cancelled"],
  interrupted: ["已中断", "Interrupted"],
  unknown: ["待核实", "Awaiting reconciliation"],
};

const STATUS_TONE: Record<NativeOutputItem["status"], TraceBadgeTone> = {
  pending: "pending", running: "running", waiting: "warning", completed: "success",
  failed: "error", cancelled: "neutral", interrupted: "error", unknown: "warning",
};

function safeHttpUrl(value?: string): string | undefined {
  // oxlint-disable-next-line no-control-regex -- reject ambiguous/control-bearing provider URLs.
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

function formatTimestamp(value: string | undefined, locale: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString(locale === "en" ? "en-US" : "zh-CN");
}

function HighlightedJson({ value, label, t }: { value: unknown; label: string; t: AgentText }) {
  const { text, json } = structuredText(value);
  if (!text) return null;
  if (!json) return <div className="native-inspector-field">
    <b>{label}</b>
    <CodeBlock code={text} wrap maxHeight={260} />
  </div>;
  const tokens = tokenizeJson(text);
  return <div className="native-inspector-field">
    <b>{label}</b>
    <pre className="native-json" tabIndex={0} aria-label={t("JSON 内容", "JSON content")}><code>{tokens.map((token, index) => <span key={index} data-token={token.kind}>{token.text}</span>)}</code></pre>
  </div>;
}

/** Only an explicit click reads bytes from this session's already-authorized inspector. */
function InspectorMedia({ path }: { path: string }) {
  const t = useAgentText();
  const actions = useChatActions();
  const threadId = actions?.canOpenFiles ? actions.threadId : undefined;
  const executionPath = actions?.executionPath;
  const normalized = threadId && executionPath ? normalizeChatFilePath(path, executionPath) : null;
  const [requested, setRequested] = useState(false);
  const [media, setMedia] = useState<{ url: string; alt: string }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!requested || !threadId || !normalized) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoading(true); setError(undefined); setMedia(undefined);
    void workspaceClient.request(inspectUrl("/api/inspector/media", { threadId, path: normalized }), { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (markdownMediaKind(response.headers.get("content-type") ?? "") !== "image") throw new Error(t("此文件不是可预览的图片。", "This file is not a previewable image."));
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_PREVIEW_BYTES) throw new Error(t("图片超过 20 MiB 预览限制。", "The image exceeds the 20 MiB preview limit."));
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (blob.size > MAX_PREVIEW_BYTES) throw new Error(t("图片超过 20 MiB 预览限制。", "The image exceeds the 20 MiB preview limit."));
      objectUrl = URL.createObjectURL(blob);
      setMedia({ url: objectUrl, alt: normalized });
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("图片读取失败。", "The image could not be loaded."));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [requested, threadId, normalized, t]);
  if (!threadId || !normalized) return null;
  return <div className="native-inspector-media">
    <Button type="button" size="xs" variant="outline" aria-expanded={requested} onClick={() => { setRequested(value => !value); setMedia(undefined); setError(undefined); }}>
      <ImageIcon aria-hidden="true" />{requested ? t("收起图片", "Hide image") : t("加载图片预览", "Load image preview")}
    </Button>
    <span className="native-inspector-path" title={normalized}>{normalized}</span>
    {requested && loading && <span role="status">{t("正在读取同源授权媒体…", "Loading same-origin authorized media…")}</span>}
    {error && <span role="alert">{error}</span>}
    {media && <img className="native-inspector-image" src={media.url} alt={media.alt} referrerPolicy="no-referrer" />}
  </div>;
}

/** A provider URL only counts when it points at this origin's inspector media route. */
function sameOriginInspectorMediaPath(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== "/api/inspector/media") return undefined;
    return url.searchParams.get("path") || undefined;
  } catch { return undefined; }
}

function mediaPaths(item: NativeOutputItem, executionPath: string | undefined): string[] {
  const candidates: string[] = [];
  for (const result of item.results ?? []) {
    if (result.path && markdownMediaCandidate(result.path)) candidates.push(result.path);
    const embedded = result.url ? sameOriginInspectorMediaPath(result.url) : undefined;
    if (embedded && markdownMediaCandidate(embedded)) candidates.push(embedded);
  }
  const input = item.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ["path", "file_path", "filePath", "output_path"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && markdownMediaCandidate(value)) candidates.push(value);
    }
  }
  if (!executionPath) return [];
  return [...new Set(candidates)].filter(path => normalizeChatFilePath(path, executionPath) !== null);
}

export function ItemInspectorDialog({ item, generationId, generationStatus, open, onOpenChange }: {
  item: NativeOutputItem;
  generationId: string;
  generationStatus: GenerationOutputStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useAgentText();
  const { locale } = useI18n();
  const actions = useChatActions();
  const [typeZh, typeEn] = TYPE_LABEL[item.type];
  const [statusZh, statusEn] = STATUS_LABEL[item.status];
  const command = item.type === "command_execution" ? commandText(item) : undefined;
  const duration = reliableDurationMs(item, generationStatus, Date.now());
  const changes = item.changes?.length ? item.changes : item.fileName ? [{ path: item.fileName, operation: "", diff: item.diff }] : [];
  const startedAt = formatTimestamp(item.startedAt, locale);
  const completedAt = formatTimestamp(item.completedAt, locale);
  const images = mediaPaths(item, actions?.executionPath);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="native-inspector-dialog" style={{ width: "min(56rem, calc(100vw - 2rem))", maxWidth: "min(56rem, calc(100vw - 2rem))" }}>
      <DialogHeader>
        <DialogTitle>{t(typeZh, typeEn)}</DialogTitle>
        <DialogDescription>{item.title || item.toolName || item.id}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <dl className="native-inspector-meta">
          <div><dt>{t("类型", "Type")}</dt><dd><code>{item.type}</code></dd></div>
          <div><dt>{t("状态", "Status")}</dt><dd><TraceStatusBadge tone={STATUS_TONE[item.status]}>{t(statusZh, statusEn)}</TraceStatusBadge></dd></div>
          <div><dt>{t("开始", "Started")}</dt><dd>{startedAt || t("未报告", "Not reported")}</dd></div>
          <div><dt>{t("结束", "Completed")}</dt><dd>{completedAt || t("未报告", "Not reported")}</dd></div>
          <div><dt>{t("耗时", "Duration")}</dt><dd>{duration === undefined ? t("未报告", "Not reported") : formatElapsedMs(duration)}</dd></div>
          {item.model && <div><dt>{t("模型", "Model")}</dt><dd>{item.model}</dd></div>}
          {item.exitCode !== undefined && <div><dt>{t("退出码", "Exit code")}</dt><dd>{item.exitCode}</dd></div>}
          <div><dt>{t("条目 ID", "Item ID")}</dt><dd><code>{item.id}</code></dd></div>
          {item.parentItemId && <div><dt>{t("父条目", "Parent item")}</dt><dd><code>{item.parentItemId}</code></dd></div>}
          {item.childSessionId && <div><dt>{t("子会话", "Child session")}</dt><dd><code>{item.childSessionId}</code></dd></div>}
        </dl>
        {item.visibility === "redacted" || item.visibility === "unavailable"
          ? <p role="status">{item.visibility === "redacted" ? t("内容已不可访问。", "This content is no longer accessible.") : t("暂时无法核验内容访问权限。", "Content access cannot be verified right now.")}</p>
          : <>
            {item.type === "subagent" && <section className="native-inspector-section">
              <h4>{t("子代理", "Subagent")}</h4>
              <NativeSubagentLink generationId={generationId} item={item} />
            </section>}
            {command && <section className="native-inspector-section">
              <h4>{t("命令", "Command")}</h4>
              <CodeBlock code={visibleCommandText(command.trim())} language="bash" wrap lineNumbers maxHeight={260} />
            </section>}
            {item.type === "assistant_message" || item.type === "reasoning" || item.type === "notification" || item.type === "error" || item.type === "compaction"
              ? <section className="native-inspector-section"><h4>{t("文本", "Text")}</h4><pre className="native-json" tabIndex={0}>{item.text || t("未报告", "Not reported")}</pre></section>
              : null}
            {item.input !== undefined && <section className="native-inspector-section"><h4>{t("输入", "Input")}</h4><HighlightedJson value={item.input} label={t("请求输入", "Request input")} t={t} /></section>}
            {item.output !== undefined && item.output !== "" && <section className="native-inspector-section"><h4>{t("输出", "Output")}</h4><HighlightedJson value={item.output} label={t("工具输出", "Tool output")} t={t} /></section>}
            {!!item.results?.length && <section className="native-inspector-section">
              <h4>{t("结果", "Results")}</h4>
              <ul className="native-inspector-results">
                {(item.results ?? []).map((result, index) => {
                  const url = safeHttpUrl(result.url);
                  const normalizedPath = result.path && actions?.executionPath ? normalizeChatFilePath(result.path, actions.executionPath) : null;
                  const openFile = normalizedPath && actions && actions.canOpenFiles ? () => actions.openFile(normalizedPath) : undefined;
                  return <li key={index}>
                    <strong>{result.title || result.path || url || t("结果", "Result")}</strong>
                    {result.path && <span className="native-inspector-path" title={result.path}>{result.path}{result.line !== undefined ? `:${result.line}` : ""}</span>}
                    {url && <a href={url} target="_blank" rel="noopener noreferrer">{t("打开链接", "Open link")}<ExternalLink aria-hidden="true" /></a>}
                    {openFile && <Button type="button" size="xs" variant="ghost" onClick={openFile}><FileSearch aria-hidden="true" />{t("打开文件", "Open file")}</Button>}
                    {result.text && <p>{result.text}</p>}
                  </li>;
                })}
              </ul>
            </section>}
            {images.length > 0 && <section className="native-inspector-section">
              <h4>{t("同源媒体", "Same-origin media")}</h4>
              <p className="native-inspector-note">{t("仅在点击后从当前会话授权的文件检查器读取；不会自动加载外部图片。", "Loaded only after a click from this session's authorized file inspector; external images are never loaded automatically.")}</p>
              {images.map(path => <InspectorMedia key={path} path={path} />)}
            </section>}
            {changes.length > 0 && <section className="native-inspector-section">
              <h4>{t("差异", "Diff")}</h4>
              <div className="native-inspector-actions">
                {changes.map((change, index) => <Button key={`${change.path}:${index}`} type="button" size="xs" variant="outline" disabled={!actions?.canOpenFiles} onClick={() => {
                  try { actions?.openDiff(change.path); } catch { /* canOpenFiles covers authorization; inspector reports the failure. */ }
                }}>{t("打开差异：", "Open diff: ")}{change.path}</Button>)}
              </div>
              <FileChanges item={item} navigation={false} />
            </section>}
          </>}
        <p className="native-inspector-note">{t("只读详情；这里没有回滚或写入操作。", "Read-only details; there are no rollback or write actions here.")}</p>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/** Row-level entry; rendering it inside a row keeps the dialog lazily mounted. */
export function ItemInspectorButton({ item, generationId, generationStatus }: {
  item: NativeOutputItem;
  generationId: string;
  generationStatus: GenerationOutputStatus;
}) {
  const t = useAgentText();
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" size="icon-xs" variant="ghost" className="native-inspector-button" aria-label={t("条目详情", "Item details")} title={t("条目详情", "Item details")} onClick={() => setOpen(true)}>
      <FileSearch aria-hidden="true" />
    </Button>
    {open && <ItemInspectorDialog item={item} generationId={generationId} generationStatus={generationStatus} open={open} onOpenChange={setOpen} />}
  </>;
}
