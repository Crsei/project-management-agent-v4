import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { BookOpenIcon, CopyIcon, ExternalLinkIcon, FileTextIcon, GitBranchIcon, MessagesSquareIcon, PackageIcon, PlayIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useChatActions } from "./chat-actions";
import { useAgentText } from "../i18n";
import { workspaceClient } from "../network";
import { inspectUrl } from "../workspace/inspector/api";
import { markdownFileReference, markdownSessionLink, safeMarkdownUrl } from "./markdown-url";
import { markdownMediaCandidate, markdownMediaKind, type MarkdownMediaKind } from "./markdown-rich-policy";
import { galleryFailureText, useMarkdownMediaGallery } from "./markdown-media-gallery";
import { markdownAuthorizedImageSource, markdownImageCopySource } from "./markdown-media-policy";
import { markdownExternalHost, markdownLinkHostIcon, type MarkdownLinkHostIcon } from "./markdown-link-host";
import { isMarkdownCitationHref, markdownCitationExcerpt, parseMarkdownCitationHref } from "./markdown-citation";
import { AnchorlessCitationCard, MarkdownCitationChip } from "./markdown-citation-chip";
import styles from "./markdown.module.css";
import "./markdown-link.css";

type Locale = "zh-CN" | "en";
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const InsideMarkdownLink = createContext(false);

