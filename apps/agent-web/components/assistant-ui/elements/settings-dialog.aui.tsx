"use client";

import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  SettingsPanel,
  type SettingToggle,
} from "@/components/assistant-ui/elements/settings-panel";
import type { ChatSettings, SettingsUpdater } from "@/hooks/use-chat-settings";
import { useProviders } from "@/hooks/use-providers";

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ChatSettings;
  set: SettingsUpdater;
};

const toggleMeta: Record<"dictation" | "speak", { label: string; detail: string }> = {
  dictation: {
    label: "语音听写",
    detail: "浏览器 Web Speech 引擎，输入框显示麦克风按钮",
  },
  speak: { label: "朗读回复", detail: "助手消息操作栏显示朗读按钮" },
};

export const SettingsDialog = ({ open, onOpenChange, settings, set }: SettingsDialogProps) => {
  const navigate = useNavigate();
  const { providers } = useProviders();
  const providerGroups = providers
    .filter((provider) => provider.enabled && provider.configured && provider.models.length > 0)
    .map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.label,
      models: provider.models.map((model) => ({ id: model.id, label: model.label })),
    }));
  const currentToggles: SettingToggle[] = (
    Object.keys(toggleMeta) as ("dictation" | "speak")[]
  ).map((key) => ({
    key,
    label: toggleMeta[key].label,
    detail: toggleMeta[key].detail,
    on: settings[key],
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="settings-dialog">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            模型与参数原子保存到当前会话；语音偏好仅保存在此浏览器。
          </DialogDescription>
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
            navigate("/settings/providers");
          }}
        >
          <span className="flex min-w-0 flex-col items-start text-left">
            <span className="text-[13px] font-medium">模型提供商</span>
            <span className="text-muted-foreground text-xs font-normal">
              API Key 与 Codex / Claude 登录
            </span>
          </span>
          <ChevronRight aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </DialogContent>
    </Dialog>
  );
};
