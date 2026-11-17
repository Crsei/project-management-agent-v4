import { useMemo } from "react";
import { Streamdown, defaultRemarkPlugins, type StreamdownProps } from "streamdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { cn } from "@agent/lib/utils";
import { useChatActions } from "./chat-actions";
import { markdownFileReference, safeMarkdownUrl } from "./markdown-url";
import { MarkdownCodeBlock, MarkdownTable } from "./markdown-blocks";
import { MarkdownImage, MarkdownLink } from "./markdown-links";
import { markdownNodeText } from "./markdown-rich-policy";
import { splitDetailsBlocks } from "./markdown-details";
import styles from "./markdown.module.css";

export interface MarkdownProps {
  content: string;
  locale?: "zh-CN" | "en";
  streaming?: boolean;
  className?: string;
  /** Root-relative source document for inspector previews; chat messages omit it. */
  documentPath?: string;
}

const remarkPlugins: NonNullable<StreamdownProps["remarkPlugins"]> = [...Object.values(defaultRemarkPlugins), remarkMath];
// No rehype-raw: author HTML stays inert. KaTeX generates only non-trusted math output.
const rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [[rehypeKatex, { throwOnError: false, strict: "error", trust: false, maxExpand: 1000, maxSize: 20 }]];
const remarkRehypeOptions = { allowDangerousHtml: false };

/** The single rich renderer used by native output, assistant-ui text and inspector Markdown. */
export function Markdown({ content, locale = "en", streaming = false, className, documentPath }: MarkdownProps) {
  const actions = useChatActions();
  const executionPath = actions?.canOpenFiles && actions.threadId ? actions.executionPath : undefined;
  // Streamdown 2.5 ignores components/urlTransform in its memo comparison. Reparse
  // unchanged content when authorization, session, source document or locale changes.
  const scopeKey = JSON.stringify([actions?.threadId, executionPath, documentPath, locale]);
  const segments = useMemo(() => splitDetailsBlocks(content), [content]);
  const components = useMemo<NonNullable<StreamdownProps["components"]>>(() => ({
    a: ({ href, children, title }) => <MarkdownLink href={href} title={title} locale={locale} documentPath={documentPath}>{children}</MarkdownLink>,
    // Never emit an author-provided image URL. Preview requires a separate explicit authorized read.
    img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} locale={locale} documentPath={documentPath} />,
    table: ({ node, children }) => <MarkdownTable node={node} locale={locale}>{children}</MarkdownTable>,
    pre: ({ node, children }) => {
      const codeNode = node?.children.find(child => child.type === "element" && child.tagName === "code");
      if (!codeNode || codeNode.type !== "element") return <pre tabIndex={0}>{children}</pre>;
      const classNames = codeNode.properties.className;
      const languageClass = Array.isArray(classNames) ? classNames.find(value => typeof value === "string" && value.startsWith("language-")) : undefined;
      const language = typeof languageClass === "string" ? languageClass.slice("language-".length) : "";
      return <MarkdownCodeBlock code={markdownNodeText(codeNode)} language={language} locale={locale} />;
    },
  }), [locale, documentPath]);
  const render = (value: string, key: string) => <Streamdown
    key={key}
    mode={streaming ? "streaming" : "static"}
    isAnimating={streaming}
    parseIncompleteMarkdown={streaming}
    skipHtml
    remarkRehypeOptions={remarkRehypeOptions}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    urlTransform={(url, transformKey) => {
      if (executionPath && markdownFileReference(url, executionPath, documentPath)) return url;
      return transformKey === "src" ? undefined : safeMarkdownUrl(url);
    }}
    components={components}
    controls={false}
  >{value}</Streamdown>;
  // Details are only interpreted after the block is complete, and only the two
  // structural tags are recognized; the body still goes through the safe renderer.
  if (!streaming && segments.some(segment => segment.kind === "details")) {
    return <div className={cn(styles.markdown, className)}>
      {segments.map((segment, index) => segment.kind === "markdown"
        ? (segment.content.trim() ? render(segment.content, `${scopeKey}:${index}`) : null)
        : <details key={`${scopeKey}:details:${index}`} className={styles.detailsBlock}>
            <summary className={styles.detailsSummary}>{segment.summary}</summary>
            <Markdown content={segment.body} locale={locale} documentPath={documentPath} />
          </details>)}
    </div>;
  }
  return <div className={cn(styles.markdown, className)}>{render(content, scopeKey)}</div>;
}
