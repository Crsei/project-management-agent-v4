import type * as React from "react";
import { MessagesSquare, SparklesIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@agent/components/ui/sidebar";
import { ThreadList } from "@agent/components/assistant-ui/elements/thread-list.aui";
import { PANELS } from "@agent/src/workspace/panel-catalog";
import { useWorkspace } from "@agent/src/workspace/provider";
import { useAgentText } from "@agent/src/i18n";

/**
 * Sidebar shell around the runtime thread list. Header and footer carry this
 * product's identity (the upstream copy links to assistant-ui.com and GitHub).
 */
export function ThreadListSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const t = useAgentText();
  const { panel, setPanel, busy } = useWorkspace();
  const { isMobile, setOpenMobile } = useSidebar();
  const sessionPanels = PANELS.filter((item) => item.group === "session");
  const inspectorPanels = PANELS.filter((item) => item.group === "inspector");
  const selectPanel = (id: (typeof PANELS)[number]["id"]) => {
    setPanel(panel === id ? null : id);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="aui-sidebar-header mb-2 border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="aui-sidebar-header-brand pointer-events-none gap-2.5"
            >
              <div className="aui-sidebar-header-icon-wrapper bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                <MessagesSquare className="aui-sidebar-header-icon size-4" />
              </div>
              <div className="aui-sidebar-header-heading flex flex-col gap-0.5 leading-none">
                <span className="aui-sidebar-header-title font-semibold">agent-workspace</span>
                <span className="text-muted-foreground text-xs">{t("持久会话与自动化", "Persistent sessions and automation")}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="aui-sidebar-content px-2">
        <SidebarGroup className="p-0">
          <SidebarGroupLabel>{t("会话工作区", "Session workspace")}</SidebarGroupLabel>
          <SidebarMenu>
            {sessionPanels.map(({ id, label, icon: Icon }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton
                  isActive={panel === id}
                  aria-pressed={panel === id}
                  aria-controls="live-workspace-panel"
                  tooltip={label}
                  onClick={() => selectPanel(id)}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  <span>{label}</span>
                  {id === "runs" && busy && (
                    <span className="live-running-dot ms-auto" aria-label={t("排队或运行中", "Queued or running")} />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {isMobile && (
          <>
            <SidebarSeparator />
            <SidebarGroup className="p-0">
              <SidebarGroupLabel>{t("工作区工具", "Workspace tools")}</SidebarGroupLabel>
              <SidebarMenu>
                {inspectorPanels.map(({ id, label, icon: Icon }) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton
                      isActive={panel === id}
                      aria-pressed={panel === id}
                      aria-controls="live-workspace-panel"
                      tooltip={label}
                      onClick={() => selectPanel(id)}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </>
        )}
        <SidebarSeparator />
        <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SidebarGroupLabel>{t("对话", "Conversations")}</SidebarGroupLabel>
          <ThreadList />
        </div>
      </SidebarContent>
      {props.collapsible !== "none" && <SidebarRail />}
      <SidebarFooter className="aui-sidebar-footer border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="aui-sidebar-footer-brand text-muted-foreground flex items-center gap-2.5 px-2.5 py-2 text-xs">
              <SparklesIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">assistant-ui · AI SDK v7</span>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
