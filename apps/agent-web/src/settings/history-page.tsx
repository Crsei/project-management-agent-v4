import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestoreIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { workspaceClient } from "../network";
import { ensureChatMigration } from "../chat/migration";
import { refreshThreadList } from "../chat/remote-adapter";
import { acceptRemoteThread, acceptRemoteThreads, forgetRemoteThread, refreshCatalog, sameScope, scopeContext, usePmChatState } from "../pm/state";
import { SettingsNotice, SettingsSection, useSettingsGuard } from "./settings-layout";
import "./file-areas-history.css";

function updatedLabel(value?: string) {
  if (!value) return "时间未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString("zh-CN");
}

export default function HistoryPage() {
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
      if (!thread.scope || !sameScope(thread.scope, listed.scope) || !scopeContext(catalog, thread.scope)) throw new Error("原始工作区或项目当前不可访问，不能恢复或删除，也不会改绑到其他分组。");
      if (thread.status !== "archived") throw new Error("此会话已不在归档中，请刷新列表后核对；没有执行本次操作。");
      if (kind === "restore") {
        const saved = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, {
          method: "PUT", body: JSON.stringify({ status: "regular" }),
        });
        acceptRemoteThread(saved.thread);
        setThreads((current) => current.map((item) => item.remoteId === saved.thread.remoteId ? saved.thread : item));
        setNotice("会话已恢复到原工作区／项目分组；原始历史和会话设置保持不变。返回聊天后可在原分组打开。");
      } else {
        await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}`, { method: "DELETE" });
        forgetRemoteThread(thread.remoteId);
        setThreads((current) => current.filter((item) => item.remoteId !== thread.remoteId));
        setDeleting(undefined);
        setNotice("会话已永久删除。此操作不会删除文件区域或撤销已经发生的文件修改。");
      }
      committed = true;
      await refreshThreadList();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setActionError(committed ? `操作已保存，但聊天列表刷新失败：${message}。请手动刷新，勿重复提交。` : `操作未确认：${message}。未自动重试；如响应丢失，请先刷新核对真实状态。`);
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
    <SettingsSection title="已归档会话" scope="session" description="归档仅隐藏常规会话列表，不等于停止生成。恢复只回到原始作用域，不复制、不重新分派会话，也不重置历史或模型设置。">
      <div className="agent-settings-page-toolbar"><p>{loading ? "正在读取真实归档列表…" : `共 ${archived.length} 个已归档会话`}</p><Button type="button" variant="outline" size="sm" disabled={loading || !!busyId} onClick={() => void refresh()}><RefreshCwIcon aria-hidden="true" className={loading ? "animate-spin" : undefined} />刷新列表与访问范围</Button></div>
      <label className="agent-history-search"><SearchIcon aria-hidden="true" /><Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话、工作区或项目…" aria-label="搜索归档会话" /></label>
      {loading && <SettingsNotice kind="loading">正在读取 Agent 持久化会话与当前 PM 授权目录册…</SettingsNotice>}
      {loadError && <SettingsNotice kind="error" onRetry={() => void refresh()}>归档列表读取失败：{loadError}。旧列表可能过期，操作已禁用。</SettingsNotice>}
      {pmState.error && <SettingsNotice kind="error" onRetry={() => void refresh()}>无法核验当前 PM 访问范围：{pmState.error}。所有恢复与删除操作已禁用，不使用旧授权绕过检查。</SettingsNotice>}
      {notice && <SettingsNotice kind="success">{notice}</SettingsNotice>}
      {actionError && <SettingsNotice kind="error" onRetry={() => void refresh()}>{actionError}</SettingsNotice>}
      {!loading && !loadError && archived.length === 0 && <p className="agent-settings-empty">暂无已归档会话。聊天侧栏中的“归档会话”会将会话移到这里。</p>}
      {!loading && archived.length > 0 && visible.length === 0 && <p className="agent-settings-empty">没有匹配的归档会话，请修改搜索条件。</p>}
      <ul className="agent-history-list" aria-label="已归档会话列表">{visible.map((thread) => {
        const context = scopeContext(pmState.catalog, thread.scope);
        const accessible = !!thread.scope && !!context && permissionsReady;
        const blocked = !thread.scope ? "旧历史未绑定作用域，仅供保留；不能恢复、删除或重新归属。" : !permissionsReady ? "当前访问范围尚未核验，操作不可用。" : !context ? "原始工作区或项目当前不可访问；不会改绑到其他分组。" : undefined;
        return <li className="agent-history-row" key={thread.remoteId}>
          <div className="agent-history-content"><h3>{thread.title || "未命名会话"}</h3><p className="agent-history-scope">{context ? `${context.workspace.name} / ${context.project?.name ?? "工作区会话"}` : thread.scope ? "原作用域当前不可访问" : "无作用域的历史会话"}</p>
            <dl><div><dt>会话 ID</dt><dd><code>{thread.remoteId}</code></dd></div><div><dt>原始作用域</dt><dd><code>{thread.scope ? `${thread.scope.workspaceId} / ${thread.scope.projectId ?? "工作区"}` : "未绑定（不会猜测归属）"}</code></dd></div><div><dt>最近更新</dt><dd>{updatedLabel(thread.lastMessageAt)}</dd></div></dl>
            {blocked && <p className="agent-history-warning">{blocked}</p>}
            {accessible && context.fileArea.status !== "available" && <p className="agent-history-warning">原分组的目录{context.fileArea.status === "unconfigured" ? "尚未配置" : "当前不可用"}；允许恢复历史，但发送前仍须配置可用目录。</p>}
          </div>
          <div className="agent-history-actions"><Button type="button" size="sm" variant="outline" disabled={!accessible || loading || !!loadError || !!busyId} onClick={() => void mutate(thread, "restore")} aria-label={`恢复${thread.title || "未命名会话"}到原分组`}><ArchiveRestoreIcon aria-hidden="true" />{busyId === thread.remoteId ? "正在处理…" : "恢复到原分组"}</Button><Button type="button" size="sm" variant="outline" disabled={!accessible || loading || !!loadError || !!busyId} onClick={() => { setActionError(undefined); setDeleting(thread); }} aria-label={`永久删除${thread.title || "未命名会话"}`}><Trash2Icon aria-hidden="true" />永久删除</Button></div>
        </li>;
      })}</ul>
    </SettingsSection>
    <SettingsNotice kind="info">此页只管理 Agent Chat 会话，不改变 PM 项目生命周期、成员权限或文件区域。原分组不可访问及无作用域的旧历史不会重新归属；每次操作由服务端再次核验当前 PM 目录册。</SettingsNotice>
    {deleting && <Dialog open onOpenChange={(open) => { if (!open && !busyId) setDeleting(undefined); }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>永久删除已归档会话？</DialogTitle><DialogDescription>“{deleting.title || "未命名会话"}”的已保存聊天历史将不可恢复。若仍有后台生成，删除会请求取消并等待服务端处理；这不会撤销已经发生的文件修改。</DialogDescription></DialogHeader>
      <p className="text-sm">原分组：{deletingContext ? `${deletingContext.workspace.name} / ${deletingContext.project?.name ?? "工作区会话"}` : "当前不可访问"}</p>
      {actionError && <p role="alert" className="text-destructive text-sm">{actionError}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={!!busyId} onClick={() => setDeleting(undefined)}>保留会话</Button><Button type="button" variant="destructive" disabled={!!busyId || !permissionsReady || !deletingContext} onClick={() => void mutate(deleting, "delete")}>{busyId ? "正在删除…" : "确认永久删除"}</Button></DialogFooter>
    </DialogContent></Dialog>}
  </div>;
}
