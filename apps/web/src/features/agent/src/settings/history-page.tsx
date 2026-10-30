import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestoreIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { useI18n } from "@/lib/i18n-provider";
import { useAgentText, type AgentText } from "../i18n";
import { workspaceClient } from "../network";
import { ensureChatMigration } from "../chat/migration";
import { refreshThreadList } from "../chat/remote-adapter";
import { acceptRemoteThread, acceptRemoteThreads, forgetRemoteThread, refreshCatalog, sameScope, scopeContext, usePmChatState } from "../pm/state";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";
import "./file-areas-history.css";

function updatedLabel(t: AgentText, locale: string, value?: string) {
  if (!value) return t("时间未提供", "Time not provided");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("时间不可用", "Time unavailable") : date.toLocaleString(locale);
}

export default function HistoryPage() {
  const t = useAgentText();
  const { locale } = useI18n();
  const pmState = usePmChatState();
  const [threads, setThreads] = useState<RemoteThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [deleting, setDeleting] = useState<RemoteThread>();
  const pending = useRef(false);
  const { setGuard } = useSettingsGuard();
  useEffect(() => { setGuard(busyId ? "busy" : "clean"); }, [busyId, setGuard]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    await Promise.all([
      refreshCatalog().catch(() => {}),
      ensureChatMigration().then(() => workspaceClient.json<{ threads: RemoteThread[] }>("/api/chat/threads")).then((response) => {
        setThreads(response.threads);
        acceptRemoteThreads(response.threads);
      }).catch((cause: unknown) => { setLoadError(cause instanceof Error ? cause.message : String(cause)); }),
    ]);
    setLoading(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = async (listed: RemoteThread, kind: "restore" | "delete") => {
    if (pending.current) return;
    pending.current = true;
    setBusyId(listed.remoteId);
    setGuard("busy");
    setActionError(undefined);
    setNotice(undefined);
    let committed = false;
    try {
      const catalog = await refreshCatalog();
      const { thread } = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(listed.remoteId)}`);
      if (!thread.scope || !sameScope(thread.scope, listed.scope) || !scopeContext(catalog, thread.scope)) throw new Error(t("原始工作区或项目当前不可访问，不能恢复或删除，也不会改绑到其他分组。", "The original workspace or project is currently inaccessible; this session cannot be restored or deleted, and it will not be rebound to another group."));
      if (thread.status !== "archived") throw new Error(t("此会话已不在归档中，请刷新列表后核对；没有执行本次操作。", "This session is no longer archived; refresh the list and check. No action was taken."));
      if (kind === "restore") {
        const saved = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, {
          method: "PUT", body: JSON.stringify({ status: "regular" }),
        });
        acceptRemoteThread(saved.thread);
        setThreads((current) => current.map((item) => item.remoteId === saved.thread.remoteId ? saved.thread : item));
        setNotice(t("会话已恢复到原工作区／项目分组；原始历史和会话设置保持不变。返回聊天后可在原分组打开。", "Session restored to its original workspace/project group; its saved history and session settings are unchanged. Open it in that group after returning to chat."));
      } else {
        await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, { method: "DELETE" });
        forgetRemoteThread(thread.remoteId);
        setThreads((current) => current.filter((item) => item.remoteId !== thread.remoteId));
        setDeleting(undefined);
        setNotice(t("会话已永久删除。此操作不会删除文件区域或撤销已经发生的文件修改。", "Session permanently deleted. This does not delete file areas or undo file changes that already happened."));
      }
      committed = true;
      await refreshThreadList();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setActionError(committed
        ? t(`操作已保存，但聊天列表刷新失败：${message}。请手动刷新，勿重复提交。`, `Operation saved, but refreshing the chat list failed: ${message}. Refresh manually and do not resubmit.`)
        : t(`操作未确认：${message}。未自动重试；如响应丢失，请先刷新核对真实状态。`, `Operation not confirmed: ${message}. No automatic retry; if the response was lost, refresh to verify the real state first.`));
    } finally {
      pending.current = false;
      setBusyId(undefined);
      setGuard("clean");
    }
  };

  const archived = threads.filter((thread) => thread.status === "archived");
  const query = search.trim().toLocaleLowerCase("zh-CN");
  const visible = archived.filter((thread) => {
    const context = scopeContext(pmState.catalog, thread.scope);
    return !query || [thread.title, thread.remoteId, thread.scope?.workspaceId, thread.scope?.projectId, context?.workspace.name, context?.project?.name].some((value) => value?.toLocaleLowerCase("zh-CN").includes(query));
  });
  const permissionsReady = !pmState.loading && !pmState.error && !!pmState.catalog;
  const deletingContext = scopeContext(pmState.catalog, deleting?.scope);

  return <div className="agent-history-settings">
    <SettingsSection title={t("已归档会话", "Archived sessions")} scope="session">
      <div className="agent-settings-page-toolbar"><p>{loading ? t("正在读取真实归档列表…", "Loading archived sessions…") : t(`共 ${archived.length} 个已归档会话`, `${archived.length} archived session(s)`)}</p><Button type="button" variant="outline" size="sm" disabled={loading || !!busyId} onClick={() => void refresh()}><RefreshCwIcon aria-hidden="true" className={loading ? "animate-spin" : undefined} />{t("刷新列表与访问范围", "Refresh list & access")}</Button></div>
      <label className="agent-history-search"><SearchIcon aria-hidden="true" /><Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索会话、工作区或项目…", "Search sessions, workspaces, or projects…")} aria-label={t("搜索归档会话", "Search archived sessions")} /></label>
      {loading && <SettingsNotice kind="loading">{t("正在读取 Agent 持久化会话与当前 PM 授权目录册…", "Loading persisted Agent sessions and the current PM authorization catalog…")}</SettingsNotice>}
      {loadError && <SettingsNotice kind="error" onRetry={() => void refresh()}>{t(`归档列表读取失败：${loadError}。旧列表可能过期，操作已禁用。`, `Failed to load archived sessions: ${loadError}. The old list may be stale and actions are disabled.`)}</SettingsNotice>}
      {pmState.error && <SettingsNotice kind="error" onRetry={() => void refresh()}>{t(`无法核验当前 PM 访问范围：${pmState.error}。所有恢复与删除操作已禁用，不使用旧授权绕过检查。`, `Cannot verify the current PM access scope: ${pmState.error}. All restore and delete actions are disabled; stale authorization is never used to bypass checks.`)}</SettingsNotice>}
      {notice && <SettingsNotice kind="success">{notice}</SettingsNotice>}
      {actionError && <SettingsNotice kind="error" onRetry={() => void refresh()}>{actionError}</SettingsNotice>}
      {!loading && !loadError && archived.length === 0 && <p className="agent-settings-empty">{t("暂无已归档会话。聊天侧栏中的“归档会话”会将会话移到这里。", "No archived sessions. “Archive session” in the chat sidebar moves sessions here.")}</p>}
      {!loading && archived.length > 0 && visible.length === 0 && <p className="agent-settings-empty">{t("没有匹配的归档会话，请修改搜索条件。", "No archived sessions match; adjust your search.")}</p>}
      <ul className="agent-history-list" aria-label={t("已归档会话列表", "Archived session list")}>{visible.map((thread) => {
        const context = scopeContext(pmState.catalog, thread.scope);
        const accessible = !!thread.scope && !!context && permissionsReady;
        const blocked = !thread.scope ? t("旧历史未绑定作用域，仅供保留；不能恢复、删除或重新归属。", "Legacy history is not bound to a scope and is kept as-is; it cannot be restored, deleted, or reassigned.")
          : !permissionsReady ? t("当前访问范围尚未核验，操作不可用。", "The current access scope is not verified yet; actions are unavailable.")
          : !context ? t("原始工作区或项目当前不可访问；不会改绑到其他分组。", "The original workspace or project is currently inaccessible; it will not be rebound to another group.") : undefined;
        return <li className="agent-history-row" key={thread.remoteId}>
          <div className="agent-history-content"><h3>{thread.title || t("未命名会话", "Untitled session")}</h3><p className="agent-history-scope">{context ? `${context.workspace.name} / ${context.project?.name ?? t("工作区会话", "Workspace session")}` : thread.scope ? t("原作用域当前不可访问", "Original scope currently inaccessible") : t("无作用域的历史会话", "History session without scope")}</p>
            <dl><div><dt>{t("会话 ID", "Session ID")}</dt><dd><code>{thread.remoteId}</code></dd></div><div><dt>{t("原始作用域", "Original scope")}</dt><dd><code>{thread.scope ? `${thread.scope.workspaceId} / ${thread.scope.projectId ?? t("工作区", "Workspace")}` : t("未绑定（不会猜测归属）", "Unbound (ownership is never guessed)")}</code></dd></div><div><dt>{t("最近更新", "Last updated")}</dt><dd>{updatedLabel(t, locale, thread.lastMessageAt)}</dd></div></dl>
            {blocked && <p className="agent-history-warning">{blocked}</p>}
            {accessible && context.fileArea.status !== "available" && <p className="agent-history-warning">{t(`原分组的目录${context.fileArea.status === "unconfigured" ? "尚未配置" : "当前不可用"}；允许恢复历史，但发送前仍须配置可用目录。`, `The original group's directory is ${context.fileArea.status === "unconfigured" ? "not configured yet" : "currently unavailable"}; restoring history is allowed, but a usable directory is required before sending.`)}</p>}
          </div>
          <div className="agent-history-actions"><Button type="button" size="sm" variant="outline" disabled={!accessible || loading || !!loadError || !!busyId} onClick={() => void mutate(thread, "restore")} aria-label={t(`恢复${thread.title || "未命名会话"}到原分组`, `Restore ${thread.title || "untitled session"} to its original group`)}><ArchiveRestoreIcon aria-hidden="true" />{busyId === thread.remoteId ? t("正在处理…", "Working…") : t("恢复到原分组", "Restore to original group")}</Button><Button type="button" size="sm" variant="outline" disabled={!accessible || loading || !!loadError || !!busyId} onClick={() => { setActionError(undefined); setDeleting(thread); }} aria-label={t(`永久删除${thread.title || "未命名会话"}`, `Permanently delete ${thread.title || "untitled session"}`)}><Trash2Icon aria-hidden="true" />{t("永久删除", "Delete permanently")}</Button></div>
        </li>;
      })}</ul>
    </SettingsSection>
    {deleting && <Dialog open onOpenChange={(open) => { if (!open && !busyId) setDeleting(undefined); }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>{t("永久删除已归档会话？", "Permanently delete archived session?")}</DialogTitle><DialogDescription>{t(`“${deleting.title || "未命名会话"}”的已保存聊天历史将不可恢复。若仍有后台生成，删除会请求取消并等待服务端处理；这不会撤销已经发生的文件修改。`, `The saved chat history of “${deleting.title || "untitled session"}” cannot be recovered. If a background generation is still running, deletion requests cancellation and waits for the server to handle it; this does not undo file changes that already happened.`)}</DialogDescription></DialogHeader>
      <p className="text-sm">{t("原分组：", "Original group: ")}{deletingContext ? `${deletingContext.workspace.name} / ${deletingContext.project?.name ?? t("工作区会话", "Workspace session")}` : t("当前不可访问", "Currently inaccessible")}</p>
      {actionError && <p role="alert" className="text-destructive text-sm">{actionError}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={!!busyId} onClick={() => setDeleting(undefined)}>{t("保留会话", "Keep session")}</Button><Button type="button" variant="destructive" disabled={!!busyId || !permissionsReady || !deletingContext} onClick={() => void mutate(deleting, "delete")}>{busyId ? t("正在删除…", "Deleting…") : t("确认永久删除", "Confirm permanent delete")}</Button></DialogFooter>
    </DialogContent></Dialog>}
  </div>;
}
