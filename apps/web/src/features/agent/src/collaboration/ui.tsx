import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import type { PmWorkspaceDiscovery } from "@agent-workspace/contracts/pm-tools";
import type { CollaborationRunStatus } from "@agent-workspace/contracts/collaboration";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadixSelect } from "@/components/ui/radix-select";
import { PmServiceProvider, usePmService } from "@/features/pm/service/pm-service";
import { useAgentText, type AgentText } from "../i18n";
import { invalidateCollaborationAccess, useCollaborationResource } from "./data";
import styles from "./collaboration.module.css";

export function CollaborationNav() {
  const t = useAgentText();
  const [params] = useSearchParams();
  const scope = new URLSearchParams();
  if (params.get("workspaceId")) scope.set("workspaceId", params.get("workspaceId")!);
  if (params.get("projectId")) scope.set("projectId", params.get("projectId")!);
  const suffix = scope.size ? `?${scope}` : "";
  return <nav className={styles.nav} aria-label={t("Agent 导航", "Agent navigation")}><strong>Agent</strong><NavLink to="/agent/runs">{t("运行面板", "Run board")}</NavLink><NavLink to={`/agent/agents${suffix}`}>Agents</NavLink><NavLink to={`/agent/teams${suffix}`}>Teams</NavLink><NavLink to={`/agent/inbox${suffix}`}>{t("需要处理", "Inbox")}</NavLink><NavLink to="/agent/workspace">Chat</NavLink><NavLink to="/pm">PM</NavLink><NavLink to="/agent/settings/providers">{t("执行器设置", "Providers")}</NavLink></nav>;
}
type CollaborationFrameProps = { title: string; description: string; actions?: ReactNode; children: ReactNode; runBoard?: boolean; dock?: ReactNode };
export function CollaborationFrame(props: CollaborationFrameProps) {
  return <PmServiceProvider><CollaborationSessionFrame {...props} /></PmServiceProvider>;
}
function CollaborationSessionFrame({ title, description, actions, children, runBoard, dock }: CollaborationFrameProps) {
  const t = useAgentText();
  const { actor, actorEpoch, loading } = usePmService();
  // Logout/account changes clear copied drafts and reject old in-flight results before paint.
  useLayoutEffect(() => { invalidateCollaborationAccess(); }, [actorEpoch]);
  return <div className={`${styles.root} ${runBoard ? styles.boardRoot : ""}`}>{!runBoard && <CollaborationNav />}<main className={runBoard ? styles.boardPage : styles.page}><header className={styles.heading}><div><h1>{title}</h1><p className={styles.hint}>{description}</p></div><div className={styles.actions}>{actions}</div></header>
    {!actor && loading && <p className={styles.hint} role="status">{t("正在核对当前 PM 会话…", "Checking the current PM session…")}</p>}
    {!actor && !loading && <p className={styles.hint} role="status">{t("当前页面未取得 PM 身份；下方数据仅按服务端当前授权读取。", "No PM identity is available on this page; data below is read only under current server authorization.")}</p>}
    {children}
  </main>{dock}</div>;
}
export function Field({ label, children, full = false }: { label: string; children: ReactNode; full?: boolean }) {
  return <label className={`${styles.field} ${full ? styles.full : ""}`}><span>{label}</span>{children}</label>;
}
export function ReadNotice({ resource }: { resource: { error: string | null; accessDenied?: boolean; loading: boolean; loadedAt: string | null; refresh: () => Promise<void> } }) {
  const t = useAgentText();
  return <>{resource.loading && !resource.loadedAt && <p role="status">{t("正在读取…", "Loading…")}</p>}{resource.error && <div className={`${styles.notice} ${styles.error}`} role="alert">{resource.loadedAt && t("保留的内容是过期快照，写入已禁用。", "Retained content is stale; writes are disabled. ")}{resource.accessDenied ? t("访问权限不可用，已清除受限内容。请核对当前 PM 会话和所选工作区／项目权限。", "Access is unavailable; restricted content was cleared. Check the current PM session and the selected workspace/project permissions.") : resource.error}<Button variant="outline" size="sm" disabled={resource.loading} onClick={() => void resource.refresh()}>{t("重新读取", "Refresh")}</Button></div>}</>;
}

