import { useEffect, useRef, useState } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { ListTodo } from "lucide-react";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { RadixSelect } from "@/components/ui/radix-select";
import { Button } from "@agent/components/ui/button";
import type { FileRecord, UnsupportedFile } from "@pm-schema";
import { useAgentText } from "../i18n";
import { PM_REFERENCE_LIMIT, usePmIssueWorkspace } from "./pm-issue-workspace";
import { pmJson, PmApiError, refreshCatalog, usePmChatState } from "./state";
import { appendProjectFlowDraft, projectFlowFileReference, projectFlowPrompt, projectFlowReferenceAdditions, selectedProjectFlowTask, type ProjectFlowPhase, type ProjectFlowTaskSelection } from "./pm-project-flow-draft";

type Folder = { path: string | null; verified: boolean; loading: boolean; error: string | null };
type ProjectFlowActionProps = {
  folder: Folder;
  sessionTitle: string;
  beforePrepare: () => boolean;
  onPrepared: () => void;
};

/** Project/task selection belongs to this composer target, never to a Session. */
export function PmProjectFlowAction(props: ProjectFlowActionProps) {
  const threadId = useAuiState(state => state.threads.mainThreadId);
  const workspace = usePmIssueWorkspace();
  return <ProjectFlowMenu key={JSON.stringify([threadId, workspace.workspaceId, workspace.projectId])} threadId={threadId} {...props} />;
}

