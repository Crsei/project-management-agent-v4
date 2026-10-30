"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { CheckIcon, ChevronDownIcon, Loader2Icon, SearchIcon, Settings2Icon, StarIcon } from "lucide-react";
import type { ProviderInstance, ProviderModel } from "@agent-workspace/contracts/provider";
import {
  formatProviderUpdateRequiredNotice, getProviderInstanceDisplayName, getProviderModelShortName,
  resolveProviderModelSelection, shouldShowProviderInstanceBadge,
} from "@agent-workspace/client-runtime/providers";
import { Popover, PopoverContent, PopoverTrigger } from "@easyuse-ui/ui/components/ui/popover";
import { cn } from "@agent/lib/utils";
import { ProviderGlyph } from "@agent/src/settings/provider-card";
import { workspaceClient } from "@agent/src/network";
import { providerSelectable, visibleProviderModels } from "@agent/src/settings/model-option-controls";
import { useAgentText, type AgentText } from "@agent/src/i18n";

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
const pairKey = (instanceId: string, model: string) => JSON.stringify([instanceId, model]);


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
  const fields = [name, id, getProviderModelShortName(item.provider.driver, item.model)?.toLowerCase() ?? "", item.model.subProvider?.toLowerCase() ?? "", item.provider.driver.toLowerCase(), getProviderInstanceDisplayName(item.provider).toLowerCase()];
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
  return providerSelectable(provider);
}

function providerNotice(provider: ProviderInstance, t: AgentText): string | null {
  if (!provider.enabled) return t("此提供商已停用。", "This provider is disabled.");
  if (!ready(provider)) return t("原生会话尚未就绪；请检查 Agent。", "The native session is not ready; check the agent.");
  if (provider.authStatus === "unknown") return t("原生会话已就绪；账号身份未知。", "The native session is ready; account identity is unknown.");
  if (!provider.models.length) return t("此提供商没有可选择的模型。", "This provider has no selectable models.");
  return null;
}

function Glyph({ provider, providers, small = false }: { provider: ProviderInstance; providers: readonly ProviderInstance[]; small?: boolean }) {
  return <span className={cn("inline-flex shrink-0 items-center justify-center [&_.provider-glyph]:inline-flex [&_.provider-glyph]:items-center [&_.provider-glyph]:justify-center [&_.provider-glyph]:size-5 [&_.provider-glyph_svg]:size-5", small && "[&_.provider-glyph]:size-3 [&_.provider-glyph_svg]:size-3")}><ProviderGlyph driver={provider.driver} accentColor={provider.accentColor} displayName={getProviderInstanceDisplayName(provider)} showInstanceBadge={shouldShowProviderInstanceBadge(provider, providers)} /></span>;
}

