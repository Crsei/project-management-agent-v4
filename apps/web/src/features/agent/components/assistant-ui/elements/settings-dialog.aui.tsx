"use client";

import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@agent/components/ui/dialog";
import { Button } from "@agent/components/ui/button";
import {
  SettingsPanel,
  type SettingToggle,
} from "@agent/components/assistant-ui/elements/settings-panel";
import type { ChatSettings, SettingsUpdater } from "@agent/hooks/use-chat-settings";
import { useProviders } from "@agent/hooks/use-providers";
import { useAgentText, type AgentText } from "@agent/src/i18n";

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ChatSettings;
  set: SettingsUpdater;
};

const toggleMeta = (t: AgentText): Record<"dictation" | "speak", { label: string }> => ({
  dictation: { label: t("语音听写", "Voice dictation") },
  speak: { label: t("朗读回复", "Read replies aloud") },
});

export const SettingsDialog = ({ open, onOpenChange, settings, set }: SettingsDialogProps) => {
  const navigate = useNavigate();
  const t = useAgentText();
  const { providers } = useProviders();
  const meta = toggleMeta(t);
  const providerGroups = providers
    .filter((provider) => provider.enabled && provider.configured && provider.models.length > 0)
    .map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.label,
      models: provider.models.map((model) => ({ id: model.id, label: model.label })),
    }));
  const currentToggles: SettingToggle[] = (
    Object.keys(meta) as ("dictation" | "speak")[]
  ).map((key) => ({
    key,
    label: meta[key].label,
    on: settings[key],
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="settings-dialog">
        <DialogHeader>
          <DialogTitle>{t("设置", "Settings")}</DialogTitle>
        </DialogHeader>
        <SettingsPanel
          model={settings.model}
          providerInstanceId={settings.providerInstanceId}
          providers={providerGroups}
          systemPrompt={settings.systemPrompt}
          temperature={settings.temperature}
          toggles={currentToggles}
          onModelChange={(model, providerInstanceId) => {
            set({ providerInstanceId: providerInstanceId ?? settings.providerInstanceId, model });
          }}
          onSystemPromptChange={(systemPrompt) => set("systemPrompt", systemPrompt)}
          onTemperatureChange={(temperature) => set("temperature", temperature)}
          onToggle={(key) => {
            const toggleKey = key as "dictation" | "speak";
            set(toggleKey, !settings[toggleKey]);
          }}
          className="border-0 bg-transparent p-0 dark:bg-transparent"
        />
        <Button
          variant="outline"
          className="h-auto w-full justify-between px-3 py-2"
          onClick={() => {
            onOpenChange(false);
            navigate("/agent/settings/providers");
          }}
        >
          <span className="flex min-w-0 flex-col items-start text-left">
            <span className="text-[13px] font-medium">{t("模型提供商", "Model providers")}</span>
            <span className="text-muted-foreground text-xs font-normal">
              {t("API Key 与 Codex / Claude 登录", "API keys and Codex / Claude sign-in")}
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </DialogContent>
    </Dialog>
  );
};