function ProjectFlowMenu({ threadId, folder, sessionTitle, beforePrepare, onPrepared }: ProjectFlowActionProps & { threadId: string }) {
  const aui = useAui();
  const t = useAgentText();
  const state = usePmChatState();
  const workspace = usePmIssueWorkspace();
  const threadBusy = useAuiState(value => value.thread.isLoading || value.threads.isLoading);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<ProjectFlowTaskSelection | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const authorizedWorkspace = state.catalog?.workspaces.find(item => item.id === workspace.workspaceId);
  const project = authorizedWorkspace?.projects.find(item => item.id === workspace.projectId);
  const scope = workspace.workspaceId && workspace.projectId ? { threadId, workspaceId: workspace.workspaceId, projectId: workspace.projectId } : null;
  const task = scope ? selectedProjectFlowTask(scope, selection, workspace.references) : null;
  const tasks = workspace.references.filter(reference => reference.kind === "issue" && reference.workspaceId === scope?.workspaceId && reference.projectId === scope?.projectId && !["stale", "forbidden", "deleted"].includes(reference.availability ?? "unverified"));
  const guard = JSON.stringify([scope, workspace.references, folder, task, !!project, state.catalogLoading, state.catalogError, threadBusy]);
  const latest = useRef({ guard, workspace });
  latest.current = { guard, workspace };
  useEffect(() => () => { request.current?.abort(); }, [guard]);
  const busy = pending === guard;
  const canPrepare = !!scope && !!project && !state.catalogLoading && !state.catalogError && !threadBusy && !busy;
  const phases: { id: ProjectFlowPhase; label: string; hint: string }[] = [
    { id: "inventory", label: t("盘点并建板", "Inventory and establish board"), hint: t("盘点源码与已有 PM 资料，去重建任务并保存项目基线建议。", "Inventory source and PM records, deduplicate tasks, and save baseline advice.") },
    { id: "find", label: t("寻找下一项任务", "Find the next task"), hint: t("只读分析当前任务、简报与依赖；推荐但不执行。", "Read tasks, briefs and dependencies; recommend without executing.") },
    { id: "execute", label: t("执行所选任务", "Execute selected task"), hint: t("执行一个明确选择的任务，记录进度与真实检查；不自动完成。", "Execute one explicitly selected task, recording progress and real checks; no automatic completion.") },
    { id: "report", label: t("验收与报告", "Accept and report"), hint: t("发送后才按证据和配置工作流验收；符合条件才完成并读回。", "Only after sending, assess evidence against the configured workflow; complete and read back only when satisfied.") },
  ];
  const prepare = async (phase: ProjectFlowPhase) => {
    if (!canPrepare || !scope || !project || (request.current && !request.current.signal.aborted)) return;
    const selectedTask = phase === "execute" || phase === "report" ? task : null;
    if ((phase === "execute" || phase === "report") && !selectedTask) return;
    if (!beforePrepare()) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(guard); setError(null);
    try {
      const path = `/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/core/files/`;
      const file = await pmJson<FileRecord | UnsupportedFile>(`${path}${encodeURIComponent(scope.projectId)}`, { signal: controller.signal });
      const projectReference = projectFlowFileReference(file, scope, "project", scope.projectId);
      if (!projectReference) throw new Error(t("项目原生来源不可读、身份或版本已变化，请刷新后重新选择。草稿未更改。", "The native project source is unreadable or its identity/revision changed. Refresh and select again; the draft was not changed."));
      if (selectedTask) {
        const current = await pmJson<FileRecord | UnsupportedFile>(`${path}${encodeURIComponent(selectedTask.id)}`, { signal: controller.signal });
        const taskReference = projectFlowFileReference(current, scope, "issue", selectedTask.id);
        if (!taskReference || !selectedTask.revision || taskReference.revision !== selectedTask.revision) throw new Error(t("任务来源不可读、归属或版本已变化：请移除旧任务引用，在任务选择器中刷新并重新引用后再选择。", "The task source is unreadable or its project/revision changed. Remove the old reference, refresh the picker, re-reference it, and select again."));
      }
      if (controller.signal.aborted || latest.current.guard !== guard) return;
      const additions = projectFlowReferenceAdditions(latest.current.workspace.references, [projectReference, ...(selectedTask ? [selectedTask] : [])], PM_REFERENCE_LIMIT);
      if (additions.error) throw new Error(additions.error === "limit"
        ? t(`加入项目引用将超过 ${PM_REFERENCE_LIMIT} 项。请明确移除不需要的引用后重试；未删除任何选择。`, `Adding the project would exceed ${PM_REFERENCE_LIMIT} references. Remove unwanted references explicitly, then retry; no selections were removed.`)
        : t("已有引用的版本或可见性已变化。请移除旧引用并重新引用；未覆盖草稿。", "An existing reference revision or visibility changed. Remove and re-reference it; the draft was not overwritten."));
      const draft = projectFlowPrompt(phase, projectReference, selectedTask, folder, t);
      // Append to the latest text after reads. Quotes, attachments, references and
      // the shared picker's checked task selections are never cleared here.
      aui.composer.setText(appendProjectFlowDraft(aui.composer.getState().text, draft));
      latest.current.workspace.reuseReferences(additions.additions);
      setOpen(false);
      onPrepared();
    } catch (cause) {
      if (controller.signal.aborted || latest.current.guard !== guard) return;
      setError(cause instanceof PmApiError && [401, 403].includes(cause.status)
        ? t("PM 登录已过期或无权读取此项目/任务。请登录 PM 后重试；这不是空项目。", "PM authentication expired or this project/task is unauthorized. Sign in to PM and retry; this is not an empty project.")
        : cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request.current === controller) { request.current = null; setPending(null); }
    }
  };
  return <Popover open={open} onOpenChange={value => {
    setOpen(value);
    if (value) {
      setError(null);
      // Reopening this draft menu must not refresh/reset checked picker rows.
      if (!state.catalog && !state.catalogLoading) void refreshCatalog().catch(() => {});
    }
  }}>
    <PopoverTrigger type="button" className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("项目流程", "Project flow")} data-testid="pm-project-flow-action">
      <ListTodo aria-hidden="true" className="size-4" /><span>{t("项目流程", "Project flow")}</span>
    </PopoverTrigger>
    <PopoverContent side="right" align="start" className="max-h-[calc(100dvh-32px)] w-[min(420px,calc(100vw-32px))] space-y-3 overflow-y-auto p-4" aria-label={t("项目流程草稿", "Project flow drafts")}>
      <PopoverTitle className="font-medium">{t("项目流程", "Project flow")}</PopoverTitle>
      <PopoverDescription className="text-xs text-muted-foreground">{t("选择阶段后核对 PM 引用，将草稿追加到当前对话并返回 Chat；检查后仍须发送。不会自动运行或写入业务，原有文字、附件和引用保留。", "Check PM references, append a stage draft to the current chat, and return to Chat for review and sending. Nothing runs or writes business data automatically; existing text, attachments and references are preserved.")}</PopoverDescription>
      <p className="text-xs">{t("接收草稿的会话：", "Draft destination session: ")}<strong>{sessionTitle}</strong></p>
      <div className="space-y-1 rounded-md border p-2 text-xs" aria-label={t("目标 PM 项目", "Target PM project")}>
        <strong>{t("目标 PM 项目", "Target PM project")}</strong>
        <p>{authorizedWorkspace ? `${authorizedWorkspace.name} · ${authorizedWorkspace.id}` : workspace.workspaceId ?? t("尚未选择工作区", "No workspace selected")}</p>
        <p>{project ? `${project.name} · ${project.id}` : workspace.projectId ? t("当前项目不可用，请重新选择", "Current project unavailable; select again") : t("尚未选择项目（空看板项目也可选择）", "No project selected (empty-board projects are supported)")}</p>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setOpen(false); workspace.openPicker(); }}>{t("选择项目与任务引用", "Choose project and task references")}</Button>
      </div>
      <div className="rounded-md border p-2 text-xs" aria-label={t("当前执行文件夹", "Current execution folder")}>
        <strong>{t("当前执行文件夹（独立于 PM 项目）", "Current execution folder (independent of PM project)")}</strong>
        <p className="break-all">{folder.path ?? t("未配置 · 仅对话", "Not configured · chat only")}</p>
        <p className="text-muted-foreground">{folder.loading ? t("正在核验", "Verifying") : folder.verified ? t("已读取原生执行环境；执行前仍需核对", "Native environment read; verify again before execution") : t("尚未核验；不会选择目录或改变 cwd", "Not verified; this action never selects a folder or changes cwd")}</p>
        {folder.error && <p role="alert" className="text-destructive">{folder.error}</p>}
      </div>
      {state.catalogLoading && <p role="status" className="text-xs">{t("正在读取授权 PM 项目…", "Loading authorized PM projects…")}</p>}
      {state.catalogError && <p role="alert" className="text-xs text-destructive">{state.catalogError}{t("（读取失败，不代表项目为空。）", " (Read failed; this does not mean the project is empty.)")}</p>}
      {!state.catalogLoading && !state.catalogError && state.catalog && !state.catalog.workspaces.length && <p className="text-xs">{t("当前账号没有可用 PM 工作区。", "This account has no available PM workspaces.")}</p>}
      {workspace.error && <p role="alert" className="text-xs text-destructive">{workspace.error}</p>}
      <label className="block space-y-1 text-xs"><span>{t("明确选择一个执行/验收任务", "Explicitly select one execution/acceptance task")}</span>
        <RadixSelect aria-label={t("项目流程任务", "Project flow task")} value={task ? JSON.stringify([task.id, task.revision]) : ""} disabled={!scope || busy} onChange={event => {
          const chosen = tasks.find(item => JSON.stringify([item.id, item.revision]) === event.target.value);
          setSelection(scope && chosen ? { ...scope, id: chosen.id, revision: chosen.revision } : null);
        }}>
          <option value="">{t("请选择任务；不会自动采用历史或首个任务", "Choose a task; never use history or the first task automatically")}</option>
          {tasks.map(item => <option key={item.id} value={JSON.stringify([item.id, item.revision])}>{item.id} · {item.title}</option>)}
        </RadixSelect>
        <span className="block text-muted-foreground">{t("通过上方选择器引用任务，再在这里明确选择。切换项目或 Session 会清除此执行选择，不删除草稿引用。", "Reference tasks using the picker above, then explicitly select one here. Changing project or Session clears this execution selection without deleting draft references.")}</span>
      </label>
      <div className="grid gap-2">{phases.map(phase => <Button key={phase.id} type="button" variant="outline" className="h-auto justify-start whitespace-normal py-2 text-left" data-testid={`pm-project-flow-${phase.id}`} disabled={!canPrepare || (phase.id === "execute" || phase.id === "report") && !task} onClick={() => { void prepare(phase.id); }}><span><strong className="block">{phase.label}</strong><small className="block font-normal text-muted-foreground">{phase.hint}</small></span></Button>)}</div>
      {busy && <p role="status" className="text-xs">{t("正在只读核对项目/任务引用…", "Checking project/task references read-only…")}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </PopoverContent>
  </Popover>;
}