export function ComposerModelPicker({
  providerInstanceId, model, onChange, catalog, className, disabled = false, saving = false, saveError, onRetry,
}: ComposerModelPickerProps) {
  const location = useLocation();
  const t = useAgentText();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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

  const selection = resolveProviderModelSelection(catalog.providers, providerInstanceId, model);
  const activeProvider = "provider" in selection ? selection.provider : undefined;
  const activeModel = "model" in selection ? selection.model : activeProvider?.models.find((option) => option.id === model || option.aliases?.includes(model));
  const validSelection = selection.status === "selected" && ready(selection.provider);
  const selectionNotice = selection.status === "unselected-provider" ? t("请选择提供商和模型。", "Select a provider and model.")
    : selection.status === "missing-provider" ? t(`原提供商 ${selection.instanceId} 已不可用。`, `The original provider ${selection.instanceId} is unavailable.`)
    : selection.status === "disabled-provider" ? t("所选提供商已停用。", "The selected provider is disabled.")
    : selection.status === "unselected-model" ? t("请明确选择模型。", "Select a model explicitly.")
    : selection.status === "missing-model" ? t(`原模型 ${selection.modelId} 已不可用。`, `The original model ${selection.modelId} is unavailable.`)
    : selection.status === "disabled-model" ? selection.model.disabledReason
    : !ready(selection.provider) ? providerNotice(selection.provider, t)
    : null;
  const favorites = useMemo(() => new Set(catalog.providers.flatMap((provider) => (provider.modelPreferences?.favorites ?? []).map((id) => pairKey(provider.instanceId, id)))), [catalog.providers]);
  const items = useMemo(() => catalog.providers.flatMap((provider) => visibleProviderModels(provider).map((option) => ({ provider, model: option, key: pairKey(provider.instanceId, option.id) }))), [catalog.providers]);
  // Browse a real provider even for an unset/stale selection; never save a fallback model.
  const selectedProvider = section.kind === "provider"
    ? catalog.providers.find((provider) => provider.instanceId === section.instanceId)
      ?? activeProvider
      ?? items.find((item) => ready(item.provider) && !item.model.disabledReason)?.provider
      ?? catalog.providers[0]
    : undefined;
  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    if (searching) {
      return items.flatMap((item, order) => {
        const score = searchScore(item, query, favorites.has(item.key));
        return score === null ? [] : [{ item, score, order }];
      }).sort((a, b) => a.score - b.score || Number(favorites.has(b.item.key)) - Number(favorites.has(a.item.key)) || a.order - b.order).map(({ item }) => item);
    }
    return items.filter((item) => section.kind === "favorites" ? favorites.has(item.key) : item.provider.instanceId === selectedProvider?.instanceId);
  }, [items, query, searching, section, favorites, selectedProvider?.instanceId]);
  const noticeProviders = searching || section.kind === "favorites" ? catalog.providers : selectedProvider ? [selectedProvider] : [];
  const updateNotices = noticeProviders.flatMap((provider) => {
    const notice = formatProviderUpdateRequiredNotice(provider, query);
    return notice ? [{ provider, notice }] : [];
  });
  const canChoose = !disabled && !saving && !pending && !refreshing && !catalog.loading && !catalog.error;
  const selectable = visible.filter((item) => ready(item.provider) && !item.model.disabledReason);
  const highlightedItem = selectable.find((item) => item.key === highlighted) ?? selectable[0];

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
  const toggleFavorite = async (item: ModelItem) => {
    if (!canChoose || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setLocalError(null);
    const preferences = item.provider.modelPreferences ?? { hidden: [], order: [], favorites: [], options: {} };
    const nextFavorites = preferences.favorites.includes(item.model.id)
      ? preferences.favorites.filter((id) => id !== item.model.id)
      : [...preferences.favorites, item.model.id];
    try {
      await workspaceClient.json(`/api/providers/${encodeURIComponent(item.provider.instanceId)}`, {
        method: "PUT",
        body: JSON.stringify({ revision: item.provider.revision, modelPreferences: { ...preferences, favorites: nextFavorites } }),
      });
      await catalog.refresh();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : t("保存收藏失败，请刷新后重试。", "Failed to save favorites. Refresh and try again."));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const selectModel = async (item: ModelItem) => {
    const current = latest.current;
    const provider = current.catalog.providers.find((entry) => entry.instanceId === item.provider.instanceId);
    if (inFlight.current || refreshingRef.current || current.disabled || current.saving || current.catalog.loading || current.catalog.error || !provider || !ready(provider) || !visibleProviderModels(provider).some((option) => option.id === item.model.id && !option.disabledReason)) return;
    if (item.provider.instanceId === providerInstanceId && item.model.id === model) { setOpen(false); return; }
    inFlight.current = true;
    setPending(true);
    setLocalError(null);
    const opening = openSequence.current;
    try {
      await current.onChange(item.provider.instanceId, item.model.id);
      if (openSequence.current === opening) setOpen(false);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : t("保存模型选择失败，请重试。", "Failed to save the model selection. Try again."));
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
      void Promise.resolve(onRetry()).catch((cause: unknown) => setLocalError(cause instanceof Error ? cause.message : t("重试失败。", "Retry failed.")))
        .finally(() => { inFlight.current = false; setPending(false); });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : t("重试失败。", "Retry failed."));
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
    <PopoverTrigger render={<button type="button" disabled={disabled} aria-label={t("切换模型和提供商", "Switch model and provider")} title={validSelection ? `${activeProvider && getProviderInstanceDisplayName(activeProvider)} · ${activeModel?.label}` : `${providerInstanceId} / ${model} · ${selectionNotice ?? ""}`} className={cn("text-muted-foreground hover:text-foreground flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-xs outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} />}>
      {activeProvider && <Glyph provider={activeProvider} providers={catalog.providers} small />}
      <span className={cn("min-w-0 truncate", validSelection ? "text-foreground/80" : "text-destructive")}>{activeModel && activeProvider ? getProviderModelShortName(activeProvider.driver, activeModel) ?? activeModel.label : model || t("选择模型", "Select model")}{(providerInstanceId || model) && !validSelection ? t("（不可用）", " (unavailable)") : ""}</span>
      {(saving || pending) && <Loader2Icon aria-label={t("保存中", "Saving")} className="size-3 shrink-0 animate-spin" />}
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </PopoverTrigger>
    <PopoverContent align="start" side="top" aria-label={t("模型和提供商", "Model and provider")} initialFocus={searchRef} className="w-[360px] max-w-[calc(100vw-16px)] overflow-hidden p-0">
      <div className="flex max-h-[min(346px,calc(100dvh-24px),var(--available-height))] min-h-0 overflow-hidden" data-model-picker-content="true" onKeyDown={(event) => { if (event.key === "Enter" || event.key.startsWith("Arrow")) event.stopPropagation(); }}>
        {!searching && <div ref={railRef} role="toolbar" aria-label={t("提供商", "Providers")} aria-orientation="vertical" className="w-11 shrink-0 overflow-y-auto bg-muted/30 p-1" data-model-picker-sidebar="true" onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "ArrowRight") { event.preventDefault(); searchRef.current?.focus(); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index >= 0) { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
          }
        }}>
          <button type="button" aria-label={t("收藏", "Favorite")} title={t("收藏", "Favorite")} aria-pressed={section.kind === "favorites"} onClick={() => selectSection({ kind: "favorites" })} className="relative flex aspect-square w-full items-center justify-center rounded-md hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none"><StarIcon className="size-5 fill-current" aria-hidden="true" />{section.kind === "favorites" && <span className="absolute -right-1 h-5 w-[3px] rounded-l-full bg-primary" />}</button>
          <div className="my-1 border-b border-border/70" />
          {catalog.providers.map((provider) => <button key={provider.instanceId} type="button" aria-label={`${getProviderInstanceDisplayName(provider)}${providerNotice(provider, t) ? ` · ${providerNotice(provider, t)}` : ""}`} title={`${getProviderInstanceDisplayName(provider)}${providerNotice(provider, t) ? ` · ${providerNotice(provider, t)}` : ""}`} aria-pressed={section.kind === "provider" && selectedProvider?.instanceId === provider.instanceId} onClick={() => selectSection({ kind: "provider", instanceId: provider.instanceId })} className={cn("relative flex aspect-square w-full items-center justify-center rounded-md hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none", !ready(provider) && "opacity-50")}><Glyph provider={provider} providers={catalog.providers} />{section.kind === "provider" && selectedProvider?.instanceId === provider.instanceId && <span className="absolute -right-1 h-5 w-[3px] rounded-l-full bg-primary" />}</button>)}
        </div>}
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/40", !searching && "border-l border-border/70")}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3"><SearchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /><input ref={searchRef} role="combobox" aria-label={t("搜索模型或提供商", "Search models or providers")} aria-expanded="true" aria-controls={listId} aria-activedescendant={highlightedItem ? `${listId}-option-${visible.indexOf(highlightedItem)}` : undefined} aria-autocomplete="list" value={query} onChange={(event) => { setQuery(event.target.value); setHighlighted(null); }} onKeyDown={onSearchKeyDown} placeholder={t("搜索模型…", "Search models…")} className="h-10 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60" /></div>
          <div ref={listRef} id={listId} role="listbox" aria-label={t("模型列表", "Model list")} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {(catalog.loading || refreshing) && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">{t("正在加载模型目录…", "Loading model catalog…")}</p>}
            {catalog.error && <div role="alert" className="px-2 py-3 text-xs text-destructive">{t("模型目录读取失败：", "Failed to load the model catalog: ")}{catalog.error} <button type="button" className="underline" onClick={refresh}>{t("重试", "Retry")}</button></div>}
            {!catalog.loading && !refreshing && !catalog.error && selectionNotice && <p role="status" className="break-words px-2 py-2 text-xs text-destructive">{selectionNotice} {t("不会自动替换所选模型。", "The selected model is never replaced automatically.")}</p>}
            {!catalog.loading && !catalog.error && updateNotices.map(({ provider, notice }) => <p key={provider.instanceId} role="status" className="break-words px-2 py-2 text-xs text-muted-foreground">{getProviderInstanceDisplayName(provider)} · {notice}</p>)}
            {!catalog.loading && !refreshing && !catalog.error && visible.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{searching ? t("没有匹配的模型。", "No matching models.") : section.kind === "favorites" ? t("尚无收藏模型。", "No favorite models yet.") : t("没有可展示的模型。", "No models to show.")}</p>}
            {visible.map((item, index) => {
              const selected = item.provider.instanceId === providerInstanceId && item.model.id === activeModel?.id;
              const unavailable = !ready(item.provider) || !!item.model.disabledReason;
              const favorite = favorites.has(item.key);
              return <div key={item.key} data-model-index={index} className={cn("group flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5", highlightedItem?.key === item.key && "bg-foreground/[0.07]", unavailable && "opacity-60")} onMouseEnter={() => { if (!unavailable) setHighlighted(item.key); }}>
                <button type="button" id={`${listId}-option-${index}`} role="option" aria-selected={selected} aria-disabled={!canChoose || unavailable} title={item.model.disabledReason ?? item.model.id} tabIndex={-1} onClick={() => { if (canChoose && !unavailable) void selectModel(item); }} className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs outline-none disabled:cursor-not-allowed">
                  <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5 font-medium leading-snug"><span className="truncate">{item.model.label}</span>{item.model.badge === "new" && <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary">{t("新", "New")}</span>}{unavailable && <span className="shrink-0 text-muted-foreground">{t("（不可用）", " (unavailable)")}</span>}</span><span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground/70"><Glyph provider={item.provider} providers={catalog.providers} small /><span className="truncate">{getProviderInstanceDisplayName(item.provider)}{item.model.subProvider ? ` · ${item.model.subProvider}` : ""}</span></span></span>
                  {selected && <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />}
                </button>
                <button type="button" disabled={!canChoose} aria-label={`${favorite ? t("取消收藏", "Remove from favorites") : t("收藏", "Favorite")} ${item.model.label} · ${getProviderInstanceDisplayName(item.provider)}`} aria-pressed={favorite} title={favorite ? t("取消收藏", "Remove from favorites") : t("收藏", "Favorite")} onClick={() => void toggleFavorite(item)} onKeyDown={(event) => event.stopPropagation()} className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-foreground/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring disabled:opacity-50"><StarIcon aria-hidden="true" className={cn("size-3.5", favorite && "fill-current text-warning")} /></button>
              </div>;
            })}
          </div>
          {!searching && selectedProvider && providerNotice(selectedProvider, t) && <div className="max-h-20 shrink-0 overflow-y-auto border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">{providerNotice(selectedProvider, t)}{selectedProvider.message && <p className="mt-1 break-words">{selectedProvider.message}</p>} <Link to="/agent/settings/providers" state={{ settingsReturnTo: `${location.pathname}${location.search}` }} className="underline underline-offset-2">{t("前往配置", "Configure")}</Link></div>}
          {(saveError || localError) && <div role="alert" className="max-h-20 shrink-0 overflow-y-auto break-words border-t border-border/70 px-3 py-2 text-xs text-destructive">{saveError || localError}{onRetry && <> <button type="button" disabled={saving || pending} onClick={retrySave} className="underline disabled:opacity-50">{t("重试保存", "Retry save")}</button></>} <button type="button" disabled={refreshing || catalog.loading} onClick={refresh} className="underline disabled:opacity-50">{t("刷新模型目录", "Refresh catalog")}</button></div>}
          <div className="shrink-0 border-t border-border/70 p-1"><Link to="/agent/settings/providers" state={{ settingsReturnTo: `${location.pathname}${location.search}` }} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"><Settings2Icon aria-hidden="true" className="size-3.5" />{t("管理模型提供商", "Manage model providers")}</Link></div>
        </div>
      </div>
    </PopoverContent>
  </Popover>;
}
