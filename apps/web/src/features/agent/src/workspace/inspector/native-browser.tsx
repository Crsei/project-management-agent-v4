import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentText } from "../../i18n";
import {
  normalizeBrowserAddress,
  type BrowserRecentEntry,
  type BrowserViewport,
} from "./browser-history";
import { BrowserChrome } from "./browser-chrome";
import { BrowserRecents } from "./browser-recents";
import type { DesktopPreviewBridge, ElectronWebviewElement, PreviewState } from "./preview-bridge";

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

/**
 * Electron runtime: one renderer-mounted <webview> per Browser surface. The
 * main process owns the session, navigation, screenshots, picker and PiP.
 */
export function NativeBrowserPanel({ bridge, active, onVisit, onMetadata, onAttachImage, onTitleChange, recents, onRemoveRecent, onClearRecents }: {
  bridge: DesktopPreviewBridge;
  active: boolean;
  onVisit: (url: string) => void;
  onMetadata: (url: string, metadata: { title?: string; faviconUrl?: string }) => void;
  onAttachImage?: (file: File) => void | Promise<void>;
  onTitleChange?: (title: string) => void;
  recents: BrowserRecentEntry[];
  onRemoveRecent: (url: string) => void;
  onClearRecents: () => void;
}) {
  const t = useAgentText();
  const tabId = useRef(`browser:${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`).current;
  const addressRef = useRef<HTMLInputElement | null>(null);
  const activated = useRef(false);
  const crashRecovery = useRef(0);
  const [partition, setPartition] = useState<string | null>(null);
  const [preload, setPreload] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BrowserViewport>("fit");
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [picking, setPicking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pipOpen, setPipOpen] = useState(false);

  useEffect(() => {
    if (!active || activated.current) return;
    activated.current = true;
    const frame = requestAnimationFrame(() => addressRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => bridge.onState((state: PreviewState) => {
    if (state.tabId !== tabId) return;
    setCurrentUrl(state.url);
    if (document.activeElement !== addressRef.current) setAddress(state.url ?? "");
    setLoading(state.loading);
    setCanGoBack(state.canGoBack);
    setCanGoForward(state.canGoForward);
    if (state.navStatus.kind === "success") {
      crashRecovery.current = 0;
      setError(null);
      const url = state.url ?? state.navStatus.url;
      if (url && url !== "about:blank") onVisit(url);
      if (state.title) onTitleChange?.(state.title);
      onMetadata(url, { title: state.title, faviconUrl: state.faviconUrl });
    } else if (state.navStatus.kind === "failed") {
      setLoading(false);
      setError(state.navStatus.description || t("页面加载失败。", "The page could not be loaded."));
      if (state.navStatus.description.startsWith("Renderer exited") && crashRecovery.current < 2) {
        crashRecovery.current += 1;
        setGeneration((value) => value + 1);
      }
    }
  }), [bridge, tabId, onMetadata, onTitleChange, onVisit, t]);

  useEffect(() => bridge.onOpenLink(({ tabId: source, url }) => {
    if (source !== tabId) return;
    void bridge.openExternal(url).catch((cause) => setError(errorMessage(cause)));
  }), [bridge, tabId]);

  useEffect(() => () => {
    void bridge.closePiP(tabId).catch(() => {});
    void bridge.closeTab(tabId).catch(() => {});
  }, [bridge, tabId]);

  const registerWebview = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const webview = node as ElectronWebviewElement;
    const register = () => {
      let id = 0;
      try { id = webview.getWebContentsId(); } catch { return; }
      if (id > 0) void bridge.registerWebview(tabId, id).catch((cause) => setError(errorMessage(cause)));
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    register();
    return () => {
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
    };
  }, [bridge, tabId]);

  const attachImage = async (dataUrl: string, name: string, message: string) => {
    if (onAttachImage) {
      await onAttachImage(await dataUrlToFile(dataUrl, name));
      setNotice(message);
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = name;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setNotice(t("图片已下载。", "The image was downloaded."));
  };

  const openAddress = async (raw: string) => {
    const result = normalizeBrowserAddress(raw);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    const url = "search" in result ? result.search : result.url;
    setError(null);
    setNotice(null);
    onVisit(url);
    if (!partition) {
      try {
        const created = await bridge.createTab(tabId, { url });
        setPartition(created.partition);
        setPreload(created.preload);
        setCurrentUrl(url);
        setAddress(url);
        setLoading(true);
      } catch (cause) {
        setError(errorMessage(cause));
      }
      return;
    }
    try {
      setCurrentUrl(url);
      setAddress(url);
      setLoading(true);
      await bridge.navigate(tabId, url);
    } catch (cause) {
      setLoading(false);
      setError(errorMessage(cause));
    }
  };

  const submitAddress = () => {
    void openAddress(address);
    addressRef.current?.blur();
  };

  const reload = () => {
    setLoading(true);
    void bridge.reload(tabId).catch((cause) => { setLoading(false); setError(errorMessage(cause)); });
  };

  const capture = async () => {
    if (!currentUrl || capturing) return;
    setCapturing(true);
    setError(null);
    try {
      const result = await bridge.capture(tabId);
      await attachImage(result.dataUrl, "browser-screenshot.png", t("截图已加入消息附件。", "Screenshot added to the message."));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCapturing(false);
    }
  };

  const pick = async () => {
    if (!currentUrl || picking) return;
    setPicking(true);
    setError(null);
    try {
      const result = await bridge.pick(tabId);
      if ("cancelled" in result) {
        setNotice(t("已取消元素选择。", "Element selection cancelled."));
        return;
      }
      await attachImage(result.dataUrl, "browser-element.png", t("已选择页面元素并加入消息附件。", "Selected element added to the message."));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPicking(false);
    }
  };

  const togglePiP = async () => {
    try {
      if (pipOpen) {
        await bridge.closePiP(tabId);
        setPipOpen(false);
      } else {
        await bridge.openPiP(tabId);
        setPipOpen(true);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const openInNewTab = () => {
    if (currentUrl) window.open(currentUrl, "_blank", "noopener,noreferrer");
  };

  const copyUrl = () => {
    if (!currentUrl) return;
    void navigator.clipboard?.writeText(currentUrl).then(
      () => setNotice(t("网址已复制。", "URL copied.")),
      () => setError(t("无法复制网址。", "Could not copy the URL.")),
    );
  };

  const live = Boolean(currentUrl && partition);
  const noUrlReason = t("先打开一个页面。", "Open a page first.");
  return <div className="inspector-panel">
    <BrowserChrome
      address={address}
      onAddressChange={(value) => { setAddress(value); setError(null); }}
      onAddressSubmit={submitAddress}
      onAddressEscape={() => setAddress(currentUrl ?? "")}
      addressRef={addressRef}
      addressInvalid={Boolean(error)}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      hasUrl={Boolean(currentUrl)}
      loading={loading}
      onBack={() => { void bridge.back(tabId).catch((cause) => setError(errorMessage(cause))); }}
      onForward={() => { void bridge.forward(tabId).catch((cause) => setError(errorMessage(cause))); }}
      onReload={reload}
      onOpenInNewTab={openInNewTab}
      onCopyUrl={copyUrl}
      onClearRecents={onClearRecents}
      hasRecents={recents.length > 0}
      viewport={viewport}
      onViewportChange={setViewport}
      onPick={live && !picking ? () => { void pick(); } : undefined}
      pickActive={picking}
      pickDisabledReason={picking ? t("正在选择元素，按 Esc 取消。", "Picking elements; press Esc to cancel.") : noUrlReason}
      onCapture={live && !capturing ? () => { void capture(); } : undefined}
      captureBusy={capturing}
      captureDisabledReason={noUrlReason}
      onTogglePiP={live ? () => { void togglePiP(); } : undefined}
      pipOpen={pipOpen}
      pipDisabledReason={noUrlReason}
      onDevTools={live ? () => { void bridge.openDevTools(tabId).catch((cause) => setError(errorMessage(cause))); } : undefined}
    />
    {error && <p className="inspector-browser-error" role="alert">{error}</p>}
    {notice && <p className="inspector-browser-notice" role="status">{notice}</p>}
    {currentUrl
      ? <div className="inspector-browser">
        <div className="inspector-browser-stage" data-viewport={viewport}>
          {partition && preload && <webview
            key={`${tabId}:${generation}`}
            ref={registerWebview}
            src="about:blank"
            partition={partition}
            preload={preload}
            allowpopups
            className="inspector-browser-webview"
            data-viewport={viewport}
          />}
        </div>
      </div>
      : <BrowserRecents recents={recents} onOpen={(url) => { void openAddress(url); }} onRemove={onRemoveRecent} t={t} />}
  </div>;
}
