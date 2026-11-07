import { useMemo, type ReactNode } from "react";
import { Check, ChevronDown, ListFilter, Search, X } from "lucide-react";

import { Button } from "@agent/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@agent/components/ui/dialog";
import { Input } from "@agent/components/ui/input";

import type { PmIssue } from "./pm-types";
import { useAgentText } from "../i18n";
import styles from "./pm-issue-picker.module.css";

export type PmIssuePickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issues: readonly PmIssue[];
  selectedIds: ReadonlySet<string>;
  query: string;
  onQueryChange: (value: string) => void;
  onToggle: (id: string) => void;
  onSelectVisible: () => void;
  onClear: () => void;
  projectName?: string | null;
  targetControls?: ReactNode;
  loading?: boolean;
  error?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
};

function matchesQuery(issue: PmIssue, query: string) {
  return [
    issue.id,
    issue.title,
    issue.status,
    issue.statusLabel,
    issue.priority,
    issue.projectName,
    issue.assigneeName,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(query));
}

function formatDueDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

export function PmIssuePicker({
  open,
  onOpenChange,
  issues,
  selectedIds,
  query,
  onQueryChange,
  onToggle,
  onSelectVisible,
  onClear,
  projectName,
  targetControls,
  loading = false,
  error = null,
  hasMore = false,
  onLoadMore,
}: PmIssuePickerProps) {
  const t = useAgentText();
  const normalizedQuery = query.trim().toLowerCase();
  const visibleIssues = useMemo(
    () => (normalizedQuery ? issues.filter((issue) => matchesQuery(issue, normalizedQuery)) : issues),
    [issues, normalizedQuery],
  );

  const selectedCount = selectedIds.size;
  const visibleCount = visibleIssues.length;
  const showLoadingState = loading && visibleCount === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>{t("引用 PM 任务", "Reference PM tasks")}</DialogTitle>
        </DialogHeader>
        {targetControls}

        <div className={styles.search}>
          <Search className={styles.searchIcon} aria-hidden="true" />
          <Input
            className={styles.searchInput}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("按标题、编号、状态或优先级搜索", "Search by title, ID, status or priority")}
            aria-label={t("搜索 PM 任务", "Search PM tasks")}
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => onQueryChange("")}
              aria-label={t("清除搜索", "Clear search")}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className={styles.toolbar}>
          <p className={styles.counts} aria-live="polite">
            {t("已选", "Selected")} <strong>{selectedCount}</strong> {t("项", "items")} · {t("当前显示", "Showing")} <strong>{visibleCount}</strong> {t("项", "items")}
          </p>
          <div className={styles.toolbarActions}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onSelectVisible}
              disabled={visibleCount === 0}
            >
              <ListFilter aria-hidden="true" />
              {t("全选当前结果", "Select all results")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onClear}
              disabled={selectedCount === 0}
            >
              {t("清除", "Clear")}
            </Button>
          </div>
        </div>

        {projectName ? <p className={styles.project}>{t("项目：", "Project: ")}{projectName}</p> : null}

        {error ? (
          <p className={styles.error} role="alert">
            <X aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}

        <div className={styles.list} role="group" aria-label={t("PM 任务列表", "PM task list")}>
          {showLoadingState ? (
            <p className={styles.state} role="status">
              {t("正在读取任务…", "Loading tasks…")}
            </p>
          ) : visibleCount === 0 ? (
            error ? null : <p className={styles.state}>{t("没有匹配的任务", "No matching tasks")}</p>
          ) : (
            <>
              <ul className={styles.rows}>
                {visibleIssues.map((issue) => {
                  const selected = selectedIds.has(issue.id);
                  return (
                    <li key={issue.id} className={styles.rowItem}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        className={styles.row}
                        onClick={() => onToggle(issue.id)}
                      >
                        <span className={styles.checkbox} aria-hidden="true">
                          {selected ? <Check /> : null}
                        </span>
                        <span className={styles.rowBody}>
                          <span className={styles.rowTitle}>{issue.title}</span>
                          <span className={styles.rowMeta}>
                            <span className={styles.rowId}>{issue.id}</span>
                            <span>{issue.statusLabel ?? issue.status}</span>
                            {issue.priority ? (
                              <span className={styles.priority}>{issue.priority}</span>
                            ) : null}
                            {issue.dueDate ? (
                              <span title={issue.dueDate}>
                                {t("截止", "Due")} {formatDueDate(issue.dueDate)}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {loading ? (
                <p className={styles.state} role="status">
                  {t("正在读取任务…", "Loading tasks…")}
                </p>
              ) : null}

              {hasMore ? (
                <div className={styles.more}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onLoadMore?.()}
                    disabled={loading || !onLoadMore}
                  >
                    <ChevronDown aria-hidden="true" />
                    {loading ? t("正在加载…", "Loading…") : t("加载更多", "Load more")}
                  </Button>
                  <p className={styles.moreHint}>{t("仅显示已读取的任务，还有更多结果未加载。", "Only loaded tasks are shown; more results are not loaded yet.")}</p>
                </div>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {t("完成", "Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
