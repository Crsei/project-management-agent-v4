"use client";

import { useEffect, useMemo, useState } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  CommandPalette,
  type PaletteCommand,
} from "@agent/components/assistant-ui/elements/command-palette";
import { useSidebar } from "@agent/components/ui/sidebar";
import { type ChatSettings, type SettingsUpdater } from "@agent/hooks/use-chat-settings";
import { useProviders } from "@agent/hooks/use-providers";

export type CommandPaletteHostProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ChatSettings;
  set: SettingsUpdater;
  onOpenSettings: () => void;
};

export const CommandPaletteHost = ({
  open: openProp,
  onOpenChange,
  settings,
  set,
  onOpenSettings,
}: CommandPaletteHostProps) => {
  const aui = useAui();
  const { toggleSidebar } = useSidebar();
  const { providers } = useProviders();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState("new-thread");
  const open = openProp;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!open) setQuery("");
        onOpenChange(!open);
        return;
      }
      if (key === "escape" && open) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const modelGroup = `Model · ${settings.providerInstanceId} · ${settings.model}`;
    const list: PaletteCommand[] = [
      {
        id: "new-thread",
        label: "New thread",
        group: "Threads",
        keys: ["⌘", "⇧", "O"],
      },
      {
        id: "open-settings",
        label: "Open settings",
        group: "App",
        keys: ["⌘", ","],
      },
      {
        id: "toggle-sidebar",
        label: "Toggle sidebar",
        group: "App",
        keys: ["⌘", "B"],
      },
    ];
    const configuredProviders = providers.filter((provider) => provider.enabled && provider.configured);
    for (const provider of configuredProviders) {
      for (const model of provider.models) {
        list.push({
          id: `use-model-${provider.instanceId}::${model.id}`,
          label: `Use ${model.label} (${provider.label})`,
          group: modelGroup,
          keys: [],
        });
      }
    }
    if (isRunning) {
      list.push({
        id: "stop-run",
        label: "Stop generating",
        group: "Threads",
        keys: [],
      });
    }
    list.push(
      {
        id: "archive-thread",
        label: "Archive current thread",
        group: "Threads",
        keys: [],
      },
      {
        id: "delete-thread",
        label: "Delete current thread",
        group: "Threads",
        keys: [],
      },
    );
    return list;
  }, [settings.model, settings.providerInstanceId, providers, isRunning]);

  const run = (id: string) => {
    onOpenChange(false);
    if (id === "new-thread") aui.threads.switchToNewThread();
    if (id === "open-settings") onOpenSettings();
    if (id === "toggle-sidebar") toggleSidebar();
    if (id === "stop-run") aui.thread.cancelRun();
    if (id === "archive-thread") aui.threads.item("main").archive();
    if (id === "delete-thread") aui.threads.item("main").delete();
    if (id.startsWith("use-model-")) {
      const [providerInstanceId, model] = id.slice("use-model-".length).split("::");
      if (providerInstanceId && model) {
        set({ providerInstanceId, model });
      }
    }
  };

  if (!open) return null;

  return (
    <div
      data-slot="command-palette-overlay"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[15vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <CommandPalette
        commands={commands}
        query={query}
        activeId={activeId}
        onQueryChange={setQuery}
        onActiveChange={setActiveId}
        onRun={run}
      />
    </div>
  );
};
