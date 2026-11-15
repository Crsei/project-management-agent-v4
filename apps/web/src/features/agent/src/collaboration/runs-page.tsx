import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { Link, useLocation, useNavigationType, useSearchParams } from "react-router-dom";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { createRunSchema, collaborationRunStatusSchema, type CollaborationRun, type AgentDetailResponse, type AgentsResponse, type TeamDetailResponse, type TeamsResponse, type CreateRun, type RunDefinition, type RunResponse, type RunsResponse } from "@agent-workspace/contracts/collaboration";
import type { AgentWorkspace } from "@agent-workspace/contracts/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadixSelect } from "@/components/ui/radix-select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Board } from "@/components/blocks/work-items-board-base";
import { AgentRunCard } from "@/views/pm/agent-run-card";
import type { GroupSnapshot } from "@/lib/grouped-items-model";
import boardStyles from "@/views/pm/boards-views.module.css";
import common from "@/views/pm/agent-run-board.module.css";
import { useAgentText } from "../i18n";
import { pmJson, workspaceExecutionSelection } from "../pm/state";
import { useAutomationLeaveProtection } from "../pm/automation/leave-protection";
import { runBoardChatHref } from "../pm/run-board-navigation";
import { useKeepRunCardVisible } from "../pm/run-execution-dock";
import { captureCollaborationAuthority, collaborationJson, collaborationPath, errorText, useCollaborationResource, useCollaborationState } from "./data";
import { businessRunStatusLabel, CollaborationFrame, Field, ReadNotice, WorkspaceScope } from "./ui";
import { CapabilityFacts } from "./capabilities";
import type { CapabilitiesResponse } from "@agent-workspace/contracts/collaboration";
import { RunDetail } from "./run-detail";
import { definitionAssignedToProject, frozenRunDefinition, runMatchesFilters } from "./model";
import styles from "./collaboration.module.css";

const pmClient = { json: pmJson };
type Issue = { id: string; projectId: string | null; title: string; revision: string; status: string | null };
type IssuesPage = { items: Issue[]; nextCursor: string | null };

