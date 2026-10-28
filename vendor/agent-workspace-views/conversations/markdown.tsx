"use client"

import { useMemo, useState } from "react"
import { Copy, Check } from "lucide-react"
import {
  Streamdown,
  defaultRemarkPlugins,
  type StreamdownProps,
} from "streamdown"
import { Button } from "./ui/button"
import styles from "./markdown.module.css"

export interface MarkdownProps {
  content: string
  locale?: "zh-CN" | "en"
  streaming?: boolean
  className?: string
}

/** Deliberately narrower than Streamdown's wildcard default URL policy. */
export function safeMarkdownUrl(url: string): string | undefined {
  const value = url.trim()
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined
  if (
    value.startsWith("#") ||
    (value.startsWith("/") && !value.startsWith("//"))
  )
    return value
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "mailto:"
      ? value
      : undefined
  } catch {
    return undefined
  }
}

const remarkPlugins = Object.values(defaultRemarkPlugins)
// Removing rehype-raw is intentional: HTML remains inert, not merely sanitized after parsing.
const rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = []
const remarkRehypeOptions = { allowDangerousHtml: false }

function MarkdownCodeBlock({
  code,
  language,
  locale,
}: {
  code: string
  language: string
  locale: "zh-CN" | "en"
}) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const chinese = locale === "zh-CN"
  const copied = copiedCode === code
  return (
    <div className={styles.codeBlock} data-language={language}>
      <div className={styles.codeHeader}>
        <span>{language || (chinese ? "纯文本" : "plain text")}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-label={chinese ? "复制完整代码" : "Copy complete code"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code)
              setCopiedCode(code)
              setCopyError(false)
            } catch {
              setCopiedCode(null)
              setCopyError(true)
            }
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? (chinese ? "已复制" : "Copied") : chinese ? "复制" : "Copy"}
        </Button>
      </div>
      {copyError && (
        <p className={styles.copyError} role="status">
          {chinese
            ? "无法访问剪贴板；可以选中下方完整代码手动复制。"
            : "Clipboard access failed; select the complete code below to copy manually."}
        </p>
      )}
      <pre tabIndex={0}>
        <code className={language ? `language-${language}` : undefined}>
          {code}
        </code>
      </pre>
    </div>
  )
}

/** Full GFM content, with inert HTML, explicit link protocols and no image network requests. */
export function Markdown({
  content,
  locale = "en",
  streaming = false,
  className,
}: MarkdownProps) {
  const components = useMemo<NonNullable<StreamdownProps["components"]>>(
    () => ({
      a: ({ href, children, title }) => {
        const safe = href ? safeMarkdownUrl(href) : undefined
        return safe ? (
          <a
            href={safe}
            title={title}
            rel="noreferrer noopener"
            target={safe.startsWith("http") ? "_blank" : undefined}
          >
            {children}
          </a>
        ) : (
          <span>{children}</span>
        )
      },
      // No img element, src, preload or URL fetch. Image descriptions remain readable.
      img: ({ alt }) => (
        <span className={styles.imageDescription}>
          {locale === "zh-CN" ? "图片未加载" : "Image not loaded"}
          {alt ? `: ${alt}` : ""}
        </span>
      ),
      pre: ({ node }) => {
        const codeNode = node?.children.find(
          (child) => child.type === "element" && child.tagName === "code",
        )
        if (!codeNode || codeNode.type !== "element") return null
        const code = codeNode.children
          .map((child) => (child.type === "text" ? child.value : ""))
          .join("")
        const classNames = codeNode.properties.className
        const languageClass = Array.isArray(classNames)
          ? classNames.find(
              (value) =>
                typeof value === "string" && value.startsWith("language-"),
            )
          : undefined
        const language =
          typeof languageClass === "string"
            ? languageClass.slice("language-".length)
            : ""
        return (
          <MarkdownCodeBlock code={code} language={language} locale={locale} />
        )
      },
    }),
    [locale],
  )
  return (
    <div className={[styles.markdown, className].filter(Boolean).join(" ")}>
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        parseIncompleteMarkdown={streaming}
        skipHtml
        remarkRehypeOptions={remarkRehypeOptions}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={(url, key) =>
          key === "src" ? undefined : safeMarkdownUrl(url)
        }
        components={components}
        controls={false}
      >
        {content}
      </Streamdown>
    </div>
  )
}
