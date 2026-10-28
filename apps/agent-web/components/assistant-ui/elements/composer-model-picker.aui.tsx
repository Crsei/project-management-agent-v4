"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { CheckIcon, ChevronDownIcon, Loader2Icon, SearchIcon, Settings2Icon, StarIcon } from "lucide-react";
import type { ProviderInstance, ProviderModel } from "@agent-workspace/contracts/provider";
import { Popover, PopoverContent, PopoverTrigger } from "@easyuse-ui/ui/components/ui/popover";
import { cn } from "@/lib/utils";
import { ProviderGlyph } from "@/src/settings/provider-card";

export type ComposerModelPickerCatalog = {
  providers: readonly ProviderInstance[];
  loading: boolean;
  error?: string | null;
  refresh: () => void | Promise<void>;
};

export type ComposerModelPickerProps = {
  providerInstanceId: string;
  model: string;
  onChange: (providerInstanceId: string, model: string) => void | Promise<void>;
  catalog: ComposerModelPickerCatalog;
  className?: string;
  disabled?: boolean;
  saving?: boolean;
  saveError?: string;
  onRetry?: () => void | Promise<void>;
};

type ModelItem = { provider: ProviderInstance; model: ProviderModel; key: string };
type Section = { kind: "favorites" } | { kind: "provider"; instanceId: string };
const FAVORITES_KEY = "agent-workspace:composer-model-favorites:v1";
const pairKey = (instanceId: string, model: string) => JSON.stringify([instanceId, model]);

function readFavorites(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    if (!Array.isArray(value)) return new Set();
    return new Set(value.flatMap((pair: unknown) =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string"
        ? [pairKey(pair[0], pair[1])]
        : [],
    ));
  } catch {
    return new Set();
  }
}

// t3code ranks each query token against the model and provider fields, boosting favorites.
function matchScore(field: string, token: string, base: number): number | null {
  if (!field) return null;
  if (field === token) return base;
  if (field.startsWith(token)) return base + 2;
  if ([" ", "-", "_", "/"].some((marker) => field.includes(marker + token))) return base + 4;
  if (field.includes(token)) return base + 6;
  if (token.length < 3) return null;
  let next = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < field.length; index++) {
    if (field[index] !== token[next]) continue;
    if (first < 0) first = index;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    if (++next === token.length) return base + 100 + gaps * 3 + index - first + 1 - token.length;
  }
  return null;
}

function searchScore(item: ModelItem, query: string, favorite: boolean): number | null {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const name = item.model.label.trim().toLowerCase();
  const id = item.model.id.trim().toLowerCase();
  if (tokens.join(" ") === name || tokens.join(" ") === id) return -1000;
  const fields = [name, id, item.provider.driver.toLowerCase(), item.provider.label.toLowerCase()];
  fields.push(fields.join(" "));
  let score = 0;
  for (const token of tokens) {
    const scores = fields.flatMap((field, index) => {
      const match = matchScore(field, token, index * 10);
      return match === null ? [] : [match];
    });
    if (!scores.length) return null;
    score += Math.min(...scores);
  }
  return score - (favorite ? 24 : 0);
}

function ready(provider: ProviderInstance): boolean {
  return provider.enabled && provider.configured;
}

function providerNotice(provider: ProviderInstance): string | null {
  if (!provider.enabled) return "此提供商已停用。";
  if (!provider.configured) return "此提供商尚未配置完成。";
  if (!provider.models.length) return "此提供商没有可选择的模型。";
  return null;
}

function Glyph({ provider, small = false }: { provider: ProviderInstance; small?: boolean }) {
  return <span className={cn("inline-flex shrink-0 items-center justify-center [&_.provider-glyph]:inline-flex [&_.provider-glyph]:items-center [&_.provider-glyph]:justify-center [&_.provider-glyph]:size-5 [&_.provider-glyph_svg]:size-5", provider.driver === "claude" && "text-warning", (provider.driver === "antigravity" || provider.driver === "muse") && "text-ring", small && "[&_.provider-glyph]:size-3 [&_.provider-glyph_svg]:size-3")}><ProviderGlyph driver={provider.driver} accentColor={provider.accentColor} /></span>;
}

