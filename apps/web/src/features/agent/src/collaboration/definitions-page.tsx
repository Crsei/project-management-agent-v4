import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  agentConfigSchema, teamConfigSchema, defaultCollaborationResourceLimits,
  type AgentConfig, type AgentDefinition, type AgentDetailResponse, type AgentVersion, type AgentsResponse,
  type TeamConfig, type TeamDefinition, type TeamDetailResponse, type TeamVersion, type TeamsResponse,
} from "@agent-workspace/contracts/collaboration";
import type { ProvidersResponse } from "@agent-workspace/contracts/provider";
import type { PmWorkspaceDiscovery } from "@agent-workspace/contracts/pm-tools";
import { getProviderInstanceDisplayName } from "@agent-workspace/client-runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadixSelect } from "@/components/ui/radix-select";
import { ModelOptionControls, modelOptionsValid, visibleProviderModels } from "../settings/model-option-controls";
import { useAutomationLeaveProtection } from "../pm/automation/leave-protection";
import { useAgentText } from "../i18n";
import { collaborationPath, useCollaborationResource, useCollaborationState } from "./data";
import { useDefinitionWriter } from "./definition-writer";
import { CapabilityBindings } from "./capabilities";
import { CollaborationFrame, Field, ReadNotice, ResourceLimitsFields, WorkspaceScope } from "./ui";
import styles from "./collaboration.module.css";

type Definition = AgentDefinition | TeamDefinition;
const EditorLeaveGuard = createContext<MutableRefObject<boolean> | null>(null);
const freshAgent = (): AgentConfig => ({ name: "", role: "", instructions: "", providerInstanceId: "", model: "", modelOptions: [], interactionMode: "default", temperature: 0.7, owner: { label: "", actorId: null }, allowedProjectIds: [], capabilityBindings: { restriction: "observe", mcp: [], skills: [], hostTools: [] }, resourceLimits: { ...defaultCollaborationResourceLimits }, executionMode: "write" });
const freshTeam = (): TeamConfig => ({ name: "", description: "", members: [], strategy: "sequential", supervisorAgentId: null, allowedProjectIds: [], resourceLimits: { ...defaultCollaborationResourceLimits } });

