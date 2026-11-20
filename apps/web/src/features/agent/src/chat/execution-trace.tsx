import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Play } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@agent/components/ui/collapsible";
import { useAgentText } from "../i18n";
import { useShikiTokens } from "./use-shiki-tokens";
import { shellCommandLanguage, visibleCommandText } from "./output-detail-model";
import { requestTerminalRun, TERMINAL_RUN_RESULT_EVENT, useTerminalRunAvailable, type TerminalRunResult } from "./terminal-run";
import styles from "./execution-trace.module.css";

export type TraceStatus = "running" | "error" | "pending";

export function Trace({ children, nested = false, className }: {
  children: ReactNode;
  nested?: boolean;
  className?: string;
}) {
  return <div className={`${styles.trace} ${className ?? ""}`} data-nested={nested || undefined}>{children}</div>;
}

export function TraceLine({ icon, title, description, status, trailing, className }: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: TraceStatus;
  trailing?: ReactNode;
  className?: string;
}) {
  return <span className={`${styles.traceLine} ${className ?? ""}`} data-status={status}>
    <span className={styles.traceIcon}>{icon}</span>
    <span className={styles.traceTitle}>{title}</span>
    {description && <span className={styles.traceDescription}>{description}</span>}
    {trailing && <span className={styles.traceTrailing}>{trailing}</span>}
  </span>;
}

export function TraceRow({ icon, title, description, status, trailing, defaultOpen = false, open: controlledOpen, onOpenChange, children, className, actions }: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: TraceStatus;
  trailing?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  /** Controls kept outside the disclosure trigger so they never nest buttons. */
  actions?: ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const change = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  return <Collapsible open={open} onOpenChange={change} className={`${styles.traceRow} ${className ?? ""}`}>
    <div className={styles.traceHeader}>
      <CollapsibleTrigger className={styles.traceTrigger} title={typeof title === "string" ? title : undefined}>
        <TraceLine
          icon={icon}
          title={title}
          description={description}
          status={status}
          trailing={<>{trailing}<ChevronDown aria-hidden="true" className={styles.chevron} /></>}
        />
      </CollapsibleTrigger>
      {actions && <div className={styles.traceActions}>{actions}</div>}
    </div>
    <CollapsibleContent className={styles.traceContent}>{children}</CollapsibleContent>
  </Collapsible>;
}

export type TraceBadgeTone = "neutral" | "running" | "success" | "warning" | "error" | "pending";

export function TraceStatusBadge({ status, tone, children }: { status?: TraceStatus; tone?: TraceBadgeTone; children: ReactNode }) {
  return <span className={styles.traceStatus} data-status={status} data-tone={tone}>{children}</span>;
}

export type CodeBlockRow = { text: string; kind?: "context" | "added" | "removed" };

export function CodeBlock({ code, rows, wrap = false, lineNumbers = false, maxHeight = 260, language }: {
  code?: string;
  rows?: CodeBlockRow[];
  wrap?: boolean;
  lineNumbers?: boolean;
  maxHeight?: number;
  language?: string;
}) {
  const t = useAgentText();
  const tokens = useShikiTokens(rows ? "" : code ?? "", language ?? "");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const lines: CodeBlockRow[] = rows ?? (code ?? "").split("\n").map(text => ({ text }));
  const copyText = rows ? rows.map(row => row.text).join("\n") : code ?? "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setError(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(true);
    }
  };
  return <div className={styles.codeBlock} data-wrap={wrap || undefined} data-numbered={lineNumbers || undefined}>
    <Button
      size="icon-xs"
      variant="ghost"
      className={styles.codeCopy}
      aria-label={t("复制内容", "Copy content")}
      onClick={copy}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
    <pre className={styles.codeContent} tabIndex={0} style={{ maxHeight }}><code>
      {tokens ? tokens.map((line, index) => <span key={index} className={styles.codeLine} data-line={lineNumbers ? index + 1 : undefined}>{line.map((token, tokenIndex) => {
        const light = token.variants.light?.color;
        const dark = token.variants.dark?.color;
        return <span key={tokenIndex} className={styles.token} style={{ "--code-token-light": /^#[\da-f]{3,8}$/i.test(light ?? "") ? light : undefined, "--code-token-dark": /^#[\da-f]{3,8}$/i.test(dark ?? "") ? dark : undefined } as React.CSSProperties}>{token.content}</span>;
      })}{index < tokens.length - 1 ? "\n" : ""}</span>) : lines.map((line, index) => <span key={index} className={styles.codeLine} data-variant={line.kind} data-line={lineNumbers ? index + 1 : undefined}>{line.text || " "}</span>)}
    </code></pre>
    {error && <p role="status" className={styles.codeError}>{t("无法访问剪贴板；请手动选择内容。", "Clipboard unavailable; select the content manually.")}</p>}
  </div>;
}

/** Command text with visible control characters, per-line layout and a real terminal action.
 * The run button only exists while a mounted execution terminal publishes that capability. */
export function ShellCommandBlock({ command, maxHeight = 260 }: { command: string; maxHeight?: number }) {
  const t = useAgentText();
  const visible = visibleCommandText(command.trim());
  const language = shellCommandLanguage(visible);
  const multiline = visible.includes("\n");
  const runAvailable = useTerminalRunAvailable();
  const [pending, setPending] = useState<string>();
  const [result, setResult] = useState<TerminalRunResult>();
  useEffect(() => {
    if (!pending) return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<TerminalRunResult>).detail;
      if (detail?.requestId !== pending) return;
      setPending(undefined);
      setResult(detail);
    };
    window.addEventListener(TERMINAL_RUN_RESULT_EVENT, listener);
    // Only reconciliation is reported here; the terminal surface owns the real status.
    const timer = window.setTimeout(() => {
      setResult({ requestId: pending, ok: false, message: t("终端尚未确认执行结果，请核对终端面板。", "The terminal has not confirmed the result yet. Check the terminal panel.") });
      setPending(current => current === pending ? undefined : current);
    }, 12_000);
    return () => { window.removeEventListener(TERMINAL_RUN_RESULT_EVENT, listener); window.clearTimeout(timer); };
  }, [pending, t]);
  const run = () => {
    const requestId = requestTerminalRun(command);
    if (!requestId) {
      setResult({ requestId: "", ok: false, message: t("当前视图没有可用的会话终端。", "No session terminal is available in this view.") });
      return;
    }
    setResult(undefined);
    setPending(requestId);
  };
  if (!visible) return null;
  return <div className={styles.shellCommand}>
    <CodeBlock code={visible} language={language} wrap lineNumbers={multiline} maxHeight={maxHeight} />
    {runAvailable && <div className={styles.shellCommandActions}>
      <Button type="button" size="xs" variant="outline" disabled={pending !== undefined} onClick={run}>
        <Play aria-hidden="true" />
        {pending ? t("正在发送到终端…", "Sending to terminal…") : t("在终端运行", "Run in terminal")}
      </Button>
      <span className={styles.shellCommandHint}>{t("目标：当前会话终端", "Target: this session's terminal")}</span>
    </div>}
    {result && <p role={result.ok ? "status" : "alert"} className={result.ok ? styles.shellCommandOk : styles.shellCommandError}>
      {result.ok ? t("命令已写入终端。", "Command sent to the terminal.") : t("未能运行：", "Could not run: ") + (result.message || t("未知原因", "unknown reason"))}
    </p>}
  </div>;
}