export function businessRunStatusLabel(status: CollaborationRunStatus, t: AgentText): string {
  switch (status) {
    case "queued": return t("排队中", "Queued");
    case "running": return t("执行中", "Executing");
    case "waiting": return t("等待中", "Waiting");
    case "succeeded": return t("Run 已成功", "Run succeeded");
    case "failed": return t("Run 已失败", "Run failed");
    case "cancelled": return t("Run 已取消", "Run cancelled");
    case "interrupted": return t("执行已中断", "Interrupted");
    case "unknown": return t("结果待核对", "Outcome unknown");
  }
}
export function WorkspaceScope({ workspaceId, projectId, onChange, disabled = false, projects = true, autoSelectSingle = false }: {
  workspaceId: string; projectId?: string; onChange: (workspaceId: string, projectId: string) => void; disabled?: boolean; projects?: boolean; autoSelectSingle?: boolean;
}) {
  const t = useAgentText();
  const { refresh: refreshSession } = usePmService();
  const catalog = useCollaborationResource<PmWorkspaceDiscovery>("/api/pm-tools/workspaces");
  const autoSelected = useRef(false);
  useEffect(() => {
    if (catalog.accessDenied) void refreshSession().catch(() => { /* The PM provider exposes authentication/transport failures without replaying writes. */ });
  }, [catalog.accessDenied, refreshSession]);
  useEffect(() => {
    if (!autoSelectSingle || autoSelected.current || workspaceId || catalog.loading || catalog.error || !catalog.data) return;
    if (catalog.data.workspaces.length !== 1) return;
    autoSelected.current = true;
    onChange(catalog.data.workspaces[0].id, "");
  }, [autoSelectSingle, workspaceId, catalog.loading, catalog.error, catalog.data, onChange]);
  const workspace = catalog.data?.workspaces.find(item => item.id === workspaceId);
  return <><div className={styles.scope}><Field label={t("PM 工作区（不改变代码目录）", "PM workspace (not the code folder)")}><RadixSelect value={workspaceId} disabled={disabled || !!catalog.error || !catalog.data} onChange={event => onChange(event.target.value, "")}><option value="">{t("明确选择授权工作区", "Choose an authorized workspace")}</option>{workspaceId && !workspace && <option value={workspaceId} disabled>{t("尚未核验：", "Not verified: ")}{workspaceId}</option>}{catalog.data?.workspaces.map(item => <option value={item.id} key={item.id}>{item.name} · {item.id}</option>)}</RadixSelect></Field>{projects && <Field label={t("项目", "Project")}><RadixSelect value={projectId ?? ""} disabled={disabled || !workspace || !!catalog.error} onChange={event => onChange(workspaceId, event.target.value)}><option value="">{t("选择项目 / 全部项目", "Choose project / all projects")}</option>{workspace?.projects.map(item => <option value={item.id} key={item.id}>{item.name} · {item.id}</option>)}</RadixSelect></Field>}<Button variant="ghost" disabled={catalog.loading} onClick={() => void catalog.refresh()}>{t("刷新权限与目录", "Refresh authorized sources")}</Button></div><ReadNotice resource={catalog} /></>;
}
export function ResourceLimitsFields({ value, onChange, disabled }: { value: { maxActiveRuns: number; maxDelegationDepth: number; maxRuns: number; maxDurationMs: number; maxOutputBytes: number }; onChange: (next: typeof value) => void; disabled: boolean }) {
  const t = useAgentText();
  const fields = [
    ["maxActiveRuns", t("活跃 Run 上限（1–3）", "Active runs (1–3)"), 1, 3],
    ["maxDelegationDepth", t("委派深度（0–3）", "Delegation depth (0–3)"), 0, 3],
    ["maxRuns", t("整条链 Run 数上限", "Whole-chain run limit"), 1, 100],
    ["maxDurationMs", t("整条链时长上限（毫秒）", "Whole-chain duration (ms)"), 1000, 86400000],
    ["maxOutputBytes", t("输出上限（字节）", "Output limit (bytes)"), 1024, 16777216],
  ] as const;
  return <fieldset><legend>{t("共享执行限额", "Shared execution limits")}</legend><div className={styles.grid}>{fields.map(([key, label, min, max]) => <Field label={label} key={key}><Input type="number" required min={min} max={max} value={value[key]} disabled={disabled} onChange={event => onChange({ ...value, [key]: Number(event.target.value) })} /></Field>)}</div><p className={styles.hint}>{t("子执行不重置限额；费用缺失不记为零。目录和 Instructions 不是安全沙箱。", "Children do not reset limits. Unknown cost is not zero. Directories and instructions are not a sandbox.")}</p></fieldset>;
}
