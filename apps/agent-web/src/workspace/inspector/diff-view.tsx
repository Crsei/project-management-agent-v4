import { PatchDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { Component, type ReactNode } from "react";

const DIFF_OPTIONS: FileDiffOptions<undefined, undefined> = {
  themeType: "system",
  diffStyle: "unified",
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
          无法渲染 {this.props.path}{" "}
          的差异内容：补丁不是单个文件的统一差异（可能包含多个文件或为二进制内容）。
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders one file's unified diff. Safe for non-git diffs (plain `---`/`+++` patches)
 * and for payloads that contain no hunks at all.
 */
export function DiffView({ patch, path, truncated = false, untracked = false }: DiffViewProps) {
  if (!patch.trim()) {
    return (
      <div className="inspector-empty">
        {untracked
          ? `${path} 是未跟踪的空文件，没有可显示的差异。`
          : `${path} 没有差异内容（可能是二进制文件，或修改已不存在）。`}
      </div>
    );
  }

  if (!HUNK_HEADER.test(patch)) {
    return (
      <div className="inspector-empty">
        {path} 没有可显示的文本差异（可能是二进制文件、纯重命名或仅权限变更）。
      </div>
    );
  }

  return (
    <div className="inspector-diff" style={{ minHeight: 0, flex: 1 }}>
      {truncated ? (
        <p className="inspector-muted" role="status" style={{ margin: 0, padding: "6px 10px" }}>
          差异过大，服务端仅返回了前一部分内容。
        </p>
      ) : null}
      <DiffRenderBoundary key={patch} path={path}>
        <PatchDiff patch={patch} disableWorkerPool options={DIFF_OPTIONS} />
      </DiffRenderBoundary>
    </div>
  );
}
