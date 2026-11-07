import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Eye,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FileWarning,
  Folder,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  RefreshCw,
  Search,
  WrapText,
  X,
  type LucideIcon,
} from "lucide-react";
import { File as PierreFile, Virtualizer } from "@pierre/diffs/react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@agent/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
  InspectorFileResponse,
  InspectorSearchEntry,
  InspectorSearchResponse,
  InspectorTreeResponse,
} from "@agent-workspace/contracts/inspector";
import { useI18n } from "@/lib/i18n-provider";
import { useTheme } from "@agent/hooks/use-theme";
import { errorMessage } from "./api";
import { InspectorExecution, useInspectorScope, useInspectorUrl } from "./scope";
import { workspaceClient } from "@agent/src/network";
import { Markdown } from "../../chat/markdown";
import { useAgentText } from "../../i18n";

const EXPLORER_STORAGE_KEY = "pm.agent.files.explorer";
const WRAP_STORAGE_KEY = "pm.agent.files.wrap";
const RENDER_MARKDOWN_STORAGE_KEY = "pm.agent.files.renderMarkdown";
const SEARCH_DEBOUNCE_MS = 220;
const MAX_EXPANDED_DIRECTORIES = 200;

type FileTone =
  | "code"
  | "json"
  | "config"
  | "markdown"
  | "text"
  | "data"
  | "image"
  | "media"
  | "archive"
  | "lock"
  | "binary";