/** Only an explicit click reads binary bytes from this session's authorized inspector. */
function SessionMediaPreview({ path, label, locale }: { path: string; label: string; locale: Locale }) {
  const actions = useChatActions();
  const threadId = actions?.canOpenFiles ? actions.threadId : undefined;
  const scope = `${threadId ?? ""}:${actions?.executionPath ?? ""}:${path}`;
  const [requested, setRequested] = useState<string | null>(null);
  const [result, setResult] = useState<{ scope: string; url: string; kind: MarkdownMediaKind } | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const chinese = locale === "zh-CN";
  useEffect(() => {
    if (!threadId || requested !== scope) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void workspaceClient.request(inspectUrl("/api/inspector/media", { threadId, path }), { signal: controller.signal, cache: "no-store" }).then(async response => {
      const kind = markdownMediaKind(response.headers.get("content-type") ?? "");
      if (!kind) throw new Error("markdown_media_type");
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_PREVIEW_BYTES) throw new Error("markdown_media_size");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (blob.size > MAX_PREVIEW_BYTES) throw new Error("markdown_media_size");
      objectUrl = URL.createObjectURL(blob);
      setResult({ scope, url: objectUrl, kind });
      setError(null);
    }).catch(cause => {
      if (!controller.signal.aborted) setError({ scope, message: cause instanceof Error ? cause.message : "markdown_media_unavailable" });
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [threadId, requested, scope, path]);
  if (!threadId) return null;
  const active = result?.scope === scope && requested === scope ? result : null;
  const failureCode = error?.scope === scope && requested === scope ? error.message : null;
  const failure = failureCode === "markdown_media_type" ? (chinese ? "此文件类型不允许内嵌预览。" : "This file type is not allowed in an inline preview.")
    : failureCode === "markdown_media_size" ? (chinese ? "媒体超过 20 MiB 预览限制。" : "Media exceeds the 20 MiB preview limit.")
    : failureCode === "markdown_media_unavailable" ? (chinese ? "媒体预览读取失败。" : "Media preview could not be loaded.") : failureCode;
  return <span className={styles.mediaPreview}>
    <button type="button" className={styles.inlineAction} onClick={() => { setRequested(value => value === scope ? null : scope); setResult(null); setError(null); }} aria-expanded={requested === scope}>{requested === scope ? (chinese ? "关闭预览" : "Close preview") : (chinese ? "预览媒体" : "Preview media")}</button>
    {requested === scope && !active && !failure && <span role="status">{chinese ? "正在读取已授权媒体…" : "Loading authorized media…"}</span>}
    {failure && <span role="alert" className={styles.linkError}>{failure}</span>}
    {active && <span className={styles.mediaContent}>
      {active.kind === "image" ? <img src={active.url} alt={label} referrerPolicy="no-referrer" /> : active.kind === "audio" ? <audio src={active.url} aria-label={label} controls preload="none" /> : <video src={active.url} aria-label={label} controls preload="none" />}
    </span>}
  </span>;
}

const hostIcons: Record<MarkdownLinkHostIcon, typeof ExternalLinkIcon> = {
  code: GitBranchIcon,
  package: PackageIcon,
  book: BookOpenIcon,
  video: PlayIcon,
  discussion: MessagesSquareIcon,
  document: FileTextIcon,
  external: ExternalLinkIcon,
};

/**
 * External Markdown anchors keep the existing `rel`/`target` policy and add a
 * local host glyph plus a link context menu. Right-click is normally left to
 * the browser for `a[href]`; `allowNativeTarget` opts this link in explicitly.
 */
function MarkdownExternalLink({ href, host, title, children }: { href: string; host: string; title?: string; children: ReactNode }) {
  const t = useAgentText();
  const Icon = hostIcons[markdownLinkHostIcon(host)];
  const [status, setStatus] = useState<string>();
  useEffect(() => {
    if (status === undefined) return;
    const timer = window.setTimeout(() => setStatus(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);
  return <span>
    <ContextMenu>
      <ContextMenuTrigger asChild allowNativeTarget>
        <a
          href={href}
          title={title ?? `${host} · ${href}`}
          rel="noreferrer noopener"
          target="_blank"
          data-external-host={host}
          data-markdown-external-link=""
          className="md-external-link"
        >
          <Icon aria-hidden="true" />
          {children}
          <span className="md-external-link-host" aria-hidden="true">{host}</span>
        </a>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t("链接操作", "Link actions")}>
        <ContextMenuItem onSelect={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(href);
              setStatus(t("已复制链接。", "Link copied."));
            } catch {
              setStatus(t("复制链接失败，请手动复制。", "Copying the link failed; copy it manually."));
            }
          })();
        }}><CopyIcon aria-hidden="true" size={16} />{t("复制链接", "Copy link")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => {
          const opened = window.open(href, "_blank", "noopener,noreferrer");
          if (opened) opened.opener = null;
        }}><SquareArrowOutUpRightIcon aria-hidden="true" size={16} />{t("在新窗口打开", "Open in new window")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuLabel dir="ltr" className="max-w-72 truncate">{href}</ContextMenuLabel>
      </ContextMenuContent>
    </ContextMenu>
    {status && <span role="status" className="sr-only">{status}</span>}
  </span>;
}

export function MarkdownLink({ href, title, children, locale, documentPath }: { href?: string; title?: string; children: ReactNode; locale: Locale; documentPath?: string }) {
  const actions = useChatActions();
  const [error, setError] = useState<string | null>(null);
  const label = <InsideMarkdownLink.Provider value>{children}</InsideMarkdownLink.Provider>;
  const citation = href && isMarkdownCitationHref(href) ? href : undefined;
  if (citation) {
    const anchor = parseMarkdownCitationHref(citation);
    if (anchor) return <MarkdownCitationChip anchor={anchor} locale={locale} />;
    const excerpt = markdownCitationExcerpt(citation);
    // No source id: keep the existing quote card and never synthesize an anchor.
    if (excerpt) return <AnchorlessCitationCard text={excerpt} />;
  }
  const file = href && actions?.canOpenFiles && actions.executionPath ? markdownFileReference(href, actions.executionPath, documentPath) : undefined;
  const session = href && actions ? markdownSessionLink(href, window.location.origin) : undefined;
  const safe = href ? safeMarkdownUrl(href) : undefined;
  if (session && actions) return <button type="button" className={styles.fileLink} title={title ?? session} onClick={() => {
    try { void actions.navigateSession(session).catch(cause => setError(cause instanceof Error ? cause.message : (locale === "zh-CN" ? "无法打开该会话。" : "Cannot open this session."))); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : (locale === "zh-CN" ? "无法打开该会话。" : "Cannot open this session.")); }
  }}>{label}</button>;
  if (file && actions) return <span>
    <button type="button" className={styles.fileLink} title={title ?? file.path} onClick={() => {
      try { actions.openFile(file.path, file.line); setError(null); }
      catch (cause) { setError(cause instanceof Error ? cause.message : (locale === "zh-CN" ? "无法在此会话打开文件。" : "Cannot open this file in the current session.")); }
    }}>{label}</button>
    {markdownMediaCandidate(file.path) && <SessionMediaPreview key={`${actions.threadId}:${actions.executionPath}:${file.path}`} path={file.path} label={file.path} locale={locale} />}
    {error && <span className={styles.linkError} role="alert">{error}</span>}
  </span>;
  const host = safe ? markdownExternalHost(safe) : undefined;
  if (safe && host) return <MarkdownExternalLink href={safe} host={host} title={title}>{label}</MarkdownExternalLink>;
  return safe ? <a href={safe} title={title} rel="noreferrer noopener" target={/^https?:/i.test(safe) ? "_blank" : undefined}>{label}</a> : <span>{children}</span>;
}

