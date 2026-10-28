"use client";

import { useState } from "react";
import { CommandIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useTheme } from "@/hooks/use-theme";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { SettingsDialog } from "@/components/assistant-ui/elements/settings-dialog.aui";
import { CommandPaletteHost } from "@/components/assistant-ui/elements/command-palette-host.aui";
import { type ChatSettings, type SettingsUpdater } from "@/hooks/use-chat-settings";

export type ShellChromeProps = {
  settings: ChatSettings;
  set: SettingsUpdater;
  displayedModel: string;
};

/**
 * Workspace chrome above the thread: sidebar trigger, live model badge, and
 * the entries into the command palette and settings dialog.
 */
export const ShellChrome = ({ settings, set, displayedModel }: ShellChromeProps) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <>
      <header
        data-slot="aui_thread-toolbar"
        className="border-border sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3"
      >
        <SidebarTrigger className="size-7" />
        <span
          data-slot="aui_thread-toolbar-model"
          className="text-muted-foreground truncate font-mono text-xs"
        >
          {displayedModel}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <TooltipIconButton
            tooltip={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            side="bottom"
            className="aui-thread-toolbar-theme text-muted-foreground hover:text-foreground size-7"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Command palette (⌘K)"
            side="bottom"
            className="aui-thread-toolbar-palette text-muted-foreground hover:text-foreground size-7"
            aria-label="Open command palette"
            onClick={() => setPaletteOpen(true)}
          >
            <CommandIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Settings"
            side="bottom"
            className="aui-thread-toolbar-settings text-muted-foreground hover:text-foreground size-7"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon className="size-4" />
          </TooltipIconButton>
        </div>
      </header>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        set={set}
      />
      <CommandPaletteHost
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        settings={settings}
        set={set}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </>
  );
};
