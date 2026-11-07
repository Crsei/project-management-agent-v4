import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { useAgentText } from "../../i18n";
import {
  normalizeBrowserAddress,
  type BrowserRecentEntry,
  type BrowserViewport,
} from "./browser-history";
import { BrowserChrome } from "./browser-chrome";
import { BrowserRecents } from "./browser-recents";

/**
 * Browser-only fallback: a sandboxed iframe. Cross-origin pages get their real
 * origin so module scripts/CSS load; same-origin pages are blocked because a
 * sandboxed same-origin iframe could otherwise escape into the host document.
 */
export function IframeBrowserPanel({ active, onVisit, recents, onRemoveRecent, onClearRecents }: {
  active: boolean;
  onVisit: (url: string) => void;
  recents: BrowserRecentEntry[];
  onRemoveRecent: (url: string) => void;
  onClearRecents: () => void;
}) {
  const t = useAgentText();
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BrowserViewport>("fit");
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const activated = useRef(false);

  const currentUrl = historyIndex >= 0 ? (history[historyIndex] ?? null) : null;
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;
  const sameOrigin = !!currentUrl && new URL(currentUrl).origin === window.location.origin;
  const sandbox = `allow-scripts allow-forms allow-popups allow-modals allow-downloads${currentUrl && !sameOrigin ? " allow-same-origin" : ""}`;

  useEffect(() => {
    if (!active || activated.current) return;
    activated.current = true;
    const frame = requestAnimationFrame(() => addressRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    setAddress(currentUrl ?? "");
  }, [currentUrl]);

  useEffect(() => {
    if (currentUrl && sameOrigin) setLoading(false);
  }, [currentUrl, sameOrigin]);

  const openAddress = (raw: string) => {
    const result = normalizeBrowserAddress(raw);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    if ("search" in result) {
      window.open(result.search, "_blank", "noopener,noreferrer");
      setError(null);
      return;
    }
    setError(null);
    const base = history.slice(0, historyIndex + 1);
    const isSame = base.length > 0 && base[base.length - 1] === result.url;
    if (isSame) {
      setHistory(base);
      setHistoryIndex(base.length - 1);
      setReloadKey((value) => value + 1);
    } else {
      setHistory([...base, result.url]);
      setHistoryIndex(base.length);
    }
    setAddress(result.url);
    setLoading(new URL(result.url).origin !== window.location.origin);
    onVisit(result.url);
    addressRef.current?.blur();
  };

  const goBack = () => {
    if (!canGoBack) return;
    const nextIndex = historyIndex - 1;
    const next = history[nextIndex];
    if (!next) return;
    setHistoryIndex(nextIndex);
    setAddress(next);
    setError(null);
    setLoading(new URL(next).origin !== window.location.origin);
    onVisit(next);
  };

  const goForward = () => {
    if (!canGoForward) return;
    const nextIndex = historyIndex + 1;
    const next = history[nextIndex];
    if (!next) return;
    setHistoryIndex(nextIndex);
    setAddress(next);
    setError(null);
    setLoading(new URL(next).origin !== window.location.origin);
    onVisit(next);
  };

  const reload = () => {
    if (!currentUrl) return;
    setLoading(!sameOrigin);
    setReloadKey((value) => value + 1);
  };

  const openInNewTab = () => {
    if (currentUrl) window.open(currentUrl, "_blank", "noopener,noreferrer");
  };

  const copyUrl = () => {
    if (!currentUrl) return;
    void navigator.clipboard?.writeText(currentUrl).then(
      () => setError(null),
      () => setError(t("无法复制网址。", "Could not copy the URL.")),
    );
  };

  return <div className="inspector-panel">
    <BrowserChrome
      address={address}
      onAddressChange={(value) => { setAddress(value); setError(null); }}
      onAddressSubmit={() => openAddress(address)}
      onAddressEscape={() => setAddress(currentUrl ?? "")}
      addressRef={addressRef}
      addressInvalid={Boolean(error)}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      hasUrl={Boolean(currentUrl)}
      loading={loading}
      onBack={goBack}
      onForward={goForward}
      onReload={reload}
      onOpenInNewTab={openInNewTab}
      onCopyUrl={copyUrl}
      onClearRecents={onClearRecents}
      hasRecents={recents.length > 0}
      viewport={viewport}
      onViewportChange={setViewport}
      pickDisabledReason={t("元素选择需要桌面版浏览器。", "Element picking requires the desktop app.")}
      captureDisabledReason={t("截图需要桌面版浏览器。", "Screenshots require the desktop app.")}
      pipDisabledReason={t("浮动预览需要桌面版浏览器。", "Floating preview requires the desktop app.")}
    />
    {error && <p className="inspector-browser-error" role="alert">{error}</p>}
    {currentUrl
      ? sameOrigin
        ? <div className="inspector-browser-blocked" role="status">
          <Globe aria-hidden="true" />
          <h3>{t("同源页面无法在沙箱中预览", "Same-origin preview is blocked")}</h3>
          <p>{t("此地址与当前 Agent 页面同源，沙箱会阻止它的脚本和样式。请在新标签页打开。", "This address shares the Agent page origin, so the sandbox blocks its scripts and styles. Open it in a new tab.")}</p>
          <button type="button" className="inspector-browser-open" onClick={openInNewTab}>{t("在新标签页打开", "Open in a new tab")}</button>
        </div>
        : <div className="inspector-browser">
          <div className="inspector-browser-stage" data-viewport={viewport}>
            <iframe
              key={`${currentUrl}:${reloadKey}`}
              src={currentUrl}
              title={t(`网页预览：${currentUrl}`, `Web preview: ${currentUrl}`)}
              className="inspector-browser-frame"
              data-viewport={viewport}
              sandbox={sandbox}
              referrerPolicy="no-referrer"
              onLoad={() => setLoading(false)}
            />
          </div>
        </div>
      : <BrowserRecents recents={recents} onOpen={openAddress} onRemove={onRemoveRecent} t={t} />}
  </div>;
}