export function MarkdownImage({ src, alt, locale, documentPath }: { src?: string; alt?: string; locale: Locale; documentPath?: string }) {
  const actions = useChatActions();
  const gallery = useMarkdownMediaGallery();
  const insideLink = useContext(InsideMarkdownLink);
  const mediaKey = useId();
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const chinese = locale === "zh-CN";
  const file = src && actions?.canOpenFiles && actions.executionPath ? markdownFileReference(src, actions.executionPath, documentPath) : undefined;
  // Auto-load only images that resolve into this session's authorized execution
  // root. Inside an anchor the image stays non-interactive so no control nests.
  const target = src && actions?.canOpenFiles && actions.threadId && actions.executionPath
    ? markdownAuthorizedImageSource(src, { canOpenFiles: true, executionPath: actions.executionPath, documentPath })
    : undefined;
  const resource = target && gallery ? gallery.resources[mediaKey] : undefined;
  useEffect(() => {
    // Depend on the stable register callback, not the whole context value: the
    // value changes on every media resource update and would abort/reload it.
    if (!target || !gallery || !src) return;
    return gallery.register({ key: mediaKey, src, alt, documentPath });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- target is derived from these fields.
  }, [gallery?.register, mediaKey, src, alt, documentPath, target?.path]);
  if (target && gallery && insideLink) {
    return <span className={styles.mediaInlineImage}>
      {resource?.status === "ready"
        ? <img
            className={styles.mediaImage}
            src={resource.url}
            alt={alt ?? target.path}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        : resource?.status === "error"
          ? <span className={styles.mediaHint}>{galleryFailureText(resource.reason, chinese)}</span>
          : <span className={styles.mediaHint} role="status">{chinese ? "正在读取会话内已授权图片…" : "Loading session-authorized image…"}</span>}
    </span>;
  }
  if (target && gallery) {
    return <figure className={styles.mediaFigure} data-markdown-media="authorized">
      {resource?.status === "ready"
        ? <button
            type="button"
            className={styles.mediaImageButton}
            onClick={() => gallery.open(mediaKey)}
            aria-label={`${chinese ? "放大图片" : "Enlarge image"}${alt ? `: ${alt}` : ""}`}
            title={chinese ? "打开图片画廊" : "Open image gallery"}
          >
            <img
              className={styles.mediaImage}
              src={resource.url}
              alt={alt ?? target.path}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
          </button>
        : resource?.status === "error"
          ? <div className={styles.mediaFigureError} role="alert">
              <span>{galleryFailureText(resource.reason, chinese)}</span>
              <span className={styles.mediaFigureActions}>
                <button type="button" className={styles.inlineAction} onClick={() => gallery.retry(mediaKey)}>{chinese ? "重新加载" : "Reload"}</button>
                <MarkdownLink href={src} locale={locale} documentPath={documentPath}>{chinese ? "在文件检查器中打开" : "Open in file inspector"}</MarkdownLink>
              </span>
            </div>
          : <span className={styles.mediaLoading} role="status">{chinese ? "正在读取会话内已授权图片…" : "Loading session-authorized image…"}</span>}
    </figure>;
  }
  const copySource = markdownImageCopySource(src);
  const copyLink = async () => {
    if (!copySource) return;
    try {
      await navigator.clipboard.writeText(copySource);
      setCopyStatus(chinese ? "已复制图片链接。" : "Image link copied.");
    } catch {
      setCopyStatus(chinese ? "复制链接失败，请手动复制。" : "Copying the link failed; copy it manually.");
    }
  };
  return <span className={styles.imageDescription}>
    <span>{chinese ? "图片未自动加载" : "Image not loaded automatically"}{alt ? `: ${alt}` : ""}</span>
    {!insideLink && (file
      ? <MarkdownLink href={src} locale={locale} documentPath={documentPath}>{chinese ? "在文件检查器中打开" : "Open in file inspector"}</MarkdownLink>
      : copySource
        ? <span className={styles.mediaFigureActions}>
            <button type="button" className={styles.inlineAction} onClick={() => { void copyLink(); }}>{chinese ? "复制图片链接" : "Copy image link"}</button>
            <span className={styles.mediaHint}>{chinese ? "外部图片不会自动请求。" : "External images are never requested automatically."}</span>
          </span>
        : <span className={styles.mediaHint}>{chinese ? "仅预览当前会话文件；不请求外部图片。" : "Only current-session files can be previewed; external images are not requested."}</span>)}
    {copyStatus && <span role="status" className={styles.mediaHint}>{copyStatus}</span>}
  </span>;
}
