import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@agent/components/ui/collapsible";
import { useAgentText } from "../i18n";
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

export function TraceRow({ icon, title, description, status, trailing, defaultOpen = false, open: controlledOpen, onOpenChange, children, className }: {
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
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const change = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  return <Collapsible open={open} onOpenChange={change} className={`${styles.traceRow} ${className ?? ""}`}>
    <CollapsibleTrigger className={styles.traceTrigger}>
      <TraceLine
        icon={icon}
        title={title}
        description={description}
        status={status}
        trailing={<>{trailing}<ChevronDown aria-hidden="true" className={styles.chevron} /></>}
      />
    </CollapsibleTrigger>
    <CollapsibleContent className={styles.traceContent}>{children}</CollapsibleContent>
  </Collapsible>;
}

export type TraceBadgeTone = "neutral" | "running" | "success" | "warning" | "error" | "pending";

export function TraceStatusBadge({ status, tone, children }: { status?: TraceStatus; tone?: TraceBadgeTone; children: ReactNode }) {
  return <span className={styles.traceStatus} data-status={status} data-tone={tone}>{children}</span>;
}

export type CodeBlockRow = { text: string; kind?: "context" | "added" | "removed" };

export function CodeBlock({ code, rows, wrap = false, lineNumbers = false, maxHeight = 260 }: {
  code?: string;
  rows?: CodeBlockRow[];
  wrap?: boolean;
  lineNumbers?: boolean;
  maxHeight?: number;
}) {
  const t = useAgentText();
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
      {lines.map((line, index) => <span key={index} className={styles.codeLine} data-variant={line.kind} data-line={lineNumbers ? index + 1 : undefined}>{line.text || " "}</span>)}
    </code></pre>
    {error && <p role="status" className={styles.codeError}>{t("无法访问剪贴板；请手动选择内容。", "Clipboard unavailable; select the content manually.")}</p>}
  </div>;
}