export default function DefinitionsPage({ kind }: { kind: "agent" | "team" }) {
  const t = useAgentText();
  const [params, setParams] = useSearchParams();
  const workspaceId = params.get("workspaceId") ?? "";
  const selectedId = params.get("id");
  const [lastSaved, setLastSaved] = useCollaborationState<Definition | null>(null, null);
  const [showArchived, setShowArchived] = useState(false);
  const leaveGuard = useRef(false);
  const list = useCollaborationResource<AgentsResponse | TeamsResponse>(collaborationPath(kind === "agent" ? "agents" : "teams", workspaceId));
  const items: Definition[] = list.data ? "agents" in list.data ? list.data.agents : list.data.teams : [];
  const selected = items.find(item => item.id === selectedId) ?? (lastSaved?.id === selectedId && lastSaved.workspaceId === workspaceId && !list.error ? lastSaved : null);
  const select = (id: string | null) => {
    if (id !== selectedId && leaveGuard.current && !window.confirm(t("配置草稿或原请求尚未保存，确认切换？", "Unsaved configuration or unresolved request. Switch?"))) return;
    const next = new URLSearchParams(params); if (id) next.set("id", id); else next.delete("id"); setParams(next);
  };
  useEffect(() => { setLastSaved(null); }, [workspaceId, kind]);
  const saved = (item: Definition) => { leaveGuard.current = false; setLastSaved(item); select(item.id); void list.refresh(); };
  return <EditorLeaveGuard.Provider value={leaveGuard}><CollaborationFrame title={kind === "agent" ? t("Agents · 可复用执行身份", "Agents · reusable execution identities") : t("Teams · 固定成员版本协作", "Teams · fixed-version collaboration")} description={t("配置不是授权。保存发布不可变版本；停用只禁止新派发，不停止在途执行。", "Configuration is not authorization. Saving publishes an immutable version. Disabling prevents new launches, not active execution.")} actions={<Button disabled={!workspaceId || !!list.error || !list.data} onClick={() => select("new")}>{kind === "agent" ? t("创建 Agent", "Create Agent") : t("创建 Team", "Create Team")}</Button>}>
    <WorkspaceScope workspaceId={workspaceId} projects={false} onChange={id => { if (leaveGuard.current && !window.confirm(t("离开此工作区的配置草稿？", "Leave this workspace configuration draft?"))) return; const next = new URLSearchParams(); if (id) next.set("workspaceId", id); setParams(next); }} />
    <ReadNotice resource={list} />
    {workspaceId && <><label className={styles.check}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />{t("包含归档配置", "Include archived definitions")}</label><div className={styles.columns}>
      <aside className={styles.list} aria-label={kind === "agent" ? "Agents" : "Teams"}>{items.filter(item => showArchived || item.state !== "archived").map(item => <button type="button" key={item.id} className={styles.row} aria-pressed={item.id === selectedId} onClick={() => select(item.id)}><strong>{item.config.name}</strong><small>{item.state} · v{item.currentVersion} · r{item.revision}</small><small>{item.id}</small></button>)}{list.data && !items.length && <p className={styles.hint}>{t("没有配置；不会生成演示身份。", "No definitions. No demo identities are generated.")}</p>}</aside>
      {selectedId === "new" || selected ? kind === "agent" ? <AgentEditor key={`${workspaceId}:${selectedId}`} workspaceId={workspaceId} source={selected as AgentDefinition | null} unavailable={!!list.error || !list.data} onSaved={saved} /> : <TeamEditor key={`${workspaceId}:${selectedId}`} workspaceId={workspaceId} source={selected as TeamDefinition | null} unavailable={!!list.error || !list.data} onSaved={saved} /> : <section className={styles.panel}><p>{selectedId ? t("配置不存在或当前不可访问。", "Definition missing or inaccessible.") : t("选择已有配置或明确创建。", "Select a definition or explicitly create one.")}</p></section>}
    </div></>}
  </CollaborationFrame></EditorLeaveGuard.Provider>;
}