export default function BusinessRunsPage() {
  const t = useAgentText();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const workspaceId = params.get("workspaceId") ?? "";
  const projectId = params.get("projectId") ?? "";
  const taskId = params.get("taskId") ?? "";
  const selectedId = params.get("runId");
  const urlQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const latestQuery = useRef(query);
  const [queryNavigationId] = useState(() => crypto.randomUUID());
  const navigationType = useNavigationType();
  useEffect(() => {
    // Older commits from our own typing must not replace a newer urgent input value.
    if (navigationType !== "POP" && location.state?.businessRunsQueryId === queryNavigationId) return;
    latestQuery.current = urlQuery;
    setQuery(urlQuery);
  }, [location.key, location.state, navigationType, queryNavigationId, urlQuery]);
  const returnParams = new URLSearchParams(params);
  if (query) returnParams.set("q", query); else returnParams.delete("q");
  const returnTo = query === urlQuery ? `${location.pathname}${location.search}` : `${location.pathname}${returnParams.size ? `?${returnParams}` : ""}`;
  const status = params.get("status") ?? "";
  const definition = params.get("definitionId") ?? "";
  const [launch, setLaunch] = useState(false);
  const launchLeaveGuard = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const boardElement = useRef<HTMLDivElement>(null);
  const runs = useCollaborationResource<RunsResponse>(collaborationPath("runs", workspaceId, { ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) }));
  const rows = runs.data?.runs ?? [];
  const filtered = rows.filter(run => runMatchesFilters(run, { query, status, definitionId: definition }));
  useKeepRunCardVisible(boardElement, selectedId && filtered.some(run => run.id === selectedId) ? selectedId : null);
  const definitions = [...new Map(rows.map(run => [run.definition.kind === "agent" ? run.definition.agentId : run.definition.teamId, run.teamVersion?.config.name ?? run.agentVersions[0]?.config.name ?? run.id])).entries()];
  const groups: GroupSnapshot[] = collaborationRunStatusSchema.options.map(key => {
    const itemIds = filtered.filter(run => run.status === key).map(run => run.id);
    return { key, label: businessRunStatusLabel(key, t), itemIds, totalCount: itemIds.length, loadedCount: itemIds.length, dataState: "success", queryKey: "collaboration-business-runs" };
  });
  const patchQuery = (patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    if (latestQuery.current) next.set("q", latestQuery.current); else next.delete("q");
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    setParams(next, { replace, state: { ...(location.state && typeof location.state === "object" ? location.state : {}), businessRunsQueryId: queryNavigationId } });
  };
  const close = () => {
    patchQuery({ runId: null });
    requestAnimationFrame(() => (opener.current?.isConnected ? opener.current : refreshButton.current)?.focus());
  };
  return <CollaborationFrame runBoard title={t("业务执行", "Business Runs")} description={t("PM 授权范围 · Run 成功不代表 Issue 完成", "PM-authorized scope · Run success is not Issue completion")} actions={<><Link to="/agent/runs?view=sessions">{t("会话活动", "Session activity")}</Link><Button ref={refreshButton} size="sm" variant="outline" disabled={runs.loading} onClick={() => void runs.refresh()}>{t("刷新", "Refresh")}</Button><Button size="sm" disabled={!workspaceId || !!runs.error || !runs.data} onClick={() => setLaunch(true)}>{t("发起执行", "Launch Run")}</Button></>} dock={selectedId && <RunDetail key={selectedId} runId={selectedId} returnTo={returnTo} onClose={close} onNavigate={id => patchQuery({ runId: id })} />}>
    <details className={styles.boardHelp}><summary>{t("业务运行说明与导航", "About business Runs")}</summary><div className={styles.actions}><Link to={runBoardChatHref({ agentWorkspaceId: null, returnTo })}>{t("新建普通 Chat（无需 PM 授权）", "New ordinary Chat (no PM authorization)")}</Link><Link to="/agent/agents">Agents</Link><Link to="/agent/teams">Teams</Link></div><p className={styles.hint}>{t("业务 Run 需要当前 PM 授权和已启用配置。普通 Chat 与目录终端不依赖 PM 授权；查看或选中运行不会发送模型消息或创建终端。离开页面不停止后台执行。", "Business Runs require current PM authorization and an enabled definition. Ordinary Chat and folder terminals do not require PM authorization. Viewing or selecting a Run sends no model message and creates no terminal. Leaving never stops background execution.")}</p></details>
    <WorkspaceScope workspaceId={workspaceId} projectId={projectId} onChange={(workspaceId, projectId) => { setLaunch(false); patchQuery({ workspaceId, projectId, taskId: null, runId: null }); }} />
    {taskId && <p className={styles.notice}>{t("当前 Issue：", "Current Issue: ")}{taskId} <Button variant="ghost" size="sm" onClick={() => patchQuery({ taskId: null })}>{t("查看项目所有执行", "Show all project Runs")}</Button></p>}
    <div className={styles.filters}><Field label={t("搜索目标、Issue 或 Agent", "Search goals, Issues or Agents")}><Input type="search" value={query} onChange={event => { const value = event.target.value; latestQuery.current = value; setQuery(value); patchQuery({ q: value }, true); }} /></Field><Field label={t("业务执行状态", "Business status")}><RadixSelect value={status} onChange={event => patchQuery({ status: event.target.value }, true)}><option value="">{t("全部状态", "All statuses")}</option>{collaborationRunStatusSchema.options.map(value => <option value={value} key={value}>{businessRunStatusLabel(value, t)}</option>)}</RadixSelect></Field><Field label="Agent / Team"><RadixSelect value={definition} onChange={event => patchQuery({ definitionId: event.target.value }, true)}><option value="">{t("全部配置", "All definitions")}</option>{definitions.map(([id, name]) => <option key={id} value={id}>{name} · {id}</option>)}</RadixSelect></Field><Link to={`/agent/inbox?${new URLSearchParams({ ...(workspaceId ? { workspaceId } : {}), ...(projectId ? { projectId } : {}) })}`}>{t("需要处理 / Inbox", "Needs attention / Inbox")}</Link></div>
    <ReadNotice resource={runs} />
    {runs.error && <p className={styles.notice}>{t("当前无法读取业务执行；这不是「没有 Run」。请核对 PM 登录与工作区权限，或使用上方普通 Chat / 会话终端入口。", "Business Runs cannot currently be read; this is not an empty Run list. Check PM sign-in and workspace access, or use ordinary Chat / Session terminals above.")}</p>}
    {!workspaceId && <p className={styles.notice}>{t("先选择当前 PM 授权工作区；普通 Chat 和会话活动不受此选择限制。", "Choose a currently authorized PM workspace. Ordinary Chat and Session activity are independent.")}</p>}
    {runs.data && !runs.error && !filtered.length && <p className={styles.notice}>{rows.length ? t("没有匹配的执行。", "No matching Runs.") : t("尚无业务 Run。不会从历史 Session 补造执行。", "No business Runs. Historical Sessions are never turned into invented Runs.")}</p>}
    {runs.data && !runs.error && <div ref={boardElement} className={`${boardStyles.viewport} ${common.viewport} ${styles.businessBoardViewport}`} role="region" tabIndex={0} aria-label={t("业务运行看板，可横向滚动", "Business Run board, horizontally scrollable")}>
      <Board<CollaborationRun> className={`${boardStyles.board} ${common.board}`} groups={groups} items={filtered} queryKey="collaboration-business-runs" manualOrder={false} getItemId={run => run.id} getItemLabel={run => run.goal} renderItem={run => {
        const visualStatus = run.status === "failed" || run.status === "interrupted" ? "attention" : run.status === "succeeded" || run.status === "cancelled" ? "ended" : run.status;
        return <AgentRunCard id={run.id} title={run.goal} agent={run.teamVersion?.config.name ?? run.agentVersions.map(version => version.config.name).join(", ")} provider={run.agentVersions[0]?.config.providerInstanceId ?? t("尚未固定执行器", "Executor not yet frozen")} model={run.agentVersions[0]?.config.model ?? ""} folder={`${run.target.projectId} / ${run.target.taskId}`} status={visualStatus} statusLabel={businessRunStatusLabel(run.status, t)} metadata={new Date(run.updatedAt).toLocaleString()} metadataLabel={`${t("实际更新时间", "Observed update")}: ${run.updatedAt}`} metadataDateTime={run.updatedAt} step={run.wait?.reason ?? `${businessRunStatusLabel(run.status, t)} · ${t("不代表 Issue 完成", "not Issue completion")}`} previewLabel={`${t("查看真实业务 Run", "Inspect business Run")}: ${run.goal}`} onOpen={trigger => { opener.current = trigger; patchQuery({ runId: run.id }); }} />;
      }} />
    </div>}
    <Sheet open={launch} onOpenChange={open => { if (!open && launchLeaveGuard.current && !window.confirm(t("执行输入或原请求待核对，确认关闭？后台执行不会停止。", "Run input or original request is unresolved. Close? Background execution continues."))) return; setLaunch(open); }}><SheetContent side="right" size={800}><SheetHeader><SheetTitle>{t("明确发起业务 Run", "Explicitly launch a business Run")}</SheetTitle><SheetDescription>{t("选择、查看与刷新不创建 Session。只有最终提交才受理执行。", "Selection, inspection and refresh create no Session. Only final submission accepts execution.")}</SheetDescription></SheetHeader><SheetBody>{launch && <RunLaunchForm key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} initialProjectId={projectId} initialTaskId={taskId} leaveGuard={launchLeaveGuard} onAccepted={run => { launchLeaveGuard.current = false; setLaunch(false); patchQuery({ runId: run.id, workspaceId: run.target.workspaceId, projectId: run.target.projectId, taskId: taskId ? run.target.taskId : null }); void runs.refresh(); }} />}</SheetBody></SheetContent></Sheet>
  </CollaborationFrame>;
}