export function ComposerModelPicker({
  providerInstanceId, model, onChange, catalog, className, disabled = false, saving = false, saveError, onRetry,
}: ComposerModelPickerProps) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(readFavorites);
  const [section, setSection] = useState<Section>({ kind: "provider", instanceId: providerInstanceId });
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const refreshSequence = useRef(0);
  const refreshingRef = useRef(false);
  const openSequence = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const latest = useRef({ catalog, disabled, saving, onChange });
  latest.current = { catalog, disabled, saving, onChange };

  const activeProvider = catalog.providers.find((provider) => provider.instanceId === providerInstanceId);
  const activeModel = activeProvider?.models.find((option) => option.id === model);
  const validSelection = Boolean(activeProvider && ready(activeProvider) && activeModel);
  const items = useMemo(() => catalog.providers.flatMap((provider) => provider.models.map((option) => ({ provider, model: option, key: pairKey(provider.instanceId, option.id) }))), [catalog.providers]);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    if (searching) {
      return items.flatMap((item, order) => {
        const score = searchScore(item, query, favorites.has(item.key));
        return score === null ? [] : [{ item, score, order }];
      }).sort((a, b) => a.score - b.score || Number(favorites.has(b.item.key)) - Number(favorites.has(a.item.key)) || a.order - b.order).map(({ item }) => item);
    }
    return items.filter((item) => section.kind === "favorites" ? favorites.has(item.key) : item.provider.instanceId === section.instanceId)
      .sort((a, b) => section.kind === "favorites" ? 0 : Number(favorites.has(b.key)) - Number(favorites.has(a.key)));
  }, [items, query, searching, section, favorites]);
  const canChoose = !disabled && !saving && !pending && !refreshing && !catalog.loading && !catalog.error;
  const selectable = visible.filter((item) => ready(item.provider));
  const highlightedItem = selectable.find((item) => item.key === highlighted) ?? selectable[0];
  const selectedProvider = section.kind === "provider" ? catalog.providers.find((provider) => provider.instanceId === section.instanceId) : undefined;

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open || !highlightedItem) return;
    const index = visible.findIndex((item) => item.key === highlightedItem.key);
    listRef.current?.querySelector<HTMLElement>(`[data-model-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlightedItem?.key, open, visible]);

  const refresh = () => {
    const sequence = ++refreshSequence.current;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      void Promise.resolve(catalog.refresh()).catch(() => {}).finally(() => {
        if (refreshSequence.current === sequence) {
          refreshingRef.current = false;
          setRefreshing(false);
        }
      });
    } catch {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  const changeOpen = (next: boolean) => {
    if (next && disabled) return;
    setOpen(next);
    openSequence.current++;
    if (next) {
      setQuery("");
      setHighlighted(null);
      setSection(!validSelection || favorites.size === 0 ? { kind: "provider", instanceId: providerInstanceId } : { kind: "favorites" });
      refresh();
    } else {
      setQuery("");
    }
  };
  const selectSection = (next: Section, focusSearch = true) => {
    setSection(next);
    setHighlighted(null);
    if (focusSearch) requestAnimationFrame(() => searchRef.current?.focus());
  };
  const toggleFavorite = (item: ModelItem) => {
    setFavorites((previous) => {
      const next = new Set(previous);
      if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next].map((key) => JSON.parse(key)))); } catch { /* Keep the in-memory preference. */ }
      return next;
    });
  };
  const selectModel = async (item: ModelItem) => {
    const current = latest.current;
    const provider = current.catalog.providers.find((entry) => entry.instanceId === item.provider.instanceId);
    if (inFlight.current || refreshingRef.current || current.disabled || current.saving || current.catalog.loading || current.catalog.error || !provider || !ready(provider) || !provider.models.some((option) => option.id === item.model.id)) return;
    if (item.provider.instanceId === providerInstanceId && item.model.id === model) { setOpen(false); return; }
    inFlight.current = true;
    setPending(true);
    setLocalError(null);
    const opening = openSequence.current;
    try {
      await current.onChange(item.provider.instanceId, item.model.id);
      if (openSequence.current === opening) setOpen(false);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "保存模型选择失败，请重试。");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const retrySave = () => {
    if (!onRetry || inFlight.current || saving) return;
    inFlight.current = true;
    setPending(true);
    setLocalError(null);
    try {
      void Promise.resolve(onRetry()).catch((cause: unknown) => setLocalError(cause instanceof Error ? cause.message : "重试失败。"))
        .finally(() => { inFlight.current = false; setPending(false); });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "重试失败。");
      inFlight.current = false;
      setPending(false);
    }
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === "Process") return;
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && ((event.key === "ArrowLeft" && !event.shiftKey && !query) || (event.key === "Tab" && event.shiftKey))) {
      const button = railRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? railRef.current?.querySelector<HTMLButtonElement>("button");
      if (button) { event.preventDefault(); button.focus(); }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!selectable.length) return;
      const index = selectable.findIndex((item) => item.key === highlightedItem?.key);
      const next = event.key === "ArrowDown" ? Math.min(index + 1, selectable.length - 1) : Math.max(index - 1, 0);
      setHighlighted(selectable[next]!.key);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (highlightedItem && canChoose) void selectModel(highlightedItem);
    }
  };

  return <Popover open={open} onOpenChange={changeOpen}>
    <PopoverTrigger render={<button type="button" disabled={disabled} aria-label="切换模型和提供商" title={validSelection ? `${activeProvider?.label} · ${activeModel?.label}` : "所选提供商或模型不可用，请明确选择；不会自动切换。"} className={cn("text-muted-foreground hover:text-foreground flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-xs outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} />}>
      {activeProvider && <Glyph provider={activeProvider} small />}
      <span className={cn("min-w-0 truncate", validSelection ? "text-foreground/80" : "text-destructive")}>{activeModel?.label ?? (model || "选择模型")}{(providerInstanceId || model) && !validSelection ? "（不可用）" : ""}</span>
      {(saving || pending) && <Loader2Icon aria-label="保存中" className="size-3 shrink-0 animate-spin" />}
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </PopoverTrigger>
    <PopoverContent align="start" side="top" aria-label="模型和提供商" initialFocus={searchRef} className="w-[360px] max-w-[calc(100vw-16px)] overflow-hidden p-0">
      <div className="flex max-h-[min(346px,calc(100dvh-24px),var(--available-height))] min-h-0 overflow-hidden" data-model-picker-content="true" onKeyDown={(event) => { if (event.key === "Enter" || event.key.startsWith("Arrow")) event.stopPropagation(); }}>
        {!searching && <div ref={railRef} role="toolbar" aria-label="提供商" aria-orientation="vertical" className="w-11 shrink-0 overflow-y-auto bg-muted/30 p-1" data-model-picker-sidebar="true" onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "ArrowRight") { event.preventDefault(); searchRef.current?.focus(); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index >= 0) { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
          }
        }}>
          <button type="button" aria-label="收藏" title="收藏" aria-pressed={section.kind === "favorites"} onClick={() => selectSection({ kind: "favorites" })} className="relative flex aspect-square w-full items-center justify-center rounded-md hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none"><StarIcon className="size-5 fill-current" aria-hidden="true" />{section.kind === "favorites" && <span className="absolute -right-1 h-5 w-[3px] rounded-l-full bg-primary" />}</button>
          <div className="my-1 border-b border-border/70" />
          {catalog.providers.map((provider) => <button key={provider.instanceId} type="button" aria-label={`${provider.label}${providerNotice(provider) ? ` · ${providerNotice(provider)}` : ""}`} title={`${provider.label}${providerNotice(provider) ? ` · ${providerNotice(provider)}` : ""}`} aria-pressed={section.kind === "provider" && section.instanceId === provider.instanceId} onClick={() => selectSection({ kind: "provider", instanceId: provider.instanceId })} className={cn("relative flex aspect-square w-full items-center justify-center rounded-md hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none", !ready(provider) && "opacity-50")}><Glyph provider={provider} />{section.kind === "provider" && section.instanceId === provider.instanceId && <span className="absolute -right-1 h-5 w-[3px] rounded-l-full bg-primary" />}</button>)}
        </div>}
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/40", !searching && "border-l border-border/70")}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3"><SearchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /><input ref={searchRef} role="combobox" aria-label="搜索模型或提供商" aria-expanded="true" aria-controls={listId} aria-activedescendant={highlightedItem ? `${listId}-option-${visible.indexOf(highlightedItem)}` : undefined} aria-autocomplete="list" value={query} onChange={(event) => { setQuery(event.target.value); setHighlighted(null); }} onKeyDown={onSearchKeyDown} placeholder="搜索模型…" className="h-10 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60" /></div>
          <div ref={listRef} id={listId} role="listbox" aria-label="模型列表" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {(catalog.loading || refreshing) && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">正在加载模型目录…</p>}
            {catalog.error && <div role="alert" className="px-2 py-3 text-xs text-destructive">模型目录读取失败：{catalog.error} <button type="button" className="underline" onClick={refresh}>重试</button></div>}
            {!catalog.loading && !catalog.error && visible.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{searching ? "没有匹配的模型。" : section.kind === "favorites" ? "尚无收藏模型。" : "没有可展示的模型。"}</p>}
            {visible.map((item, index) => {
              const selected = item.provider.instanceId === providerInstanceId && item.model.id === model;
              const unavailable = !ready(item.provider);
              const favorite = favorites.has(item.key);
              return <div key={item.key} data-model-index={index} className={cn("group flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5", highlightedItem?.key === item.key && "bg-foreground/[0.07]", unavailable && "opacity-60")} onMouseEnter={() => { if (!unavailable) setHighlighted(item.key); }}>
                <button type="button" id={`${listId}-option-${index}`} role="option" aria-selected={selected} aria-disabled={!canChoose || unavailable} tabIndex={-1} onClick={() => { if (canChoose && !unavailable) void selectModel(item); }} className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs outline-none disabled:cursor-not-allowed">
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium leading-snug">{item.model.label}{unavailable && <span className="ml-1 text-muted-foreground">（不可用）</span>}</span><span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground/70"><Glyph provider={item.provider} small /><span className="truncate">{item.provider.label}</span></span></span>
                  {selected && <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />}
                </button>
                <button type="button" aria-label={`${favorite ? "取消收藏" : "收藏"} ${item.model.label} · ${item.provider.label}`} aria-pressed={favorite} title={favorite ? "取消收藏" : "收藏"} onClick={() => toggleFavorite(item)} onKeyDown={(event) => event.stopPropagation()} className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-foreground/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"><StarIcon aria-hidden="true" className={cn("size-3.5", favorite && "fill-current text-warning")} /></button>
              </div>;
            })}
          </div>
          {!searching && selectedProvider && providerNotice(selectedProvider) && <div className="max-h-20 shrink-0 overflow-y-auto border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">{providerNotice(selectedProvider)}{selectedProvider.message && <p className="mt-1 break-words">{selectedProvider.message}</p>} <Link to="/settings/providers" state={{ settingsReturnTo: `${location.pathname}${location.search}` }} className="underline underline-offset-2">前往配置</Link></div>}
          {(saveError || localError) && <div role="alert" className="max-h-20 shrink-0 overflow-y-auto break-words border-t border-border/70 px-3 py-2 text-xs text-destructive">{saveError || localError}{onRetry && <> <button type="button" disabled={saving || pending} onClick={retrySave} className="underline disabled:opacity-50">重试保存</button></>} <button type="button" disabled={refreshing || catalog.loading} onClick={refresh} className="underline disabled:opacity-50">刷新模型目录</button></div>}
          <div className="shrink-0 border-t border-border/70 p-1"><Link to="/settings/providers" state={{ settingsReturnTo: `${location.pathname}${location.search}` }} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"><Settings2Icon aria-hidden="true" className="size-3.5" />管理模型提供商</Link></div>
        </div>
      </div>
    </PopoverContent>
  </Popover>;
}
