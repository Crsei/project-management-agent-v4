import { useEffect, useRef, useState } from 'react';
import type { FileRecord } from '@pm-schema';
import { Button } from '@/components/ui/button';
import { RadixSelect } from '@/components/ui/radix-select';
import { MemberPicker } from '../service/people-components';
import { usePeopleCandidates } from '../service/people-hooks';
import { usePmService } from '../service/pm-service';
import { HumanIdentity } from '../service/human-identity';
import type { WorkspaceController } from './controller';
import { ProjectTaskEditingNotice, useProjectTaskEditing } from '../service/project-task-editing';
import { readProjectTaskDraft } from '../service/project-task-editing-model';

type Outcome = { id: string; status: 'saved' | 'stopped'; message?: string };

/** Each selected task uses the existing native revision/draft/unknown-result path. */
export function TaskAssignmentPanel({ controller, files, en }: { controller: WorkspaceController; files: readonly FileRecord[]; en: boolean }) {
  const service = usePmService();
  const [open, setOpen] = useState(false);
  const [chosenProject, setChosenProject] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const sending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const projectId = controller.projectId || chosenProject;
  const editing = useProjectTaskEditing(projectId);
  const candidates = usePeopleCandidates({ purpose: 'assignee', projectId, enabled: open && !!projectId });
  const identity = `${service.actor?.id}:${service.workspace?.id}:${service.actorEpoch}`;
  const latest = useRef({ controller, editing, identity, projectId });
  latest.current = { controller, editing, identity, projectId };
  const projectIds = new Set(files.map(file => file.entity.project).filter((id): id is string => !!id));
  const scoped = files.filter(file => file.entity.entity === 'work_item' && file.entity.project === projectId);
  const locked = running || !!controller.busy || editing.locked || controller.writesBlocked || !!controller.accessError || !!controller.query.error || !controller.canWrite;
  const ready = !locked && candidates.complete && !!selected.length && (!assignee || candidates.items.some(member => member.userId === assignee));
  async function assign() {
    if (!ready || sending.current) return;
    const original = selected.map(id => scoped.find(file => file.id === id));
    if (original.some(file => !file || !editing.canEdit(file.id) || controller.draftIds.has(file.id))) return;
    sending.current = true; setRunning(true); setOutcomes([]);
    try {
      for (const file of original) {
        if (!file || !active.current) break;
        const current = latest.current;
        const saved = current.editing.files.find(item => item.id === file.id);
        try {
          if (current.identity !== identity || current.projectId !== projectId) throw new Error(en ? 'Account or project scope changed; remaining tasks were not sent.' : '账号或项目范围已变化，未发送剩余任务。');
          if (!saved || saved.revision !== file.revision || saved.raw !== file.raw || !current.editing.canEdit(file.id) || current.controller.draftIds.has(file.id)) throw new Error(en ? 'The source changed or is not writable. Remaining tasks were not sent.' : '源版本变化或不可写，未发送剩余任务。');
          current.editing.change(file.id, { assignee });
          const retained = readProjectTaskDraft(current.controller.session.drafts.getSnapshot()[file.id]);
          if (!retained || retained.revision !== file.revision || retained.changes.assignee !== assignee) throw new Error(en ? 'Assignment draft was not retained; no write was sent.' : '分派草稿未保留，未发送写入。');
          await current.editing.save(file.id);
          if (active.current) setOutcomes(rows => [...rows, { id: file.id, status: 'saved' }]);
        } catch (cause) {
          if (active.current) setOutcomes(rows => [...rows, { id: file.id, status: 'stopped', message: cause instanceof Error ? cause.message : String(cause) }]);
          break;
        }
      }
    } finally { sending.current = false; if (active.current) { setRunning(false); setSelected([]); } }
  }
  return <details className="m-3 rounded-md border p-3 text-sm" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{en ? 'Assign tasks · single owner / batch' : '分派任务 · 单一负责人 / 批量'}</summary>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{en ? 'Choose tasks from one project. Each task saves separately with its original revision. The first conflict or uncertain outcome stops the batch; reconcile the retained original task before making another request. Assignment never completes a task.' : '选择同一项目中的任务，按原 revision 逐项保存。遇到冲突或未知结果立即停止；先通过原任务草稿核对，不会自动重发。分派不完成任务。'}</p>
      {!controller.projectId && <label className="grid gap-1">{en ? 'Project' : '项目'}<RadixSelect value={projectId} disabled={running} onChange={event => { setChosenProject(event.target.value); setSelected([]); setAssignee(null); }}><option value="">{en ? 'Choose a project' : '选择项目'}</option>{controller.projects.filter(project => projectIds.has(project.id)).map(project => <option key={project.id} value={project.id}>{project.entity.title}</option>)}</RadixSelect></label>}
      <MemberPicker purpose="assignee" projectId={projectId} value={assignee} onChange={setAssignee} disabled={locked || !projectId} label={en ? 'New single assignee (empty clears assignment)' : '新的唯一负责人（空值为取消分派）'} />
      <fieldset disabled={locked || !projectId} className="max-h-56 space-y-2 overflow-auto"><legend>{en ? 'Select tasks in the current view' : '选择当前视图中的任务'}</legend>{scoped.map(file => <div className="flex flex-wrap items-center gap-2" key={file.id}><label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={selected.includes(file.id)} disabled={!controller.canEdit(file.id) || controller.draftIds.has(file.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, file.id] : ids.filter(id => id !== file.id))} /><span>{file.id} · {file.entity.title}</span></label><HumanIdentity userId={file.entity.assignee} projectId={projectId} size={20} /></div>)}</fieldset>
      {candidates.error && <p role="alert">{candidates.error.message}</p>}
      <Button disabled={!ready} onClick={() => { void assign(); }}>{en ? `Assign ${selected.length} selected tasks` : `分派所选 ${selected.length} 项任务`}</Button>
      <ul aria-live="polite">{outcomes.map(row => <li key={row.id}>{row.id} · {row.status === 'saved' ? en ? 'Assignment confirmed' : '分派已确认' : en ? 'Stopped; inspect the original task result' : '已停止；请核对原任务结果'}{row.message && ` · ${row.message}`}</li>)}</ul>
      <ProjectTaskEditingNotice editing={editing} onOpen={item => controller.select(item.id)} />
    </div>}
  </details>;
}
