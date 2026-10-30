import { PatchDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { Component, useMemo, type ReactNode } from "react";
import { useChatBrowserPreferences } from "@agent/src/settings/browser-preferences";
import { agentText, useAgentText } from "../../i18n";

const DIFF_OPTIONS: FileDiffOptions<undefined, undefined> = {
  themeType: "system",
  overflow: "scroll",
};

const HUNK_HEADER = /^@@ /m;

type DiffViewProps = {
  patch: string;
  path: string;
  truncated?: boolean;
  untracked?: boolean;
};

type DiffBoundaryProps = {
  path: string;
  children: ReactNode;
};

type DiffBoundaryState = { failed: boolean };

/** PatchDiff throws while parsing malformed or multi-file patches; keep the panel alive. */
class DiffRenderBoundary extends Component<DiffBoundaryProps, DiffBoundaryState> {
  state: DiffBoundaryState = { failed: false };

  static getDerivedStateFromError(): DiffBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="inspector-empty" role="alert">
          {agentText(`无法渲染 ${this.props.path} 的差异内容。`, `Could not render the diff for ${this.props.path}.`)}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders one file's diff in the user's preferred layout. Safe for non-git diffs (plain `---`/`+++` patches)
 * and for payloads that contain no hunks at all.
 */
export function DiffView({ patch, path, truncated = false, untracked = false }: DiffViewProps) {
  const t = useAgentText();
  const { preferences } = useChatBrowserPreferences();
  const options = useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({ ...DIFF_OPTIONS, diffStyle: preferences.diffLayout }),
    [preferences.diffLayout],
  );

  if (!patch.trim()) {
    return (
      <div className="inspector-empty">
        {untracked
          ? t(`${path} 是未跟踪的空文件。`, `${path} is an untracked empty file.`)
          : t(`${path} 没有差异内容。`, `${path} has no diff content.`)}
      </div>
    );
  }

  if (!HUNK_HEADER.test(patch)) {
    return (
      <div className="inspector-empty">
        {t(`${path} 没有可显示的文本差异。`, `${path} has no textual diff to display.`)}
      </div>
    );
  }

  return (
    <div className="inspector-diff" style={{ minHeight: 0, flex: 1 }}>
      {truncated ? (
        <p className="inspector-muted" role="status" style={{ margin: 0, padding: "6px 10px" }}>
          {t("差异过大，仅显示前一部分内容。", "The diff is large; only the first part is shown.")}
        </p>
      ) : null}
      <DiffRenderBoundary key={patch} path={path}>
        <PatchDiff patch={patch} disableWorkerPool options={options} />
      </DiffRenderBoundary>
    </div>
  );
}
