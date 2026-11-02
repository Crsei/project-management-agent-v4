import { Input } from "@agent/components/ui/input";
import { Button } from "@agent/components/ui/button";
import type { PmAutomationCandidate, PmAutomationSnapshot } from "../../../../../../../../packages/contracts/src/automation-pm";
import { useAgentText } from "../../i18n";
import { StudioSetupField as Field } from "./studio-setup-field";
import styles from "./studio-setup.module.css";

type TaskDraft = Extract<PmAutomationCandidate, { kind: "create-task" }>["task"];
type TaskPatch = Extract<PmAutomationCandidate, { kind: "task-update" }>["after"];
function TextList({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <Field label={label}>{id => <textarea id={id} rows={3} value={value.join("\n")} onChange={event => onChange(event.target.value.split(/\r?\n/))} />}</Field>;
}
function TaskFields({ task, onChange }: { task: TaskDraft; onChange: (task: TaskDraft) => void }) {
  const t = useAgentText();
  return <>
    <Field label={t("任务标题", "Task title")}>{id => <Input id={id} maxLength={300} value={task.title} onChange={event => onChange({ ...task, title: event.target.value })} />}</Field>
    <Field label={t("任务说明", "Task description")}>{id => <textarea id={id} rows={5} maxLength={24000} value={task.description} onChange={event => onChange({ ...task, description: event.target.value })} />}</Field>
    <TextList label={t("验收标准（每行一条）", "Acceptance criteria (one per line)")} value={task.acceptanceCriteria} onChange={acceptanceCriteria => onChange({ ...task, acceptanceCriteria })} />
    <TextList label={t("标签（每行一个）", "Labels (one per line)")} value={task.labels} onChange={labels => onChange({ ...task, labels })} />
    <TextList label={t("依赖的真实任务 ID", "Existing prerequisite task IDs")} value={task.dependsOn} onChange={dependsOn => onChange({ ...task, dependsOn })} />
    <TextList label={t("关联的真实任务 ID", "Related existing task IDs")} value={task.relatedTaskIds} onChange={relatedTaskIds => onChange({ ...task, relatedTaskIds })} />
    <Field label={t("里程碑 ID（可选）", "Milestone ID (optional)")}>{id => <Input id={id} value={task.milestoneId ?? ""} onChange={event => onChange({ ...task, milestoneId: event.target.value || null })} />}</Field>
  </>;
}
function PatchFields({ value, onChange }: { value: TaskPatch; onChange: (patch: TaskPatch) => void }) {
  const t = useAgentText();
  const names = { title: t("标题", "Title"), description: t("说明", "Description"), acceptanceCriteria: t("验收标准", "Acceptance criteria"), progressNote: t("进展备注", "Progress note"), labels: t("标签", "Labels"), assigneeIds: t("负责人 ID（最多一个）", "Assignee ID (at most one)") };
  return <>{(Object.keys(names) as (keyof TaskPatch)[]).map(name => <div key={name}>
    <label><input type="checkbox" checked={value[name] !== undefined} onChange={event => { const next = { ...value }; if (event.target.checked) { if (name === "acceptanceCriteria" || name === "labels" || name === "assigneeIds") next[name] = []; else next[name] = ""; } else delete next[name]; onChange(next); }} /> {names[name]}</label>
    {value[name] !== undefined && (name === "acceptanceCriteria" || name === "labels" || name === "assigneeIds" ? <TextList label={names[name]} value={value[name] ?? []} onChange={items => onChange({ ...value, [name]: items })} /> : <Field label={names[name]}>{id => <textarea id={id} rows={name === "title" ? 2 : 4} value={String(value[name] ?? "")} onChange={event => onChange({ ...value, [name]: event.target.value })} />}</Field>)}
  </div>)}</>;
}
export function StudioPmCandidateFields({ candidate, workflow, onChange }: { candidate: PmAutomationCandidate; workflow?: PmAutomationSnapshot["workflow"]; onChange: (candidate: PmAutomationCandidate) => void }) {
  const t = useAgentText();
  return <>
    <Field label={t("候选标题", "Candidate title")}>{id => <Input id={id} value={candidate.title} onChange={event => onChange({ ...candidate, title: event.target.value })} />}</Field>
    <Field label={t("提出理由", "Rationale")}>{id => <textarea id={id} rows={3} value={candidate.rationale} onChange={event => onChange({ ...candidate, rationale: event.target.value })} />}</Field>
    {"taskId" in candidate && <p>{t("目标任务", "Target task")}: <code>{candidate.taskId}</code> · {t("来源版本", "Source revision")}: <code>{candidate.expectedRevision}</code></p>}
    {candidate.kind === "task-update" && <PatchFields value={candidate.after} onChange={after => onChange({ ...candidate, after })} />}
    {candidate.kind === "task-relation" && <><Field label={t("关系类型", "Relationship")}>{id => <select id={id} value={candidate.relation} onChange={event => onChange({ ...candidate, relation: event.target.value as "related" | "depends-on" })}><option value="related">related</option><option value="depends-on">depends-on</option></select>}</Field><TextList label={t("应用后关联任务 ID", "Related task IDs after apply")} value={candidate.after} onChange={after => onChange({ ...candidate, after })} /></>}
    {candidate.kind === "task-comment" && <Field label={t("跟进备注", "Follow-up comment")}>{id => <textarea id={id} rows={5} maxLength={8000} value={candidate.body} onChange={event => onChange({ ...candidate, body: event.target.value })} />}</Field>}
    {candidate.kind === "task-status" && <Field label={t("建议的当前工作流状态", "Suggested current workflow status")}>{id => <select id={id} value={candidate.after} onChange={event => onChange({ ...candidate, after: event.target.value })}>{!workflow?.statuses.some(status => status.id === candidate.after) && <option value={candidate.after}>{candidate.after}</option>}{workflow?.statuses.filter(status => status.category !== "completed" && status.category !== "canceled" && workflow.statuses.find(item => item.id === candidate.before)?.nextStatusIds.includes(status.id)).map(status => <option key={status.id} value={status.id}>{status.name} ({status.category})</option>)}</select>}</Field>}
    {candidate.kind === "create-task" && <TaskFields task={candidate.task} onChange={task => onChange({ ...candidate, task })} />}
    {candidate.kind === "create-document" && <><Field label={t("文档标题", "Document title")}>{id => <Input id={id} maxLength={300} value={candidate.document.title} onChange={event => onChange({ ...candidate, document: { ...candidate.document, title: event.target.value } })} />}</Field><Field label={t("文档 Markdown", "Document Markdown")}>{id => <textarea id={id} rows={10} maxLength={24000} value={candidate.document.body} onChange={event => onChange({ ...candidate, document: { ...candidate.document, body: event.target.value } })} />}</Field><TextList label={t("关联任务 ID", "Linked task IDs")} value={candidate.document.taskIds} onChange={taskIds => onChange({ ...candidate, document: { ...candidate.document, taskIds } })} /></>}
    {candidate.kind === "plan" && <>
      <Field label={t("规划标题", "Plan title")}>{id => <Input id={id} value={candidate.plan.title} onChange={event => onChange({ ...candidate, plan: { ...candidate.plan, title: event.target.value } })} />}</Field>
      <Field label={t("规划说明", "Plan description")}>{id => <textarea id={id} rows={4} value={candidate.plan.description} onChange={event => onChange({ ...candidate, plan: { ...candidate.plan, description: event.target.value } })} />}</Field>
      {candidate.plan.tasks.map((task, index) => <details key={task.localId} className={styles.section}><summary>{task.localId} · {task.title} {task.existingTaskId && `→ ${task.existingTaskId}`}</summary>
        {task.existingTaskId && <p>{t("此条目复用已有任务；发布规划不会更改它的任务字段，也不会重复创建。", "This item reuses an existing task. Publishing the plan neither changes its task fields nor creates it again.")}</p>}
        <fieldset disabled={Boolean(task.existingTaskId)}><TaskFields task={task} onChange={next => onChange({ ...candidate, plan: { ...candidate.plan, tasks: candidate.plan.tasks.map((item, at) => at === index ? { ...task, ...next } : item) } })} />
        <TextList label={t("本规划内前置条目的 localId", "Prerequisite localIds within this plan")} value={task.dependsOnLocalIds} onChange={dependsOnLocalIds => onChange({ ...candidate, plan: { ...candidate.plan, tasks: candidate.plan.tasks.map((item, at) => at === index ? { ...task, dependsOnLocalIds } : item) } })} /></fieldset>
        <Button type="button" variant="outline" onClick={() => onChange({ ...candidate, plan: { ...candidate.plan, tasks: candidate.plan.tasks.filter((_, at) => at !== index) } })}>{t("移除此规划条目", "Remove this plan item")}</Button>
      </details>)}
      <Button type="button" variant="outline" onClick={() => onChange({ ...candidate, plan: { ...candidate.plan, tasks: [...candidate.plan.tasks, { localId: `draft-${crypto.randomUUID()}`, dependsOnLocalIds: [], title: "", description: "", acceptanceCriteria: [], labels: [], dependsOn: [], relatedTaskIds: [], milestoneId: null }] } })}>{t("添加规划条目（尚未发布）", "Add plan item (not published)")}</Button>
    </>}
  </>;
}
