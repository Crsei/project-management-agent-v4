import { GitBranch, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@agent/components/ui/button";
import type {
  GitChangedFile,
  GitDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "@agent-workspace/contracts/inspector";
import { errorMessage } from "./api";
import { useInspectorUrl } from "./scope";
import { workspaceClient } from "@agent/src/network";
import { DiffView } from "./diff-view";
import { useAgentText, type AgentText } from "../../i18n";

type DiffMode = "staged" | "worktree";

type Selection = { path: string; mode: DiffMode };

const STATUS_TEXT: Record<GitFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "??",
  conflicted: "U",
};

const STATUS_TONE: Record<GitFileStatus, "added" | "deleted" | "modified"> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "modified",
  copied: "modified",
  untracked: "modified",
  conflicted: "modified",
};

function statusTitle(t: AgentText): Record<GitFileStatus, string> {
  return {
    added: t("新增", "Added"),
    modified: t("修改", "Modified"),
    deleted: t("删除", "Deleted"),
    renamed: t("重命名", "Renamed"),
    copied: t("复制", "Copied"),
    untracked: t("未跟踪", "Untracked"),
    conflicted: t("冲突", "Conflicted"),
  };
}

function stagingLabel(t: AgentText, file: GitChangedFile): string {
  if (file.staged && file.unstaged) return t("已暂存 · 工作区", "Staged · Worktree");
  if (file.staged) return t("已暂存", "Staged");
  return t("工作区", "Worktree");
}

