// Picker focus and annotation attachment adapted from t3code 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c
// apps/web/src/components/preview/PreviewView.tsx (MIT; see LICENSE.t3code).
import { useCallback, useEffect, useRef, useState } from "react";
import { useMessageContextDraft } from "../../chat/message-context";
import { useAgentText } from "../../i18n";
import {
  normalizeBrowserAddress,
  type BrowserRecentEntry,
  type BrowserViewport,
} from "./browser-history";
import { BrowserChrome } from "./browser-chrome";
import { BrowserRecents } from "./browser-recents";
import type { DesktopPreviewBridge, ElectronWebviewElement, PreviewState } from "./preview-bridge";
import { PreviewAnnotationDialog, type PendingPreviewAnnotation } from "./preview-annotation-dialog";

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * Electron runtime: one renderer-mounted <webview> per Browser surface. The
 * main process owns the session, navigation, screenshots, picker and PiP.
 */
export function NativeBrowserPanel({ bridge, active, onVisit, onMetadata, onTitleChange, recents, onRemoveRecent, onClearRecents }: {
  bridge: DesktopPreviewBridge;
  active: boolean;
  onVisit: (url: string) => void;
  onMetadata: (url: string, metadata: { title?: string; faviconUrl?: string }) => void;
  onTitleChange?: (title: string) => void;
  recents: BrowserRecentEntry[];
  onRemoveRecent: (url: string) => void;
  onClearRecents: () => void;
}) {
  const t = useAgentText();
  const contextDraft = useMessageContextDraft();
  const tabId = useRef(`browser:${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`).current;
  const addressRef = useRef<HTMLInputElement | null>(null);
  const activated = useRef(false);
  const crashRecovery = useRef(0);
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const [partition, setPartition] = useState<string | null>(null);
  const [preload, setPreload] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BrowserViewport>("fit");
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [picking, setPicking] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pipOpen, setPipOpen] = useState(false);
  const [annotation, setAnnotation] = useState<PendingPreviewAnnotation | null>(null);

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
    webviewRef.current = node as ElectronWebviewElement | null;
    if (!node) return;
    const webview = webviewRef.current!;
    const register = () => {
      let id = 0;
      try { id = webview.getWebContentsId(); } catch { return; }
      if (id > 0) void bridge.registerWebview(tabId, id).catch((cause) => setError(errorMessage(cause)));
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    register();
    return () => {
      if (webviewRef.current === webview) webviewRef.current = null;
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
    };
  }, [bridge, tabId]);

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

  const prepareAnnotation = (snapshot: PendingPreviewAnnotation["snapshot"], draft: PendingPreviewAnnotation["draft"]) => {
    if (!draft.isCurrent()) throw new Error(t("会话已切换，捕获的页面上下文未添加。", "The session changed; captured page context was not added."));
    setAnnotation({ contextId: crypto.randomUUID(), attachmentId: crypto.randomUUID(), snapshot, draft });
  };

  const capture = async () => {
    if (!currentUrl || capturing || picking || annotation || !contextDraft.available) return;
    const draft = contextDraft;
    setCapturing(true);
    setContextError(null);
    setNotice(null);
    try {
      prepareAnnotation(await bridge.capture(tabId), draft);
    } catch (cause) {
      setContextError(errorMessage(cause));
    } finally {
      setCapturing(false);
    }
  };

  const pick = async () => {
    if (!currentUrl || picking || capturing || annotation || !contextDraft.available) return;
    const draft = contextDraft;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPicking(true);
    setContextError(null);
    setNotice(null);
    try {
      // Focus the embedder's webview as well as main's WebContents so Esc reaches the picker.
      webviewRef.current?.focus();
      const result = await bridge.pick(tabId);
      if ("cancelled" in result) {
        setNotice(t("已取消元素选择。", "Element selection cancelled."));
        return;
      }
      prepareAnnotation(result, draft);
    } catch (cause) {
      setContextError(errorMessage(cause));
    } finally {
      setPicking(false);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
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
  const contextUnavailable = t("当前消息尚未就绪，无法添加页面上下文。", "The current message is not ready to receive page context.");
  const contextBusy = Boolean(picking || capturing || annotation);
  const actionDisabledReason = !live ? noUrlReason : !contextDraft.available ? contextUnavailable : annotation
    ? t("请先加入或取消当前批注。", "Attach or cancel the current annotation first.") : undefined;
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
      onPick={live && !contextBusy && contextDraft.available ? () => { void pick(); } : undefined}
      pickActive={picking}
      pickDisabledReason={actionDisabledReason ?? (picking ? t("正在选择元素，按 Esc 取消。", "Picking elements; press Esc to cancel.") : capturing ? t("正在截图。", "Capturing screenshot.") : undefined)}
      onCapture={live && !contextBusy && contextDraft.available ? () => { void capture(); } : undefined}
      captureBusy={capturing}
      captureDisabledReason={actionDisabledReason ?? (contextBusy ? t("请先完成当前页面捕获。", "Finish the current page capture first.") : undefined)}
      onTogglePiP={live ? () => { void togglePiP(); } : undefined}
      pipOpen={pipOpen}
      pipDisabledReason={noUrlReason}
      onDevTools={live ? () => { void bridge.openDevTools(tabId).catch((cause) => setError(errorMessage(cause))); } : undefined}
    />
    {error && <p className="inspector-browser-error" role="alert">{error}</p>}
    {contextError && <p className="inspector-browser-error" role="alert">{contextError}</p>}
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
    {annotation && <PreviewAnnotationDialog key={annotation.contextId} pending={annotation} onClose={() => setAnnotation(null)} onAttached={warning => {
      setAnnotation(null);
      if (warning) setContextError(warning);
      else setNotice(t("页面上下文已加入消息，尚未发送。", "Page context was attached to the message; it has not been sent."));
    }} />}
  </div>;
}
