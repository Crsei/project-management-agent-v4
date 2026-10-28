"use client"
import {
  isValidElement,
  useMemo,
  useState,
  type JSX,
  type MouseEvent,
} from "react"
import {
  CodeBlock,
  Streamdown,
  useIsCodeFenceIncomplete,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import {
  MESSAGE_CONTENT_DEFAULT_MAXIMUM,
  isDrawableImageUrl,
  messageContentCodePlugin,
  messageContentText,
  messageContentUrlTransform,
  type MessageContentImages,
} from "../../lib/message-content-model"
import styles from "./message-content.module.css"

export type MessageContentProps = {
  /** Raw message body; rendered as GFM Markdown with streaming-safe parsing. */
  content: string
  /** Characters actually rendered; defaults to 32768 and clamps to 262144. */
  maximum?: number
  /** While the source is still streaming, incomplete fences keep their text. */
  streaming?: boolean
  /** Host capability: without a resolver no markdown image is requested. */
  images?: MessageContentImages
  className?: string
}

/** Raw HTML stays visible text: keep rehype-raw out of the pipeline. */
const SAFE_REHYPE_PLUGINS: NonNullable<StreamdownProps["rehypePlugins"]> = []
const LINK_SAFETY_OFF: NonNullable<StreamdownProps["linkSafety"]> = {
  enabled: false,
}
const CONTROLS_OFF: NonNullable<StreamdownProps["controls"]> = {
  code: false,
  table: false,
}
const CODE_PLUGIN: NonNullable<StreamdownProps["plugins"]> = {
  code: messageContentCodePlugin,
}

function SafeLink(props: JSX.IntrinsicElements["a"] & ExtraProps) {
  const { href, children } = props
  if (!href) {
    return (
      <span
        className={styles.linkInert}
        data-streamdown="link"
        data-inert="true"
      >
        {children}
      </span>
    )
  }
  const external = /^[a-z][a-z0-9+.-]*:/i.test(href)
  return (
    <a
      className={cn(styles.link, props.className)}
      data-streamdown="link"
      href={href}
      rel={external ? "noreferrer noopener" : undefined}
      target={external ? "_blank" : undefined}
      title={props.title}
    >
      {children}
    </a>
  )
}

type MessageImageProps = JSX.IntrinsicElements["img"] &
  ExtraProps & {
    images?: MessageContentImages
  }

function MessageImage(props: MessageImageProps) {
  const [failed, setFailed] = useState(false)
  const { src, alt, title, images } = props
  const rawSource = typeof src === "string" ? src : ""
  const resolved = rawSource ? images?.resolve?.(rawSource) : undefined
  const drawable = resolved && !failed && isDrawableImageUrl(resolved)
  if (!drawable || !resolved) {
    const inert = rawSource
      ? alt
        ? `${alt} (${rawSource})`
        : rawSource
      : (alt ?? "")
    if (!inert) return null
    return (
      <span
        className={styles.imageInert}
        data-inert="true"
        data-streamdown="image"
      >
        {inert}
      </span>
    )
  }
  return (
    // Host-gated markdown images stay framework-neutral; the public package
    // must not depend on next/image.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt ?? ""}
      className={styles.image}
      data-streamdown="image"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={resolved}
      title={title}
    />
  )
}

function codeTextOf(children: unknown): string {
  if (typeof children === "string") return children
  if (
    isValidElement(children) &&
    typeof children.props === "object" &&
    children.props !== null &&
    "children" in children.props &&
    typeof children.props.children === "string"
  ) {
    return children.props.children
  }
  return ""
}

function MarkdownCode(props: JSX.IntrinsicElements["code"] & ExtraProps) {
  const { t } = useI18n()
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  )
  const incomplete = useIsCodeFenceIncomplete()
  const className = typeof props.className === "string" ? props.className : ""
  const language = /language-([^\s]+)/.exec(className)?.[1] ?? ""
  const block = "data-block" in props

  const copyLabel =
    copyState === "copied"
      ? t("workbench.copied")
      : copyState === "failed"
        ? t("workbench.copyFailed")
        : t("workbench.copy")

  const onCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    try {
      const container = event.currentTarget.closest(
        '[data-streamdown="code-block"]',
      )
      const pre = container?.querySelector("pre")
      if (!pre) throw new Error("code block missing")
      const lines = Array.from(
        pre.querySelectorAll(":scope > code > span"),
        (line) => (line.textContent ?? "").replace(/\n$/, ""),
      )
      const shown =
        lines.length > 0 ? lines.join("\n") : (pre.textContent ?? "")
      await navigator.clipboard.writeText(shown)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  if (!block) {
    return <code className={styles.inlineCode}>{props.children}</code>
  }

  return (
    <CodeBlock
      className={className}
      code={codeTextOf(props.children)}
      isIncomplete={incomplete}
      language={language}
      lineNumbers={false}
    >
      {language ? (
        <span className={styles.codeLanguage}>{language}</span>
      ) : null}
      <Button
        className={styles.copyButton}
        onClick={onCopy}
        size="sm"
        variant="ghost"
      >
        {copyLabel}
      </Button>
      <span className={styles.visuallyHidden} role="status">
        {copyState === "idle" ? "" : copyLabel}
      </span>
    </CodeBlock>
  )
}

/**
 * Bounded, streaming-safe message body: full GFM through Streamdown, raw
 * HTML as literal text, inert unsafe links, host-gated images and Shiki
 * highlighting through the installed root `shiki`.
 */
export function MessageContent({
  content,
  maximum = MESSAGE_CONTENT_DEFAULT_MAXIMUM,
  streaming = false,
  images,
  className,
}: MessageContentProps) {
  const { t } = useI18n()
  const shikiTheme = useMemo<NonNullable<StreamdownProps["shikiTheme"]>>(
    () => ["github-light", "github-dark"],
    [],
  )
  const components = useMemo<Components>(
    () => ({
      a: SafeLink,
      code: MarkdownCode,
      img: (props) => <MessageImage {...props} images={images} />,
    }),
    [images],
  )
  const bound = messageContentText(content, maximum)
  return (
    <div className={cn(styles.root, className)} data-message-content="">
      <Streamdown
        className={styles.markdown}
        components={components}
        controls={CONTROLS_OFF}
        linkSafety={LINK_SAFETY_OFF}
        lineNumbers={false}
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown
        plugins={CODE_PLUGIN}
        rehypePlugins={SAFE_REHYPE_PLUGINS}
        shikiTheme={shikiTheme}
        urlTransform={messageContentUrlTransform}
      >
        {bound}
      </Streamdown>
      {bound.length < content.length ? (
        <p className={styles.truncated}>{t("workbench.truncated")}</p>
      ) : null}
    </div>
  )
}
