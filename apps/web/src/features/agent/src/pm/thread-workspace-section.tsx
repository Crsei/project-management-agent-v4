import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CopyIcon,
  FolderOpenIcon,
  GitBranchIcon,
  RefreshCwIcon,
  TerminalSquareIcon,
} from "lucide-react";
import styles from "./thread-details-sections.module.css";
import { useAgentText, type AgentText } from "../i18n";
import { errorMessage } from "../workspace/inspector/api";
import { workspaceClient } from "../network";
import {
  shortCommit,
  worktreeCreateBlockers,
  worktreeEndBlockers,
  worktreeEndStateSchema,
  worktreeHealth,
  worktreeMutationRevisions,
  worktreeStateSchema,
  type WorktreeBlocker,
  type WorktreeState,
} from "./thread-worktree-model";

type Failure = { message: string; code?: string };

function failureOf(error: unknown): Failure {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  return { message: errorMessage(error), ...(code ? { code } : {}) };
}

function blockerText(blocker: WorktreeBlocker, action: "create" | "end", t: AgentText): string {
  switch (blocker) {
    case "exists":
      return t("此会话已有工作树，不会重新创建。", "This Session already has a worktree; it is never recreated.");
    case "busy":
      return t("上一个工作树请求尚未结束。", "The previous worktree request has not finished.");
    case "transitioning":
      return t("服务端仍在完成上一次工作树切换；请稍后重新核对。", "The server is still completing the previous worktree transition; recheck shortly.");
    case "terminals":
      return action === "create"
        ? t("会话或工作树内仍有终端；先显式关闭终端再创建。", "A Session or worktree terminal is still open; close it explicitly before creating.")
        : t("会话或工作树内仍有终端；先显式关闭终端，服务端不会自动终止。", "A Session or worktree terminal is still open; close it explicitly. The server never terminates it for you.");
    case "dirty":
      return t("工作树有未提交、未跟踪或忽略文件；服务端会拒绝结束，不会强制删除。", "The worktree has uncommitted, untracked or ignored files; the server refuses to end it and never force-deletes.");
  }
}

