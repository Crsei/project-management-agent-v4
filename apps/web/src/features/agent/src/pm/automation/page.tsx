import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, FileClock, GitBranch, LayoutDashboard, LockKeyhole, Plug, RefreshCw, Shapes } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { StudioClient, StudioApiError } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import { studioDefinitionSchema, type StudioConfig, type StudioDefinition, type StudioExecution } from "../../../../../../../../packages/contracts/src/automation-studio";
import type { Entity, EntityPage, Workspace } from "../../../../../../../../packages/contracts/src/client";
import { pmJson, PmApiError } from "../state";
import { useAgentText } from "../../i18n";
import { useAutomationQuery } from "./query";
import { useAutomationLeaveProtection } from "./leave-protection";
import { StudioDashboard, type DashboardAction, type DashboardFilters } from "./studio-dashboard";
import { StudioActivity, StudioDetail } from "./studio-detail";
import { useStudioActions, type StudioCommand } from "./studio-actions";
import { StudioEditor, type StudioAssistCallback } from "./studio-editor";
import { StudioTemplates } from "./studio-templates";
import { StudioGitSync } from "./studio-git-sync";
import { StudioImport, downloadStudioDefinition } from "./studio-import";
import { StudioIntegrations } from "./studio-integrations";
import { parseStudioDraftRoute, studioExecutionNeedsRefresh } from "./studio-view";
import { clearStudioRecovery } from "./studio-setup";
import { redactPmReviewDrafts } from "./studio-pm-review";
import styles from "./studio.module.css";
import "./theme.css";
import { RadixSelect } from "@/components/ui/radix-select"