export function GitPanel({ active = true }: { active?: boolean }) {
  const t = useAgentText();
  const inspectUrl = useInspectorUrl();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);

  const statusRequest = useRef<AbortController | null>(null);
  const diffRequest = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;

    setLoading(true);
    setStatusError(null);
    try {
      const data = await workspaceClient.json<GitStatusResponse>(inspectUrl("/api/inspector/git"), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStatus(data);
      setSelection((current) => {
        if (!current) return current;
        const file = data.files.find((item) => item.path === current.path);
        if (!file) return null;
        const mode: DiffMode =
          current.mode === "staged" && !file.staged && file.unstaged ? "worktree" : current.mode;
        return mode === current.mode ? current : { path: current.path, mode };
      });
      setDiffRevision((revision) => revision + 1);
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatusError(errorMessage(error));
    } finally {
      if (statusRequest.current === controller) {
        statusRequest.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, [inspectUrl]);

  const loadDiff = useCallback(async (path: string, mode: DiffMode) => {
    diffRequest.current?.abort();
    const controller = new AbortController();
    diffRequest.current = controller;

    setDiffLoading(true);
    setDiffError(null);
    setDiff(null);
    try {
      const data = await workspaceClient.json<GitDiffResponse>(
        inspectUrl("/api/inspector/git/diff", {
          path,
          staged: mode === "staged" ? "1" : undefined,
        }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setDiff(data);
    } catch (error) {
      if (controller.signal.aborted) return;
      setDiffError(errorMessage(error));
    } finally {
      if (diffRequest.current === controller) {
        diffRequest.current = null;
        if (!controller.signal.aborted) setDiffLoading(false);
      }
    }
  }, [inspectUrl]);

  // Cleanup can run during StrictMode's mount replay; every active setup reloads.
  useEffect(() => {
    if (active) void loadStatus();
    return () => statusRequest.current?.abort();
  }, [active, loadStatus]);

  useEffect(() => {
    if (!selection) {
      diffRequest.current?.abort();
      diffRequest.current = null;
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    void loadDiff(selection.path, selection.mode);
  }, [selection, diffRevision, loadDiff]);

  useEffect(() => {
    const pendingStatus = statusRequest;
    const pendingDiff = diffRequest;
    return () => {
      pendingStatus.current?.abort();
      pendingDiff.current?.abort();
    };
  }, []);

  function changeMode(mode: DiffMode) {
    setSelection((current) => (current && current.mode !== mode ? { ...current, mode } : current));
  }

  const files = status?.files ?? [];
  const selectedFile = selection
    ? (files.find((file) => file.path === selection.path) ?? null)
    : null;
  const showModeSwitch = Boolean(selectedFile?.staged && selectedFile.unstaged);

  return (
    <div className="inspector-panel" style={{ minHeight: 0 }}>
      <div className="inspector-toolbar">
        <GitBranch className="size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium">Git</span>
        {status?.repo ? (
          <>
            <span className="inspector-muted">
              {status.branch
                ? t(`分支 ${status.branch}`, `Branch ${status.branch}`)
                : t("游离 HEAD", "Detached HEAD")}
            </span>
            <span className="inspector-muted">
              {status.upstream
                ? t(`上游 ${status.upstream}`, `Upstream ${status.upstream}`)
                : t("无上游分支", "No upstream branch")}
            </span>
            {status.ahead > 0 ? (
              <span
                className="inspector-muted"
                title={t("领先上游的提交数", "Commits ahead of upstream")}
              >
                ↑ {status.ahead}
              </span>
            ) : null}
            {status.behind > 0 ? (
              <span
                className="inspector-muted"
                title={t("落后上游的提交数", "Commits behind upstream")}
              >
                ↓ {status.behind}
              </span>
            ) : null}
            {status.upstream && status.ahead === 0 && status.behind === 0 ? (
              <span className="inspector-muted">{t("与上游同步", "Up to date with upstream")}</span>
            ) : null}
          </>
        ) : null}
        <span className="inspector-toolbar-spacer" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void loadStatus()}
          disabled={loading}
          aria-busy={loading}
          aria-label={t("刷新 Git 状态", "Refresh Git status")}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden="true" />
        </Button>
      </div>

      {status?.repo && status.root ? (
        <p className="inspector-muted inspector-mono" style={{ margin: 0 }} title={status.root}>
          {t("仓库根目录：", "Repository root: ")}
          {status.root}
        </p>
      ) : null}

      {statusError ? (
        <div className="inspector-empty" role="alert">
          <p style={{ margin: 0 }}>
            {t("无法读取 Git 状态：", "Could not read Git status: ")}
            {statusError}
          </p>
          <Button
            size="sm"
            variant="outline"
            style={{ marginTop: 8 }}
            onClick={() => void loadStatus()}
          >
            {t("重试", "Retry")}
          </Button>
        </div>
      ) : null}

      {!status && loading ? (
        <p className="inspector-empty">{t("正在读取 Git 状态…", "Reading Git status…")}</p>
      ) : null}

      {status && !status.repo ? (
        <p className="inspector-empty">
          {t(
            "当前项目不是 Git 仓库，或本机没有可用的 Git。",
            "This project is not a Git repository, or Git is unavailable on this machine.",
          )}
        </p>
      ) : null}

      {status?.repo && files.length === 0 ? (
        <p className="inspector-empty">{t("工作区干净。", "The worktree is clean.")}</p>
      ) : null}

      {status?.repo && files.length > 0 ? (
        <div className="inspector-split">
          <div
            className="inspector-scroll"
            style={{
              maxHeight: "38%",
              minHeight: 0,
              flexShrink: 0,
              padding: 4,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-module)",
            }}
            aria-label={t("变更文件", "Changed files")}
          >
            {status.truncated ? (
              <p className="inspector-muted" style={{ margin: 0, padding: "4px 6px" }}>
                {t(
                  `文件过多，仅显示前 ${files.length} 项。`,
                  `Too many changes; only the first ${files.length} are shown.`,
                )}
              </p>
            ) : null}
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                className="inspector-tree-row"
                aria-selected={selection?.path === file.path}
                title={`${statusTitle(t)[file.status]} ${file.path}`}
                onClick={() =>
                  setSelection({
                    path: file.path,
                    mode: file.unstaged ? "worktree" : "staged",
                  })
                }
              >
                <span className="inspector-badge" data-tone={STATUS_TONE[file.status]}>
                  {STATUS_TEXT[file.status]}
                </span>
                <span className="inspector-tree-label" style={{ flex: 1 }}>
                  {file.oldPath ? (
                    <>
                      <span className="inspector-muted">{file.oldPath} → </span>
                      {file.path}
                    </>
                  ) : (
                    file.path
                  )}
                </span>
                <span className="inspector-muted" style={{ flexShrink: 0 }}>
                  {stagingLabel(t, file)}
                </span>
              </button>
            ))}
          </div>

          <div className="inspector-toolbar" style={{ flexShrink: 0 }}>
            <span
              className="inspector-tree-label inspector-mono"
              style={{ flex: 1 }}
              title={selection?.path}
            >
              {selection ? selection.path : t("未选择文件", "No file selected")}
            </span>
            {diffLoading ? (
              <span className="inspector-muted">{t("读取中…", "Loading…")}</span>
            ) : null}
            {selection && showModeSwitch ? (
              <div
                role="group"
                aria-label={t("差异来源", "Diff source")}
                style={{ display: "flex", gap: 4 }}
              >
                <Button
                  size="xs"
                  variant={selection.mode === "staged" ? "secondary" : "ghost"}
                  aria-pressed={selection.mode === "staged"}
                  onClick={() => changeMode("staged")}
                >
                  {t("已暂存", "Staged")}
                </Button>
                <Button
                  size="xs"
                  variant={selection.mode === "worktree" ? "secondary" : "ghost"}
                  aria-pressed={selection.mode === "worktree"}
                  onClick={() => changeMode("worktree")}
                >
                  {t("工作区", "Worktree")}
                </Button>
              </div>
            ) : selection ? (
              <span className="inspector-muted">
                {selection.mode === "staged"
                  ? t("已暂存", "Staged")
                  : t("工作区", "Worktree")}
              </span>
            ) : null}
          </div>

          {!selection ? null : diffError ? (
            <div className="inspector-empty" role="alert">
              {t("无法读取该文件的差异：", "Could not read the diff for this file: ")}
              {diffError}
            </div>
          ) : diff ? (
            <DiffView
              patch={diff.patch}
              path={diff.path}
              truncated={diff.truncated}
              untracked={diff.untracked}
            />
          ) : (
            <p className="inspector-empty">{t("正在读取差异…", "Reading diff…")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