export function ThreadWorkspaceSection({
  threadId,
  environmentPath,
  activeTerminals,
  terminalAvailable,
  onOpenFiles,
  onOpenTerminal,
  onChanged,
}: {
  threadId: string;
  environmentPath?: string;
  activeTerminals: number;
  terminalAvailable: boolean;
  onOpenFiles?: () => void;
  onOpenTerminal?: () => void;
  onChanged?: (notice?: string) => void;
}) {
  const t = useAgentText();
  const headingId = useId();
  const [load, setLoad] = useState<{ loading: boolean; data?: WorktreeState; error?: Failure }>({ loading: true });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"create" | "end" | null>(null);
  const [mutationError, setMutationError] = useState<Failure>();
  const [stalePath, setStalePath] = useState<string>();
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<string>();
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const id = ++sequence.current;
    const controller = new AbortController();
    setLoad(current => ({ loading: true, data: current.data }));
    void workspaceClient.json<unknown>(`/api/chat/threads/${encodeURIComponent(threadId)}/worktree`, { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted || sequence.current !== id) return;
        const parsed = worktreeStateSchema.safeParse(value);
        if (!parsed.success) setLoad({ loading: false, error: { message: t("服务端返回的工作树状态无法识别。", "The server returned a worktree state this view cannot read.") } });
        else setLoad({ loading: false, data: parsed.data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sequence.current !== id) return;
        setLoad({ loading: false, error: failureOf(error) });
      });
    return () => controller.abort();
  }, [threadId, reload, t]);

  useEffect(() => {
    if (copiedAt === null) return;
    const timer = window.setTimeout(() => setCopiedAt(null), 2500);
    return () => window.clearTimeout(timer);
  }, [copiedAt]);

  useEffect(() => {
    // A mutation changes the Session folder; Files/Terminal stay unavailable until
    // the server-resolved environment matches the new state.
    if (stalePath !== undefined && environmentPath !== stalePath) setStalePath(undefined);
  }, [environmentPath, stalePath]);

  const worktree = load.data?.worktree ?? null;
  const environmentPathCurrent = environmentPath !== undefined && environmentPath !== stalePath ? environmentPath : undefined;
  const activePath = worktree?.directory ?? environmentPathCurrent;
  const pathSynced = !!environmentPathCurrent && activePath === environmentPathCurrent;
  const health = worktree ? worktreeHealth(worktree) : undefined;
  const createBlockers = worktreeCreateBlockers({ worktree, busy, activeTerminals });
  const endBlockers = worktreeEndBlockers({ worktree, busy, activeTerminals });

  const mutate = async (action: "create" | "end") => {
    if (!load.data || busy) return;
    setBusy(true);
    setMutationError(undefined);
    try {
      const revisions = worktreeMutationRevisions(load.data);
      const response = action === "create"
        ? await workspaceClient.json<unknown>(`/api/chat/threads/${encodeURIComponent(threadId)}/worktree`, {
            method: "POST",
            body: JSON.stringify(revisions),
          })
        : await workspaceClient.json<unknown>(`/api/chat/threads/${encodeURIComponent(threadId)}/worktree`, {
            method: "DELETE",
            body: JSON.stringify({ confirm: true, ...revisions }),
          });
      if (!mounted.current) return;
      let notice: string | undefined;
      if (action === "end") {
        const ended = worktreeEndStateSchema.safeParse(response);
        if (ended.success) {
          const { worktree: next, revision, lifecycleRevision, retainedBranch } = ended.data;
          setLoad({ loading: false, data: { worktree: next, revision, lifecycleRevision } });
          notice = t(`Chat 工作树已结束；分支已保留：${retainedBranch}。执行目录回到原仓库，服务端不会删除或自动合并该分支。`, `Chat worktree ended; branch retained: ${retainedBranch}. The execution folder returns to the original repository; the server never deletes or auto-merges the branch.`);
        } else setReload(value => value + 1);
      } else {
        const created = worktreeStateSchema.safeParse(response);
        if (created.success) {
          setLoad({ loading: false, data: created.data });
          notice = t("Chat 工作树已创建；会话执行目录已切换到私有目录。", "Chat worktree created; the Session execution folder moved to the private directory.");
        } else setReload(value => value + 1);
      }
      setConfirming(null);
      setStalePath(environmentPath);
      // The server mutation already happened even if the receipt shape was
      // unreadable; refresh the Session rather than leaving the view stale.
      onChanged?.(notice);
    } catch (error) {
      if (!mounted.current) return;
      setMutationError(failureOf(error));
      // Re-read authoritative revisions so the next attempt is not stuck on a stale value.
      setReload(value => value + 1);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const copyPath = async () => {
    if (!activePath) return;
    setCopyError(undefined);
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("浏览器未提供剪贴板。", "The browser does not expose the clipboard."));
      await navigator.clipboard.writeText(activePath);
      setCopiedAt(Date.now());
    } catch (error) {
      setCopyError(errorMessage(error));
    }
  };

  const renderFailure = (failure: Failure) => (
    <p role="alert" className={styles.error}>
      {failure.message}
      {failure.code && <> <code className={styles.code}>{failure.code}</code></>}
    </p>
  );

  return <>
    <section className={styles.section} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>{t("工作树", "Worktree")}</h3>
      {load.loading && <p role="status" className={styles.note}>{t("正在核对 Chat 工作树…", "Checking the Chat worktree…")}</p>}
      {load.error && renderFailure(load.error)}
      {load.error && <div className={styles.row}><button type="button" className={styles.button} onClick={() => setReload(value => value + 1)}><RefreshCwIcon aria-hidden="true" />{t("重新核对", "Recheck")}</button></div>}
      {!load.loading && !load.error && load.data && !worktree && <>
        <p className={styles.note}>{t("此会话没有工作树。创建后执行目录会切到私有目录。", "This Session has no worktree. Creating one moves its execution folder to a private directory.")}</p>
        <div className={styles.row}>
          <button type="button" className={`${styles.button} ${styles.primary}`} disabled={createBlockers.length > 0} onClick={() => setConfirming("create")}>
            <GitBranchIcon aria-hidden="true" />{t("创建 Chat worktree", "Create Chat worktree")}
          </button>
          <button type="button" className={styles.button} onClick={() => setReload(value => value + 1)}><RefreshCwIcon aria-hidden="true" />{t("重新核对", "Recheck")}</button>
        </div>
        {createBlockers.map(blocker => <p key={blocker} className={styles.note}>{blockerText(blocker, "create", t)}</p>)}
        {confirming === "create" && <div className={styles.confirm}>
          <p className={styles.subtitle}>{t("创建前请确认这些不可撤销的效果：", "Confirm these effects before creating:")}</p>
          <ul className={styles.confirmList}>
            <li>{t("会从当前 HEAD 复制到私有 Git 工作树，并把会话执行目录切到该目录。", "It copies the current HEAD into a private Git worktree and moves the Session execution folder there.")}</li>
            <li>{t("会清空原生 Provider 会话；下一次发送会在新目录建立新会话。", "It clears the native Provider session; the next send establishes a new session in the new folder.")}</li>
            <li>{t("服务端不提供自动回退；结束工作树只移除目录，分支会保留。", "The server offers no automatic rollback; ending the worktree removes the directory but keeps the branch.")}</li>
          </ul>
          {mutationError && renderFailure(mutationError)}
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => setConfirming(null)}>{t("取消", "Cancel")}</button>
            <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy || createBlockers.length > 0} onClick={() => void mutate("create")}>{busy ? t("正在创建…", "Creating…") : t("确认创建", "Create")}</button>
          </div>
        </div>}
      </>}
      {!load.loading && !load.error && load.data && worktree && <>
        <span className={styles.status} data-health={health}>
          {health === "clean" ? t("工作树干净", "Worktree clean") : health === "dirty" ? t("工作树有改动", "Worktree has changes") : t("工作树操作进行中", "Worktree transition in progress")}
        </span>
        <dl className={styles.meta}>
          <div><dt>{t("分支", "Branch")}</dt><dd><code className={styles.code}>{worktree.branch}</code></dd></div>
          <div><dt>{t("HEAD", "HEAD")}</dt><dd title={worktree.headSha}><code className={styles.code}>{shortCommit(worktree.headSha)}</code></dd></div>
          <div><dt>{t("目录", "Folder")}</dt><dd><code className={styles.code}>{worktree.directory}</code></dd></div>
        </dl>
        <div className={styles.row}>
          <button type="button" className={`${styles.button} ${styles.danger}`} disabled={endBlockers.length > 0} onClick={() => setConfirming("end")}>
            <AlertTriangleIcon aria-hidden="true" />{t("结束工作树", "End worktree")}
          </button>
          <button type="button" className={styles.button} disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCwIcon aria-hidden="true" />{t("只读核对", "Recheck read-only")}</button>
        </div>
        {endBlockers.map(blocker => <p key={blocker} className={styles.note}>{blockerText(blocker, "end", t)}</p>)}
        {confirming === "end" && <div className={styles.confirm}>
          <p className={styles.subtitle}>{t("结束前请确认：", "Confirm before ending:")}</p>
          <ul className={styles.confirmList}>
            <li>{t("只移除工作树目录，不删除分支，也不会自动合并提交。", "Only the worktree directory is removed; the branch and its commits are kept, never merged automatically.")}</li>
            <li>{t("会清空原生 Provider 会话，执行目录回到原仓库。", "The native Provider session is cleared and the execution folder returns to the original repository.")}</li>
            <li>{t("有未提交、未跟踪或忽略文件时服务端会拒绝结束；不会强制删除。", "The server refuses to end a worktree with uncommitted, untracked or ignored files; nothing is force-deleted.")}</li>
          </ul>
          {mutationError && renderFailure(mutationError)}
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => setConfirming(null)}>{t("取消", "Cancel")}</button>
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy || endBlockers.length > 0} onClick={() => void mutate("end")}>{busy ? t("正在结束…", "Ending…") : t("确认结束", "End worktree")}</button>
          </div>
        </div>}
      </>}
      {mutationError && !confirming && renderFailure(mutationError)}
    </section>
    <section className={styles.section} aria-labelledby={`${headingId}-open`}>
      <h3 id={`${headingId}-open`} className={styles.title}>{t("打开方式", "Open in")}</h3>
      <div className={styles.row}>
        <button type="button" className={styles.button} disabled={busy || !pathSynced || !onOpenFiles} title={!pathSynced ? t("执行目录正在更新，稍后再试。", "The execution folder is updating; retry shortly.") : undefined} onClick={onOpenFiles}>
          <FolderOpenIcon aria-hidden="true" />{t("文件区域", "Files area")}
        </button>
        <button type="button" className={styles.button} disabled={busy || !pathSynced || !onOpenTerminal || !terminalAvailable} title={!terminalAvailable ? t("当前视图未启用终端。", "Terminals are not enabled in this view.") : undefined} onClick={onOpenTerminal}>
          <TerminalSquareIcon aria-hidden="true" />{t("终端", "Terminal")}
        </button>
        <button type="button" className={styles.button} disabled={!activePath} onClick={() => void copyPath()}>
          <CopyIcon aria-hidden="true" />{copiedAt !== null ? t("已复制", "Copied") : t("复制路径", "Copy path")}
        </button>
      </div>
      {activePath && <code className={styles.code} title={activePath}>{activePath}</code>}
      {!pathSynced && <p role="status" className={styles.note}>
        {environmentPathCurrent
          ? t("执行目录仍在更新为工作树切换后的位置；文件与终端入口暂不可用。", "The execution folder is still settling to the post-worktree location; Files and Terminal stay unavailable.")
          : t("正在重新核对工作树切换后的执行目录；文件与终端入口暂不可用。", "Rechecking the execution folder after the worktree switch; Files and Terminal stay unavailable.")}
      </p>}
      {!terminalAvailable && <p className={styles.note}>{t("当前视图未启用终端；不会在这里创建 PTY。", "Terminals are not enabled in this view; no PTY is created here.")}</p>}
      {copyError && <p role="alert" className={styles.error}>{copyError}</p>}
      <p className={styles.note}>{t("仅使用本应用的文件夹、终端与剪贴板；没有桌面编辑器集成，不会声称已在编辑器中打开。", "Only this app's folder, terminal and clipboard are used. There is no desktop-editor integration, so no editor is claimed to open.")}</p>
    </section>
  </>;
}
