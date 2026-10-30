import { useEffect, useRef, useState } from "react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { useAgentText, type AgentText } from "../../i18n";
import { agentText } from "../../i18n-text.ts";

type Viewport = "fit" | "desktop" | "tablet" | "mobile";

type NormalizedUrl = { url: string } | { error: string };

const VIEWPORT_VALUES: ReadonlyArray<Viewport> = ["fit", "desktop", "tablet", "mobile"];

function viewportOptions(t: AgentText): ReadonlyArray<{ value: Viewport; label: string }> {
  return [
    { value: "fit", label: t("自适应", "Fit") },
    { value: "desktop", label: t("桌面", "Desktop") },
    { value: "tablet", label: t("平板（834）", "Tablet (834)") },
    { value: "mobile", label: t("手机（390）", "Mobile (390)") },
  ];
}

function isViewport(value: string): value is Viewport {
  return (VIEWPORT_VALUES as ReadonlyArray<string>).includes(value);
}

function normalizeUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { error: agentText("请输入网址。", "Enter a URL.") };

  const schemeMatch = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(trimmed);
  let candidate = trimmed;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const rest = trimmed.slice(schemeMatch[0].length);
    // Allow shorthand hosts such as localhost:3000 or 127.0.0.1:8080.
    const isHostPort = /^\d+(?:[/?#]|$)/.test(rest) && !trimmed.includes("://");
    if (scheme !== "http" && scheme !== "https") {
      if (!isHostPort) {
        return {
          error: agentText(
            "只支持 http:// 或 https:// 网址。",
            "Only http:// and https:// URLs are supported.",
          ),
        };
      }
      candidate = `http://${trimmed}`;
    }
  } else {
    candidate = `http://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: agentText("网址格式无效。", "That URL is not valid.") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      error: agentText(
        "只支持 http:// 或 https:// 网址。",
        "Only http:// and https:// URLs are supported.",
      ),
    };
  }
  return { url: parsed.toString() };
}

export function BrowserPanel({ active = true }: { active?: boolean }) {
  const t = useAgentText();
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
          placeholder={t("输入网址", "Enter a URL")}
          aria-label={t("预览网址", "Preview URL")}
          aria-invalid={error ? true : undefined}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" size="sm">
          {t("打开", "Open")}
        </Button>
      </form>

      <div className="inspector-toolbar">
        <Button type="button" variant="ghost" size="sm" onClick={goBack} disabled={!canGoBack}>
          {t("后退", "Back")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={goForward}
          disabled={!canGoForward}
        >
          {t("前进", "Forward")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={reload} disabled={!currentUrl}>
          {t("刷新", "Reload")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={openInNewTab}
          disabled={!currentUrl}
        >
          {t("在新标签打开", "Open in new tab")}
        </Button>
        <span className="inspector-toolbar-spacer" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("视口", "Viewport")}
          <select
            value={viewport}
            onChange={(event) => {
              const value = event.target.value;
              if (isViewport(value)) setViewport(value);
            }}
            aria-label={t("预览视口", "Preview viewport")}
            className="h-7 rounded-lg bg-muted px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {viewportOptions(t).map((option) => (
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
              title={t(`网页预览：${currentUrl}`, `Web preview: ${currentUrl}`)}
              className="inspector-browser-frame shrink-0"
              data-viewport={viewport}
              sandbox={sandbox}
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
