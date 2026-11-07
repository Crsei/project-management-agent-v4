import { RadixSelect } from "@/components/ui/radix-select";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { refreshCatalog, usePmChatState } from "./state";
import { usePmIssueWorkspace } from "./pm-issue-workspace";
import { PmIssuePicker } from "./pm-issue-picker";

/** Single picker instance shared by the sidebar and composer. */
export function PmIssuePickerHost() {
  const workspace = usePmIssueWorkspace();
  const t = useAgentText();
  const state = usePmChatState();
  const targetWorkspace = state.catalog?.workspaces.find(item => item.id === workspace.workspaceId);
  return <PmIssuePicker
    open={workspace.pickerOpen}
    onOpenChange={(open) => {
      if (open) { workspace.openPicker(); return; }
      // Closing the picker commits the checked issues as structured chips; the
      // send path reads the same list, so no composer text is generated.
      workspace.addSelectedToReferences();
      workspace.closePicker();
    }}
    issues={workspace.filteredIssues}
    selectedIds={workspace.selectedIds}
    query={workspace.query}
    onQueryChange={workspace.setQuery}
    onToggle={workspace.toggleSelection}
    onSelectVisible={workspace.selectVisible}
    onClear={workspace.clearSelection}
    projectName={workspace.projectName}
    targetControls={<div className="grid gap-2">
      <label>{t("PM 资料来源工作区（不改变代码目录）", "PM source workspace (does not change the code folder)")}<RadixSelect value={workspace.workspaceId ?? ""} disabled={state.catalogLoading} onChange={event => workspace.selectTarget(event.target.value ? { workspaceId: event.target.value, projectId: null } : null)}><option value="">{t("明确选择 PM 工作区", "Choose a PM workspace explicitly")}</option>{state.catalog?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</RadixSelect></label>
      {targetWorkspace && <label>{t("资料项目", "Source project")}<RadixSelect value={workspace.projectId ?? ""} onChange={event => workspace.selectTarget({ workspaceId: targetWorkspace.id, projectId: event.target.value || null })}><option value="">{t("全部有权访问的项目", "All authorized projects")}</option>{targetWorkspace.projects.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</RadixSelect></label>}
      {state.catalogLoading && <p role="status">{t("正在发现 PM 工作区…", "Discovering PM workspaces…")}</p>}
      {state.catalogError && <p role="alert">{state.catalogError}</p>}
      <Button size="sm" variant="ghost" disabled={state.catalogLoading} onClick={() => void refreshCatalog().catch(() => {})}>{t("刷新 PM 资料来源", "Refresh PM sources")}</Button>
    </div>}
    loading={workspace.loading}
    error={workspace.error}
    hasMore={workspace.hasMore}
    onLoadMore={workspace.loadMore}
  />;
}
