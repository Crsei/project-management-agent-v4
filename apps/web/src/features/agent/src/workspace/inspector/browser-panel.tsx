import { useCallback, useMemo, useState } from "react";
import {
  addBrowserRecent,
  readBrowserRecents,
  updateBrowserRecentMetadata,
  writeBrowserRecents,
  type BrowserRecentEntry,
} from "./browser-history";
import { IframeBrowserPanel } from "./iframe-browser";
import { NativeBrowserPanel } from "./native-browser";
import { desktopPreviewBridge } from "./preview-bridge";

/**
 * The Browser surface chooses a runtime once: Electron gets a native <webview>
 * with picker/screenshot/PiP; plain web keeps the sandboxed iframe fallback.
 */
export function BrowserPanel({ active = true, onAttachImage, onTitleChange }: {
  active?: boolean;
  onAttachImage?: (file: File) => void | Promise<void>;
  onTitleChange?: (title: string) => void;
}) {
  const bridge = useMemo(() => desktopPreviewBridge(), []);
  const [recents, setRecents] = useState<BrowserRecentEntry[]>(() => readBrowserRecents());

  const visit = useCallback((url: string) => {
    setRecents((current) => {
      const next = addBrowserRecent(current, url);
      writeBrowserRecents(next);
      return next;
    });
  }, []);

  const metadata = useCallback((url: string, value: { title?: string; faviconUrl?: string }) => {
    setRecents((current) => {
      const next = updateBrowserRecentMetadata(current, url, value);
      writeBrowserRecents(next);
      return next;
    });
  }, []);

  const remove = useCallback((url: string) => {
    setRecents((current) => {
      const next = current.filter((entry) => entry.url !== url);
      writeBrowserRecents(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecents([]);
    writeBrowserRecents([]);
  }, []);

  return bridge
    ? <NativeBrowserPanel bridge={bridge} active={active} onVisit={visit} onMetadata={metadata} onAttachImage={onAttachImage} onTitleChange={onTitleChange} recents={recents} onRemoveRecent={remove} onClearRecents={clear} />
    : <IframeBrowserPanel active={active} onVisit={visit} recents={recents} onRemoveRecent={remove} onClearRecents={clear} />;
}
