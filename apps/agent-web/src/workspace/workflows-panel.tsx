import { generateId } from "ai";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowStep, WorkspaceWorkflow } from "@agent-workspace/contracts/workspace";
import { useWorkspace } from "./provider";
import { usePanelDraft } from "./use-panel-draft";

const selectClass =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function WorkflowsPanel() {
  const { state, threadId, update, busy, submitting, ready, runWorkflow, setPanel } =
    useWorkspace();
  const [selectedId, setSelectedId] = usePanelDraft<string>(threadId, "selected-workflow");
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const fieldId = useId();
  const selected = state.workflows.find((item) => item.id === selectedId) ?? state.workflows[0];

  function changeWorkflow(id: string, recipe: (workflow: WorkspaceWorkflow) => WorkspaceWorkflow) {
    update((current) => ({
      ...current,
      workflows: current.workflows.map((workflow) =>
        workflow.id === id ? recipe(workflow) : workflow,
      ),
    }));
    setError(null);
  }

  function createWorkflow() {
    const id = generateId();
    update((current) => ({
      ...current,
      workflows: [...current.workflows, { id, name: "", steps: [], input: "" }],
    }));
    setSelectedId(id);
    setError(null);
  }

  function changeStep(stepId: string, patch: Partial<WorkflowStep>) {
    if (!selected) return;
    changeWorkflow(selected.id, (workflow) => ({
      ...workflow,
      steps: workflow.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
    }));
  }

  function moveStep(stepId: string, offset: number) {
    if (!selected) return;
    changeWorkflow(selected.id, (workflow) => {
      const index = workflow.steps.findIndex((step) => step.id === stepId);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= workflow.steps.length) return workflow;
      const steps = [...workflow.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...workflow, steps };
    });
  }

  const validation: string[] = [];
  if (selected) {
    if (!selected.name.trim()) validation.push("请填写工作流名称。");
    if (!selected.steps.length) validation.push("请添加至少一个步骤。");
    if (selected.steps.length > 8) validation.push("每个工作流最多允许 8 个步骤。");
    selected.steps.forEach((step, index) => {
      const agent = state.agents.find((item) => item.id === step.agentId);
      if (!step.name.trim()) validation.push(`步骤 ${index + 1} 缺少名称。`);
      if (!step.instruction.trim()) validation.push(`步骤 ${index + 1} 缺少执行指令。`);
      if (!agent) validation.push(`步骤 ${index + 1} 的 Agent 未选择或已删除。`);
      else {
        if (!agent.name.trim() || !agent.system.trim()) {
          validation.push(`步骤 ${index + 1} 的 Agent 缺少名称或系统指令，请先完善配置。`);
        }
        if (agent.skillIds.some((id) => !state.skills.some((skill) => skill.id === id))) {
          validation.push(`步骤 ${index + 1} 的 Agent 引用了已删除的技能，请先调整配置。`);
        }
      }
    });
    if (!(selected.input ?? "").trim()) validation.push("请填写本次任务。");
    if ((selected.input ?? "").length > 8000)
      validation.push("本次任务不能超过 8000 个字符，请缩短已保存的任务。");
  }

  async function execute() {
    if (!selected || !ready || submitting || validation.length) return;
    const id = selected.id;
    setError(null);
    try {
      await runWorkflow(id, selected.input ?? "");
    } catch (cause) {
      setError({
        id,
        message: cause instanceof Error ? cause.message : "工作流启动失败，请检查配置。",
      });
    }
  }

  return (
    <div className="space-y-5">
      <section className="live-panel-section">
        <div className="live-panel-toolbar">
          <h3 className="font-medium">本会话工作流</h3>
          <Button onClick={createWorkflow} disabled={!ready}>
            新建工作流
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          按顺序调用真实 Agent；后续步骤接收任务和此前步骤的输出。
        </p>
        {state.workflows.length === 0 ? (
          <div className="live-panel-empty">
            还没有工作流。先创建 Agent，再添加步骤，组合你自己的执行流程。
          </div>
        ) : (
          <div className="live-panel-list" aria-label="工作流列表">
            {state.workflows.map((workflow) => (
              <Button
                key={workflow.id}
                variant="ghost"
                className={`h-auto min-h-11 w-full justify-between gap-3 whitespace-normal border-l-2 py-2 text-left ${selected?.id === workflow.id ? "border-l-primary bg-muted font-medium" : "border-l-transparent"}`}
                aria-pressed={selected?.id === workflow.id}
                onClick={() => {
                  setSelectedId(workflow.id);
                  setError(null);
                }}
              >
                <span className="min-w-0 break-words">
                  {workflow.name.trim() || "未命名工作流"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {workflow.steps.length} 步
                </span>
              </Button>
            ))}
          </div>
        )}
        {state.agents.length === 0 && (
          <Button variant="outline" onClick={() => setPanel("agents")}>
            配置 Agent
          </Button>
        )}
      </section>

      {selected && (
        <>
          <section className="live-panel-section space-y-3">
            <div className="live-panel-toolbar">
              <h3 className="font-medium">工作流配置</h3>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (
                    !window.confirm(
                      `删除「${selected.name.trim() || "未命名工作流"}」？已有运行记录会保留。`,
                    )
                  )
                    return;
                  update((current) => ({
                    ...current,
                    workflows: current.workflows.filter((item) => item.id !== selected.id),
                  }));
                  setSelectedId(null);
                  setError(null);
                }}
              >
                删除工作流
              </Button>
            </div>
            <label className="live-panel-field" htmlFor={`${fieldId}-name`}>
              工作流名称
              <Input
                id={`${fieldId}-name`}
                value={selected.name}
                placeholder="为这个流程命名"
                maxLength={200}
                onChange={(event) =>
                  changeWorkflow(selected.id, (item) => ({ ...item, name: event.target.value }))
                }
              />
            </label>
            {selected.steps.length > 0 && (
              <ol
                className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground"
                aria-label="步骤执行顺序"
              >
                {selected.steps.map((step, index) => (
                  <li key={step.id} className="min-w-0 break-words">
                    {index > 0 && <span aria-hidden="true">→ </span>}
                    {index + 1}. {step.name.trim() || "未命名步骤"} ·{" "}
                    {state.agents.find((agent) => agent.id === step.agentId)?.name.trim() ||
                      "未配置 Agent"}
                  </li>
                ))}
              </ol>
            )}
            <ol className="live-panel-list space-y-3">
              {selected.steps.map((step, index) => (
                <li key={step.id} className="live-panel-item space-y-3">
                  <div className="live-panel-toolbar flex-wrap">
                    <h4 className="text-sm font-medium">步骤 {index + 1}</h4>
                    <div className="live-panel-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={index === 0}
                        onClick={() => moveStep(step.id, -1)}
                        aria-label={`上移步骤 ${index + 1}`}
                      >
                        上移
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={index === selected.steps.length - 1}
                        onClick={() => moveStep(step.id, 1)}
                        aria-label={`下移步骤 ${index + 1}`}
                      >
                        下移
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `删除步骤 ${index + 1}「${step.name.trim() || "未命名步骤"}」？`,
                            )
                          )
                            return;
                          changeWorkflow(selected.id, (item) => ({
                            ...item,
                            steps: item.steps.filter((entry) => entry.id !== step.id),
                          }));
                        }}
                        aria-label={`删除步骤 ${index + 1}`}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                  <label className="live-panel-field" htmlFor={`${fieldId}-${step.id}-name`}>
                    步骤名称
                    <Input
                      id={`${fieldId}-${step.id}-name`}
                      value={step.name}
                      maxLength={200}
                      onChange={(event) => changeStep(step.id, { name: event.target.value })}
                    />
                  </label>
                  <label className="live-panel-field" htmlFor={`${fieldId}-${step.id}-agent`}>
                    执行 Agent
                    <select
                      id={`${fieldId}-${step.id}-agent`}
                      className={selectClass}
                      value={step.agentId}
                      onChange={(event) => changeStep(step.id, { agentId: event.target.value })}
                    >
                      <option value="">请选择 Agent</option>
                      {step.agentId && !state.agents.some((agent) => agent.id === step.agentId) && (
                        <option value={step.agentId}>原 Agent 已删除，请重新选择</option>
                      )}
                      {state.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name.trim() || "未命名 Agent"} · {agent.model}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="live-panel-field" htmlFor={`${fieldId}-${step.id}-instruction`}>
                    执行指令
                    <Textarea
                      id={`${fieldId}-${step.id}-instruction`}
                      value={step.instruction}
                      maxLength={16000}
                      placeholder="描述本步骤如何处理任务和之前的输出"
                      onChange={(event) => changeStep(step.id, { instruction: event.target.value })}
                    />
                  </label>
                </li>
              ))}
            </ol>
            <Button
              variant="outline"
              disabled={selected.steps.length >= 8}
              onClick={() => {
                const step: WorkflowStep = {
                  id: generateId(),
                  name: "",
                  agentId: "",
                  instruction: "",
                };
                changeWorkflow(selected.id, (item) =>
                  item.steps.length >= 8 ? item : { ...item, steps: [...item.steps, step] },
                );
              }}
            >
              添加步骤（{selected.steps.length}/8）
            </Button>
            {selected.steps.length >= 8 && (
              <p className="text-xs text-muted-foreground">已达到 8 个步骤上限。</p>
            )}
          </section>
          <section className="live-panel-section space-y-3">
            <label className="live-panel-field" htmlFor={`${fieldId}-task`}>
              本次任务
              <Textarea
                id={`${fieldId}-task`}
                value={selected.input ?? ""}
                maxLength={8000}
                placeholder="输入实际要完成的任务（最多 8000 个字符）"
                onChange={(event) =>
                  changeWorkflow(selected.id, (item) => ({ ...item, input: event.target.value }))
                }
              />
            </label>
            <p className="text-xs text-muted-foreground">
              开始时捕获配置与上下文；之后编辑不会改变已经开始的运行。不会自动发送聊天消息。
            </p>
            {validation.length > 0 && (
              <ul id={`${fieldId}-validation`} className="space-y-1 text-xs text-muted-foreground">
                {validation.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
            {busy && (
              <p className="live-panel-status" role="status">
                本会话已有排队或运行中的任务；新的提交会持久入队并按顺序执行。
              </p>
            )}
            {!ready && (
              <p className="text-sm text-muted-foreground">正在准备当前会话，暂时无法运行。</p>
            )}
            {error?.id === selected.id && (
              <p className="live-panel-error" role="alert">
                {error.message}
              </p>
            )}
            <div className="live-panel-actions">
              <Button
                disabled={!ready || submitting || validation.length > 0}
                aria-describedby={validation.length ? `${fieldId}-validation` : undefined}
                onClick={() => void execute()}
              >
                {submitting ? "提交中…" : busy ? "提交工作流到队列" : "运行工作流"}
              </Button>
              <Button variant="outline" onClick={() => setPanel("runs")}>
                查看运行记录
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