export type AutomationPageProps = { workspace: Workspace; actorId: string; onExit: () => void; onRecheckAccess: () => void; onLeaveGuardChange?: (guard: (() => boolean) | null) => void; embedded?: boolean; onAssist?: StudioAssistCallback; onOpenThread?: (threadId: string) => void | Promise<void> };
type Confirmation = { command: StudioCommand; name: string };
const featureKeys = ["automationId", "templateId", "draftId", "run", "cursor"];
async function readProjects(workspaceId: string, signal: AbortSignal): Promise<Entity[]> {
  const projects = new Map<string, Entity>(); const seen = new Set<string>(); let after: string | undefined;
  do {
    const query = new URLSearchParams({ kind: "project", limit: "100" }); if (after) query.set("after", after);
    const page = await pmJson<EntityPage>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?${query}`, { signal });
    for (const item of page.items) projects.set(item.id, item);
    after = page.nextCursor ?? undefined;
    if (after && seen.has(after)) throw new Error("invalid_pagination_cursor");
    if (after) seen.add(after);
  } while (after);
  return [...projects.values()];
}
function StudioLeaveBoundary({ active, message }: { active: boolean; message: string }) { useAutomationLeaveProtection(active, message); return null; }

/** One PM-authorized execution automation shell. */
export function AutomationPage({ workspace, actorId, onExit, onRecheckAccess, onLeaveGuardChange, embedded = false, onAssist, onOpenThread }: AutomationPageProps) {
  const t = useAgentText(); const location = useLocation(); const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const route = embedded ? params.get("automationPage") ?? "dashboard" : location.pathname.replace(/^\/agent\/automations\/?/, "") || "dashboard";
  const page = route.startsWith("detail/") ? "detail" : route;
  const localDraft = parseStudioDraftRoute(params.get("draftId"));
  const localDraftId = localDraft ? params.get("draftId") ?? undefined : undefined;
  const templateId = params.get("templateId") ?? localDraft?.templateId ?? null;
  const definitionId = page === "detail" ? route.slice(7) : params.get("automationId") ?? (localDraft ? "" : params.get("draftId") ?? "");
  const projectId = params.get("project") || localDraft?.projectId || "";
  const runId = params.get("run"); const cursor = params.get("cursor") || undefined;
  const [api] = useState(() => new StudioClient(workspace.id));
  const [version, setVersion] = useState(0); const [accessLost, setAccessLost] = useState(false); const [notice, setNotice] = useState("");
  const [definitions, setDefinitions] = useState<StudioDefinition[]>([]); const [definitionCursor, setDefinitionCursor] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null); const [importOpen, setImportOpen] = useState(false);
  const editorKey = `${actorId}:${workspace.id}:${workspace.version}:${definitionId || "new"}:${localDraftId ?? ""}:${templateId ?? ""}:${projectId}`;
  const [draftState, setDraftState] = useState({ key: "", dirty: false });
  const studioDirty = page === "setup" && draftState.key === editorKey && draftState.dirty;
  const surfaceKey = `${page}:${projectId}:${importOpen ? "import" : "page"}`;
  const [surfaceState, setSurfaceState] = useState({ key: "", dirty: false });
  const surfaceDirty = surfaceState.key === surfaceKey && surfaceState.dirty;
  const scopeCurrent = useRef(true);
  useEffect(() => { scopeCurrent.current = true; return () => { scopeCurrent.current = false; }; }, []);
  useEffect(() => { setConfirmation(null); }, [page, projectId]);
  const accessFailure = useCallback((cause: unknown) => {
    const status = cause instanceof StudioApiError || cause instanceof PmApiError ? cause.status : 0;
    if (![401, 403].includes(status)) return;
    scopeCurrent.current = false;
    try { clearStudioRecovery(actorId, workspace.id); } catch { /* Keep unreadable request identities; no new writes are allowed. */ }
    try { redactPmReviewDrafts(actorId, workspace.id); } catch { /* Hide private data even if its recovery journal needs manual reconciliation. */ }
    setAccessLost(true); setDefinitions([]); setConfirmation(null); setImportOpen(false);
  }, [actorId, workspace.id]);
  const revoke = useCallback(() => accessFailure(new StudioApiError(403, "access_revoked", "Access revoked")), [accessFailure]);
  const refresh = useCallback(() => { setDefinitionCursor(undefined); setDefinitions([]); setVersion(value => value + 1); }, []);
  const studioActions = useStudioActions(api, actorId, workspace.id, result => {
    setConfirmation(null); refresh();
    if (result.execution) selectExecution(result.execution);
    else if (result.command.kind === "remove") setNotice(t("定义已删除；授权历史保留。", "Definition deleted; authorized history retained."));
    else setNotice(t("定义已保存。启停不影响已开始的运行。", "Definition saved. Status changes do not cancel runs already started."));
  }, revoke);
  const pending = !!studioActions.pending;
  const leaveActive = studioDirty || surfaceDirty || pending || studioActions.storageError;
  const leaveMessage = t("有未保存修改或待核对请求。离开后不会取消运行，确定离开？", "There are unsaved changes or unreconciled requests. Leaving does not cancel runs. Leave anyway?");
  const leaveRef = useRef({ active: leaveActive, message: leaveMessage }); leaveRef.current = { active: leaveActive, message: leaveMessage };
  const canLeave = useCallback(() => !leaveRef.current.active || window.confirm(leaveRef.current.message), []);
  useEffect(() => { onLeaveGuardChange?.(canLeave); return () => onLeaveGuardChange?.(null); }, [onLeaveGuardChange, canLeave]);
  function setQuery(patch: Record<string, string | undefined>, replace = true) {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    navigate({ pathname: location.pathname, search: next.toString() }, { replace });
  }
  function go(destination: string, query: Record<string, string | undefined> = {}, bypass = false) {
    if (!bypass && !canLeave()) return;
    const next = new URLSearchParams(location.search); for (const key of featureKeys) next.delete(key);
    next.delete("view"); next.delete("thread"); next.set("workspace", workspace.id);
    for (const [key, value] of Object.entries(query)) if (value) next.set(key, value);
    if (embedded) next.set("automationPage", destination); else next.delete("automationPage");
    navigate({ pathname: embedded ? location.pathname : `/agent/automations${destination === "dashboard" ? "" : `/${destination}`}`, search: next.toString() });
  }
  function selectExecution(execution: StudioExecution) { go(`detail/${execution.definitionId}`, { run: execution.id }, true); }
  const projects = useAutomationQuery(`studio-projects:${version}`, async signal => { try { return await readProjects(workspace.id, signal); } catch (cause) { accessFailure(cause); throw cause; } }, !accessLost);
  const list = useAutomationQuery(`studio-definitions:${definitionCursor ?? ""}:${version}`, async signal => {
    try { const result = await api.definitions(definitionCursor, { signal }); return { ...result, items: result.items.map(item => studioDefinitionSchema.parse(item)) }; } catch (cause) { accessFailure(cause); throw cause; }
  }, !accessLost);
  useEffect(() => { const data = list.data; if (!data || list.error || list.loading || accessLost) return; setDefinitions(current => { const next = new Map(current.map(item => [item.id, item])); for (const item of data.items) next.set(item.id, item); return [...next.values()]; }); }, [list.data, list.error, list.loading, accessLost]);
  const recent = useAutomationQuery(`studio-recent:${version}`, async signal => { try { return await api.executions(undefined, undefined, { signal }); } catch (cause) { accessFailure(cause); throw cause; } }, !accessLost, page => page.items.some(studioExecutionNeedsRefresh));
  const capabilities = useAutomationQuery(`studio-capabilities:${projectId}:${version}`, async signal => { try { return await api.capabilities(projectId, { signal }); } catch (cause) { accessFailure(cause); throw cause; } }, !!projectId && !accessLost);
  const detail = useAutomationQuery(`studio-definition:${definitionId}:${version}`, async signal => { try { return studioDefinitionSchema.parse(await api.definition(definitionId, { signal })); } catch (cause) { accessFailure(cause); throw cause; } }, !!definitionId && ["detail", "setup"].includes(page) && !accessLost);
  const allProjects = projects.data ?? [];
  const availableProjects = allProjects.filter(item => !item.data.archivedAt && !["completed", "cancelled"].includes(String(item.data.status ?? "")));
  const writableFor = (id: string) => !accessLost && workspace.capabilities.includes("planning.edit") && (workspace.projectIds === null || workspace.projectIds.includes(id)) && availableProjects.some(project => project.id === id) && (!projectId || projectId === id);
  const reviewProjectIds = workspace.capabilities.includes("domain.read") ? allProjects.filter(item => (workspace.projectIds === null || workspace.projectIds.includes(item.id)) && (!projectId || projectId === item.id)).map(item => item.id) : [];
  const planningProjectIds = availableProjects.filter(item => reviewProjectIds.includes(item.id) && writableFor(item.id)).map(item => item.id);
  const commentProjectIds = workspace.capabilities.includes("intent.propose") ? availableProjects.filter(item => reviewProjectIds.includes(item.id)).map(item => item.id) : [];
  const ready = !!projects.data && !projects.error && !!list.data && !list.error;
  const locked = !ready || list.loading || studioActions.busy || pending || studioActions.storageError;
  const selectedDefinition = detail.error ? null : detail.data?.id === definitionId ? detail.data : definitions.find(item => item.id === definitionId) ?? null;
  const definitionScopeMismatch = !!projectId && !!selectedDefinition && selectedDefinition.config.projectId !== projectId;
  const queryFilters: DashboardFilters = { search: params.get("q") ?? "", status: params.get("status") ?? "", trigger: params.get("trigger") ?? "", tag: params.get("tag") ?? "", sort: params.get("sort") ?? "updated", view: params.get("mode") ?? "grid" };
  function onFilters(patch: Partial<DashboardFilters>) { setQuery(Object.fromEntries(Object.entries(patch).map(([key, value]) => [key === "search" ? "q" : key === "view" ? "mode" : key, value || undefined]))); }
  function confirmCommand(command: StudioCommand, name = selectedDefinition?.config.name ?? command.id) { if (!locked) setConfirmation({ command, name }); }
  async function exportDefinition(id: string, format: "bundle" | "source" = "bundle") { try { await downloadStudioDefinition(workspace.id, id, format); } catch (cause) { accessFailure(cause); setNotice(cause instanceof Error ? cause.message : String(cause)); } }
  function itemAction(action: DashboardAction, item: StudioDefinition) {
    if (action === "view") go(`detail/${item.id}`);
    else if (action === "edit") go("setup", { automationId: item.id });
    else if (action === "export") void exportDefinition(item.id);
    else if (action === "status") confirmCommand({ kind: "status", id: item.id, expectedRevision: item.revision, status: item.status === "enabled" ? "paused" : "enabled" }, item.config.name);
    else confirmCommand({ kind: action, id: item.id, expectedRevision: item.revision }, item.config.name);
  }
  function submitConfirmation() {
    if (!confirmation || locked) return;
    void studioActions.execute(confirmation.command);
    setConfirmation(null);
  }
  function debug(config: StudioConfig, execution?: StudioExecution) {
    if (!onAssist) return;
    const context = t(`请协助调试自动化「${config.name}」。仅分析配置与已有结果，未经我明确要求不要运行或产生外部副作用。\n${execution ? `运行 ${execution.id}：${execution.status}\n${execution.error ?? execution.summary}` : ""}`, `Help debug automation “${config.name}”. Analyze its configuration and existing results only; do not execute or cause external effects without my explicit request.\n${execution ? `Execution ${execution.id}: ${execution.status}\n${execution.error ?? execution.summary}` : ""}`);
    void Promise.resolve().then(() => onAssist({ projectId: config.projectId, definitionId: execution?.definitionId ?? selectedDefinition?.id, templateId: config.templateId ?? undefined, config, prompt: `${context}\n\n${JSON.stringify(config, null, 2)}` })).catch(cause => { if (scopeCurrent.current) setNotice(cause instanceof Error ? cause.message : String(cause)); });
  }
  const onDirtyChange = useCallback((dirty: boolean) => setDraftState({ key: editorKey, dirty }), [editorKey]);
  const onSurfaceDirtyChange = useCallback((dirty: boolean) => setSurfaceState({ key: surfaceKey, dirty }), [surfaceKey]);
  const nav = [{ id: "dashboard", label: t("控制台", "Dashboard"), Icon: LayoutDashboard }, { id: "templates", label: t("模板", "Templates"), Icon: Shapes }, { id: "history", label: t("全部运行历史", "All run history"), Icon: FileClock }, { id: "git-sync", label: "Git Sync", Icon: GitBranch }, { id: "integrations", label: t("连接与事件", "Connections & events"), Icon: Plug }];
  const selectedProjectUnavailable = !!projectId && !!projects.data && !allProjects.some(project => project.id === projectId);
  const confirmationKind = confirmation?.command.kind;
  const enabling = confirmation?.command.kind === "status" && confirmation.command.status === "enabled";
  const confirmationTitle = confirmationKind === "remove" ? t("删除自动化？", "Delete automation?") : confirmationKind === "run" ? t("立即运行一次？", "Run once now?") : confirmationKind === "cancel" ? t("请求取消此运行？", "Request cancellation?") : enabling ? t("启用自动化？", "Turn on automation?") : t("暂停自动化？", "Turn off automation?");
  return <div className={`pm-automation ${styles.shell}`} onClickCapture={event => {
    const target = event.target instanceof Element ? event.target : null;
    const clicked = target?.closest("details");
    event.currentTarget.querySelectorAll(`details.${styles.menu}[open]`).forEach(item => { if (item !== clicked || target?.closest("button")) item.removeAttribute("open"); });
  }} onKeyDown={event => { if (event.key === "Escape") event.currentTarget.querySelectorAll("details[open]").forEach(item => item.removeAttribute("open")); }}>
    <div className={styles.frame}>
    <StudioLeaveBoundary active={leaveActive} message={leaveMessage} />
    <aside className={styles.secondaryNav}><div className={styles.navHeading}>{t("自动化", "Automate")}</div><nav aria-label={t("自动化导航", "Automation navigation")}>{nav.map(item => <button type="button" key={item.id} aria-current={page === item.id ? "page" : undefined} onClick={() => go(item.id)}><item.Icon size={16} /><span>{item.label}</span></button>)}</nav><div className={styles.navFooter}><LockKeyhole size={13} />{t("当前主体与项目授权", "Current actor & project access")}</div><Button variant="ghost" size="sm" onClick={() => { if (canLeave()) onExit(); }}><ArrowLeft size={14} />{t("返回对话", "Back to Chat")}</Button></aside>
    <main className={styles.main}><div className={styles.body}>
      <div className={styles.scopeBar}><label>{t("项目范围", "Project scope")}<RadixSelect aria-label={t("自动化项目范围", "Automation project scope")} value={projectId} disabled={projects.loading} onChange={event => { if (canLeave()) { setQuery({ project: event.target.value || undefined }, false); } }}><option value="">{t("工作区 / 选择项目配置", "Workspace / choose project to configure")}</option>{projectId && !allProjects.some(item => item.id === projectId) && <option value={projectId}>{projectId}</option>}{allProjects.map(item => <option value={item.id} key={item.id}>{String(item.data.name ?? item.data.title ?? item.id)}</option>)}</RadixSelect></label><Button variant="ghost" size="sm" aria-label={t("刷新自动化", "Refresh automations")} disabled={list.loading || projects.loading} onClick={refresh}><RefreshCw size={15} /></Button></div>
      {accessLost ? <section className={styles.empty} role="alert"><LockKeyhole size={28} /><h1>{t("授权已失效", "Access is no longer available")}</h1><p>{t("私有页面数据已隐藏。重新读取当前授权后继续。", "Private page data is hidden. Recheck current authorization to continue.")}</p><Button variant="outline" onClick={() => { onRecheckAccess(); scopeCurrent.current = true; setAccessLost(false); refresh(); }}>{t("重新读取授权", "Recheck access")}</Button></section> : <>
        {(projects.loading || (list.loading && !list.data)) && <div className={styles.skeleton} role="status">{t("正在读取自动化…", "Loading automations…")}</div>}
        {(!!projects.error || !!list.error) && <div className={styles.error} role="alert"><h2>{t("无法读取自动化", "Could not load automations")}</h2><p>{t("写入已暂停；原请求和草稿版本不会重置。", "Writes are paused; original request identities and draft revisions are preserved.")}</p><Button variant="outline" onClick={refresh}>{t("重试", "Retry")}</Button></div>}
        {selectedProjectUnavailable && <p role="alert" className={styles.error}>{t("URL 中的项目不在当前可访问范围。请重新选择，不会静默替换项目。", "The URL project is outside current access. Select a project; it will not be silently replaced.")}</p>}
        {!workspace.capabilities.includes("planning.edit") && <p className={styles.notice} role="status"><LockKeyhole size={14} /> {t("自动化为只读模式。历史和模板仍按当前授权可见；保存、启停和运行需要现有项目编辑权限。", "Read-only automation access. History and templates remain subject to current authorization; saving, status changes, and dispatch require the existing project edit permission.")}</p>}
        {projectId && allProjects.some(item => item.id === projectId) && !availableProjects.some(item => item.id === projectId) && <p className={styles.notice}>{t("此项目已归档或结束；配置和历史仍可查看，但不能新建或派发执行。", "This project is archived or closed. Configuration and history remain readable, but new definitions and dispatch are not allowed.")}</p>}
        {studioActions.storageError && <div className={styles.warning} role="alert"><p>{t("恢复存储不可用，所有新写入暂停。不会丢弃未知请求。", "Recovery storage is unavailable. New writes are paused; unknown request identities are not discarded.")}</p><Button variant="outline" size="sm" onClick={studioActions.retryStorage}>{t("重试恢复存储", "Retry recovery storage")}</Button></div>}
        {studioActions.pending && <div className={styles.warning} role="status"><strong>{t("原请求待核对", "Original request awaiting reconciliation")}</strong><p>{t("只查询原收据，不重复保存、删除或运行。", "Only the original receipt is queried; no save, delete, or run is repeated.")}</p><code>{studioActions.pending.requestId}</code><Button variant="outline" size="sm" disabled={studioActions.busy} onClick={() => void studioActions.reconcile()}>{t("核对原收据", "Check original receipt")}</Button></div>}
        {studioActions.error && <p className={styles.error} role="alert">{studioActions.error}</p>}{notice && <p className={styles.notice} role="status">{notice}<button type="button" onClick={() => setNotice("")}>{t("关闭", "Dismiss")}</button></p>}
        {page === "dashboard" && ready && <StudioDashboard definitions={definitions.filter(item => !projectId || item.config.projectId === projectId)} executions={recent.data?.items.filter(item => !projectId || item.configSnapshot.projectId === projectId)} executionError={!!recent.error} api={api} filters={queryFilters} onFilters={onFilters} onAction={itemAction} onNew={() => go("setup")} onTemplates={() => go("templates")} onImport={() => setImportOpen(true)} onGit={() => go("git-sync")} onHistory={() => go("history")} onMore={() => setDefinitionCursor(list.data?.nextCursor ?? undefined)} hasMore={!!list.data?.nextCursor} loadingMore={list.loading} writableFor={writableFor} locked={locked} onAccessFailure={accessFailure} />}
        {page === "templates" && <StudioTemplates key={projectId} workspaceId={workspace.id} projectId={projectId || undefined} onSelect={templateId => go("setup", { templateId })} onAssist={onAssist} onIntegrations={() => go("integrations")} />}
        {definitionScopeMismatch && ["setup", "detail"].includes(page) && <div className={styles.error} role="alert"><h2>{t("定义与当前项目不一致", "Definition does not match the current project")}</h2><p>{t("不会在另一个项目范围中打开或修改此定义。", "This definition will not be opened or edited under another project scope.")}</p><Button variant="outline" onClick={() => { if (canLeave()) setQuery({ project: selectedDefinition?.config.projectId, cursor: undefined, run: undefined }, false); }}>{t("切换到定义所属项目", "Switch to the definition's project")}</Button></div>}
        {page === "setup" && !definitionScopeMismatch && projects.data && (!definitionId || (!detail.loading && !detail.error && selectedDefinition)) && <StudioEditor key={editorKey}
          workspaceId={workspace.id} actorId={actorId} membershipVersion={workspace.version} projectId={projectId || undefined}
          projects={allProjects.filter(item => !item.data.archivedAt)} definition={selectedDefinition} templateId={templateId} draftId={localDraftId}
          writable={!locked && workspace.capabilities.includes("planning.edit") && !selectedProjectUnavailable}
          onSaved={definition => { refresh(); go(`detail/${definition.id}`, {}, true); }} onExecution={selectExecution} onCancel={() => go("dashboard")}
          onDirtyChange={onDirtyChange} onAssist={onAssist} onIntegrations={() => go("integrations")} onAccessLost={revoke} />}
        {page === "setup" && !!definitionId && !!detail.error && <div className={styles.error} role="alert"><h2>{t("定义无法读取，未创建空白替代项", "Definition unavailable; no blank replacement created")}</h2><Button variant="outline" onClick={detail.refetch}>{t("重试", "Retry")}</Button></div>}
        {page === "detail" && !!detail.error && !(detail.error instanceof StudioApiError && detail.error.status === 404) && <div className={styles.error} role="alert"><h2>{t("定义详情读取失败", "Could not load definition details")}</h2><p>{detail.error instanceof Error ? detail.error.message : t("网络或服务返回异常。历史仍单独按当前授权读取。", "A network or service error occurred. History is read separately under current authorization.")}</p><Button variant="outline" onClick={detail.refetch}>{t("重试详情", "Retry details")}</Button></div>}
        {page === "detail" && !definitionScopeMismatch && (detail.loading && detail.data?.id !== definitionId ? <div className={styles.skeleton} role="status">{t("读取详情…", "Loading detail…")}</div> : <StudioDetail key={`${actorId}:${workspace.id}:${workspace.version}:${definitionId}:${projectId}`}
          definition={selectedDefinition} definitionId={definitionId} api={api} reloadKey={version} runId={runId} cursor={cursor} projectId={projectId || undefined}
          pmContext={{ actorId, workspaceId: workspace.id, membershipVersion: workspace.version, reviewProjectIds, planningProjectIds, commentProjectIds, onDirtyChange: onSurfaceDirtyChange }}
          onCursor={cursor => setQuery({ cursor })} onRunSelect={run => setQuery({ run: run ?? undefined })} onBack={() => go("dashboard")}
          onEdit={() => go("setup", { automationId: definitionId })} onExport={format => void exportDefinition(definitionId, format)} onCommand={confirmCommand}
          onDebug={onAssist ? debug : undefined} onOpenThread={onOpenThread}
          writable={selectedDefinition ? writableFor(selectedDefinition.config.projectId) : workspace.capabilities.includes("planning.edit")} locked={locked} onAccessFailure={accessFailure} />)}
        {page === "history" && <div className={styles.stack}><header className={styles.heading}><div><h1>{t("全部运行历史", "All execution history")}</h1><p>{t("保留已删除定义的授权执行记录。", "Authorized execution records survive definition deletion.")}</p></div></header>
          <StudioActivity key={`history:${actorId}:${workspace.id}:${workspace.version}:${projectId}`} api={api} pmContext={{ actorId, workspaceId: workspace.id, membershipVersion: workspace.version, reviewProjectIds, planningProjectIds, commentProjectIds, onDirtyChange: onSurfaceDirtyChange }} projectId={projectId || undefined} reloadKey={version} runId={runId} cursor={cursor}
            onCursor={cursor => setQuery({ cursor })} onRunSelect={run => setQuery({ run: run ?? undefined })} onCommand={confirmCommand}
            onDefinition={execution => go(`detail/${execution.definitionId}`, { run: execution.id })}
            onDebug={onAssist ? debug : undefined} onOpenThread={onOpenThread} writable={workspace.capabilities.includes("planning.edit")} locked={locked} onAccessFailure={accessFailure} /></div>}
        {(["git-sync", "integrations"].includes(page)) && (!projectId || selectedProjectUnavailable
          ? <div className={styles.empty}><Plug size={26} /><h1>{t("先选择项目", "Choose a project first")}</h1><p>{t("连接、事件与 Git Sync 均明确归属当前项目。", "Connections, events, and Git Sync belong to an explicit project.")}</p></div>
          : page === "git-sync" ? <StudioGitSync key={projectId} workspaceId={workspace.id} actorId={actorId} membershipVersion={workspace.version} projectId={projectId} canWrite={writableFor(projectId)} onDirtyChange={onSurfaceDirtyChange} onBack={() => go("dashboard")} />
          : <StudioIntegrations key={projectId} workspaceId={workspace.id} actorId={actorId} membershipVersion={workspace.version} projectId={projectId} canWrite={writableFor(projectId)} onDirtyChange={onSurfaceDirtyChange} />)}
        {projectId && capabilities.data && page === "dashboard" && <div className={styles.capabilityNotice}>{capabilities.data.actions.filter(action => !action.available).map(action => <p key={action.id}>{action.id}: {action.reason ?? t("未配置", "Not configured")}</p>)}{!capabilities.data.scheduler.ready && <p>{t("后台调度：", "Background scheduler: ")}{capabilities.data.scheduler.reason ?? t("未就绪", "Not ready")}</p>}</div>}
        {projectId && !!capabilities.error && page === "dashboard" && <p className={styles.warning} role="alert">{t("当前项目的执行能力读取失败，未假定 Provider 或调度已配置。", "Execution capabilities could not be read for this project; Provider and scheduler readiness are not assumed.")}</p>}
        {!nav.some(item => item.id === page) && !["setup", "detail"].includes(page) && <div className={styles.empty}><h1>{t("自动化页面不存在", "Automation page not found")}</h1><Button onClick={() => go("dashboard")}>{t("返回 Dashboard", "Back to dashboard")}</Button></div>}
      </>}
    </div></main>
    {importOpen && !accessLost && (projectId ? <StudioImport key={projectId} workspaceId={workspace.id} actorId={actorId} membershipVersion={workspace.version} projectId={projectId}
      onDirtyChange={onSurfaceDirtyChange} onClose={() => { if (canLeave()) setImportOpen(false); }}
      onImported={definition => { setImportOpen(false); refresh(); go(`detail/${definition.id}`, {}, true); }} />
      : <Dialog open onOpenChange={open => setImportOpen(open)}><DialogContent><DialogHeader><DialogTitle>{t("选择导入项目", "Choose an import project")}</DialogTitle><DialogDescription>{t("请在页面顶部选择项目后导入。导入只会创建持久草稿，不会启用。", "Choose a project at the top before importing. Import creates only a persistent draft; it never enables execution.")}</DialogDescription></DialogHeader><Button onClick={() => setImportOpen(false)}>{t("关闭", "Close")}</Button></DialogContent></Dialog>)}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{confirmationTitle}</DialogTitle>
        <DialogDescription>{confirmationKind === "remove" ? t("停止未来调度并删除定义，授权运行历史保留。不可撤销。", "Stops future scheduling and deletes the definition. Authorized execution history is retained. This cannot be undone.")
          : confirmationKind === "cancel" ? t("请求取消原执行；外部服务确认前仍显示待核对，不会假定已经停止。", "Requests cancellation of the original execution. It remains pending until confirmed by the runtime; stopping is not assumed.")
          : confirmationKind === "status" ? enabling ? t("按当前保存版本启用。启用本身不会立即运行；后续定时/事件可触发实际执行。", "Enables the current saved revision. Enabling does not run immediately; later schedule/events can trigger real execution.") : t("只停止新的自动触发。已开始的运行不会因此取消。", "Stops new automatic dispatch only. Runs already started are not cancelled.")
          : t("使用已保存版本执行，可能调用模型、计费、使用连接器或运行脚本。不是只读验证。", "Executes the saved revision and may invoke a model, incur cost, use integrations, or run a script. This is not read-only validation.")}</DialogDescription>
      </DialogHeader><strong>{confirmation?.name}</strong>
        <DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</Button><Button variant={confirmationKind === "remove" ? "destructive" : "default"} disabled={locked} onClick={submitConfirmation}>{t("确认", "Confirm")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  </div>;
}
