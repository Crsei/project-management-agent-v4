import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useChatActions } from "./chat-actions";
import { workspaceClient } from "../network";
import { inspectUrl } from "../workspace/inspector/api";
import { markdownFileReference, markdownSessionLink, safeMarkdownUrl } from "./markdown-url";
import { markdownMediaCandidate, markdownMediaKind, type MarkdownMediaKind } from "./markdown-rich-policy";
import styles from "./markdown.module.css";

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

export function MarkdownLink({ href, title, children, locale, documentPath }: { href?: string; title?: string; children: ReactNode; locale: Locale; documentPath?: string }) {
  const actions = useChatActions();
  const [error, setError] = useState<string | null>(null);
  const label = <InsideMarkdownLink.Provider value>{children}</InsideMarkdownLink.Provider>;
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
  return safe ? <a href={safe} title={title} rel="noreferrer noopener" target={/^https?:/i.test(safe) ? "_blank" : undefined}>{label}</a> : <span>{children}</span>;
}

export function MarkdownImage({ src, alt, locale, documentPath }: { src?: string; alt?: string; locale: Locale; documentPath?: string }) {
  const actions = useChatActions();
  const insideLink = useContext(InsideMarkdownLink);
  const file = src && actions?.canOpenFiles && actions.executionPath ? markdownFileReference(src, actions.executionPath, documentPath) : undefined;
  const chinese = locale === "zh-CN";
  return <span className={styles.imageDescription}>
    <span>{chinese ? "图片未自动加载" : "Image not loaded automatically"}{alt ? `: ${alt}` : ""}</span>
    {!insideLink && (file ? <MarkdownLink href={src} locale={locale} documentPath={documentPath}>{chinese ? "在文件检查器中打开" : "Open in file inspector"}</MarkdownLink> : <span className={styles.mediaHint}>{chinese ? "仅预览当前会话文件；不请求外部图片。" : "Only current-session files can be previewed; external images are not requested."}</span>)}
  </span>;
}