function ProjectReferences({ workspaceId, value, onChange, disabled }: { workspaceId: string; value: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const t = useAgentText();
  const catalog = useCollaborationResource<PmWorkspaceDiscovery>("/api/pm-tools/workspaces");
  const projects = catalog.data?.workspaces.find(item => item.id === workspaceId)?.projects ?? [];
  return <fieldset><legend>{t("项目引用上限（不是权限）", "Project reference ceiling (not permission)")}</legend><p className={styles.hint}>{t("未选择 = 未分配项目，不能启动业务 Run。显式分配项目仍不会授予 PM 权限；复制配置必须重新分配。", "Empty = unassigned: business Runs cannot start. Explicit assignments still grant no PM permission; copies must be reassigned.")}</p><ReadNotice resource={catalog} /><div className={styles.actions}>{projects.map(project => <label className={styles.check} key={project.id}><input type="checkbox" disabled={disabled || !!catalog.error} checked={value.includes(project.id)} onChange={event => onChange(event.target.checked ? [...value, project.id] : value.filter(id => id !== project.id))} />{project.name} · {project.id}</label>)}{value.filter(id => !projects.some(project => project.id === id)).map(id => <label className={styles.check} key={id}><input type="checkbox" checked disabled={disabled} onChange={() => onChange(value.filter(item => item !== id))} />{id} · {t("当前不可访问，取消以移除", "Unavailable; uncheck to remove")}</label>)}</div></fieldset>;
}

function AgentEditor({ workspaceId, source, unavailable, onSaved }: { workspaceId: string; source: AgentDefinition | null; unavailable: boolean; onSaved: (item: Definition) => void }) {
  const t = useAgentText();
  const [baseline, setBaseline] = useCollaborationState(source, null);
  const [draft, setDraft] = useCollaborationState<AgentConfig>(() => source?.config ?? freshAgent(), freshAgent);
  const [formError, setFormError] = useCollaborationState<string | null>(null, null);
  const [capabilityProjectId, setCapabilityProjectId] = useCollaborationState("", "");
  const providers = useCollaborationResource<ProvidersResponse>("/api/providers");
  const details = useCollaborationResource<AgentDetailResponse>(source ? `/api/collaboration/agents/${encodeURIComponent(source.id)}` : null);
  const writer = useDefinitionWriter("agent", workspaceId, source?.id ?? "new", item => { const agent = item as AgentDefinition; setBaseline(agent); setDraft(agent.config); onSaved(agent); void details.refresh(); });
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline?.config ?? freshAgent());
  const leaveGuard = useContext(EditorLeaveGuard);
  useEffect(() => { if (leaveGuard) leaveGuard.current = dirty || writer.locked; return () => { if (leaveGuard) leaveGuard.current = false; }; }, [leaveGuard, dirty, writer.locked]);
  useAutomationLeaveProtection(dirty || writer.locked, t("配置草稿或原请求待核对。确认离开？不会停止后台执行。", "Unsaved configuration or unresolved request. Leave? Background execution will not stop."));
  const provider = providers.data?.providers.find(item => item.instanceId === draft.providerInstanceId);
  const model = provider?.models.find(item => item.id === draft.model);
  const remote = details.data?.agent ?? source;
  const conflict = !!baseline && !!remote && remote.revision !== baseline.revision;
  const locked = writer.locked || unavailable || !!details.error || conflict;
  const patch = (next: Partial<AgentConfig>) => setDraft(current => ({ ...current, ...next }));
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (locked) return;
    const parsed = agentConfigSchema.safeParse(draft);
    if (!parsed.success) { setFormError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n")); return; }
    if (!provider || !model || !modelOptionsValid(model, draft.modelOptions)) { setFormError(t("请从真实目录明确选择有效 Provider、模型和选项。", "Choose a valid Provider, model and options from the real catalog.")); return; }
    setFormError(null);
    void writer.write(baseline ? `/api/collaboration/agents/${encodeURIComponent(baseline.id)}` : "/api/collaboration/agents", baseline ? "PUT" : "POST", baseline ? { revision: baseline.revision, config: parsed.data } : { id: crypto.randomUUID(), workspaceId, config: parsed.data });
  };
  return <section className={styles.panel}><form className={styles.form} onSubmit={submit}>
    <header className={styles.heading}><h2>{baseline ? baseline.config.name : t("新 Agent", "New Agent")}</h2>{baseline && <span className={styles.status}>{baseline.state} · v{baseline.currentVersion} · r{baseline.revision}</span>}</header>
    <ReadNotice resource={providers} /><ReadNotice resource={details} />
    {conflict && <div className={styles.notice} role="alert">{t("服务端版本已变化；你的草稿未被覆盖。比较后显式载入当前版本。", "The server revision changed; your draft is preserved. Compare, then explicitly load the current version.")}<details><summary>{t("当前配置", "Current configuration")}</summary><pre>{JSON.stringify(remote?.config, null, 2)}</pre></details><Button type="button" variant="outline" disabled={writer.locked} onClick={() => { if (remote && window.confirm(t("放弃此配置草稿并载入当前版本？", "Discard this draft and load current version?"))) { setBaseline(remote); setDraft(remote.config); } }}>{t("载入当前版本", "Load current version")}</Button></div>}
    <div className={styles.grid}><Field label={t("名称", "Name")}><Input required maxLength={200} disabled={locked} value={draft.name} onChange={event => patch({ name: event.target.value })} /></Field><Field label={t("角色", "Role")}><Input required maxLength={200} disabled={locked} value={draft.role} onChange={event => patch({ role: event.target.value })} /></Field><Field label={t("负责人显示名称（元数据）", "Owner label (metadata)")}><Input maxLength={200} disabled={locked} value={draft.owner.label} onChange={event => patch({ owner: { ...draft.owner, label: event.target.value } })} /></Field><Field label={t("负责人 actor UUID（可空，不授予权限）", "Owner actor UUID (optional; grants nothing)")}><Input disabled={locked} value={draft.owner.actorId ?? ""} onChange={event => patch({ owner: { ...draft.owner, actorId: event.target.value || null } })} /></Field><Field label="Provider"><RadixSelect required disabled={locked || !!providers.error} value={draft.providerInstanceId} onChange={event => patch({ providerInstanceId: event.target.value, model: "", modelOptions: [] })}><option value="">{t("明确选择执行器", "Choose an executor")}</option>{draft.providerInstanceId && !provider && <option value={draft.providerInstanceId}>{draft.providerInstanceId} · unavailable</option>}{providers.data?.providers.map(item => <option key={item.instanceId} value={item.instanceId}>{getProviderInstanceDisplayName(item)}{!item.enabled || !item.nativeSessionReady ? t(" · 当前未就绪", " · not ready") : ""}</option>)}</RadixSelect></Field><Field label={t("模型", "Model")}><RadixSelect required disabled={locked || !provider || !!providers.error} value={draft.model} onChange={event => patch({ model: event.target.value, modelOptions: [] })}><option value="">{t("明确选择模型", "Choose a model")}</option>{draft.model && !model && <option value={draft.model}>{draft.model} · unavailable</option>}{provider && visibleProviderModels(provider).map(item => <option value={item.id} key={item.id}>{item.label} · {item.id}</option>)}</RadixSelect></Field><Field label={t("交互模式", "Interaction mode")}><RadixSelect disabled={locked} value={draft.interactionMode} onChange={event => patch({ interactionMode: event.target.value as AgentConfig["interactionMode"] })}><option value="default">Default</option><option value="plan">Plan</option></RadixSelect></Field><Field label={t("执行权限限制", "Execution restriction")}><RadixSelect disabled={locked} value={draft.executionMode} onChange={event => patch({ executionMode: event.target.value as AgentConfig["executionMode"] })}><option value="write">{t("允许写执行（仍需当前权限）", "Write execution (current authority required)")}</option><option value="read-only">{t("只读（不支持强制限制的执行器会拒绝）", "Read-only (unsupported executors reject)")}</option></RadixSelect></Field><Field label={t("温度", "Temperature")}><Input type="number" min={0} max={2} step={0.1} disabled={locked} value={draft.temperature} onChange={event => patch({ temperature: Number(event.target.value) })} /></Field><Field label={t("Instructions", "Instructions")} full><Textarea rows={8} maxLength={16000} disabled={locked} value={draft.instructions} onChange={event => patch({ instructions: event.target.value })} /></Field></div>
    <ModelOptionControls model={model} selections={draft.modelOptions} disabled={locked} onChange={modelOptions => patch({ modelOptions })} />
    <ProjectReferences workspaceId={workspaceId} value={draft.allowedProjectIds} disabled={locked} onChange={allowedProjectIds => patch({ allowedProjectIds })} />
    <ResourceLimitsFields value={draft.resourceLimits} onChange={resourceLimits => patch({ resourceLimits })} disabled={locked} />
    <Field label={t("明确选择项目私有能力盘点范围（不创建管理 context）", "Explicit project-private inventory scope (creates no management context)")}><RadixSelect value={capabilityProjectId} disabled={locked} onChange={event => setCapabilityProjectId(event.target.value)}><option value="">{t("仅原生能力 / 不选项目", "Native capabilities / no project")}</option>{draft.allowedProjectIds.map(id => <option key={id} value={id}>{id}</option>)}</RadixSelect></Field>
    <CapabilityBindings workspaceId={workspaceId} providerInstanceId={draft.providerInstanceId} projectId={draft.allowedProjectIds.includes(capabilityProjectId) ? capabilityProjectId : ""} value={draft.capabilityBindings} onChange={capabilityBindings => patch({ capabilityBindings })} disabled={locked} />
    {(formError || writer.error) && <p className={styles.error} role="alert">{formError || writer.error}</p>}
    <div className={styles.actions}><Button type="submit" disabled={locked || !!providers.error}>{writer.busy ? t("保存中…", "Saving…") : t("保存并发布新版本", "Save and publish version")}</Button>{writer.attempt && <Button type="button" variant="outline" disabled={writer.busy} onClick={() => void writer.reconcile()}>{t("核对原保存请求", "Reconcile original save")}</Button>}</div>
    {writer.attempt && <p className={styles.hint}>{t("结果待核对，不自动重发。原请求：", "Outcome unresolved; no automatic replay. Original request: ")}{writer.attempt}</p>}
  </form>{baseline && <DefinitionActions kind="agent" item={baseline} versions={details.data?.versions ?? []} locked={locked || dirty} write={writer.write} />}</section>;
}