const TONE_EXTENSIONS: Record<string, FileTone> = {};
for (const extension of [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "rb", "php", "swift", "scala", "sh",
  "bash", "zsh", "fish", "lua", "dart", "ex", "exs", "erl", "hrl", "hs", "clj",
  "cljs", "cljc", "edn", "fs", "fsx", "vb", "pl", "pm", "r", "zig", "v", "sol",
  "astro", "vue", "svelte", "html", "htm", "xml", "graphql", "gql", "proto", "sql",
]) TONE_EXTENSIONS[extension] = "code";
for (const extension of ["json", "jsonc", "json5", "geojson"]) TONE_EXTENSIONS[extension] = "json";
for (const extension of [
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "editorconfig", "gitignore", "gitattributes", "dockerfile", "makefile",
]) TONE_EXTENSIONS[extension] = "config";
TONE_EXTENSIONS.lock = "lock";
for (const extension of ["md", "mdx", "markdown", "rst", "adoc"]) TONE_EXTENSIONS[extension] = "markdown";
for (const extension of ["txt", "text", "log"]) TONE_EXTENSIONS[extension] = "text";
for (const extension of ["csv", "tsv", "parquet", "sqlite", "db"]) TONE_EXTENSIONS[extension] = "data";
for (const extension of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff", "svg"]) TONE_EXTENSIONS[extension] = "image";
for (const extension of ["mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "flac", "ogg", "m4a"]) TONE_EXTENSIONS[extension] = "media";
for (const extension of ["zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z", "jar", "whl", "deb", "rpm"]) TONE_EXTENSIONS[extension] = "archive";
for (const extension of ["bin", "dat", "exe", "dll", "so", "dylib", "wasm"]) TONE_EXTENSIONS[extension] = "binary";

const AUDIO_EXTENSIONS: Record<string, true> = {
  mp3: true,
  wav: true,
  flac: true,
  ogg: true,
  m4a: true,
};

const FILE_TONE_VISUALS: Record<FileTone, { Icon: LucideIcon; tone: FileTone }> = {
  code: { Icon: FileCode2, tone: "code" },
  json: { Icon: FileJson, tone: "json" },
  config: { Icon: FileCog, tone: "config" },
  markdown: { Icon: FileText, tone: "markdown" },
  text: { Icon: FileText, tone: "text" },
  data: { Icon: FileSpreadsheet, tone: "data" },
  image: { Icon: FileImage, tone: "image" },
  media: { Icon: FileVideo, tone: "media" },
  archive: { Icon: FileArchive, tone: "archive" },
  lock: { Icon: FileLock, tone: "lock" },
  binary: { Icon: FileWarning, tone: "binary" },
};

function fileVisual(name: string): { Icon: LucideIcon; tone: FileTone } {
  const lower = name.toLowerCase();
  if (/^(dockerfile|makefile|cmakelists\.txt|procfile)$/.test(lower) || lower.startsWith(".")) {
    return FILE_TONE_VISUALS.config;
  }
  if (/(^|\/)license(\..*)?$/.test(lower)) return FILE_TONE_VISUALS.text;
  if (/(^|\/)readme(\..*)?$/.test(lower) || /\.(md|mdx|markdown)$/.test(lower)) {
    return FILE_TONE_VISUALS.markdown;
  }
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const tone = TONE_EXTENSIONS[extension];
  if (tone === "media" && AUDIO_EXTENSIONS[extension]) {
    return { Icon: FileAudio, tone: "media" };
  }
  if (tone) return FILE_TONE_VISUALS[tone];
  return { Icon: FileIcon, tone: "text" };
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // Storage can be unavailable in embedded or privacy-restricted contexts.
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function countLines(content: string): number {
  if (!content) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return content.endsWith("\n") ? lines - 1 : lines;
}

function pathAncestors(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment;
    ancestors.push(current);
  }
  return ancestors;
}

function directoryAncestors(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    ancestors.push(current);
  }
  return ancestors;
}

function failureOf(error: unknown): { message: string; code?: string } {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return { message: errorMessage(error), code };
}

function HighlightedMatch({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim();
  const index = trimmed ? text.toLowerCase().indexOf(trimmed.toLowerCase()) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="inspector-file-match">{text.slice(index, index + trimmed.length)}</mark>
      {text.slice(index + trimmed.length)}
    </>
  );
}

function SourcePreview({ path, contents, wrap }: { path: string; contents: string; wrap: boolean }) {
  const { theme } = useTheme();
  return (
    <Virtualizer
      key={`${path}:${contents.length}:${wrap}:${theme}`}
      className="inspector-file-virtualizer"
      config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
    >
      <PierreFile
        file={{ name: path, contents }}
        options={{
          disableFileHeader: true,
          overflow: wrap ? "wrap" : "scroll",
          themeType: theme,
        }}
        disableWorkerPool
        className="inspector-file-source"
      />
    </Virtualizer>
  );
}

export function FilesPanel({ active = true }: { active?: boolean }) {
  return <InspectorExecution><FilesRootPanel active={active} /></InspectorExecution>;
}

function FilesRootPanel({ active }: { active: boolean }) {
  const t = useAgentText();
  const { locale } = useI18n();
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
  const [fileError, setFileError] = useState<{ message: string; code?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchEntries, setSearchEntries] = useState<InspectorSearchEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(() => readStoredBoolean(EXPLORER_STORAGE_KEY, true));
  const [wrap, setWrap] = useState(() => readStoredBoolean(WRAP_STORAGE_KEY, false));
  const [renderMarkdown, setRenderMarkdown] = useState(() => readStoredBoolean(RENDER_MARKDOWN_STORAGE_KEY, false));
  const [expandAll, setExpandAll] = useState(false);
  const [expandAllCapped, setExpandAllCapped] = useState(false);
  const [treeMenuTarget, setTreeMenuTarget] = useState<{ path: string; expanded: boolean } | null>(null);

  const mounted = useRef(false);
  const treeRequests = useRef(new Map<string, AbortController>());
  const fileRequest = useRef<AbortController | null>(null);
  const searchRequest = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbsRef = useRef<HTMLElement | null>(null);
  const revealSelected = useRef(false);

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
      setFileError(failureOf(error));
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
      if (debouncedQuery) await runSearch(debouncedQuery);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  async function runSearch(value: string) {
    searchRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const data = await workspaceClient.json<InspectorSearchResponse>(
        inspectUrl("/api/inspector/search", { q: value }),
        { signal: controller.signal },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setSearchEntries(data.entries);
      setSearchTruncated(data.truncated);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setSearchEntries([]);
      setSearchTruncated(false);
      setSearchError(errorMessage(error));
    } finally {
      if (searchRequest.current === controller) {
        searchRequest.current = null;
        if (!controller.signal.aborted) setSearchLoading(false);
      }
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
    const pendingSearch = searchRequest;
    return () => {
      mounted.current = false;
      for (const controller of pendingTrees.values()) controller.abort();
      pendingTrees.clear();
      pendingFile.current?.abort();
      pendingFile.current = null;
      pendingSearch.current?.abort();
      pendingSearch.current = null;
    };
  }, []);

  const previousActive = useRef(active);
  useEffect(() => {
    const wasActive = previousActive.current;
    previousActive.current = active;
    if (wasActive || !active) return;
    // The panel refreshes when its tab becomes visible again.
    const timer = window.setTimeout(() => refreshRef.current(), 0);
    return () => window.clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) {
      searchRequest.current?.abort();
      searchRequest.current = null;
      setSearchEntries([]);
      setSearchError(null);
      setSearchLoading(false);
      setSearchTruncated(false);
      return;
    }
    void runSearch(debouncedQuery);
    return () => {
      searchRequest.current?.abort();
      searchRequest.current = null;
    };
  }, [debouncedQuery]);

  useEffect(() => {
    writeStoredBoolean(EXPLORER_STORAGE_KEY, explorerOpen);
  }, [explorerOpen]);

  useEffect(() => {
    writeStoredBoolean(WRAP_STORAGE_KEY, wrap);
  }, [wrap]);

  useEffect(() => {
    writeStoredBoolean(RENDER_MARKDOWN_STORAGE_KEY, renderMarkdown);
  }, [renderMarkdown]);

  useEffect(() => {
    if (!revealSelected.current || !selectedPath || !explorerOpen) return;
    const row = treeRef.current?.querySelector<HTMLElement>('.inspector-file-row[data-selected="true"]');
    if (!row) return;
    revealSelected.current = false;
    const frame = window.requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedPath, explorerOpen, trees]);

  useEffect(() => {
    breadcrumbsRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedPath, explorerOpen]);

  useEffect(() => {
    if (!expandAll || debouncedQuery) return;
    const pending: string[] = [];
    for (const tree of Object.values(trees)) {
      for (const entry of tree.entries) {
        if (entry.kind !== "directory" || expanded.has(entry.path)) continue;
        if (!trees[entry.path] && !dirLoading.has(entry.path)) pending.push(entry.path);
      }
    }
    if (pending.length === 0) return;
    const room = MAX_EXPANDED_DIRECTORIES - expanded.size;
    if (room <= 0) {
      setExpandAllCapped(true);
      return;
    }
    const next = pending.slice(0, room);
    setExpanded((current) => {
      const merged = new Set(current);
      for (const path of next) merged.add(path);
      return merged;
    });
    for (const path of next) void loadTree(path);
    if (pending.length > room) setExpandAllCapped(true);
  }, [expandAll, trees, expanded, dirLoading, debouncedQuery]);

  function setDirectoryExpanded(path: string, nextExpanded: boolean) {
    if (!nextExpanded) {
      setExpandAll(false);
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

  function revealDirectory(path: string) {
    if (!path) return;
    setExplorerOpen(true);
    const chain = directoryAncestors(path);
    setExpanded((current) => {
      const next = new Set(current);
      for (const item of chain) next.add(item);
      return next;
    });
    for (const item of chain) {
      if (!trees[item] && !dirLoading.has(item)) void loadTree(item);
    }
  }

  function revealFile(path: string) {
    const chain = pathAncestors(path);
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
    revealSelected.current = true;
    setSelectedPath(path);
    setQuery("");
    setDebouncedQuery("");
    setSearchEntries([]);
    setSearchError(null);
    setSearchTruncated(false);
    revealFile(path);
    void loadFile(path);
  }

  function toggleExpandAll() {
    if (expandAll) {
      setExpandAll(false);
      setExpandAllCapped(false);
      setExpanded(new Set());
      return;
    }
    setExpandAll(true);
    setExpandAllCapped(false);
  }

  function renderTree(path: string, depth: number): ReactNode {
    const tree = trees[path];
    if (!tree) return null;
    const indent = 8 + depth * 12;
    return (
      <>
        {tree.entries.map((entry) => {
          const directory = entry.kind === "directory";
          const open = directory && expanded.has(entry.path);
          const menuExpanded = treeMenuTarget?.path === entry.path ? treeMenuTarget.expanded : open;
          const visual = directory ? null : fileVisual(entry.name);
          return (
            <div key={entry.path}>
              <ContextMenu onOpenChange={(isOpen) => {
                if (isOpen) setTreeMenuTarget({ path: entry.path, expanded: open });
              }}>
                <ContextMenuTrigger asChild onContextMenu={() => setTreeMenuTarget({ path: entry.path, expanded: open })}>
                  <button
                    type="button"
                    className="inspector-file-row"
                    data-kind={entry.kind}
                    style={{ paddingLeft: indent }}
                    aria-expanded={directory ? open : undefined}
                    aria-current={!directory && selectedPath === entry.path ? "true" : undefined}
                    data-selected={!directory && selectedPath === entry.path}
                    title={directory ? entry.path : `${entry.path}${entry.size !== null ? ` · ${formatBytes(entry.size)}` : ""}`}
                    onClick={() => (directory ? toggleDirectory(entry.path) : selectFile(entry.path))}
                  >
                    {directory ? (
                      open ? (
                        <ChevronDown className="inspector-file-chevron" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="inspector-file-chevron" aria-hidden="true" />
                      )
                    ) : (
                      <span className="inspector-file-chevron" aria-hidden="true" />
                    )}
                    {directory ? (
                      open ? (
                        <FolderOpen className="inspector-file-icon" data-tone="folder" aria-hidden="true" />
                      ) : (
                        <Folder className="inspector-file-icon" data-tone="folder" aria-hidden="true" />
                      )
                    ) : visual ? (
                      <visual.Icon className="inspector-file-icon" data-tone={visual.tone} aria-hidden="true" />
                    ) : null}
                    <span className="inspector-file-label">{entry.name}</span>
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
                      if (directory) void loadTree(entry.path);
                      else if (selectedPath === entry.path) void loadFile(entry.path);
                      else selectFile(entry.path);
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
                    <p className="inspector-file-note" style={{ paddingLeft: indent + 20 }}>
                      {t("正在加载…", "Loading…")}
                    </p>
                  ) : null}
                  {dirErrors[entry.path] ? (
                    <p role="alert" className="inspector-file-note inspector-file-note--error" style={{ paddingLeft: indent + 20 }}>
                      {t("无法读取该目录：", "Could not read this directory: ")}
                      {dirErrors[entry.path]}
                    </p>
                  ) : null}
                  {trees[entry.path]?.entries.length === 0 ? (
                    <p className="inspector-file-note" style={{ paddingLeft: indent + 20 }}>
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
          <p className="inspector-file-note" style={{ paddingLeft: 8 + depth * 12 }}>
            {t(
              `条目过多，仅显示前 ${tree.entries.length} 项。`,
              `Too many entries; only the first ${tree.entries.length} are shown.`,
            )}
          </p>
        ) : null}
      </>
    );
  }

  const rootTree = trees[""];
  const rootPath = rootTree?.root ?? "";
  const rootName = rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath;
  const breadcrumb = selectedPath ? selectedPath.split("/") : [];
  const showSearch = debouncedQuery.length > 0;
  const markdown = selectedPath !== null && /\.(md|mdx|markdown)$/i.test(selectedPath);
  const lines = file ? countLines(file.content) : 0;

  const treePanel = (
    <aside className="inspector-file-explorer" aria-label={t("项目文件", "Project files")}>
      <div className="inspector-file-explorer-header">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-busy={refreshing}
          aria-label={t("刷新文件列表", "Refresh file list")}
          title={t("刷新文件列表", "Refresh file list")}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />
        </Button>
        <div className="inspector-file-search">
          <Search aria-hidden="true" />
          <input
            ref={searchInput}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setQuery("");
              setDebouncedQuery("");
              event.currentTarget.blur();
            }}
            placeholder={t("搜索文件", "Search files")}
            aria-label={t("搜索项目文件", "Search project files")}
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="inspector-file-search-clear"
              aria-label={t("清除搜索", "Clear search")}
              onClick={() => {
                setQuery("");
                setDebouncedQuery("");
                searchInput.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={toggleExpandAll}
          aria-pressed={expandAll}
          aria-label={expandAll ? t("折叠全部目录", "Collapse all folders") : t("展开全部目录", "Expand all folders")}
          title={expandAll ? t("折叠全部目录", "Collapse all folders") : t("展开全部目录", "Expand all folders")}
        >
          {expandAll ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
        </Button>
      </div>

      {expandAllCapped ? (
        <p className="inspector-file-note" role="status">
          {t(
            `为保持响应，最多展开 ${MAX_EXPANDED_DIRECTORIES} 个目录。`,
            `Expanded at most ${MAX_EXPANDED_DIRECTORIES} folders to stay responsive.`,
          )}
        </p>
      ) : null}

      <div ref={treeRef} className="inspector-file-tree" aria-label={t("文件树", "File tree")}>
        {showSearch ? (
          <>
            {searchLoading ? (
              <p className="inspector-file-note" role="status">
                <LoaderCircle className="animate-spin" aria-hidden="true" />
                {t("正在搜索…", "Searching…")}
              </p>
            ) : null}
            {searchError ? (
              <p className="inspector-file-note inspector-file-note--error" role="alert">
                {t("搜索失败：", "Search failed: ")}
                {searchError}
              </p>
            ) : null}
            {!searchLoading && !searchError && searchEntries.length === 0 ? (
              <div className="inspector-file-empty" role="status">
                <Search aria-hidden="true" />
                <p>{t("没有匹配的文件。", "No matching files.")}</p>
              </div>
            ) : null}
            {searchEntries.length > 0 ? (
              <div aria-label={t("搜索结果", "Search results")}>
                {searchEntries.map((entry) => {
                  const visual = fileVisual(entry.name);
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className="inspector-file-row inspector-file-row--search"
                      aria-current={selectedPath === entry.path ? "true" : undefined}
                      data-selected={selectedPath === entry.path}
                      title={entry.path}
                      onClick={() => selectFile(entry.path)}
                    >
                      <visual.Icon className="inspector-file-icon" data-tone={visual.tone} aria-hidden="true" />
                      <span className="inspector-file-search-path">
                        <HighlightedMatch text={entry.path} query={debouncedQuery} />
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {searchTruncated && !searchLoading ? (
              <p className="inspector-file-note" role="status">
                {t("匹配过多，请补充搜索内容。", "Too many matches; refine the search.")}
              </p>
            ) : null}
          </>
        ) : (
          <>
            {treeLoading && !rootTree ? (
              <p className="inspector-file-note" role="status">
                <LoaderCircle className="animate-spin" aria-hidden="true" />
                {t("正在读取项目文件…", "Reading project files…")}
              </p>
            ) : null}
            {treeError && !rootTree ? (
              <div className="inspector-file-empty inspector-file-empty--error" role="alert">
                <FileWarning aria-hidden="true" />
                <p>
                  {t("无法读取项目文件：", "Could not read project files: ")}
                  {treeError}
                </p>
                <Button size="sm" variant="outline" onClick={() => void loadTree("")}>
                  {t("重试", "Retry")}
                </Button>
              </div>
            ) : null}
            {rootTree && rootTree.entries.length === 0 ? (
              <div className="inspector-file-empty" role="status">
                <Folder aria-hidden="true" />
                <p>{t("项目根目录为空。", "The project root is empty.")}</p>
              </div>
            ) : null}
            {treeError && rootTree ? (
              <p role="alert" className="inspector-file-note inspector-file-note--error">
                {t("刷新文件列表失败：", "Failed to refresh the file list: ")}
                {treeError}
              </p>
            ) : null}
            {rootTree ? renderTree("", 0) : null}
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className="inspector-files-surface">
      {selectedPath ? (
        <>
          <div className="inspector-file-subheader">
            <nav ref={breadcrumbsRef} className="inspector-file-breadcrumbs" aria-label={t("当前文件路径", "Current file path")}>
              <button
                type="button"
                className="inspector-file-crumb"
                title={rootPath || rootName}
                onClick={() => {
                  setExplorerOpen(true);
                  setExpanded(new Set());
                }}
              >
                {rootName || "/"}
              </button>
              {breadcrumb.map((segment, index) => {
                const path = breadcrumb.slice(0, index + 1).join("/");
                const last = index === breadcrumb.length - 1;
                return (
                  <Fragment key={path}>
                    <ChevronRight className="inspector-file-crumb-separator" aria-hidden="true" />
                    {last ? (
                      <span className="inspector-file-crumb inspector-file-crumb--current" aria-current="page" title={selectedPath ?? undefined}>
                        {segment}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="inspector-file-crumb"
                        title={path}
                        onClick={() => revealDirectory(path)}
                      >
                        {segment}
                      </button>
                    )}
                  </Fragment>
                );
              })}
            </nav>
            <div className="inspector-file-actions">
              {markdown ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-pressed={renderMarkdown}
                  aria-label={renderMarkdown ? t("显示 Markdown 源码", "Show markdown source") : t("渲染 Markdown", "Render markdown")}
                  title={renderMarkdown ? t("显示 Markdown 源码", "Show markdown source") : t("渲染 Markdown", "Render markdown")}
                  onClick={() => setRenderMarkdown((current) => !current)}
                >
                  {renderMarkdown ? <Code2 aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-pressed={wrap}
                aria-label={t("切换自动换行", "Toggle word wrap")}
                title={t("切换自动换行", "Toggle word wrap")}
                onClick={() => setWrap((current) => !current)}
              >
                <WrapText aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-pressed={explorerOpen}
                aria-label={explorerOpen ? t("隐藏文件树", "Hide file explorer") : t("显示文件树", "Show file explorer")}
                title={explorerOpen ? t("隐藏文件树", "Hide file explorer") : t("显示文件树", "Show file explorer")}
                onClick={() => setExplorerOpen((current) => {
                  if (!current) revealSelected.current = true;
                  return !current;
                })}
              >
                <FolderTree aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="inspector-file-body">
            <div className="inspector-file-preview">
              {file?.truncated && !(markdown && renderMarkdown) ? (
                <p className="inspector-file-notice" role="status">
                  {t(
                    "文件较大，仅显示前 256 KB 内容。",
                    "The file is large; only the first 256 KB is shown.",
                  )}
                </p>
              ) : null}
              {fileLoading && !file ? (
                <div className="inspector-file-loading" role="status">
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                  <span>{t("正在读取文件…", "Reading file…")}</span>
                </div>
              ) : null}
              {fileError ? (
                <div className="inspector-file-failure" role="alert">
                  <FileWarning aria-hidden="true" />
                  <h3>
                    {fileError.code === "binary_file"
                      ? t("无法预览二进制文件", "This binary file cannot be previewed")
                      : fileError.code === "not_found"
                        ? t("文件不存在", "The file does not exist")
                        : fileError.code === "not_a_file"
                          ? t("该路径不是文件", "This path is not a file")
                          : t("无法读取文件", "Could not read the file")}
                  </h3>
                  <p>{fileError.message}</p>
                  <code>{selectedPath}</code>
                  <Button size="sm" variant="outline" onClick={() => selectedPath && void loadFile(selectedPath)}>
                    {t("重试", "Retry")}
                  </Button>
                </div>
              ) : null}
              {file && !fileLoading ? (
                markdown && renderMarkdown ? (
                  <div className="inspector-file-markdown">
                    <Markdown content={file.content} locale={locale === "en" ? "en" : "zh-CN"} />
                  </div>
                ) : (
                  <SourcePreview path={selectedPath ?? ""} contents={file.content} wrap={wrap} />
                )
              ) : null}
            </div>
            {explorerOpen ? treePanel : null}
          </div>

          {file ? (
            <div className="inspector-file-status" role="status">
              <span>{formatBytes(file.size)}</span>
              <span>{t(`${lines} 行`, `${lines} lines`)}</span>
              {file.truncated ? (
                <span className="inspector-file-status-warning">
                  {t("内容已截断", "Content truncated")}
                </span>
              ) : null}
              <span className="inspector-file-status-spacer" />
              <span>{t("只读", "Read-only")}</span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="inspector-file-body inspector-file-body--browse">{treePanel}</div>
      )}
    </div>
  );
}
