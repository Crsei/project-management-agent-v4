import { ClipboardList } from "lucide-react";
import { TooltipIconButton } from "@agent/components/assistant-ui/elements/tooltip-icon-button";

import { useAgentText } from "../i18n";
import { PM_REFERENCE_LIMIT, usePmIssueWorkspace } from "./pm-issue-workspace";
import { PmReferenceTray } from "./pm-reference-tray";

/**
 * Structured PM references for the next message. The tray only chips what the
 * transport already sends as `pmReferences`; nothing is injected as text.
 */
export function PmComposerReferences() {
  const workspace = usePmIssueWorkspace();
  return <>
    <PmReferenceTray
      references={workspace.references}
      onRemove={(reference) => workspace.removeReference(reference.id)}
      onClear={workspace.clearReferences}
      max={PM_REFERENCE_LIMIT}
    />
    {workspace.referenceError && <p role="alert" className="px-2 text-xs text-destructive">{workspace.referenceError}</p>}
  </>;
}

/** Opens the same issue picker used by the rest of the PM workspace. */
export function PmComposerReferenceAction() {
  const t = useAgentText();
  const workspace = usePmIssueWorkspace();
  return <TooltipIconButton
    type="button"
    tooltip={t("引用任务", "Reference tasks")}
    aria-label={t("引用任务", "Reference tasks")}
    aria-haspopup="dialog"
    aria-expanded={workspace.pickerOpen}
    onClick={workspace.openPicker}
    className="size-7 rounded-full text-muted-foreground hover:text-foreground"
  >
    <ClipboardList aria-hidden="true" className="size-4" />
  </TooltipIconButton>;
}