function TeamEditor({ workspaceId, source, unavailable, onSaved }: { workspaceId: string; source: TeamDefinition | null; unavailable: boolean; onSaved: (item: Definition) => void }) {
  const t = useAgentText();
  const [baseline, setBaseline] = useCollaborationState(source, null);
  const [draft, setDraft] = useCollaborationState<TeamConfig>(() => source?.config ?? freshTeam(), freshTeam);
  const [formError, setFormError] = useCollaborationState<string | null>(null, null);
  const agents = useCollaborationResource<AgentsResponse>(collaborationPath("agents", workspaceId));
  const details = useCollaborationResource<TeamDetailResponse>(source ? `/api/collaboration/teams/${encodeURIComponent(source.id)}` : null);
  const writer = useDefinitionWriter("team", workspaceId, source?.id ?? "new", item => { const team = item as TeamDefinition; setBaseline(team); setDraft(team.config); onSaved(team); void details.refresh(); });
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline?.config ?? freshTeam());
  const leaveGuard = useContext(EditorLeaveGuard);
  useEffect(() => { if (leaveGuard) leaveGuard.current = dirty || writer.locked; return () => { if (leaveGuard) leaveGuard.current = false; }; }, [leaveGuard, dirty, writer.locked]);
  useAutomationLeaveProtection(dirty || writer.locked, t("Team 草稿或原请求待核对，确认离开？", "Unsaved Team or unresolved request. Leave?"));
  const remote = details.data?.team ?? source;
  const conflict = !!baseline && !!remote && remote.revision !== baseline.revision;
  const locked = writer.locked || unavailable || !!details.error || conflict;
  const patch = (next: Partial<TeamConfig>) => setDraft(current => ({ ...current, ...next }));
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (locked) return;
    const parsed = teamConfigSchema.safeParse(draft);
    if (!parsed.success) { setFormError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n")); return; }
    setFormError(null);
    void writer.write(baseline ? `/api/collaboration/teams/${encodeURIComponent(baseline.id)}` : "/api/collaboration/teams", baseline ? "PUT" : "POST", baseline ? { revision: baseline.revision, config: parsed.data } : { id: crypto.randomUUID(), workspaceId, config: parsed.data });
  };
  return <section className={styles.panel}><form className={styles.form} onSubmit={submit}><header className={styles.heading}><h2>{baseline ? baseline.config.name : t("新 Team", "New Team")}</h2>{baseline && <span>{baseline.state} · v{baseline.currentVersion} · r{baseline.revision}</span>}</header><ReadNotice resource={agents} /><ReadNotice resource={details} />{conflict && <div className={styles.notice} role="alert">{t("配置已被其他保存更改，草稿保留。", "Definition changed elsewhere; your draft is preserved.")}<details><summary>{t("当前配置", "Current configuration")}</summary><pre>{JSON.stringify(remote?.config, null, 2)}</pre></details><Button type="button" variant="outline" disabled={writer.locked} onClick={() => { if (remote && window.confirm(t("放弃草稿并载入当前版本？", "Discard draft and load current version?"))) { setBaseline(remote); setDraft(remote.config); } }}>{t("载入当前版本", "Load current version")}</Button></div>}
    <Field label={t("名称", "Name")}><Input required maxLength={200} value={draft.name} disabled={locked} onChange={event => patch({ name: event.target.value })} /></Field><Field label={t("说明", "Description")}><Textarea rows={4} maxLength={16000} value={draft.description} disabled={locked} onChange={event => patch({ description: event.target.value })} /></Field><Field label={t("协作策略", "Strategy")}><RadixSelect value={draft.strategy} disabled={locked} onChange={event => patch({ strategy: event.target.value as TeamConfig["strategy"], supervisorAgentId: null })}><option value="sequential">Sequential · {t("按成员顺序实际执行并交接结果", "execute in member order with result handoff")}</option><option value="supervisor">Supervisor · {t("有界真实宿主委派", "bounded real host-tool delegation")}</option></RadixSelect></Field>
    <fieldset><legend>{t("有序成员与不可变 Agent 版本", "Ordered members and immutable Agent versions")}</legend><div className={styles.list}>{draft.members.map((member, index) => <TeamMemberRow key={member.agentId} workspaceId={workspaceId} agentId={member.agentId} version={member.agentVersion} index={index} count={draft.members.length} disabled={locked} onVersion={agentVersion => patch({ members: draft.members.map((item, position) => position === index ? { ...item, agentVersion } : item) })} onMove={offset => { const members = [...draft.members]; const swap = members[index + offset]; if (swap) { members[index + offset] = member; members[index] = swap; patch({ members }); } }} onRemove={() => patch({ members: draft.members.filter(item => item.agentId !== member.agentId), supervisorAgentId: draft.supervisorAgentId === member.agentId ? null : draft.supervisorAgentId })} />)}</div><RadixSelect aria-label={t("添加成员", "Add member")} value="" disabled={locked || !!agents.error || draft.members.length >= 12} onChange={event => { const agent = agents.data?.agents.find(item => item.id === event.target.value); if (agent) patch({ members: [...draft.members, { agentId: agent.id, agentVersion: agent.currentVersion }] }); }}><option value="">{t("明确添加 Agent 成员", "Add an Agent member")}</option>{agents.data?.agents.filter(agent => agent.state === "active" && !draft.members.some(member => member.agentId === agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.config.name} · v{agent.currentVersion}</option>)}</RadixSelect></fieldset>
    {draft.strategy === "supervisor" && <Field label={t("Supervisor（必须是成员，且执行器支持真实宿主工具）", "Supervisor (member with real host-tool support)")}><RadixSelect required value={draft.supervisorAgentId ?? ""} disabled={locked} onChange={event => patch({ supervisorAgentId: event.target.value || null })}><option value="">{t("明确指定 Supervisor", "Choose a supervisor")}</option>{draft.members.map(member => <option key={member.agentId} value={member.agentId}>{agents.data?.agents.find(agent => agent.id === member.agentId)?.config.name ?? member.agentId} · v{member.agentVersion}</option>)}</RadixSelect></Field>}
    <ProjectReferences workspaceId={workspaceId} value={draft.allowedProjectIds} disabled={locked} onChange={allowedProjectIds => patch({ allowedProjectIds })} /><ResourceLimitsFields value={draft.resourceLimits} disabled={locked} onChange={resourceLimits => patch({ resourceLimits })} />{(formError || writer.error) && <p role="alert" className={styles.error}>{formError || writer.error}</p>}<div className={styles.actions}><Button type="submit" disabled={locked || !!agents.error}>{writer.busy ? t("保存中…", "Saving…") : t("保存并发布 Team 版本", "Save and publish Team version")}</Button>{writer.attempt && <Button type="button" variant="outline" disabled={writer.busy} onClick={() => void writer.reconcile()}>{t("核对原保存请求", "Reconcile original save")}</Button>}</div>{writer.attempt && <p className={styles.hint}>{t("原请求结果待核对，不自动重发：", "Original request unresolved; no replay: ")}{writer.attempt}</p>}
  </form>{baseline && <DefinitionActions kind="team" item={baseline} versions={details.data?.versions ?? []} locked={locked || dirty} write={writer.write} />}</section>;
}

