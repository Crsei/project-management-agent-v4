import type { PmToolCallProjection } from "@agent-workspace/contracts/pm-tools";
import { usePmIssueWorkspace } from "./pm-issue-workspace";
import { PmSidebarContext } from "./pm-sidebar-context";
import { usePmToolCalls } from "../chat/pm-tool-calls";
import { pmToolChanges } from "./pm-tool-changes";

export function PmSidebarSection() {
  const workspace = usePmIssueWorkspace();
  const calls = usePmToolCalls();
  return <PmSidebarContext
    workspaceName={workspace.workspaceName}
    projectName={workspace.projectName}
    currentIssue={workspace.currentIssue}
    issues={workspace.filteredIssues}
    selectedIds={workspace.selectedIds}
    query={workspace.query}
    onQueryChange={workspace.setQuery}
    onToggle={workspace.toggleSelection}
    onOpenPicker={workspace.openPicker}
    onOpenIssue={(issue) => {
      workspace.selectCurrentIssue(issue.id);
      if (workspace.workspaceId) window.open(`/pm/${encodeURIComponent(workspace.workspaceId)}/entities/${encodeURIComponent(issue.id)}`, "_blank", "noopener,noreferrer");
    }}
    onClearSelection={workspace.clearSelection}
    onAddSelected={workspace.addSelectedToReferences}
    changes={pmToolChanges((calls?.items ?? []).filter((call): call is Extract<PmToolCallProjection, { name: string }> => "name" in call && call.visibility === "visible"))}
    changesLoading={calls?.loading}
    changesError={calls?.error}
    loading={workspace.loading}
    error={workspace.error}
    hasMore={workspace.hasMore}
    onLoadMore={workspace.loadMore}
  />;
}
