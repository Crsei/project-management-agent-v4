import { useMemo, useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { FileCode } from "lucide-react";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { useAgentText } from "../i18n";
import { CodeBlock, TraceRow } from "./execution-trace";
import { changedFileSummary } from "./output-presenter";
import { useChatActions } from "./chat-actions";

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

export function ChangedFilesSummary({ items }: { items: readonly NativeOutputItem[] }) {
  const t = useAgentText();
  const files = useMemo(() => changedFileSummary(items), [items]);
  if (!files.length) return null;
  return <section className="native-changed-files-summary" aria-label={t("变更文件", "Changed files")}>
    <TraceRow icon={<FileCode aria-hidden="true" />} title={t(`${files.length} 个变更文件`, `${files.length} changed files`)}>
      <p className="native-summary-note">{t("来自本次运行报告的变更；当前文件与 Git 差异可能已变化。", "Changes reported by this run; current files and Git diffs may have changed.")}</p>
      <ul className="native-changed-file-list">{files.map(file => <li key={file.path}>
        <div className="native-changed-file-heading"><strong title={file.path}>{file.path}</strong><span className="native-diff-counts" title={file.partialCounts ? t("部分变更未提供行数，显示已报告的最低数量。", "Some changes have no line counts; these are the minimum reported counts.") : undefined}>{file.additions !== undefined && <span>+{file.partialCounts ? "≥" : ""}{file.additions}</span>}{file.deletions !== undefined && <span>−{file.partialCounts ? "≥" : ""}{file.deletions}</span>}</span></div>
        <FileNavigation path={file.path} />
        <details className="native-recorded-diff"><summary>{t("运行记录差异", "Recorded diff")}</summary>
          {file.records.map(record => <div key={record.id}>
            {record.status !== "completed" && <p className={record.status === "failed" ? "native-error" : undefined} role="status">{t("原操作状态：", "Recorded operation status: ")}{record.status}</p>}
            <FileChanges item={record} onlyPath={file.path} navigation={false} />
          </div>)}
        </details>
      </li>)}</ul>
    </TraceRow>
  </section>;
}
