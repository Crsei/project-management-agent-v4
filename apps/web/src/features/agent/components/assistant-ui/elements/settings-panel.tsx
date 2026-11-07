"use client";

import type { ComponentProps } from "react";
import { Link } from "react-router-dom";
import { cn } from "@agent/lib/utils";
import { field, mono, paper } from "./surfaces";
import { clamp } from "../utils/range";
import { useAgentText } from "@agent/src/i18n";
import { RadixSelect } from "@/components/ui/radix-select"

export interface SettingToggle {
  key: string;
  label: string;
  on: boolean;
}

export type SettingsProviderGroup = {
  instanceId: string;
  label: string;
  models: readonly { id: string; label: string }[];
};

export function SettingsPanel({
  model,
  providerInstanceId,
  providers,
  systemPrompt,
  temperature,
  toggles,
  onModelChange,
  onProviderChange,
  onSystemPromptChange,
  onTemperatureChange,
  onToggle,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "model"
  | "providerInstanceId"
  | "providers"
  | "systemPrompt"
  | "temperature"
  | "toggles"
  | "onModelChange"
  | "onProviderChange"
  | "onSystemPromptChange"
  | "onTemperatureChange"
  | "onToggle"
> & {
  model: string;
  providerInstanceId: string;
  providers: readonly SettingsProviderGroup[];
  systemPrompt: string;
  temperature: number;
  toggles: readonly SettingToggle[];
  onModelChange?: (model: string, providerInstanceId?: string) => void;
  onProviderChange?: (providerInstanceId: string) => void;
  onSystemPromptChange?: (prompt: string) => void;
  onTemperatureChange?: (temperature: number) => void;
  onToggle?: (key: string) => void;
}) {
  const t = useAgentText();
  const selectedProvider = providers.find((provider) => provider.instanceId === providerInstanceId);
  const hasProviders = providers.length > 0;

  function changeProvider(instanceId: string) {
    const group = providers.find((provider) => provider.instanceId === instanceId);
    onProviderChange?.(instanceId);
    const firstModel = group?.models[0];
    if (firstModel) onModelChange?.(firstModel.id, instanceId);
  }

  return (
    <div
      data-slot="settings-panel"
      className={cn(paper, "flex w-full max-w-sm flex-col gap-4 rounded-[20px] p-4", className)}
      {...props}
    >
      <div className="flex flex-col gap-1.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn(mono, "text-muted-foreground")}>model</span>
          <Link
            to="/agent/settings/providers"
            className="text-muted-foreground hover:text-foreground text-[11px] transition-colors"
          >
            {t("模型提供商", "Model providers")}
          </Link>
        </span>

        {hasProviders ? (
          <>
            <label className="sr-only" htmlFor="settings-provider-instance">
              {t("模型提供商", "Model providers")}
            </label>
            <RadixSelect
              id="settings-provider-instance"
              value={selectedProvider ? providerInstanceId : ""}
              onChange={(event) => changeProvider(event.target.value)}
              className={cn(
                field,
                "text-foreground/80 focus-visible:ring-foreground/20 h-8 rounded-lg px-2.5 text-xs outline-none focus-visible:ring-1",
              )}
            >
              {!selectedProvider && (
                <option value="" disabled>
                  {t("选择提供商", "Select provider")}
                </option>
              )}
              {providers.map((provider) => (
                <option key={provider.instanceId} value={provider.instanceId}>
                  {provider.label}
                </option>
              ))}
            </RadixSelect>

            <div className="flex flex-col gap-2" role="group" aria-label={t("模型", "Model")}>
              {providers.map((group) => (
                <div key={group.instanceId} className="flex flex-col gap-1">
                  <span className={cn(mono, "text-muted-foreground px-1")}>{group.label}</span>
                  <div
                    role="group"
                    aria-label={t(`${group.label} 模型`, `${group.label} models`)}
                    className={cn(field, "flex flex-wrap gap-0.5 rounded-2xl p-0.5")}
                  >
                    {group.models.map((option) => {
                      const selected =
                        group.instanceId === providerInstanceId && option.id === model;
                      const className = cn(
                        "rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--motion-button)]",
                        onModelChange && "active:bg-surface-pressed",
                        selected
                          ? "bg-background text-foreground/90 dark:bg-foreground/10"
                          : onModelChange
                            ? "text-muted-foreground hover:text-foreground/70"
                            : "text-muted-foreground",
                      );

                      return onModelChange ? (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => onModelChange(option.id, group.instanceId)}
                          className={className}
                        >
                          {option.label || option.id}
                        </button>
                      ) : (
                        <span
                          key={option.id}
                          aria-current={selected ? "true" : undefined}
                          className={className}
                        >
                          {option.label || option.id}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div
            role="status"
            className={cn(field, "flex flex-col gap-2 rounded-lg px-3 py-2 text-xs")}
          >
            <RadixSelect
              disabled
              aria-label={t("模型提供商", "Model providers")}
              className="text-muted-foreground bg-transparent outline-none"
            >
              <option>{t("未配置提供商", "No provider configured")}</option>
            </RadixSelect>
            <p className="text-muted-foreground">
              {t("尚未配置模型提供商，模型选择已禁用。", "No model provider is configured; model selection is disabled.")}
            </p>
            <Link
              to="/agent/settings/providers"
              className="text-primary w-fit hover:text-primary/80"
            >
              {t("前往配置模型提供商", "Configure model providers")}
            </Link>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={cn(mono, "text-muted-foreground")}>system prompt</span>
        <textarea
          value={systemPrompt}
          onChange={(event) => onSystemPromptChange?.(event.target.value)}
          rows={3}
          aria-label="System prompt"
          className={cn(
            field,
            "text-foreground/80 focus-visible:ring-foreground/20 resize-none rounded-xl px-3 py-2 text-xs leading-relaxed outline-none focus-visible:ring-1",
          )}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="flex items-baseline justify-between">
          <span className={cn(mono, "text-muted-foreground")}>temperature</span>
          <span className={cn(mono, "text-muted-foreground tabular-nums")}>
            {clamp(temperature, 0, 2).toFixed(1)}
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={clamp(temperature, 0, 2)}
          aria-label="Temperature"
          onChange={(event) => onTemperatureChange?.(Number(event.target.value))}
          className="accent-foreground/80 h-1 w-full cursor-pointer"
        />
      </div>

      <div className="flex flex-col gap-2.5">
        {toggles.map((toggle) => (
          <div key={toggle.key} className="flex items-center gap-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px]">{toggle.label}</span>
            </span>
            {onToggle ? (
              <button
                type="button"
                role="switch"
                aria-checked={toggle.on}
                aria-label={toggle.label}
                onClick={() => onToggle(toggle.key)}
                className={cn(
                  "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200",
                  toggle.on ? "bg-foreground/80" : "bg-foreground/15",
                )}
              >
                <span
                  className={cn(
                    "bg-background size-4 rounded-full transition-transform duration-200 motion-reduce:transition-none",
                    toggle.on && "translate-x-4",
                  )}
                />
              </button>
            ) : (
              <span
                role="switch"
                aria-checked={toggle.on}
                aria-disabled="true"
                aria-label={toggle.label}
                className={cn(
                  "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5",
                  toggle.on ? "bg-foreground/80" : "bg-foreground/15",
                )}
              >
                <span
                  className={cn("bg-background size-4 rounded-full", toggle.on && "translate-x-4")}
                />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
