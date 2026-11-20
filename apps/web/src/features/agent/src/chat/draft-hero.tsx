import { useAuiState } from "@assistant-ui/react";
import { FolderTreeIcon, MessagesSquareIcon } from "lucide-react";
import { useAgentText } from "../i18n";
import { usePmIssueWorkspace } from "../pm/pm-issue-workspace";
import { threadExecutionSelection, usePmChatState } from "../pm/state";
import "./draft-hero.css";

/**
 * Empty-session hero. The project/workspace choice reuses the PM reference
 * scope picker; the execution target is the selection the session already
 * bound. No favicon or project icon is synthesized: only real names are shown,
 * and with no data the hero keeps just its headline.
 */
export function DraftHero({ title, alternateLabel, onAlternate }: { title: string; alternateLabel?: string; onAlternate?: () => void }) {
  const t = useAgentText();
  const scope = usePmIssueWorkspace();
  const state = usePmChatState();
  const localThreadId = useAuiState((s) => s.threads.mainThreadId);
  const selection = threadExecutionSelection(localThreadId);
  const executionName = selection?.agentWorkspaceId
    ? state.workspaces.find((workspace) => workspace.id === selection.agentWorkspaceId)?.name
    : undefined;
  const scopeLabel = scope.projectName ?? scope.workspaceName;
  const hasScope = !!scopeLabel;
  // Chat-only is the absence of a folder target, so it adds no data to the hero.
  const hasExecution = !!executionName;
  return (
    <div className="draft-hero" data-draft-hero>
      <h1 className="draft-hero-title">{title}</h1>
      {(hasScope || hasExecution) && (
        <div className="draft-hero-scope" aria-label={t("当前项目与执行位置", "Current project and execution target")}>
          {hasScope && (
            <button
              type="button"
              className="draft-hero-scope-picker"
              aria-haspopup="dialog"
              aria-expanded={scope.pickerOpen}
              title={t("选择项目工作区", "Choose the project workspace")}
              onClick={scope.openPicker}
            >
              <FolderTreeIcon aria-hidden="true" />
              <span>{scopeLabel}</span>
              <span className="draft-hero-scope-action">{t("更换", "Change")}</span>
            </button>
          )}
          {hasExecution && (
            <span
              className="draft-hero-execution"
              title={t("执行位置沿用当前会话设置；在会话详情中可以更改。", "The execution target follows the current session; change it in session details.")}
            >
              <MessagesSquareIcon aria-hidden="true" />
              <span>{executionName}</span>
            </span>
          )}
        </div>
      )}
      {alternateLabel && onAlternate && (
        <button type="button" className="draft-hero-alternate" onClick={onAlternate}>
          {alternateLabel}
        </button>
      )}
    </div>
  );
}
