import { useState } from "react";
import { Globe, History, X } from "lucide-react";
import { relativeTime, recentHost, recentLabel, recentPath, type BrowserRecentEntry } from "./browser-history";

function RecentFavicon({ entry }: { entry: BrowserRecentEntry }) {
  const [failed, setFailed] = useState(false);
  let source: string | null = entry.faviconUrl ?? null;
  if (!source) {
    try {
      source = new URL("/favicon.ico", entry.url).href;
    } catch { /* Keep the globe fallback. */ }
  }
  return <span className="inspector-browser-recent-icon" aria-hidden="true">
    {!failed && source
      ? <img src={source} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <Globe />}
  </span>;
}

export function BrowserRecents({ recents, onOpen, onRemove, t }: {
  recents: BrowserRecentEntry[];
  onOpen: (url: string) => void;
  onRemove: (url: string) => void;
  t: (zh: string, en: string) => string;
}) {
  if (recents.length === 0) {
    return <div className="inspector-browser-empty">
      <div className="inspector-browser-no-recents">
        <Globe aria-hidden="true" />
        <h3>{t("暂无预览", "No preview yet")}</h3>
        <p>{t("在上方输入网址，或从最近记录打开。", "Type a URL above, or open a recent page.")}</p>
      </div>
    </div>;
  }
  return <div className="inspector-browser-empty">
    <div className="inspector-browser-recents">
      <div className="inspector-browser-recents-heading">
        <History aria-hidden="true" />
        <h3>{t("最近使用", "Recently used")}</h3>
      </div>
      <div className="inspector-browser-recent-list">
        {recents.map((entry) => <div key={entry.url} className="inspector-browser-recent-row">
          <button type="button" className="inspector-browser-recent" onClick={() => onOpen(entry.url)} aria-label={recentLabel(entry.url)}>
            <RecentFavicon entry={entry} />
            <span className="inspector-browser-recent-text">
              <span className="inspector-browser-recent-title">{entry.title ?? recentHost(entry.url)}</span>
              <span className="inspector-browser-recent-meta">
                {entry.title ? `${recentLabel(entry.url)} · ` : `${recentPath(entry.url)} · `}
                {relativeTime(entry.visitedAt)}
              </span>
            </span>
          </button>
          <button type="button" className="inspector-browser-recent-remove" aria-label={t("从最近记录中移除", "Remove from recent history")} title={t("从最近记录中移除", "Remove from recent history")} onClick={() => onRemove(entry.url)}><X /></button>
        </div>)}
      </div>
    </div>
  </div>;
}
