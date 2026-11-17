import { Fragment, useContext, useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Copy, FileCode, Maximize2, WrapText } from "lucide-react";
import { StreamdownContext } from "streamdown";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@agent/components/ui/dialog";
import { cn } from "@agent/lib/utils";
import { markdownMermaidError, markdownTableCsv, markdownTableData, markdownTableMarkdown, type MarkdownNode } from "./markdown-rich-policy";
import { useShikiTokens } from "./use-shiki-tokens";
import styles from "./markdown.module.css";

type Locale = "zh-CN" | "en";

export function MarkdownCopyButton({ text, label, locale }: { text: string; label: string; locale: Locale }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <span className={styles.copyControl}>
    <Button type="button" variant="ghost" size="xs" aria-label={label} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(text); setFailed(false); }
      catch { setCopied(null); setFailed(true); }
    }}>
      {copied === text ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied === text ? (locale === "zh-CN" ? "已复制" : "Copied") : label}
    </Button>
    {failed && <span role="status" className={styles.copyError}>{locale === "zh-CN" ? "复制失败，请手动选择内容。" : "Copy failed; select the content manually."}</span>}
  </span>;
}

function HighlightedCode({ code, language, streaming }: { code: string; language: string; streaming: boolean }) {
  const tokens = useShikiTokens(code, language, streaming);
  return <pre tabIndex={0} data-native-context-menu><code className={language ? `language-${language}` : undefined}>{tokens ? tokens.map((line, index) => <Fragment key={index}>{line.map((token, tokenIndex) => {
    const light = token.variants.light?.color;
    const dark = token.variants.dark?.color;
    const tokenStyle = {
      "--markdown-token-light": /^#[\da-f]{3,8}$/i.test(light ?? "") ? light : undefined,
      "--markdown-token-dark": /^#[\da-f]{3,8}$/i.test(dark ?? "") ? dark : undefined,
    } as CSSProperties;
    return <span key={tokenIndex} className={styles.syntaxToken} style={tokenStyle}>{token.content}</span>;
  })}{index < tokens.length - 1 ? "\n" : ""}</Fragment>) : code}</code></pre>;
}

let diagramQueue: Promise<void> = Promise.resolve();

/** Guard before Mermaid touches the DOM, then sanitize and isolate its generated SVG. */
function renderDiagram(source: string, id: string): Promise<string> {
  const invalid = markdownMermaidError(source);
  if (invalid) return Promise.reject(new Error(invalid));
  const operation = diagramQueue.then(async () => {
    const [{ default: mermaid }, { default: purify }] = await Promise.all([import("mermaid"), import("dompurify")]);
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, maxTextSize: 50_000, maxEdges: 500, htmlLabels: false, flowchart: { htmlLabels: false }, secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "flowchart"] });
    const { svg } = await mermaid.render(id, source);
    const safe = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed", "a", "image", "use", "animate", "animateMotion", "animateTransform", "set"], FORBID_ATTR: ["href", "xlink:href", "src", "onload", "onclick", "onerror"], ALLOW_DATA_ATTR: false });
    if (!safe.includes("<svg")) throw new Error("Diagram did not produce safe SVG.");
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:#fff;color:#111;font:14px system-ui}svg{display:block;max-width:100%;height:auto;margin:auto}</style></head><body>${safe}</body></html>`;
  });
  diagramQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function MermaidDiagram({ code, locale }: { code: string; locale: Locale }) {
  const id = `agent-markdown-${useId().replace(/[^a-z\d]/gi, "")}`;
  const [result, setResult] = useState<{ code: string; document?: string; error?: string } | null>(null);
  useEffect(() => {
    let current = true;
    void renderDiagram(code, id).then(document => { if (current) setResult({ code, document }); }, error => { if (current) setResult({ code, error: error instanceof Error ? error.message : "Invalid Mermaid diagram." }); });
    return () => { current = false; };
  }, [code, id]);
  const active = result?.code === code ? result : null;
  if (active?.error) return <p role="alert" className={styles.diagramError}>Mermaid: {active.error}</p>;
  if (!active?.document) return <p role="status" className={styles.diagramStatus}>{locale === "zh-CN" ? "正在渲染图表…" : "Rendering diagram…"}</p>;
  return <iframe className={styles.diagram} title={locale === "zh-CN" ? "Mermaid 图表（隔离预览）" : "Mermaid diagram (isolated preview)"} sandbox="" referrerPolicy="no-referrer" srcDoc={active.document} />;
}

