import { generateId } from "ai";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useProviders } from "@/hooks/use-providers";
import type { WorkspaceAgent } from "@agent-workspace/contracts/workspace";
import { useWorkspace } from "./provider";
import { usePanelDraft } from "./use-panel-draft";

export function AgentsPanel() {
  const { state, threadId, update, runAgent, busy, submitting, ready, setPanel, settings } =
    useWorkspace();
  const { providers } = useProviders();
  const [selectedId, setSelectedId] = usePanelDraft<string>(threadId, "selected-agent");
  const [error, setError] = useState<string | null>(null);
  const selected = state.agents.find((agent) => agent.id === selectedId) ?? state.agents[0];
  const active = state.agents.find((agent) => agent.id === state.activeAgentId);
  const task = selected?.input ?? "";
  const providerChoices = providers.filter(
    (provider) => provider.enabled && provider.configured && provider.models.length > 0,
  );
  const selectedProviderId = selected?.providerInstanceId ?? settings.providerInstanceId;
  const selectedProvider = providers.find((provider) => provider.instanceId === selectedProviderId);
  const modelChoices = selectedProvider?.enabled && selectedProvider.configured ? selectedProvider.models : [];
  const providerLabel = (instanceId?: string) =>
    providers.find(
      (provider) => provider.instanceId === (instanceId ?? settings.providerInstanceId),
    )?.label ??
    instanceId ??
    "未选择模型提供商";

  function changeAgent(id: string, patch: Partial<WorkspaceAgent>) {
    update((current) => ({
      ...current,
      agents: current.agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)),
    }));
  }

  function createAgent() {
    const agent: WorkspaceAgent = {
      id: generateId(),
      name: "未命名 Agent",
      providerInstanceId: settings.providerInstanceId,
      model: settings.model,
      system: "",
      skillIds: [],
    };
    update((current) => ({ ...current, agents: [...current.agents, agent] }));
    setSelectedId(agent.id);
    setError(null);
  }

  function deleteAgent(agent: WorkspaceAgent) {
    const references = state.workflows.filter((workflow) =>
      workflow.steps.some((step) => step.agentId === agent.id),
    );
    if (references.length) {
      setError(
        `无法删除：工作流「${references.map((workflow) => workflow.name || "未命名工作流").join("」、「")}」仍在使用此 Agent。请先更换或删除相关步骤。`,
      );
      return;
    }
    if (
      !window.confirm(
        `删除「${agent.name || "未命名 Agent"}」？若正在用于聊天，将恢复默认助手；已有运行记录保留。`,
      )
    )
      return;
    update((current) => ({
      ...current,
      agents: current.agents.filter((item) => item.id !== agent.id),
      activeAgentId: current.activeAgentId === agent.id ? null : current.activeAgentId,
    }));
    setSelectedId(null);
    setError(null);
  }

  async function execute(agent: WorkspaceAgent) {
    if (!agent.name.trim()) {
      setError("请先填写 Agent 名称。");
      return;
    }
    if (!task.trim()) {
      setError("请填写本次任务。");
      return;
    }
    setError(null);
    try {
      await runAgent(agent.id, task);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "运行失败，请在运行记录中查看详情。");
    }
  }

  return (
    <div className="live-panel-section">
      <div className="live-panel-toolbar">
        <h2 className="text-base font-medium">Agent 配置</h2>
        <Button onClick={createAgent}>新建 Agent</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        配置仅属于当前会话，自动保存到服务端，失败保留草稿。技能本身是提示词；是否可以执行代码或访问外部系统取决于所选
        Provider / CLI 的能力。
      </p>
      <div className="live-panel-status" role="status">
        <p>
          后续聊天：
          {active
            ? `${active.name || "未命名 Agent"} · ${providerLabel(active.providerInstanceId)} · ${active.model}`
            : `默认助手 · ${providerLabel(settings.providerInstanceId)} · ${settings.model}`}
        </p>
        {active && (
          <Button
            variant="outline"
            onClick={() => update((current) => ({ ...current, activeAgentId: null }))}
          >
            恢复默认助手
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          切换只影响后续请求，不会改写已有消息或正在执行的运行。默认助手使用聊天设置。
        </p>
      </div>
      {error && (
        <p className="live-panel-error" role="alert">
          {error}
        </p>
      )}
      {state.agents.length === 0 ? (
        <p className="live-panel-empty">
          当前会话还没有 Agent。新建后填写指令，既可用于聊天，也可提交真实模型任务。
        </p>
      ) : (
        <>
          <div className="live-panel-list" aria-label="当前会话的 Agent">
            {state.agents.map((agent) => (
              <Button
                key={agent.id}
                variant="ghost"
                className={`live-panel-item h-auto min-h-11 w-full justify-between whitespace-normal text-left ${selected?.id === agent.id ? "border-l-2 border-l-primary bg-muted" : ""}`}
                aria-pressed={selected?.id === agent.id}
                onClick={() => {
                  setSelectedId(agent.id);
                  setError(null);
                }}
              >
                <span className="min-w-0 break-words">{agent.name || "未命名 Agent"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {`${state.activeAgentId === agent.id ? "聊天使用中 · " : ""}${providerLabel(agent.providerInstanceId)} · ${agent.model}`}
                </span>
              </Button>
            ))}
          </div>
          {selected && (
            <section className="live-panel-section" aria-label="编辑 Agent">
              <label className="live-panel-field">
                <span>名称（最多 200 字符）</span>
                <Input
                  value={selected.name}
                  maxLength={200}
                  onChange={(event) => changeAgent(selected.id, { name: event.target.value })}
                  aria-invalid={!selected.name.trim()}
                />
              </label>
              {!selected.name.trim() && (
                <p className="live-panel-error">名称不能为空，填写后才能用于聊天或运行。</p>
              )}
              <label className="live-panel-field">
                <span>模型提供商</span>
                <select
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  value={selectedProviderId}
                  onChange={(event) => {
                    const providerInstanceId = event.target.value;
                    const provider = providers.find(
                      (item) => item.instanceId === providerInstanceId,
                    );
                    changeAgent(selected.id, {
                      providerInstanceId,
                      model: provider?.models[0]?.id ?? selected.model,
                    });
                  }}
                >
                  {!providerChoices.some(
                    (provider) => provider.instanceId === selectedProviderId,
                  ) && (
                    <option value={selectedProviderId}>{providerLabel(selectedProviderId)}</option>
                  )}
                  {providerChoices.map((provider) => (
                    <option key={provider.instanceId} value={provider.instanceId}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="live-panel-field">
                <span>模型</span>
                <select
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  value={selected.model}
                  onChange={(event) => changeAgent(selected.id, { model: event.target.value })}
                >
                  {!modelChoices.some((model) => model.id === selected.model) && (
                    <option value={selected.model}>{selected.model}</option>
                  )}
                  {modelChoices.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="live-panel-field">
                <span>系统指令（最多 16,000 字符）</span>
                <Textarea
                  className="min-h-32 max-h-80 overflow-y-auto"
                  value={selected.system}
                  maxLength={16000}
                  placeholder="说明此 Agent 的职责、回答方式与边界"
                  onChange={(event) => changeAgent(selected.id, { system: event.target.value })}
                />
              </label>
              <fieldset className="live-panel-field">
                <legend className="mb-2 text-sm font-medium">附加技能</legend>
                {state.skills.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    尚无技能，可在技能面板创建可复用的指令。
                  </p>
                ) : (
                  state.skills.map((skill) => (
                    <label key={skill.id} className="flex min-h-9 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.skillIds.includes(skill.id)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          update((current) => ({
                            ...current,
                            agents: current.agents.map((agent) =>
                              agent.id !== selected.id
                                ? agent
                                : {
                                    ...agent,
                                    skillIds: checked
                                      ? [...new Set([...agent.skillIds, skill.id])]
                                      : agent.skillIds.filter((id) => id !== skill.id),
                                  },
                            ),
                          }));
                        }}
                      />
                      <span className="min-w-0 break-words">{skill.name || "未命名技能"}</span>
                    </label>
                  ))
                )}
                <Button variant="ghost" onClick={() => setPanel("skills")}>
                  管理技能
                </Button>
                <p className="text-xs text-muted-foreground">
                  系统指令与所有选中技能合并后最多 16,000 字符，超限时不会发送请求。
                </p>
              </fieldset>
              <div className="live-panel-actions">
                <Button
                  disabled={!selected.name.trim() || state.activeAgentId === selected.id}
                  onClick={() => update((current) => ({ ...current, activeAgentId: selected.id }))}
                >
                  {state.activeAgentId === selected.id ? "已用于后续聊天" : "用于后续聊天"}
                </Button>
                <Button variant="destructive" onClick={() => deleteAgent(selected)}>
                  删除 Agent
                </Button>
              </div>
              <section className="live-panel-section" aria-label="执行 Agent 任务">
                <h3 className="text-sm font-medium">真实模型调用</h3>
                <p className="text-xs text-muted-foreground">
                  调用 {providerLabel(selected.providerInstanceId)} 的 {selected.model}
                  ，使用当前配置、技能与勾选的文档。不自动发送聊天消息；结果存入运行记录。可能产生模型费用。
                </p>
                <label className="live-panel-field">
                  <span>本次任务（最多 8,000 字符）</span>
                  <Textarea
                    className="min-h-24 max-h-64 overflow-y-auto"
                    value={task}
                    maxLength={8000}
                    placeholder="输入要交给此 Agent 的任务"
                    onChange={(event) => changeAgent(selected.id, { input: event.target.value })}
                  />
                </label>
                <div className="live-panel-actions">
                  <Button
                    disabled={!ready || submitting || !task.trim() || !selected.name.trim()}
                    onClick={() => void execute(selected)}
                  >
                    {submitting ? "提交中…" : busy ? "提交 Agent 到队列" : "运行 Agent"}
                  </Button>
                  <Button variant="outline" onClick={() => setPanel("runs")}>
                    查看运行记录
                  </Button>
                </div>
              </section>
            </section>
          )}
        </>
      )}
    </div>
  );
}
