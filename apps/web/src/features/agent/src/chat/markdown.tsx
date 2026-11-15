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
  return <div className={cn(styles.markdown, className)}>
    <Streamdown
      key={scopeKey}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      skipHtml
      remarkRehypeOptions={remarkRehypeOptions}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={(url, key) => {
        if (executionPath && markdownFileReference(url, executionPath, documentPath)) return url;
        return key === "src" ? undefined : safeMarkdownUrl(url);
      }}
      components={components}
      controls={false}
    >{content}</Streamdown>
  </div>;
}