function TeamMemberRow({ workspaceId: _workspaceId, agentId, version, index, count, disabled, onVersion, onMove, onRemove }: { workspaceId: string; agentId: string; version: number; index: number; count: number; disabled: boolean; onVersion: (version: number) => void; onMove: (offset: number) => void; onRemove: () => void }) {
  const t = useAgentText();
  const detail = useCollaborationResource<AgentDetailResponse>(`/api/collaboration/agents/${encodeURIComponent(agentId)}`);
  return <div className={styles.row}><strong>{index + 1}. {detail.data?.agent.config.name ?? agentId}</strong><ReadNotice resource={detail} /><div className={styles.actions}><RadixSelect aria-label={t("成员版本", "Member version")} disabled={disabled || !!detail.error || !detail.data} value={String(version)} onChange={event => onVersion(Number(event.target.value))}>{!detail.data?.versions.some(item => item.version === version) && <option value={version}>v{version} · unverified</option>}{detail.data?.versions.map(item => <option key={item.version} value={item.version}>v{item.version} · {item.config.role} · {item.config.providerInstanceId}</option>)}</RadixSelect><Button type="button" variant="ghost" disabled={disabled || index === 0} onClick={() => onMove(-1)}>{t("上移", "Move up")}</Button><Button type="button" variant="ghost" disabled={disabled || index === count - 1} onClick={() => onMove(1)}>{t("下移", "Move down")}</Button><Button type="button" variant="ghost" disabled={disabled} onClick={onRemove}>{t("移除", "Remove")}</Button></div><Link to={`/agent/agents?${new URLSearchParams({ workspaceId: detail.data?.agent.workspaceId ?? _workspaceId, id: agentId })}`}>{t("查看配置与能力支持", "Inspect configuration and capabilities")}</Link></div>;
}

