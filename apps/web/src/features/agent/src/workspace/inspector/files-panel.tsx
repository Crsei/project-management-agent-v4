import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw,
  WrapText,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@agent/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
  InspectorFileResponse,
  InspectorTreeResponse,
} from "@agent-workspace/contracts/inspector";
import { errorMessage } from "./api";
import { InspectorExecution, useInspectorScope, useInspectorUrl } from "./scope";
import { workspaceClient } from "@agent/src/network";
import { useAgentText } from "../../i18n";

const MAX_RENDERED_LINES = 3000;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function FilesPanel({ active = true }: { active?: boolean }) {
  return <InspectorExecution><FilesRootPanel active={active} /></InspectorExecution>;
}

function FilesRootPanel({ active }: { active: boolean }) {
  const t = useAgentText();
  const inspectUrl = useInspectorUrl();
  const inspectorScope = useInspectorScope();
  const [trees, setTrees] = useState<Record<string, InspectorTreeResponse>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirLoading, setDirLoading] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<InspectorFileResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [treeMenuTarget, setTreeMenuTarget] = useState<{ path: string; expanded: boolean } | null>(null);

  const mounted = useRef(false);
  const treeRequests = useRef(new Map<string, AbortController>());
  const fileRequest = useRef<AbortController | null>(null);

  async function loadTree(path: string) {
    treeRequests.current.get(path)?.abort();
    const controller = new AbortController();
    treeRequests.current.set(path, controller);

    if (path === "") {
      setTreeLoading(true);
      setTreeError(null);
    } else {
      setDirLoading((current) => new Set(current).add(path));
      setDirErrors((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    }

    try {
      const data = await workspaceClient.json<InspectorTreeResponse>(
        inspectUrl("/api/inspector/files", { path: path || undefined }),
        { signal: controller.signal },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setTrees((current) => ({ ...current, [path]: data }));
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const message = errorMessage(error);
      if (path === "") setTreeError(message);
      else setDirErrors((current) => ({ ...current, [path]: message }));
    } finally {
      const isCurrent = treeRequests.current.get(path) === controller;
      if (isCurrent) {
        treeRequests.current.delete(path);
        if (!controller.signal.aborted) {
          if (path === "") setTreeLoading(false);
          setDirLoading((current) => {
            if (!current.has(path)) return current;
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        }
      }
    }
  }

  async function loadFile(path: string) {
    fileRequest.current?.abort();
    const controller = new AbortController();
    fileRequest.current = controller;

    setFileLoading(true);
    setFileError(null);
    setFile(null);

    try {
      const data = await workspaceClient.json<InspectorFileResponse>(
        inspectUrl("/api/inspector/file", { path }),
        { signal: controller.signal },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setFile(data);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setFileError(errorMessage(error));
    } finally {
      if (fileRequest.current === controller) {
        fileRequest.current = null;
        if (!controller.signal.aborted) setFileLoading(false);
      }
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const paths = ["", ...Array.from(expanded)];
      await Promise.all(paths.map((path) => loadTree(path)));
      if (selectedPath) await loadFile(selectedPath);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    refreshRef.current = () => {
      void refresh();
    };
  });

  useEffect(() => {
    mounted.current = true;
    void loadTree("");
    const pendingTrees = treeRequests.current;
    const pendingFile = fileRequest;
    return () => {
      mounted.current = false;
      for (const controller of pendingTrees.values()) controller.abort();
      pendingTrees.clear();
      pendingFile.current?.abort();
      pendingFile.current = null;
    };
  }, []);

  // Refresh the listing whenever the panel becomes visible again.
  const previousActive = useRef(active);
  useEffect(() => {
    const wasActive = previousActive.current;
    previousActive.current = active;
    if (!wasActive && active) refreshRef.current();
  }, [active]);

  function setDirectoryExpanded(path: string, nextExpanded: boolean) {
    if (!nextExpanded) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(path));
    if (!trees[path] && !dirLoading.has(path)) void loadTree(path);
  }

  function toggleDirectory(path: string) {
    setDirectoryExpanded(path, !expanded.has(path));
  }

  function openDirectory(path: string) {
    const parts = path.split("/");
    const chain: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      chain.push(parts.slice(0, index + 1).join("/"));
    }
    setExpanded((current) => {
      const next = new Set(current);
      for (const item of chain) next.add(item);
      return next;
    });
    for (const item of chain) {
      if (!trees[item] && !dirLoading.has(item)) void loadTree(item);
    }
  }

  function selectFile(path: string) {
    setSelectedPath(path);
    void loadFile(path);
  }

  function renderTree(path: string, depth: number): ReactNode {
    const tree = trees[path];
    if (!tree) return null;
    const indent = 6 + (depth + 1) * 14;
    return (
      <>
        {tree.entries.map((entry) => {
          const directory = entry.kind === "directory";
          const open = directory && expanded.has(entry.path);
          const menuExpanded = treeMenuTarget?.path === entry.path ? treeMenuTarget.expanded : open;
          return (
            <div key={entry.path}>
              <ContextMenu onOpenChange={(isOpen) => {
                if (isOpen) setTreeMenuTarget({ path: entry.path, expanded: open });
              }}>
                <ContextMenuTrigger asChild onContextMenu={() => setTreeMenuTarget({ path: entry.path, expanded: open })}>
              <button
                type="button"
                className="inspector-tree-row"
                style={{ paddingLeft: 6 + depth * 14 }}
                aria-expanded={directory ? open : undefined}
                aria-selected={!directory && selectedPath === entry.path}
                title={entry.path}
                onClick={() => (directory ? toggleDirectory(entry.path) : selectFile(entry.path))}
              >
                {directory ? (
                  open ? (
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                  )
                ) : (
                  <span className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                {directory ? (
                  open ? (
                    <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                  )
                ) : (
                  <FileIcon className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                <span className="inspector-tree-label">{entry.name}</span>
                {!directory && entry.size !== null ? (
                  <span className="inspector-muted" style={{ marginLeft: "auto", flexShrink: 0 }}>
                    {formatBytes(entry.size)}
                  </span>
                ) : null}
              </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => directory ? setDirectoryExpanded(entry.path, !menuExpanded) : selectFile(entry.path)}>
                    {directory
                      ? menuExpanded ? t("折叠目录", "Collapse directory") : t("展开目录", "Expand directory")
                      : t("查看文件", "View file")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={directory ? dirLoading.has(entry.path) : fileLoading && selectedPath === entry.path}
                    title={(directory ? dirLoading.has(entry.path) : fileLoading && selectedPath === entry.path) ? t("正在读取，请稍候。", "A read is in progress; please wait.") : undefined}
                    onSelect={() => {
                      if (directory) {
                        void loadTree(entry.path);
                      } else selectFile(entry.path);
                    }}
                  >
                    {directory ? t("刷新目录", "Refresh directory") : t("刷新文件内容", "Refresh file contents")}
                  </ContextMenuItem>
                  {directory && inspectorScope.onOpenTerminal && <>
                    <ContextMenuItem onSelect={() => inspectorScope.onOpenTerminal?.({ relativePath: entry.path, scope: "workspace" })}>{t("在此目录新建 Workspace 终端", "New Workspace terminal here")}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => inspectorScope.onOpenTerminal?.({ relativePath: entry.path, scope: "session" })}>{t("在此目录新建 Session 终端", "New Session terminal here")}</ContextMenuItem>
                  </>}
                </ContextMenuContent>
              </ContextMenu>
              {directory && open ? (
                <>
                  {!trees[entry.path] && dirLoading.has(entry.path) ? (
                    <p
                      className="inspector-muted"
                      style={{ margin: 0, padding: `2px 6px 2px ${indent}px` }}
                    >
                      {t("正在加载…", "Loading…")}
                    </p>
                  ) : null}
                  {dirErrors[entry.path] ? (
                    <p
                      role="alert"
                      className="inspector-muted"
                      style={{
                        margin: 0,
                        padding: `2px 6px 2px ${indent}px`,
                        color: "var(--danger)",
                      }}
                    >
                      {t("无法读取该目录：", "Could not read this directory: ")}
                      {dirErrors[entry.path]}
                    </p>
                  ) : null}
                  {trees[entry.path]?.entries.length === 0 ? (
                    <p
                      className="inspector-muted"
                      style={{ margin: 0, padding: `2px 6px 2px ${indent}px` }}
                    >
                      {t("空目录", "Empty directory")}
                    </p>
                  ) : null}
                  {renderTree(entry.path, depth + 1)}
                </>
              ) : null}
            </div>
          );
        })}
        {tree.truncated ? (
          <p
            className="inspector-muted"
            style={{ margin: 0, padding: `2px 6px 2px ${6 + depth * 14}px` }}
          >
            {t(
              `条目过多，仅显示前 ${tree.entries.length} 项。`,
              `Too many entries; only the first ${tree.entries.length} are shown.`,
            )}
          </p>
        ) : null}
      </>
    );
  }

  const fileCount = useMemo(() => {
    let count = 0;
    for (const tree of Object.values(trees)) {
      for (const entry of tree.entries) if (entry.kind === "file") count += 1;
    }
    return count;
  }, [trees]);

  const preview = useMemo(() => {
    if (!file) return null;
    const lines = file.content
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return {
      total: lines.length,
      shown: lines.slice(0, MAX_RENDERED_LINES),
    };
  }, [file]);

  const breadcrumb = selectedPath ? selectedPath.split("/") : [];
  const rootTree = trees[""];

  return (
    <div className="inspector-panel" style={{ minHeight: 0 }}>
      <div className="inspector-toolbar">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-busy={refreshing}
          aria-label={t("刷新文件列表", "Refresh file list")}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => inspectorScope.onOpenTerminal?.({ relativePath: "", scope: "workspace" })}>{t("根目录 Workspace 终端", "Workspace terminal at root")}</Button>
        <Button variant="ghost" size="sm" onClick={() => inspectorScope.onOpenTerminal?.({ relativePath: "", scope: "session" })}>{t("根目录 Session 终端", "Session terminal at root")}</Button>
        {selectedPath ? (
          <nav
            className="inspector-mono"
            aria-label={t("当前文件路径", "Current file path")}
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 2,
              minWidth: 0,
            }}
          >
            <span className="inspector-muted">{t("根目录", "Root")}</span>
            {breadcrumb.map((segment, index) => {
              const path = breadcrumb.slice(0, index + 1).join("/");
              const last = index === breadcrumb.length - 1;
              return (
                <Fragment key={path}>
                  <span className="inspector-muted" aria-hidden="true">
                    /
                  </span>
                  {last ? (
                    <span
                      className="inspector-tree-label"
                      style={{ maxWidth: 180 }}
                      title={selectedPath}
                    >
                      {segment}
                    </span>
                  ) : (
                    <Button variant="ghost" size="xs" onClick={() => openDirectory(path)}>
                      {segment}
                    </Button>
                  )}
                </Fragment>
              );
            })}
          </nav>
        ) : (
          <span className="inspector-muted">{t("项目根目录", "Project root")}</span>
        )}
        <span className="inspector-toolbar-spacer" />
        <span
          className="inspector-muted"
          title={t("已加载目录中的文件总数", "Total files in the loaded directories")}
        >
          {t(`${fileCount} 个文件`, `${fileCount} files`)}
        </span>
      </div>

      {treeError && rootTree ? (
        <p role="alert" className="inspector-muted" style={{ margin: 0, color: "var(--danger)" }}>
          {t("刷新文件列表失败：", "Failed to refresh the file list: ")}
          {treeError}
        </p>
      ) : null}

      <div className="inspector-split">
        <div
          className="inspector-tree"
          style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <div className="inspector-scroll" style={{ flex: 1, minHeight: 0 }}>
            {treeLoading && !rootTree ? (
              <p className="inspector-muted" style={{ margin: 0, padding: 6 }}>
                {t("正在读取项目文件…", "Reading project files…")}
              </p>
            ) : null}
            {treeError && !rootTree ? (
              <div className="inspector-empty" role="alert" style={{ margin: 6 }}>
                <p style={{ margin: 0 }}>
                  {t("无法读取项目文件：", "Could not read project files: ")}
                  {treeError}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  style={{ marginTop: 8 }}
                  onClick={() => void loadTree("")}
                >
                  {t("重试", "Retry")}
                </Button>
              </div>
            ) : null}
            {rootTree && rootTree.entries.length === 0 ? (
              <p className="inspector-muted" style={{ margin: 0, padding: 6 }}>
                {t("项目根目录为空。", "The project root is empty.")}
              </p>
            ) : null}
            {rootTree ? renderTree("", 0) : null}
          </div>
        </div>

        <div
          className="inspector-code"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            padding: 0,
            overflow: "hidden",
          }}
        >
          <div
            className="inspector-toolbar"
            style={{
              flexShrink: 0,
              padding: "6px 10px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span
              className="inspector-tree-label inspector-mono"
              style={{ flex: 1 }}
              title={selectedPath ?? undefined}
            >
              {selectedPath ?? t("未选择文件", "No file selected")}
            </span>
            {file ? (
              <span className="inspector-muted">
                {formatBytes(file.size)}
                {preview ? t(` · ${preview.total} 行`, ` · ${preview.total} lines`) : ""}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-pressed={wrap}
              aria-label={t("切换自动换行", "Toggle word wrap")}
              onClick={() => setWrap((current) => !current)}
            >
              <WrapText aria-hidden="true" />
            </Button>
          </div>

          <div className="inspector-scroll" style={{ flex: 1, minHeight: 0, padding: "10px 12px" }}>
            {fileLoading && !file ? (
              <p className="inspector-muted" style={{ margin: 0 }}>
                {t("正在读取文件…", "Reading file…")}
              </p>
            ) : null}
            {fileError ? (
              <p
                role="alert"
                className="inspector-muted"
                style={{ margin: 0, color: "var(--danger)" }}
              >
                {t("无法读取文件：", "Could not read the file: ")}
                {fileError}
              </p>
            ) : null}
            {preview && !fileLoading ? (
              <>
                {file?.truncated ? (
                  <p className="inspector-muted" style={{ margin: "0 0 8px" }}>
                    {t(
                      "文件较大，仅返回了部分内容。",
                      "The file is large; only part of its contents were returned.",
                    )}
                  </p>
                ) : null}
                {preview.total > MAX_RENDERED_LINES ? (
                  <p className="inspector-muted" style={{ margin: "0 0 8px" }}>
                    {t(
                      `仅显示前 ${MAX_RENDERED_LINES} 行（共 ${preview.total} 行）。`,
                      `Showing the first ${MAX_RENDERED_LINES} of ${preview.total} lines.`,
                    )}
                  </p>
                ) : null}
                {preview.total === 0 ? (
                  <p className="inspector-muted" style={{ margin: 0 }}>
                    {t("（空文件）", "(Empty file)")}
                  </p>
                ) : (
                  <div
                    className="inspector-mono"
                    style={
                      wrap
                        ? {
                            display: "grid",
                            gridTemplateColumns: "max-content minmax(0, 1fr)",
                            gap: "0 12px",
                            minWidth: "100%",
                            lineHeight: 1.6,
                          }
                        : {
                            display: "grid",
                            gridTemplateColumns: "max-content max-content",
                            gap: "0 12px",
                            width: "max-content",
                            minWidth: "100%",
                            lineHeight: 1.6,
                          }
                    }
                  >
                    {preview.shown.map((line, index) => (
                      <Fragment key={index}>
                        <span
                          aria-hidden="true"
                          style={{
                            color: "var(--muted-foreground)",
                            textAlign: "right",
                            userSelect: "none",
                          }}
                        >
                          {index + 1}
                        </span>
                        <span
                          style={
                            wrap
                              ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }
                              : { whiteSpace: "pre" }
                          }
                        >
                          {line === "" ? " " : line}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
