import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Viewport = "fit" | "desktop" | "tablet" | "mobile";

type NormalizedUrl = { url: string } | { error: string };

const VIEWPORT_OPTIONS: ReadonlyArray<{ value: Viewport; label: string }> = [
  { value: "fit", label: "自适应" },
  { value: "desktop", label: "桌面" },
  { value: "tablet", label: "平板（834）" },
  { value: "mobile", label: "手机（390）" },
];

function isViewport(value: string): value is Viewport {
  return VIEWPORT_OPTIONS.some((option) => option.value === value);
}

function normalizeUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "请输入要预览的网址。" };

  const schemeMatch = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(trimmed);
  let candidate = trimmed;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const rest = trimmed.slice(schemeMatch[0].length);
    // Allow shorthand hosts such as localhost:3000 or 127.0.0.1:8080.
    const isHostPort = /^\d+(?:[/?#]|$)/.test(rest) && !trimmed.includes("://");
    if (scheme !== "http" && scheme !== "https") {
      if (!isHostPort) return { error: "只支持 http:// 或 https:// 网址。" };
      candidate = `http://${trimmed}`;
    }
  } else {
    candidate = `http://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "网址格式无效，请检查后重试。" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "只支持 http:// 或 https:// 网址。" };
  }
  return { url: parsed.toString() };
}

export function BrowserPanel({ active = true }: { active?: boolean }) {
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>("fit");
  const [reloadKey, setReloadKey] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const activatedRef = useRef(false);

  const currentUrl = historyIndex >= 0 ? (history[historyIndex] ?? null) : null;
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;

  useEffect(() => {
    if (!active || activatedRef.current) return;
    const frame = requestAnimationFrame(() => {
      activatedRef.current = true;
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const openAddress = (raw: string) => {
    const result = normalizeUrl(raw);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    const base = history.slice(0, historyIndex + 1);
    const isSame = base.length > 0 && base[base.length - 1] === result.url;
    if (isSame) {
      setHistory(base);
      setHistoryIndex(base.length - 1);
    } else {
      setHistory([...base, result.url]);
      setHistoryIndex(base.length);
    }
    setAddress(result.url);
    if (isSame) setReloadKey((value) => value + 1);
  };

  const goBack = () => {
    if (!canGoBack) return;
    const nextIndex = historyIndex - 1;
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    setAddress(nextUrl);
    setError(null);
  };

  const goForward = () => {
    if (!canGoForward) return;
    const nextIndex = historyIndex + 1;
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    setAddress(nextUrl);
    setError(null);
  };

  const reload = () => {
    if (!currentUrl) return;
    setReloadKey((value) => value + 1);
  };

  const openInNewTab = () => {
    if (!currentUrl) return;
    const anchor = document.createElement("a");
    anchor.href = currentUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  const sandbox = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

  return (
    <div className="inspector-panel">
      <form
        className="inspector-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          openAddress(address);
        }}
      >
        <Input
          ref={inputRef}
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setError(null);
          }}
          placeholder="输入网址，例如 example.com"
          aria-label="预览网址"
          aria-invalid={error ? true : undefined}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" size="sm">
          打开
        </Button>
      </form>

      <div className="inspector-toolbar">
        <Button type="button" variant="ghost" size="sm" onClick={goBack} disabled={!canGoBack}>
          后退
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={goForward}
          disabled={!canGoForward}
        >
          前进
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={reload} disabled={!currentUrl}>
          刷新
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={openInNewTab}
          disabled={!currentUrl}
        >
          在新标签打开
        </Button>
        <span className="inspector-toolbar-spacer" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          视口
          <select
            value={viewport}
            onChange={(event) => {
              const value = event.target.value;
              if (isViewport(value)) setViewport(value);
            }}
            aria-label="预览视口"
            className="h-7 rounded-lg bg-muted px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {VIEWPORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {currentUrl ? (
        <div className="inspector-browser">
          <div className="inspector-browser-stage">
            <iframe
              key={`${currentUrl}:${reloadKey}`}
              src={currentUrl}
              title={`网页预览：${currentUrl}`}
              className="inspector-browser-frame shrink-0"
              data-viewport={viewport}
              sandbox={sandbox}
              referrerPolicy="no-referrer"
            />
          </div>
          <p className="inspector-muted">
            跨域站点可能通过 X-Frame-Options 或 CSP 拒绝嵌入；若页面空白，请使用「在新标签打开」。
          </p>
        </div>
      ) : (
        <div className="inspector-empty space-y-1">
          <p>在上方输入 http:// 或 https:// 网址并点击「打开」，即可在此嵌入预览。</p>
          <p>省略协议时会自动补全 http://；切换上下文或关闭面板会清除预览，页面始终使用隔离的 iframe。</p>
        </div>
      )}
    </div>
  );
}