function RunLaunchForm({ workspaceId, initialProjectId, initialTaskId, onAccepted, leaveGuard }: { workspaceId: string; initialProjectId: string; initialTaskId: string; onAccepted: (run: RunResponse["run"]) => void; leaveGuard: MutableRefObject<boolean> }) {
  const t = useAgentText();
  const [projectId, setProjectId] = useCollaborationState(initialProjectId, "");
  const [query, setQuery] = useCollaborationState(initialTaskId, "");
  const [cursor, setCursor] = useCollaborationState("", "");
  const [task, setTask] = useCollaborationState<Issue | null>(null, null);
  const [kind, setKind] = useState<"agent" | "team">("agent");
  const [definitionId, setDefinitionId] = useCollaborationState("", "");
  const [version, setVersion] = useCollaborationState("", "");
  const [folderId, setFolderId] = useCollaborationState("", "");
  const [goal, setGoal] = useCollaborationState("", "");
  const [input, setInput] = useCollaborationState("", "");
  const [confirmed, setConfirmed] = useCollaborationState(false, false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useCollaborationState<string | null>(null, null);
  const storageKey = `agent-collaboration:run-request:${workspaceId}`;
  const [attempt, setAttempt] = useState<string | null>(() => { try { return sessionStorage.getItem(storageKey); } catch { return null; } });
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const agents = useCollaborationResource<AgentsResponse>(collaborationPath("agents", workspaceId));
  const teams = useCollaborationResource<TeamsResponse>(collaborationPath("teams", workspaceId));
  const detail = useCollaborationResource<AgentDetailResponse | TeamDetailResponse>(definitionId ? `/api/collaboration/${kind === "agent" ? "agents" : "teams"}/${encodeURIComponent(definitionId)}` : null);
  const folders = useCollaborationResource<{ workspaces: AgentWorkspace[] }>("/api/agent-workspaces");
  const issues = useCollaborationResource<IssuesPage>(projectId ? `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-issues?${new URLSearchParams({ projectId, limit: "100", ...(query.trim() ? { q: query.trim() } : {}), ...(cursor ? { after: cursor } : {}) })}` : null, pmClient);
  const capabilities = useCollaborationResource<CapabilitiesResponse>(kind === "agent" && definitionId && version ? collaborationPath("capabilities", workspaceId, { agentId: definitionId, agentVersion: version, ...(projectId ? { projectId } : {}) }) : null);
  const definitionRows = (kind === "agent" ? agents.data?.agents : teams.data?.teams)?.filter(item => definitionAssignedToProject(item, projectId));
  const versions = detail.data?.versions ?? [];
  const folder = folders.data?.workspaces.find(item => item.id === folderId && item.archivedAt === null && item.status === "available");
  const locked = busy || !!attempt;
  const unavailable = !!agents.error || !!teams.error || !!folders.error || !!issues.error || !!detail.error || !!capabilities.error;
  const selectedDefinition = definitionRows?.find(item => item.id === definitionId);
  const selectedVersion = versions.find(item => item.version === Number(version));
  const assignmentValid = !!selectedDefinition && !!selectedVersion?.config.allowedProjectIds.includes(projectId);
  const staleTask = !!task && !!issues.data?.items.some(item => item.id === task.id && item.revision !== task.revision);
  useEffect(() => { leaveGuard.current = !!goal || !!input || busy || !!attempt; return () => { leaveGuard.current = false; }; }, [goal, input, busy, attempt, leaveGuard]);
  useAutomationLeaveProtection(!!goal || !!input || busy || !!attempt, t("执行输入或原受理请求待核对，确认离开？后台 Run 不会停止。", "Run input or original acceptance is unresolved. Leave? Background Runs will not stop."));
  const reconcile = async () => {
    if (!attempt || submitting.current) return;
    const currentAuthority = captureCollaborationAuthority();
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await collaborationJson<RunResponse>(`/api/collaboration/runs/${encodeURIComponent(attempt)}`, { cache: "no-store" });
      if (!alive.current || !currentAuthority()) return;
      sessionStorage.removeItem(storageKey);
      if (alive.current) { setAttempt(null); onAccepted(result.run); }
    } catch (cause) { if (alive.current && currentAuthority()) setError(`${errorText(cause)} · ${t("尚不能证明未受理；保留原身份继续只读核对，不重发。", "Absence does not prove nonacceptance; retain the original identity and recheck without resending.")}`); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked || submitting.current || unavailable || !task || !folder || !selectedVersion || !selectedDefinition || !assignmentValid || staleTask || !confirmed) return;
    const id = crypto.randomUUID();
    const definition: RunDefinition = frozenRunDefinition(kind, definitionId, Number(version));
    const parsed = createRunSchema.safeParse({ id, requestId: id, target: { workspaceId, projectId, taskId: task.id, taskRevision: task.revision }, definition, executionSelection: workspaceExecutionSelection(folder), goal, input } satisfies CreateRun);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n")); return; }
    try { sessionStorage.setItem(storageKey, id); } catch { setError(t("原受理身份无法备份，未提交。", "Cannot back up original acceptance identity; nothing submitted.")); return; }
    submitting.current = true; setAttempt(id); setBusy(true); setError(null);
    const currentAuthority = captureCollaborationAuthority();
    try {
      const result = await collaborationJson<RunResponse>("/api/collaboration/runs", { method: "POST", body: JSON.stringify(parsed.data) });
      if (!alive.current || !currentAuthority()) return;
      sessionStorage.removeItem(storageKey);
      if (alive.current) { setAttempt(null); onAccepted(result.run); }
    } catch (cause) {
      if (!alive.current || !currentAuthority()) return;
      if (cause instanceof WorkspaceClientError && [400, 404, 409, 422].includes(cause.status)) { sessionStorage.removeItem(storageKey); setAttempt(null); }
      setError(errorText(cause));
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  };
  return <form className={`${styles.form} ${styles.panel}`} onSubmit={event => void submit(event)}>
    <WorkspaceScope workspaceId={workspaceId} projectId={projectId} disabled={locked} onChange={(id, project) => { if (id !== workspaceId) { setError(t("跨工作区请先关闭向导并从面板明确选择，原输入保留。", "For another workspace, close the wizard and explicitly choose it on the board; this input is retained.")); return; } setProjectId(project); setTask(null); setQuery(""); setCursor(""); setConfirmed(false); }} />
    <Field label={t("搜索真实 Issue（服务端分页）", "Search real Issues (server paginated)")}><Input type="search" value={query} disabled={locked || !projectId} onChange={event => { setQuery(event.target.value); setCursor(""); }} /></Field><ReadNotice resource={issues} />
    <Field label={t("明确选择 Issue 与读取时 revision", "Explicitly select an Issue and observed revision")}><RadixSelect value={task?.id ?? ""} disabled={locked || !!issues.error || !issues.data} onChange={event => { setTask(issues.data?.items.find(item => item.id === event.target.value) ?? null); setConfirmed(false); }}><option value="">{t("选择 Issue", "Choose an Issue")}</option>{task && !issues.data?.items.some(item => item.id === task.id) && <option value={task.id}>{task.title} · {task.id}</option>}{issues.data?.items.filter(item => item.projectId === projectId).map(item => <option value={item.id} key={item.id}>{item.title} · {item.id} · {item.status}</option>)}</RadixSelect></Field>
    <div className={styles.actions}>{cursor && <Button type="button" variant="ghost" disabled={locked} onClick={() => setCursor("")}>{t("回到第一页", "First page")}</Button>}{issues.data?.nextCursor && <Button type="button" variant="outline" disabled={locked || issues.loading} onClick={() => setCursor(issues.data!.nextCursor!)}>{t("下一页 Issue", "Next Issue page")}</Button>}</div>{task && <p className={styles.hint}>{task.id} · revision {task.revision}{issues.data?.items.some(item => item.id === task.id && item.revision !== task.revision) && <strong role="alert">{t(" · 当前 revision 已变化，请显式重新选择", " · revision changed; explicitly select again")}</strong>}</p>}
    <div className={styles.grid}><Field label={t("执行配置类型", "Definition type")}><RadixSelect value={kind} disabled={locked} onChange={event => { setKind(event.target.value as "agent" | "team"); setDefinitionId(""); setVersion(""); setConfirmed(false); }}><option value="agent">Agent</option><option value="team">Team</option></RadixSelect></Field><Field label="Agent / Team"><RadixSelect value={definitionId} disabled={locked || !!agents.error || !!teams.error} onChange={event => { setDefinitionId(event.target.value); setVersion(""); setConfirmed(false); }}><option value="">{t("明确选择已启用配置", "Choose an active definition")}</option>{definitionRows?.filter(item => item.state === "active").map(item => <option key={item.id} value={item.id}>{item.config.name} · {item.id}</option>)}</RadixSelect></Field><Field label={t("固定版本", "Frozen version")}><RadixSelect value={version} disabled={locked || !!detail.error || !detail.data} onChange={event => { setVersion(event.target.value); setConfirmed(false); }}><option value="">{t("明确选择版本", "Choose a version")}</option>{versions.map(item => <option value={item.version} key={item.version}>v{item.version} · {item.createdAt}</option>)}</RadixSelect></Field><Field label={t("实际服务器代码目录（不是 PM 项目）", "Real server code folder (not the PM project)")}><RadixSelect value={folderId} disabled={locked || !!folders.error} onChange={event => { setFolderId(event.target.value); setConfirmed(false); }}><option value="">{t("明确选择已登记目录", "Choose a registered folder")}</option>{folders.data?.workspaces.filter(item => item.archivedAt === null && item.status === "available").map(item => <option key={item.id} value={item.id}>{item.name} · {item.path}</option>)}</RadixSelect></Field></div>
    <div className={styles.actions}><Link to={`/agent/${kind === "agent" ? "agents" : "teams"}?${new URLSearchParams({ workspaceId, ...(definitionId ? { id: definitionId } : {}) })}`}>{t("管理 Agent / Team 配置", "Manage Agent / Team")}</Link><Link to="/agent/workspace">{t("在 Chat 登记或核对目录", "Register or inspect folders in Chat")}</Link></div>
    <ReadNotice resource={agents} /><ReadNotice resource={teams} /><ReadNotice resource={detail} /><ReadNotice resource={folders} /><ReadNotice resource={capabilities} />{capabilities.data && !capabilities.error && <CapabilityFacts manifest={capabilities.data.manifest} />}{selectedVersion && <details><summary>{t("本次固定的配置", "Configuration frozen for this Run")}</summary><pre>{JSON.stringify(selectedVersion.config, null, 2)}</pre></details>}
    {selectedVersion && "teamId" in selectedVersion && <section className={styles.form}><h3>{t("逐成员真实能力兼容性", "Actual per-member capability compatibility")}</h3>{selectedVersion.config.members.map(member => <MemberCapability key={member.agentId} workspaceId={workspaceId} projectId={projectId} agentId={member.agentId} agentVersion={member.agentVersion} />)}</section>}
    <Field label={t("本次目标", "Goal for this execution")}><Textarea required rows={4} maxLength={16000} value={goal} disabled={locked} onChange={event => { setGoal(event.target.value); setConfirmed(false); }} /></Field><Field label={t("补充输入（不是 Issue 权威正文）", "Additional input (not authoritative Issue text)")}><Textarea rows={4} maxLength={48000} value={input} disabled={locked} onChange={event => { setInput(event.target.value); setConfirmed(false); }} /></Field>
    <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} /><span>{t("确认以上 Issue/revision、固定配置版本与真实目录；受理可能执行工具，且不会自动完成 Issue。", "Confirm the Issue/revision, fixed definition version and real folder. Acceptance may execute tools; it never auto-completes the Issue.")}</span></label>
    {selectedVersion && !assignmentValid && <p className={styles.error} role="alert">{t("该固定版本未分配到当前项目，不能启动。请显式发布或选择已分配版本。", "This frozen version is not assigned to the project. Explicitly publish or choose an assigned version.")}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}{attempt && <p className={styles.notice}>{t("原受理身份已保留，结果未确认时不重新派发：", "Original acceptance identity retained. No redispatch while unresolved: ")}{attempt}</p>}<div className={styles.actions}><Button type="submit" disabled={locked || unavailable || !task || !folder || !selectedVersion || !assignmentValid || staleTask || !confirmed || !goal.trim()}>{busy ? t("处理中…", "Working…") : t("明确提交并启动", "Submit and launch explicitly")}</Button>{attempt && <Button type="button" variant="outline" disabled={busy} onClick={() => void reconcile()}>{t("只读核对原受理结果", "Read original acceptance result")}</Button>}</div>
  </form>;
}

function MemberCapability({ workspaceId, projectId, agentId, agentVersion }: { workspaceId: string; projectId: string; agentId: string; agentVersion: number }) {
  const facts = useCollaborationResource<CapabilitiesResponse>(collaborationPath("capabilities", workspaceId, { agentId, agentVersion: String(agentVersion), ...(projectId ? { projectId } : {}) }));
  return <details><summary>Agent {agentId} · v{agentVersion}</summary><ReadNotice resource={facts} />{facts.data && !facts.error && <CapabilityFacts manifest={facts.data.manifest} />}</details>;
}
