import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useChatActions } from "./chat-actions";
import { useAgentText } from "../i18n";
import { useI18n } from "@/lib/i18n-provider";
import { workspaceClient } from "../network";
import { inspectUrl } from "../workspace/inspector/api";
import {
  markdownAuthorizedImageSource,
  markdownGalleryFileName,
  markdownGalleryIndex,
  markdownImageWithinSizeLimit,
  markdownImageContentTypeAllowed,
  type MarkdownImageFailure,
} from "./markdown-media-policy";
import "./markdown-media-gallery.css";

type MarkdownMediaResource =
  | { status: "loading" }
  | { status: "ready"; url: string; contentType: string; size: number; blob: Blob }
  | { status: "error"; reason: MarkdownImageFailure };

interface MarkdownMediaEntryInput {
  /** Stable per mounted image; also used as the resource key. */
  key: string;
  /** Raw author-provided Markdown source; re-resolved here before any read. */
  src: string;
  alt?: string;
  documentPath?: string;
}

interface MarkdownMediaEntry extends MarkdownMediaEntryInput {
  /** Workspace-relative path resolved inside the session execution root. */
  path: string;
}

interface MarkdownMediaGalleryApi {
  register(entry: MarkdownMediaEntryInput): () => void;
  resources: Readonly<Record<string, MarkdownMediaResource | undefined>>;
  open(key: string): void;
  retry(key: string): void;
}

const MarkdownMediaGalleryContext = createContext<MarkdownMediaGalleryApi | null>(null);

/** Present only under the rich Markdown renderer; inert elsewhere. */
export function useMarkdownMediaGallery(): MarkdownMediaGalleryApi | null {
  return useContext(MarkdownMediaGalleryContext);
}

class MarkdownMediaLoadError extends Error {
  constructor(readonly reason: MarkdownImageFailure) {
    super(reason);
  }
}

type ZoomMode = "fit" | "actual" | "double";
const ZOOM_ORDER: readonly ZoomMode[] = ["fit", "actual", "double"];

/**
 * Collects every session-authorized image in one Markdown message so a click
 * can open a gallery with prev/next and zoom. Images are read only through the
 * existing same-origin inspector media endpoint, and only after both the
 * Markdown source and the resolved path pass `markdownAuthorizedImageSource`.
 */
