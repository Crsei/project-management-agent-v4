import { useEffect, useMemo, useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileCode, FileDiff, FolderClosed, FolderOpen } from "lucide-react";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { CodeBlock, TraceRow } from "./execution-trace";
import { changedFileSummary } from "./output-presenter";
import { useChatActions } from "./chat-actions";
import { allDirectoryNodes, buildChangedFileTree, isDirectoryOpen, readDirectoryOverrides, writeDirectoryOverrides, type ChangedFileTreeNode, type ChangedFileTreeDir, type KeyValueStorage } from "./output-detail-model";

export function NativeDiff({ text }: { text: string }) {
  const rows = text.split("\n")
    .filter(line => !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map(line => ({ text: line, kind: line.startsWith("+") ? "added" as const : line.startsWith("-") ? "removed" as const : "context" as const }));
  return <CodeBlock rows={rows} lineNumbers />;
}

function FileNavigation({ path }: { path: string }) {
  const t = useAgentText();
  const actions = useChatActions();
  const [error, setError] = useState<string>();
  const open = (kind: "file" | "diff") => {
    try {
      if (!actions?.canOpenFiles) throw new Error(t("当前会话的文件区域不可用。", "Files are not available for this session."));
      if (kind === "file") actions.openFile(path); else actions.openDiff(path);
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <>
    <span className="native-file-actions">
      <button type="button" disabled={!actions?.canOpenFiles} onClick={() => open("file")}>{t("打开文件", "Open file")}</button>
      <button type="button" disabled={!actions?.canOpenFiles} onClick={() => open("diff")}>{t("当前差异", "Current diff")}</button>
    </span>
    {error && <p role="alert" className="native-error">{error}</p>}
  </>;
}

export function FileChanges({ item, onlyPath, navigation = true }: { item: NativeOutputItem; onlyPath?: string; navigation?: boolean }) {
  const t = useAgentText();
  const changes: NonNullable<NativeOutputItem["changes"]> = item.changes?.length ? item.changes : [{ path: item.fileName || item.title || t("文件", "File"), operation: "", diff: item.diff }];
  return <div data-native-context-menu className="native-changes">
    {changes.map((change, index) => (!onlyPath || change.path === onlyPath) && <div key={`${change.path}:${index}`} className="native-change">
      <div className="native-change-path"><strong title={change.path}>{change.oldPath ? `${change.oldPath} → ` : ""}{change.path}</strong>{change.operation && <span>{change.operation}</span>}</div>
      {navigation && !!(item.fileName || item.changes?.length) && <FileNavigation path={change.path} />}
      {change.diff ? <NativeDiff text={change.diff} /> : index === 0 && item.oldText !== undefined && item.newText !== undefined ? <MultiFileDiff oldFile={{ name: change.oldPath || change.path, contents: item.oldText }} newFile={{ name: change.path, contents: item.newText }} disableWorkerPool options={{ themeType: "system", diffStyle: "unified", overflow: "scroll" }} /> : index === 0 && (item.oldText !== undefined || item.newText !== undefined) ? <div className="native-before-after">{item.oldText !== undefined && <div><b>{t("原内容", "Original")}</b><CodeBlock code={item.oldText} lineNumbers /></div>}{item.newText !== undefined && <div><b>{t("新内容", "New")}</b><CodeBlock code={item.newText} lineNumbers /></div>}</div> : <p>{t("未提供差异内容。", "No diff content provided.")}</p>}
    </div>)}
  </div>;
}


const TREE_STORAGE_PREFIX = "pm-v4:changed-files:";

function sessionTreeStorage(): KeyValueStorage | undefined {
  try { return sessionStorage; } catch { return undefined; }
}

type FlatTreeNode = ChangedFileTreeNode & { open?: boolean };

function flattenTree(nodes: readonly ChangedFileTreeNode[], overrides: Readonly<Record<string, boolean>>, output: FlatTreeNode[] = []): FlatTreeNode[] {
  for (const node of nodes) {
    if (node.kind === "dir") {
      const open = isDirectoryOpen(node, overrides);
      output.push({ ...node, open });
      if (open) flattenTree(node.children, overrides, output);
    } else {
      output.push(node);
    }
  }
  return output;
}

function DiffCounts({ additions, deletions, partial }: { additions?: number; deletions?: number; partial: boolean }) {
  if (additions === undefined && deletions === undefined) return null;
  return <span className="native-diff-counts">{additions !== undefined && <span>+{partial ? "≥" : ""}{additions}</span>}{deletions !== undefined && <span>−{partial ? "≥" : ""}{deletions}</span>}</span>;
}

/** A generation's changed files as a directory tree. Fold state is per session/generation
 * in sessionStorage; every file keeps its reported counts and file/diff actions. */
export function ChangedFilesSummary({ items, storageKey }: { items: readonly NativeOutputItem[]; storageKey?: string }) {
  const t = useAgentText();
  const actions = useChatActions();
  const files = useMemo(() => changedFileSummary(items), [items]);
  const tree = useMemo(() => buildChangedFileTree(files), [files]);
  const directories = useMemo(() => allDirectoryNodes(tree), [tree]);
  const storageKeyValue = storageKey ? `${TREE_STORAGE_PREFIX}${storageKey}` : undefined;
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => readDirectoryOverrides(sessionTreeStorage(), storageKeyValue ?? ""));
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set<string>());
  useEffect(() => {
    setOverrides(readDirectoryOverrides(sessionTreeStorage(), storageKeyValue ?? ""));
    setExpandedFiles(new Set<string>());
  }, [storageKeyValue]);
  if (!files.length) return null;
  const additions = files.reduce<number | undefined>((total, file) => file.additions === undefined ? total : (total ?? 0) + file.additions, undefined);
  const deletions = files.reduce<number | undefined>((total, file) => file.deletions === undefined ? total : (total ?? 0) + file.deletions, undefined);
  const partial = files.some(file => file.partialCounts || file.additions === undefined || file.deletions === undefined);
  const everyOpen = directories.every(node => isDirectoryOpen(node, overrides));
  const updateOverrides = (next: Record<string, boolean>) => {
    setOverrides(next);
    writeDirectoryOverrides(sessionTreeStorage(), storageKeyValue ?? "", next);
  };
  const toggleDirectory = (node: ChangedFileTreeDir) => {
    const open = isDirectoryOpen(node, overrides);
    updateOverrides({ ...overrides, [node.path]: !open });
  };
  const toggleAll = () => {
    if (everyOpen) updateOverrides(Object.fromEntries(directories.map(node => [node.path, false])));
    else updateOverrides(Object.fromEntries(directories.map(node => [node.path, true])));
  };
  const toggleFile = (path: string) => {
    setExpandedFiles(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  const openAllChanges = () => {
    if (!actions || !actions.canOpenFiles) return;
    actions.openDiff();
  };
  const rows = flattenTree(tree, overrides);
  return <section className="native-changed-files-summary" aria-label={t("变更文件", "Changed files")}>
    <TraceRow
      icon={<FileCode aria-hidden="true" />}
      defaultOpen
      title={<span className="native-changed-files-title">{t(`${files.length} 个变更文件`, `${files.length} changed files`)}<span className="native-diff-counts" title={partial ? t("部分变更未提供行数，显示已报告的最低数量。", "Some changes have no line counts; these are the minimum reported counts.") : undefined}>{additions !== undefined && <span>+{partial ? "≥" : ""}{additions}</span>}{deletions !== undefined && <span>−{partial ? "≥" : ""}{deletions}</span>}</span></span>}
      actions={directories.length > 0 ? <Button type="button" size="icon-xs" variant="ghost" aria-label={everyOpen ? t("折叠全部目录", "Collapse all folders") : t("展开全部目录", "Expand all folders")} title={everyOpen ? t("折叠全部目录", "Collapse all folders") : t("展开全部目录", "Expand all folders")} onClick={toggleAll}>
        {everyOpen ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
      </Button> : undefined}
    >
      <div className="native-changed-files-toolbar">
        <p className="native-summary-note">{t("来自本次运行报告的变更；当前文件与 Git 差异可能已变化。", "Changes reported by this run; current files and Git diffs may have changed.")}</p>
        <Button type="button" size="xs" variant="outline" disabled={!actions?.canOpenFiles} title={t("在检查器中查看全部改动", "Open all changes in the inspector")} onClick={openAllChanges}><FileDiff aria-hidden="true" />{t("全部改动", "All changes")}</Button>
      </div>
      <ul className="native-changed-file-tree">
        {rows.map(node => node.kind === "dir"
          ? <li key={`dir:${node.path}`} className="native-tree-directory" data-depth={node.depth}>
            <button type="button" className="native-tree-row native-tree-directory-row" style={{ paddingInlineStart: `${(node.depth - 1) * 12}px` }} aria-expanded={node.open} onClick={() => toggleDirectory(node)}>
              <ChevronRight aria-hidden="true" className="native-tree-chevron" data-open={node.open || undefined} />
              {node.open ? <FolderOpen aria-hidden="true" /> : <FolderClosed aria-hidden="true" />}
              <span className="native-tree-name" title={node.path}>{node.name}</span>
              <span className="native-tree-file-count">{t(`${node.files} 个文件`, `${node.files} files`)}</span>
              <DiffCounts additions={node.additions} deletions={node.deletions} partial={node.partialCounts} />
            </button>
          </li>
          : <li key={`file:${node.path}`} className="native-tree-file" data-depth={node.depth}>
            <div className="native-tree-row" style={{ paddingInlineStart: `${(node.depth - 1) * 12}px` }}>
              <button type="button" className="native-tree-file-name" aria-expanded={expandedFiles.has(node.path)} title={node.path} onClick={() => toggleFile(node.path)}>
                <ChevronRight aria-hidden="true" className="native-tree-chevron" data-open={expandedFiles.has(node.path) || undefined} />
                <FileCode aria-hidden="true" />
                <span>{node.name}</span>
              </button>
              <DiffCounts additions={node.summary.additions} deletions={node.summary.deletions} partial={node.summary.partialCounts === true} />
              <FileNavigation path={node.path} />
            </div>
            {expandedFiles.has(node.path) && <div className="native-tree-file-diff">
              {node.summary.records.map(record => <div key={record.id}>
                {record.status !== "completed" && <p className={record.status === "failed" ? "native-error" : undefined} role="status">{t("原操作状态：", "Recorded operation status: ")}{record.status}</p>}
                <FileChanges item={record} onlyPath={node.path} navigation={false} />
              </div>)}
            </div>}
          </li>)}
      </ul>
    </TraceRow>
  </section>;
}