function DefinitionActions({ kind, item, versions, locked, write }: { kind: "agent" | "team"; item: Definition; versions: (AgentVersion | TeamVersion)[]; locked: boolean; write: (path: string, method: string, body: Record<string, unknown>) => Promise<void> }) {
  const t = useAgentText();
  const [version, setVersion] = useCollaborationState("", "");
  const base = `/api/collaboration/${kind === "agent" ? "agents" : "teams"}/${encodeURIComponent(item.id)}`;
  const chosen = versions.find(row => row.version === Number(version));
  return <div className={styles.form}><hr /><div className={styles.actions}><Button type="button" variant="outline" disabled={locked} onClick={() => { const name = window.prompt(t("复制配置的名称（不复制授权、凭据或执行）", "Copy name (no grants, credentials or executions)"), `${item.config.name} copy`); if (name?.trim()) void write(`${base}/copy`, "POST", { id: crypto.randomUUID(), revision: item.revision, name: name.trim() }); }}>{t("复制配置", "Copy configuration")}</Button><Button type="button" variant="outline" disabled={locked} onClick={() => { const state = item.state === "active" ? "disabled" : "active"; if (window.confirm(state === "disabled" ? t("停用只阻止新派发，不停止在途 Run。继续？", "Disable new launches only; active Runs continue. Proceed?") : t("恢复此配置为 active？当前权限仍需重新核验。", "Activate this definition? Current authority will still be rechecked."))) void write(base, "PUT", { revision: item.revision, state }); }}>{item.state === "active" ? t("停用", "Disable") : t("启用 / 恢复", "Activate / restore")}</Button>{item.state !== "archived" && <Button type="button" variant="outline" disabled={locked} onClick={() => { if (window.confirm(t("归档配置并保留版本和执行证据？不会停止已有 Run。", "Archive while retaining versions and execution evidence? Existing Runs are not stopped."))) void write(base, "PUT", { revision: item.revision, state: "archived" }); }}>{t("归档（保留历史）", "Archive (retain history)")}</Button>}</div><Field label={t("不可变版本历史", "Immutable version history")}><RadixSelect value={version} onChange={event => setVersion(event.target.value)}><option value="">{t("选择历史版本", "Select a historical version")}</option>{versions.map(row => <option key={row.version} value={row.version}>v{row.version} · {row.createdAt}{row.restoredFromVersion ? ` · restored from v${row.restoredFromVersion}` : ""}</option>)}</RadixSelect></Field>{chosen && <><pre>{JSON.stringify(chosen.config, null, 2)}</pre><Button type="button" variant="outline" disabled={locked} onClick={() => { if (window.confirm(t(`将 v${chosen.version} 配置发布为新的版本？不会重写历史。`, `Publish v${chosen.version} as a new version? History will not be rewritten.`))) void write(`${base}/restore-version`, "POST", { revision: item.revision, version: chosen.version }); }}>{t("从此版本发布新版本", "Publish a new version from this version")}</Button></>}<p className={styles.hint}>{t("删除采用可见归档；版本和执行证据不销毁。配置变更不会污染原 Run 的固定快照。", "Removal uses visible archiving; versions and evidence are retained. Changes never rewrite existing Run snapshots.")}</p></div>;
}
