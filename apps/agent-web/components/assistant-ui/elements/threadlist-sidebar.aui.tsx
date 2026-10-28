import type * as React from "react";
import { MessagesSquare, SparklesIcon } from "lucide-react";
import { Link } from "react-router-dom";
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
} from "@/components/ui/sidebar";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { PANELS } from "@/src/workspace/panel-catalog";
import { useWorkspace } from "@/src/workspace/provider";

/**
 * Sidebar shell around the runtime thread list. Header and footer carry this
 * product's identity (the upstream copy links to assistant-ui.com and GitHub).
 */
export function ThreadListSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
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
                <span className="text-muted-foreground text-xs">持久会话与自动化</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="aui-sidebar-content px-2">
        <SidebarGroup className="p-0">
          <SidebarGroupLabel>会话工作区</SidebarGroupLabel>
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
                    <span className="live-running-dot ms-auto" aria-label="排队或运行中" />
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
              <SidebarGroupLabel>工作区工具</SidebarGroupLabel>
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
          <SidebarGroupLabel>对话</SidebarGroupLabel>
          <ThreadList />
        </div>
      </SidebarContent>
      {props.collapsible !== "none" && <SidebarRail />}
      <SidebarFooter className="aui-sidebar-footer border-t">
        <SidebarMenu>
          {(import.meta.env.DEV || import.meta.env.VITE_ENABLE_UI_LAB === "1") && (
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link to="/showcase" />} tooltip="页面与组件展示">
                <MessagesSquare className="size-4" />
                <span>页面与组件展示</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
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