export function MarkdownCodeBlock({ code, language, title, locale }: { code: string; language: string; title?: string; locale: Locale }) {
  const { isAnimating: streaming } = useContext(StreamdownContext);
  const [wrap, setWrap] = useState(false);
  const [showDiagram, setShowDiagram] = useState(true);
  const chinese = locale === "zh-CN";
  const mermaid = language.toLowerCase() === "mermaid";
  return <div className={styles.codeBlock} data-language={language} data-wrap={wrap}>
    <div className={styles.codeHeader}>
      {title ? <span className={styles.codeTitle} title={title}><FileCode aria-hidden="true" />{title}</span> : <span>{language || (chinese ? "纯文本" : "plain text")}</span>}
      <div className={styles.blockActions}>
        {mermaid && <Button type="button" variant="ghost" size="xs" aria-pressed={showDiagram} onClick={() => setShowDiagram(value => !value)}>{showDiagram ? (chinese ? "查看源码" : "Show source") : (chinese ? "查看图表" : "Show diagram")}</Button>}
        <Button type="button" variant="ghost" size="xs" aria-label={chinese ? "代码自动换行" : "Wrap code"} aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText aria-hidden="true" />{chinese ? "换行" : "Wrap"}</Button>
        <MarkdownCopyButton text={code} label={chinese ? "复制代码" : "Copy code"} locale={locale} />
      </div>
    </div>
    {mermaid && showDiagram && !streaming && <MermaidDiagram code={code} locale={locale} />}
    {mermaid && showDiagram && streaming && <p role="status" className={styles.diagramStatus}>{chinese ? "流式输出完成后渲染图表。" : "Diagram renders when streaming completes."}</p>}
    {(!mermaid || !showDiagram || streaming) ? <HighlightedCode code={code} language={language.toLowerCase()} streaming={streaming} /> : <details className={styles.diagramSource}><summary>{chinese ? "Mermaid 源码" : "Mermaid source"}</summary><HighlightedCode code={code} language="mermaid" streaming={false} /></details>}
  </div>;
}

export function MarkdownTable({ node, children, locale }: { node?: MarkdownNode; children: ReactNode; locale: Locale }) {
  const [expanded, setExpanded] = useState(false);
  const data = useMemo(() => node ? markdownTableData(node) : { headers: [], rows: [] }, [node]);
  const chinese = locale === "zh-CN";
  const actions = <div className={styles.blockActions}>
    <MarkdownCopyButton text={markdownTableCsv(data)} label={chinese ? "复制 CSV" : "Copy CSV"} locale={locale} />
    <MarkdownCopyButton text={markdownTableMarkdown(data)} label={chinese ? "复制 Markdown" : "Copy Markdown"} locale={locale} />
  </div>;
  return <div className={styles.tableBlock}>
    <div className={styles.codeHeader}><span>{chinese ? "表格" : "Table"}</span><div className={styles.blockActions}>{actions}<Button type="button" variant="ghost" size="xs" onClick={() => setExpanded(true)}><Maximize2 aria-hidden="true" />{chinese ? "展开" : "Expand"}</Button></div></div>
    <div className={styles.tableViewport} tabIndex={0} role="region" aria-label={chinese ? "可滚动表格" : "Scrollable table"}><table>{children}</table></div>
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogContent className={cn(styles.markdown, styles.tableDialog)}>
        <DialogTitle>{chinese ? "展开表格" : "Expanded table"}</DialogTitle>
        <DialogDescription>{chinese ? "完整表格；可以横向滚动、复制 CSV 或 Markdown。" : "Complete table. Scroll horizontally or copy CSV or Markdown."}</DialogDescription>
        {actions}
        <div className={styles.expandedTableViewport} tabIndex={0} role="region" aria-label={chinese ? "完整表格" : "Complete table"}><table>{children}</table></div>
      </DialogContent>
    </Dialog>
  </div>;
}
