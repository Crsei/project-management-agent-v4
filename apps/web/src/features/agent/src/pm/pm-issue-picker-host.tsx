import { usePmIssueWorkspace } from "./pm-issue-workspace";
import { PmIssuePicker } from "./pm-issue-picker";

/** Single picker instance shared by the sidebar and composer. */
export function PmIssuePickerHost() {
  const workspace = usePmIssueWorkspace();
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
    loading={workspace.loading}
    error={workspace.error}
    hasMore={workspace.hasMore}
    onLoadMore={workspace.loadMore}
  />;
}
