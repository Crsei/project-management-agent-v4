"use client";

import { useEffect, useRef, useState } from "react";
import { BrainIcon, ChevronDownIcon, Loader2Icon, SlidersHorizontalIcon } from "lucide-react";
import type { ProviderDriver, ProviderModel, ProviderOptionDescriptor, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { getDescriptorStringValue, getProviderModelTraits, REASONING_SELECT_DESCRIPTOR_IDS, selectableProviderOptionChoices } from "@agent-workspace/client-runtime/providers";
import { getComposerTraitChange } from "./composer-traits-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@agent/lib/utils";
import { useAgentText, type AgentText } from "@agent/src/i18n";

type SettingsPatch = { modelOptions?: ProviderOptionSelection[]; interactionMode?: "default" | "plan" };
type ComposerTraitsPickerProps = {
  driver?: ProviderDriver;
  prompt: string;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  model?: ProviderModel;
  selections?: ProviderOptionSelection[];
  interactionMode?: "default" | "plan";
  onSettingsChange: (patch: SettingsPatch) => Promise<void>;
  disabled?: boolean;
  saving?: boolean;
  saveError?: string;
  catalogLoading?: boolean;
  catalogError?: string | null;
  onRetry?: () => void | Promise<void>;
};


function readTrait(descriptor: ProviderOptionDescriptor, t: AgentText) {
  const value = descriptor.type === "select" ? getDescriptorStringValue(descriptor) ?? undefined : descriptor.currentValue;
  const valid = value === undefined || (descriptor.type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string" && descriptor.options.some((option) => option.id === value));
  const label = !valid
    ? t(`不可用：${String(value)}`, `Unavailable: ${String(value)}`)
    : descriptor.type === "boolean"
      ? value === undefined ? t("未指定", "Not set") : value ? t("开启", "On") : t("关闭", "Off")
      : descriptor.options.find((option) => option.id === value)?.label ?? t("未指定", "Not set");
  return { value, label, valid };
}

const defaultBadge = (t: AgentText) => (
  <span className="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] leading-none text-muted-foreground">
    {t("默认", "Default")}
  </span>
);

export function ComposerTraitsPicker({
  driver, model, selections, prompt, onPromptEdit, interactionMode = "default", onSettingsChange, disabled = false, saving = false,
  saveError, catalogLoading = false, catalogError, onRetry,
}: ComposerTraitsPickerProps) {
  const t = useAgentText();
  const [open, setOpen] = useState<"traits" | "interaction" | null>(null);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pendingPromptEdit = useRef<((prompt: string) => string) | null>(null);
  const latest = useRef({ driver, model, selections, prompt, onPromptEdit, onSettingsChange, onRetry, disabled, saving, catalogLoading, catalogError });
  latest.current = { driver, model, selections, prompt, onPromptEdit, onSettingsChange, onRetry, disabled, saving, catalogLoading, catalogError };
  const traits = driver && model ? getProviderModelTraits({ driver, model, options: selections, prompt }) : undefined;
  const descriptors = traits?.descriptors ?? [];
  const primary = descriptors.find((descriptor) => REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id))
    ?? traits?.primarySelectDescriptor ?? descriptors[0];
  const unavailable = traits?.invalidOptions ?? selections ?? [];
  const triggerLabel = unavailable.length ? t("选项不可用", "Invalid options") : traits?.label || t("模型选项", "Model options");
  const description = traits?.label || t("模型选项", "Model options");
  const modeLabel = interactionMode === "plan" ? t("计划", "Plan") : t("默认", "Default");
  const error = localError ?? saveError;
  const busy = pending || saving;
  const blocked = disabled || busy || catalogLoading || !!catalogError;

  useEffect(() => {
    if (disabled) setOpen(null);
  }, [disabled]);
  useEffect(() => {
    if (saving) setLocalError(null);
  }, [saving]);

  const save = async (operation: () => void | Promise<void>) => {
    const current = latest.current;
    if (inFlight.current || current.disabled || current.saving || current.catalogLoading || current.catalogError) return;
    inFlight.current = true;
    setPending(true);
    setLocalError(null);
    try {
      await operation();
      if (pendingPromptEdit.current) {
        latest.current.onPromptEdit(pendingPromptEdit.current);
        pendingPromptEdit.current = null;
      }
      setOpen(null);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : t("保存会话参数失败，请重试。", "Failed to save session parameters. Try again."));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const chooseTrait = (id: string, value: string | boolean) => {
    const current = latest.current;
    if (inFlight.current || current.disabled || current.saving || current.catalogLoading || current.catalogError || !current.driver || !current.model) return;
    const input = { driver: current.driver, model: current.model, selections: current.selections, prompt: current.prompt, id, value };
    const change = getComposerTraitChange(input);
    if (!change) return;
    pendingPromptEdit.current = (text) => getComposerTraitChange({ ...input, prompt: text })?.prompt ?? text;
    void save(() => change.modelOptions !== undefined ? current.onSettingsChange({ modelOptions: change.modelOptions }) : undefined);
  };
  const retry = () => {
    const retrySave = latest.current.onRetry;
    if (retrySave) void save(retrySave);
  };

  return <>
    {(descriptors.length > 0 || unavailable.length > 0) && <DropdownMenu open={open === "traits"} onOpenChange={(next) => {
      if (next) { if (!blocked) setOpen("traits"); }
      else setOpen((current) => current === "traits" ? null : current);
    }}>
      <DropdownMenuTrigger render={<button
        type="button"
        disabled={blocked}
        aria-label={t(`模型能力选项：${description}`, `Model capability options: ${description}`)}
        aria-busy={busy}
        title={error ? t(`参数未保存：${error}`, `Parameters not saved: ${error}`) : description}
        data-composer-traits-trigger="true"
        className={cn("flex h-7 min-w-0 max-w-40 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50", (error || unavailable.length > 0) && "text-destructive")}
      />}>
        {primary && REASONING_SELECT_DESCRIPTOR_IDS.has(primary.id) ? <BrainIcon aria-hidden="true" className="size-3.5 shrink-0" /> : <SlidersHorizontalIcon aria-hidden="true" className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate" data-composer-effort-label={primary && REASONING_SELECT_DESCRIPTOR_IDS.has(primary.id) ? true : undefined}>{triggerLabel}</span>
        {busy ? <Loader2Icon aria-label={t("保存中", "Saving")} className="size-3 shrink-0 animate-spin" /> : <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        aria-label={t("模型能力选项", "Model capability options")}
        aria-busy={busy}
        className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain bg-card p-1"
        onKeyDown={(event) => event.stopPropagation()}
      >
        {descriptors.map((descriptor, index) => {
          const trait = readTrait(descriptor, t);
          const promptControlled = traits?.ultrathinkPromptControlled && descriptor.id === traits.primarySelectDescriptor?.id;
          const promptLocked = traits?.ultrathinkInBodyText && descriptor.id === traits.primarySelectDescriptor?.id;
          const selectedValue = promptControlled && descriptor.type === "select" ? descriptor.promptInjectedValues?.[0] : trait.value;
          return <div key={descriptor.id}>
            {index > 0 && <DropdownMenuSeparator className="my-1 border-t border-border/70" />}
            <DropdownMenuGroup aria-label={descriptor.label}>
              <DropdownMenuLabel className="px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{descriptor.label}</DropdownMenuLabel>
              {descriptor.description && <p className="px-3 pb-1.5 text-xs text-muted-foreground">{descriptor.description}</p>}
              {(!trait.valid || unavailable.some((selection) => selection.id === descriptor.id)) && <p role="alert" className="break-words px-3 pb-1.5 text-xs text-destructive">{t(`已保存的选项不可用，请重新选择或明确移除。`, `Saved options are invalid; choose again or explicitly remove them.`)}</p>}
              {promptLocked && <p className="px-3 pb-1.5 text-xs text-muted-foreground">{t("消息正文包含 ultrathink；请先在正文移除，再更改此选项。", "Your message contains ultrathink in its body. Remove it from the text to change this option.")}</p>}
              <DropdownMenuRadioGroup value={trait.valid && selectedValue !== undefined ? String(selectedValue) : ""}>
                {descriptor.type === "select" ? selectableProviderOptionChoices(descriptor).map((option) => <DropdownMenuRadioItem
                  key={option.id}
                  value={option.id}
                  disabled={blocked || promptLocked}
                  textValue={option.label}
                  className="py-1.5"
                  onSelect={(event) => { event.preventDefault(); chooseTrait(descriptor.id, option.id); }}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5"><span className="min-w-0 break-words">{option.label}</span>{option.isDefault && defaultBadge(t)}</span>
                    {option.description && <span className="text-pretty text-xs text-muted-foreground">{option.description}</span>}
                  </span>
                </DropdownMenuRadioItem>) : [true, false].map((value) => <DropdownMenuRadioItem
                  key={String(value)}
                  value={String(value)}
                  disabled={blocked}
                  className="py-1.5"
                  onSelect={(event) => { event.preventDefault(); chooseTrait(descriptor.id, value); }}
                >
                  <span className="flex min-w-0 items-center gap-1.5">{value ? t("开启", "On") : t("关闭", "Off")}{descriptor.currentValue === value && defaultBadge(t)}</span>
                </DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </div>;
        })}
        {!model && <p className="px-3 py-2 text-xs text-muted-foreground">{t("请先选择可用模型以配置其能力选项。", "Select an available model to configure its capability options.")}</p>}
        {unavailable.length > 0 && <>
          <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{t("不可用的已保存选项：", "Unavailable saved options: ")}{unavailable.map((selection) => `${selection.id} = ${String(selection.value)}`).join(t("、", ", "))}</p>
          <DropdownMenuItem disabled={blocked || !model} onSelect={(event) => {
            event.preventDefault();
            const current = latest.current;
            if (!current.driver || !current.model) return;
            const invalid = getProviderModelTraits({ driver: current.driver, model: current.model, options: current.selections, prompt: current.prompt }).invalidOptions;
            void save(() => current.onSettingsChange({ modelOptions: (current.selections ?? []).filter((selection) => !invalid.includes(selection)).map((selection) => ({ ...selection })) }));
          }}>{t("移除不可用选项", "Remove unavailable options")}</DropdownMenuItem>
        </>}
        {busy && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("正在保存会话参数…", "Saving session parameters…")}</p>}
        {catalogLoading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("正在加载模型能力…", "Loading model capabilities…")}</p>}
        {catalogError && <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{t("模型目录读取失败：", "Failed to load the model catalog: ")}{catalogError}</p>}
        {error && <>
          <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{t("参数未保存，修改已保留：", "Parameters not saved; changes kept: ")}{error}</p>
          {onRetry && <DropdownMenuItem disabled={blocked} onSelect={(event) => { event.preventDefault(); retry(); }}>{t("重试保存", "Retry save")}</DropdownMenuItem>}
        </>}
      </DropdownMenuContent>
    </DropdownMenu>}
    <DropdownMenu open={open === "interaction"} onOpenChange={(next) => {
      if (next) { if (!blocked) setOpen("interaction"); }
      else setOpen((current) => current === "interaction" ? null : current);
    }}>
      <DropdownMenuTrigger render={<button
        type="button"
        disabled={blocked}
        aria-label={t(`交互模式：${modeLabel}`, `Interaction mode: ${modeLabel}`)}
        aria-busy={busy}
        title={t(`交互模式：${modeLabel}`, `Interaction mode: ${modeLabel}`)}
        className="flex h-7 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50"
      />}>
        <SlidersHorizontalIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{modeLabel}</span>
        {busy ? <Loader2Icon aria-label={t("保存中", "Saving")} className="size-3 shrink-0 animate-spin" /> : <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" aria-label={t("交互模式", "Interaction mode")} aria-busy={busy} className="w-48 max-w-[calc(100vw-16px)] bg-card p-1" onKeyDown={(event) => event.stopPropagation()}>
        <DropdownMenuGroup aria-label={t("交互模式", "Interaction mode")}>
          <DropdownMenuLabel className="px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{t("交互模式", "Interaction mode")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={interactionMode}>
            {(["default", "plan"] as const).map((mode) => <DropdownMenuRadioItem key={mode} value={mode} disabled={blocked} className="py-1.5" onSelect={(event) => {
              event.preventDefault();
              void save(() => latest.current.onSettingsChange({ interactionMode: mode }));
            }}>{mode === "plan" ? t("计划", "Plan") : t("默认", "Default")}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {busy && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("正在保存会话参数…", "Saving session parameters…")}</p>}
        {catalogLoading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t("正在加载模型能力…", "Loading model capabilities…")}</p>}
        {catalogError && <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{t("模型目录读取失败：", "Failed to load the model catalog: ")}{catalogError}</p>}
        {error && <>
          <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{t("参数未保存，修改已保留：", "Parameters not saved; changes kept: ")}{error}</p>
          {onRetry && <DropdownMenuItem disabled={blocked} onSelect={(event) => { event.preventDefault(); retry(); }}>{t("重试保存", "Retry save")}</DropdownMenuItem>}
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
    {unavailable.length > 0 && !open && <p role="alert" className="min-w-0 max-w-full basis-full break-words px-2 text-xs text-destructive">{t("已保存的模型选项不可用，发送已阻止。请打开模型选项明确更正：", "Saved model options are invalid and sending is blocked. Open model options to explicitly correct: ")}{unavailable.map((selection) => `${selection.id} = ${String(selection.value)}`).join(t("、", ", "))}</p>}
    {error && !open && <p role="alert" className="min-w-0 max-w-full basis-full break-words px-2 text-xs text-destructive">{t("参数未保存：", "Parameters not saved: ")}{error}{onRetry && <> <button type="button" disabled={blocked} className="enabled:hover:bg-foreground/[0.05] disabled:opacity-50" onClick={retry}>{t("重试保存", "Retry save")}</button></>}</p>}
  </>;
}
