import { useId, useMemo } from "react";
import {
  CheckSquare,
  ChevronRight,
  ExternalLink,
  GitPullRequestArrow,
  ListTodo,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import type { PmChangeSet, PmChangeState, PmIssue } from "./pm-types";
import styles from "./pm-sidebar-context.module.css";

export type PmSidebarContextProps = {
  workspaceName?: string | null;
  projectName?: string | null;
  currentIssue: PmIssue | null;
  issues: readonly PmIssue[];
  selectedIds: ReadonlySet<string>;
  query: string;
  onQueryChange: (value: string) => void;
  onToggle: (id: string) => void;
  onOpenPicker: () => void;
  onOpenIssue?: (issue: PmIssue) => void;
  onClearSelection: () => void;
  onAddSelected?: () => void;
  changes?: readonly PmChangeSet[];
  changesLoading?: boolean;
  changesError?: string;
  loading?: boolean;
  error?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
};

const CHANGE_STATE_LABEL: Record<PmChangeState, string> = {
  proposed: "待确认",
  approved: "已批准",
  queued: "排队中",
  running: "进行中",
  applied: "已应用",
  failed: "失败",
  conflict: "冲突",
  unknown: "结果未知",
  reverted: "已撤销",
};

const CHANGE_STATE_ORDER: readonly PmChangeState[] = [
  "running",
  "queued",
  "approved",
  "proposed",
  "applied",
  "conflict",
  "failed",
  "reverted",
  "unknown",
];

const CHANGE_KIND_LABEL: Record<PmChangeSet["kind"], string> = {
  create: "新建",
  update: "更新",
  delete: "删除",
  archive: "归档",
  status: "状态变更",
  comment: "评论",
  relation: "关联",
};

const PRIORITY_LABEL: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const exact = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (exact) return exact[1];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function priorityLabel(value: string | null): string {
  if (!value) return "无优先级";
  return PRIORITY_LABEL[value.toLowerCase()] ?? value;
}

function issueStatus(issue: PmIssue): string {
  return issue.statusLabel?.trim() || issue.status;
}

function changeTimestamp(change: PmChangeSet): number {
  const stamp = Date.parse(change.updatedAt ?? change.createdAt);
  return Number.isNaN(stamp) ? 0 : stamp;
}

function changeSummary(change: PmChangeSet): string {
  const summary = change.summary.trim();
  if (summary) return summary;
  const label = CHANGE_KIND_LABEL[change.kind];
  return change.targetTitle ? `${label} ${change.targetTitle}` : label;
}

export function PmSidebarContext({
  workspaceName,
  projectName,
  currentIssue,
  issues,
  selectedIds,
  query,
  onQueryChange,
  onToggle,
  onOpenPicker,
  onOpenIssue,
  onClearSelection,
  onAddSelected,
  changes,
  changesLoading = false,
  changesError,
  loading = false,
  error = null,
  hasMore = false,
  onLoadMore,
}: PmSidebarContextProps) {
  const headingId = useId();
  const currentHeadingId = useId();
  const referenceHeadingId = useId();
  const changesHeadingId = useId();

  const scope = [workspaceName?.trim(), projectName?.trim()].filter(
    (value): value is string => !!value,
  );
  const normalizedQuery = query.trim().toLowerCase();

  const filteredIssues = useMemo(() => {
    if (!normalizedQuery) return issues;
    return issues.filter((candidate) =>
      [candidate.id, candidate.title, candidate.status, candidate.statusLabel ?? ""].some(
        (value) => value.toLowerCase().includes(normalizedQuery),
      ),
    );
  }, [issues, normalizedQuery]);

  const changeCounts = useMemo(() => {
    const counts = new Map<PmChangeState, number>();
    for (const change of changes ?? []) {
      counts.set(change.state, (counts.get(change.state) ?? 0) + 1);
    }
    return CHANGE_STATE_ORDER.flatMap((state) => {
      const count = counts.get(state);
      return count ? [{ state, count }] : [];
    });
  }, [changes]);

  const latestChanges = useMemo(
    () =>
      [...(changes ?? [])]
        .sort(
          (a, b) =>
            changeTimestamp(b) - changeTimestamp(a) || b.id.localeCompare(a.id),
        )
        .slice(0, 3),
    [changes],
  );

  const issue = currentIssue;
  const currentDue = issue ? formatDate(issue.dueDate) : null;
  const currentStatus = issue ? issueStatus(issue) : "";
  const openIssue = issue && onOpenIssue ? () => onOpenIssue(issue) : null;
  const noIssues = issues.length === 0;
  const noMatches = filteredIssues.length === 0 && !noIssues;
  const showLoading = loading && noIssues && !error;

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <header className={styles.header}>
        <h2 id={headingId} className={styles.title}>
           PM 上下文
        </h2>
        {scope.length > 0 ? (
          <p className={styles.subtitle} title={scope.join(" · ")}>
            {scope.join(" · ")}
          </p>
        ) : (
          <p className={styles.subtitle}>未关联工作区</p>
        )}
      </header>

      <div className={styles.body}>
        <section className={styles.section} aria-labelledby={currentHeadingId}>
          <h3 id={currentHeadingId} className={styles.sectionTitle}>
            当前任务
          </h3>
          {issue ? (
            <article className={styles.issueCard}>
              <p className={styles.issueTitle} title={issue.title}>
                {issue.title}
              </p>
              <p className={styles.issueMeta}>
                <code className={styles.issueId}>{issue.id}</code>
                {issue.projectName ? (
                  <span className={styles.issueProject}>{issue.projectName}</span>
                ) : null}
              </p>
              <div className={styles.chips}>
                <span className={styles.chip}>{currentStatus}</span>
                <span className={styles.chip}>{priorityLabel(issue.priority)}</span>
                {currentDue ? <span className={styles.chip}>截止 {currentDue}</span> : null}
                {issue.archived ? (
                  <span className={styles.chipWarning}>已归档</span>
                ) : null}
              </div>
              {openIssue ? (
                <div className={styles.issueActions}>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={openIssue}
                  >
                    <ExternalLink aria-hidden="true" />
                    在 PM 打开
                  </Button>
                </div>
              ) : null}
            </article>
          ) : (
            <p className={styles.empty}>没有关联的 PM 任务</p>
          )}
        </section>

        <section className={styles.section} aria-labelledby={referenceHeadingId}>
          <h3 id={referenceHeadingId} className={styles.sectionTitle}>
            任务引用
            <span className={styles.sectionCount}>{issues.length}</span>
          </h3>

          <div className={styles.search}>
            <Search className={styles.searchIcon} aria-hidden="true" />
            <Input
              type="search"
              className={styles.searchInput}
              value={query}
              placeholder="搜索任务标题或编号"
              aria-label="搜索任务"
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </div>

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}

          {loading && !error ? (
            <p className={styles.loading} aria-live="polite">
              <RefreshCw className={styles.spin} aria-hidden="true" />
              {showLoading ? "正在加载 PM 任务…" : "正在更新 PM 任务…"}
            </p>
          ) : null}

          {filteredIssues.length > 0 ? (
            <ul className={styles.list} aria-busy={loading || undefined}>
              {filteredIssues.map((row) => {
                const selected = selectedIds.has(row.id);
                const status = issueStatus(row);
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      aria-label={`选择任务 ${row.id}：${row.title}`}
                      className={styles.row}
                      onClick={() => onToggle(row.id)}
                    >
                      <span className={styles.check} aria-hidden="true">
                        {selected ? <CheckSquare /> : <Square />}
                      </span>
                      <span className={styles.rowText}>
                        <code className={styles.rowId}>{row.id}</code>
                        <span className={styles.rowTitle} title={row.title}>
                          {row.title}
                        </span>
                      </span>
                      <span className={styles.rowStatus} title={status}>
                        {status}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {!error && !showLoading && noIssues ? (
            <p className={styles.empty}>暂时没有可引用的任务</p>
          ) : null}

          {!error && !showLoading && noMatches ? (
            <p className={styles.empty}>没有匹配“{query.trim()}”的任务</p>
          ) : null}

          {hasMore && onLoadMore ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.loadMore}
              disabled={loading}
              onClick={onLoadMore}
            >
              {loading ? <RefreshCw className={styles.spin} aria-hidden="true" /> : null}
              加载更多
            </Button>
          ) : null}

          <div className={styles.selection}>
            <span className={styles.selectionCount}>已选 {selectedIds.size} 项</span>
            {onAddSelected ? (
              <Button
                type="button"
                variant="secondary"
                size="xs"
                disabled={selectedIds.size === 0}
                onClick={onAddSelected}
              >
                引用已选
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={selectedIds.size === 0}
              onClick={onClearSelection}
            >
              清除
            </Button>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className={styles.picker}
            onClick={onOpenPicker}
          >
            <ListTodo aria-hidden="true" />
            <span>选择更多任务</span>
            <ChevronRight className={styles.pickerChevron} aria-hidden="true" />
          </Button>
        </section>

        <section className={styles.section} aria-labelledby={changesHeadingId}>
          <h3 id={changesHeadingId} className={styles.sectionTitle}>
            <GitPullRequestArrow aria-hidden="true" />
            PM 变更
          </h3>
          {changesError && <p role="alert" className={styles.empty}>PM 工具记录读取失败：{changesError}</p>}
          {changeCounts.length === 0 ? (
            <p className={styles.empty}>{changesLoading ? "正在读取 PM 工具记录…" : changesError ? "无法确认当前会话的 PM 变更。" : "当前会话还没有 PM 变更"}</p>
          ) : (
            <>
              <div className={styles.chips}>
                {changeCounts.map(({ state, count }) => (
                  <span key={state} className={styles.chip} data-state={state}>
                    {CHANGE_STATE_LABEL[state]} {count}
                  </span>
                ))}
              </div>
              <ul className={styles.changeList}>
                {latestChanges.map((change) => {
                  const summary = changeSummary(change);
                  return (
                    <li key={change.id} className={styles.changeItem}>
                      <span className={styles.changeSummary} title={summary}>
                        {summary}
                      </span>
                      <span className={styles.changeMeta}>
                        {CHANGE_KIND_LABEL[change.kind]} ·{" "}
                        {CHANGE_STATE_LABEL[change.state]}
                        {change.targetTitle ? ` · ${change.targetTitle}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
