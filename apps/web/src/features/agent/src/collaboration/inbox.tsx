import { Link, useSearchParams } from "react-router-dom";
import type { InboxResponse } from "@agent-workspace/contracts/collaboration";
import { Button } from "@/components/ui/button";
import { useAgentText } from "../i18n";
import { collaborationPath, safeCollaborationHref, useCollaborationResource } from "./data";
import { CollaborationFrame, ReadNotice, WorkspaceScope } from "./ui";
import styles from "./collaboration.module.css";

export function RunInbox({ workspaceId, projectId, runId }: { workspaceId: string; projectId?: string; runId?: string }) {
  const t = useAgentText();
  const inbox = useCollaborationResource<InboxResponse>(collaborationPath("inbox", workspaceId, { ...(projectId ? { projectId } : {}), ...(runId ? { runId } : {}) }));
  // Persisted native cards are not authority: only the live owner can advertise an answerable request.
  const items = inbox.data?.items.filter(item => item.kind !== "native_input" || item.respondable) ?? [];
  return <section className={styles.form} aria-label={t("当前需要处理", "Current pending actions")}><div className={styles.actions}><h3>{t("需要处理", "Needs attention")}</h3><Button type="button" variant="ghost" size="sm" disabled={inbox.loading} onClick={() => void inbox.refresh()}>{t("核对当前待办", "Refresh live actions")}</Button></div><ReadNotice resource={inbox} />{inbox.data && !items.length && <p className={styles.hint}>{t("没有当前有权处理的真实待办。原生权限卡不会生成假批准按钮。", "No currently authorized live actions. Native permission cards never create fake approvals.")}</p>}{items.map(item => {
    const href = !inbox.error ? safeCollaborationHref(item.href) : null;
    return <article className={styles.row} key={item.id}><strong>{item.kind === "native_input" ? t("原生信息提问", "Native input request") : item.kind === "pm_approval" ? t("原 PM 工具审批", "Original PM tool approval") : t("真实执行资源等待", "Execution resource wait")}</strong><small>{item.id} · {item.createdAt}</small>{item.kind === "native_input" && <p>{item.request.questions?.map(question => question.prompt).join("\n") || t("在原 Chat 查看并回答本次提问。", "Inspect and answer this request in its original Chat.")}</p>}{item.kind === "pm_approval" && <><p>{item.call.name} · {item.call.status}</p><code>{item.operationId}</code><p className={styles.hint}>{t("决策仍由原操作核验当前权限、固定参数与能力版本；不会在这里假批准。", "The original owner revalidates authority, fixed parameters and capability revision. This page never fabricates approval.")}</p></>}{item.kind === "resource_wait" && <><p>{item.wait.reason}</p><small>{item.wait.kind} · {item.wait.blockingRunIds.join(", ")}</small></>}{item.unavailableReason && <p role="status">{item.unavailableReason}</p>}{href && (item.respondable || item.kind === "resource_wait") && <Link to={href}>{item.respondable ? t("到原入口处理", "Handle in original surface") : t("查看原 Run 等待事实", "Inspect original Run wait")}</Link>}{!href && inbox.error && <p className={styles.hint}>{t("过期快照不可操作。", "Stale actions are disabled.")}</p>}</article>;
  })}</section>;
}
export default function InboxPage() {
  const t = useAgentText();
  const [params, setParams] = useSearchParams();
  const workspaceId = params.get("workspaceId") ?? "", projectId = params.get("projectId") ?? "", runId = params.get("runId") ?? "";
  return <CollaborationFrame title={t("需要处理", "Inbox")} description={t("聚合当前 PM 权限下的 live 提问、原审批和真实资源等待；离开不会取消执行。", "Live input, original approvals and real resource waits under current PM authority. Leaving does not cancel execution.")}><WorkspaceScope workspaceId={workspaceId} projectId={projectId} onChange={(workspaceId, projectId) => setParams({ ...(workspaceId ? { workspaceId } : {}), ...(projectId ? { projectId } : {}) })} />{workspaceId && <RunInbox key={`${workspaceId}:${projectId}:${runId}`} workspaceId={workspaceId} projectId={projectId} runId={runId} />}</CollaborationFrame>;
}