export function MarkdownMediaProvider({ children }: { children: ReactNode }) {
  const t = useAgentText();
  const chinese = useI18n().locale === "zh-CN";
  const actions = useChatActions();
  const canOpenFiles = Boolean(actions?.canOpenFiles && actions.threadId);
  const executionPath = actions?.executionPath;
  const threadId = canOpenFiles ? actions?.threadId : undefined;

  const [entries, setEntries] = useState<MarkdownMediaEntry[]>([]);
  const [resources, setResources] = useState<Record<string, MarkdownMediaResource>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState<ZoomMode>("fit");
  const [note, setNote] = useState<string | undefined>(undefined);

  const controllers = useRef(new Map<string, AbortController>());
  const urls = useRef(new Map<string, string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, []);

  const revoke = useCallback((key: string) => {
    const url = urls.current.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      urls.current.delete(key);
    }
  }, []);

  const register = useCallback((input: MarkdownMediaEntryInput): (() => void) => {
    const target = markdownAuthorizedImageSource(input.src, { canOpenFiles, executionPath, documentPath: input.documentPath });
    if (!target) return () => {};
    const entry: MarkdownMediaEntry = { ...input, path: target.path };
    setEntries(previous => previous.some(item => item.key === input.key) ? previous : [...previous, entry]);
    return () => {
      setEntries(previous => previous.filter(item => item.key !== input.key));
      controllers.current.get(input.key)?.abort();
      controllers.current.delete(input.key);
      revoke(input.key);
      setResources(previous => {
        if (!(input.key in previous)) return previous;
        const next = { ...previous };
        delete next[input.key];
        return next;
      });
    };
  }, [canOpenFiles, executionPath, revoke]);

  // Auto-load every registered session image. The browser request is a same-origin
  // inspector read; there is no author-controlled URL here.
  useEffect(() => {
    if (!threadId) return;
    for (const entry of entries) {
      if (controllers.current.has(entry.key)) continue;
      const existing = resources[entry.key];
      if (existing?.status === "error") continue;
      if (existing?.status === "ready" && urls.current.has(entry.key)) continue;
      const controller = new AbortController();
      controllers.current.set(entry.key, controller);
      setResources(previous => previous[entry.key] ? previous : { ...previous, [entry.key]: { status: "loading" } });
      void workspaceClient.request(
        inspectUrl("/api/inspector/media", { threadId, path: entry.path }),
        { signal: controller.signal, cache: "no-store" },
      ).then(async response => {
        const contentType = response.headers.get("content-type") ?? "";
        if (!markdownImageContentTypeAllowed(contentType)) throw new MarkdownMediaLoadError("type");
        if (!markdownImageWithinSizeLimit(response.headers.get("content-length"))) throw new MarkdownMediaLoadError("size");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!markdownImageWithinSizeLimit(null, blob.size)) throw new MarkdownMediaLoadError("size");
        const url = URL.createObjectURL(blob);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        urls.current.set(entry.key, url);
        if (!mounted.current) {
          URL.revokeObjectURL(url);
          urls.current.delete(entry.key);
          return;
        }
        setResources(previous => ({
          ...previous,
          [entry.key]: { status: "ready", url, contentType, size: blob.size, blob },
        }));
      }).catch(cause => {
        if (controller.signal.aborted) return;
        const reason: MarkdownImageFailure = cause instanceof MarkdownMediaLoadError ? cause.reason : "unavailable";
        setResources(previous => ({ ...previous, [entry.key]: { status: "error", reason } }));
      }).finally(() => {
        if (controllers.current.get(entry.key) === controller) controllers.current.delete(entry.key);
      });
    }
  }, [entries, resources, threadId]);

  const retry = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    revoke(key);
    setResources(previous => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, [revoke]);

  const open = useCallback((key: string) => {
    setZoom("fit");
    setNote(undefined);
    setOpenKey(key);
  }, []);

  const selectedIndex = openKey ? entries.findIndex(entry => entry.key === openKey) : -1;
  const selected = selectedIndex >= 0 ? entries[selectedIndex] : undefined;

  useEffect(() => {
    if (openKey && selectedIndex < 0) setOpenKey(null);
  }, [openKey, selectedIndex]);

  useEffect(() => {
    setNote(undefined);
  }, [selectedIndex]);

  const step = useCallback((delta: number) => {
    if (entries.length < 1) return;
    const index = markdownGalleryIndex(selectedIndex, delta, entries.length);
    const next = entries[index];
    if (!next) return;
    setZoom("fit");
    setOpenKey(next.key);
  }, [entries, selectedIndex]);

  const resource = selected ? resources[selected.key] : undefined;
  const selectedUrl = resource?.status === "ready" ? resource.url : undefined;
  const canCopyImage = typeof navigator !== "undefined"
    && typeof navigator.clipboard?.write === "function"
    && typeof ClipboardItem !== "undefined"
    && selectedUrl !== undefined;

  const copyImage = async () => {
    if (!selected || resource?.status !== "ready" || !canCopyImage) return;
    try {
      const type = resource.blob.type || resource.contentType || "image/png";
      await navigator.clipboard.write([new ClipboardItem({ [type]: resource.blob })]);
      setNote(t("已复制图片。", "Image copied."));
    } catch {
      setNote(t("复制图片失败。", "Copying the image failed."));
    }
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = ZOOM_ORDER.indexOf(zoom);
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, current + 1)] ?? "double");
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom(ZOOM_ORDER[Math.max(0, current - 1)] ?? "fit");
    } else if (event.key === "0") {
      event.preventDefault();
      setZoom("fit");
    }
  };

  const zoomLabels: Record<ZoomMode, string> = {
    fit: t("适应宽度", "Fit width"),
    actual: t("1×", "1×"),
    double: t("2×", "2×"),
  };

  const value = useMemo<MarkdownMediaGalleryApi>(() => ({ register, resources, open, retry }), [register, resources, open, retry]);

  return <MarkdownMediaGalleryContext.Provider value={value}>
    {children}
    {selected && <Dialog open onOpenChange={next => { if (!next) setOpenKey(null); }}>
      <DialogContent
        className="md-media-gallery-dialog"
        style={{ width: "min(72rem, calc(100vw - 2rem))", maxWidth: "min(72rem, calc(100vw - 2rem))", maxHeight: "calc(100dvh - 2rem)" }}
        onKeyDown={onDialogKeyDown}
      >
        <DialogTitle className="md-media-gallery-title">{selected.alt?.trim() || markdownGalleryFileName(selected.path)}</DialogTitle>
        <DialogDescription className="md-media-gallery-description">
          {t(`本会话已授权图片，共 ${entries.length} 张。使用左右方向键切换，Escape 关闭。`, `Session-authorized gallery with ${entries.length} image${entries.length === 1 ? "" : "s"}. Use the arrow keys to switch and Escape to close.`)}
        </DialogDescription>
        <div className="md-media-gallery-toolbar">
          <div className="md-media-gallery-nav">
            <button type="button" className="md-media-gallery-button" onClick={() => step(-1)} disabled={entries.length < 2} aria-label={t("上一张", "Previous image")} title={t("上一张", "Previous image")}>
              <ChevronLeftIcon aria-hidden="true" />
            </button>
            <span className="md-media-gallery-count" aria-live="polite">{selectedIndex + 1} / {entries.length}</span>
            <button type="button" className="md-media-gallery-button" onClick={() => step(1)} disabled={entries.length < 2} aria-label={t("下一张", "Next image")} title={t("下一张", "Next image")}>
              <ChevronRightIcon aria-hidden="true" />
            </button>
          </div>
          <div className="md-media-gallery-zoom" role="group" aria-label={t("缩放", "Zoom")}>
            {ZOOM_ORDER.map(mode => <button
              key={mode}
              type="button"
              className="md-media-gallery-button"
              aria-pressed={zoom === mode}
              onClick={() => setZoom(mode)}
            >{zoomLabels[mode]}</button>)}
          </div>
          {selectedUrl && <a className="md-media-gallery-action" href={selectedUrl} download={markdownGalleryFileName(selected.path)}>
            <DownloadIcon aria-hidden="true" />{t("下载", "Download")}
          </a>}
          {canCopyImage && <button type="button" className="md-media-gallery-action" onClick={() => { void copyImage(); }}>
            <CopyIcon aria-hidden="true" />{t("复制图片", "Copy image")}
          </button>}
        </div>
        {note && <span className="md-media-gallery-note" role="status">{note}</span>}
        <div className="md-media-gallery-stage" data-zoom={zoom}>
          {resource?.status === "ready"
            ? <img src={resource.url} alt={selected.alt?.trim() || selected.path} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
            : resource?.status === "error"
              ? <div className="md-media-gallery-stage-error" role="alert">
                  <span>{galleryFailureText(resource.reason, chinese)}</span>
                  <button type="button" className="md-media-gallery-button" onClick={() => retry(selected.key)}>{t("重新加载", "Reload")}</button>
                </div>
              : <span role="status" className="md-media-gallery-loading">{t("正在读取已授权图片…", "Loading authorized image…")}</span>}
        </div>
        {entries.length > 1 && <ul className="md-media-gallery-thumbs" aria-label={t("图片画廊", "Image gallery")}>
          {entries.map((entry, index) => {
            const item = resources[entry.key];
            const label = entry.alt?.trim() || entry.path;
            return <li key={entry.key}>
              <button
                type="button"
                className="md-media-gallery-thumb"
                aria-current={index === selectedIndex ? "true" : undefined}
                aria-label={`${t(`查看第 ${index + 1} 张图片`, `View image ${index + 1}`)}${label ? `: ${label}` : ""}`}
                title={label}
                onClick={() => { setZoom("fit"); setOpenKey(entry.key); }}
              >
                {item?.status === "ready"
                  ? <img src={item.url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                  : <span className="md-media-gallery-thumb-placeholder" aria-hidden="true">{index + 1}</span>}
              </button>
            </li>;
          })}
        </ul>}
      </DialogContent>
    </Dialog>}
  </MarkdownMediaGalleryContext.Provider>;
}

export function galleryFailureText(reason: MarkdownImageFailure, chinese: boolean): string {
  if (reason === "type") return chinese ? "此文件不是可内嵌的图片类型。" : "This file is not an embeddable image type.";
  if (reason === "size") return chinese ? "图片超过 20 MiB 预览限制。" : "The image exceeds the 20 MiB preview limit.";
  return chinese ? "图片读取失败。" : "The image could not be loaded.";
}
