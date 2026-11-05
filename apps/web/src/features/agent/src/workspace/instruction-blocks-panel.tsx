import { generateId } from "ai";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Textarea } from "@agent/components/ui/textarea";
import type { WorkspaceSkill } from "@agent-workspace/contracts/workspace";
import { useWorkspace } from "./provider";
import { usePanelDraft } from "./use-panel-draft";

export function InstructionBlocksPanel() {
  const { state, threadId, update, setPanel } = useWorkspace();
  const [selectedId, setSelectedId] = usePanelDraft<string>(threadId, "selected-skill");
  const selected = state.skills.find((skill) => skill.id === selectedId) ?? state.skills[0];

  function createSkill() {
    const skill: WorkspaceSkill = { id: generateId(), name: "未命名指令块", instructions: "" };
    update((current) => ({ ...current, skills: [...current.skills, skill] }));
    setSelectedId(skill.id);
  }

  function changeSkill(id: string, patch: Partial<WorkspaceSkill>) {
    update((current) => ({
      ...current,
      skills: current.skills.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill)),
    }));
  }

  function deleteSkill(skill: WorkspaceSkill) {
    const count = state.agents.filter((agent) => agent.skillIds.includes(skill.id)).length;
    if (
      !window.confirm(
        `删除「${skill.name || "未命名指令块"}」？将同时从 ${count} 个 Agent 的配置中移除，已有运行记录不变。`,
      )
    )
      return;
    update((current) => ({
      ...current,
      skills: current.skills.filter((item) => item.id !== skill.id),
      agents: current.agents.map((agent) =>
        agent.skillIds.includes(skill.id)
          ? {
              ...agent,
              skillIds: agent.skillIds.filter((id) => id !== skill.id),
            }
          : agent,
      ),
    }));
    setSelectedId(null);
  }

  return (
    <div className="live-panel-section">
      <div className="live-panel-toolbar">
        <h2 className="text-base font-medium">可复用指令块</h2>
        <Button onClick={createSkill}>新建指令块</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        指令块是你编写的会话提示词，不是原生 Skills、插件、脚本或可执行工具。只有在 Agent
        中勾选后才会影响其后续聊天或运行。
      </p>
      <p className="text-xs text-muted-foreground">
        所有修改自动保存到服务端，仅属于当前会话；失败保留草稿。正在进行的运行使用提交时的配置。
      </p>
      {state.skills.length === 0 ? (
        <p className="live-panel-empty">
          当前会话还没有指令块。创建一个指令块，再到 Agent 面板选择使用。
        </p>
      ) : (
        <>
          <div className="live-panel-list" aria-label="当前会话的指令块">
            {state.skills.map((skill) => (
              <Button
                key={skill.id}
                variant="ghost"
                className={`live-panel-item h-auto min-h-11 w-full justify-between whitespace-normal text-left ${selected?.id === skill.id ? "border-l-2 border-l-primary bg-muted" : ""}`}
                aria-pressed={selected?.id === skill.id}
                onClick={() => setSelectedId(skill.id)}
              >
                <span className="min-w-0 break-words">{skill.name || "未命名指令块"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {state.agents.filter((agent) => agent.skillIds.includes(skill.id)).length} 个
                  Agent 使用
                </span>
              </Button>
            ))}
          </div>
          {selected && (
            <section className="live-panel-section" aria-label="编辑指令块">
              <label className="live-panel-field">
                <span>名称（最多 200 字符）</span>
                <Input
                  value={selected.name}
                  maxLength={200}
                  aria-invalid={!selected.name.trim()}
                  onChange={(event) => changeSkill(selected.id, { name: event.target.value })}
                />
              </label>
              {!selected.name.trim() && (
                <p className="live-panel-error">请为此指令块填写名称，便于在 Agent 中识别。</p>
              )}
              <label className="live-panel-field">
                <span>指令块内容（最多 16,000 字符）</span>
                <Textarea
                  className="min-h-56 max-h-[32rem] overflow-y-auto"
                  value={selected.instructions}
                  maxLength={16000}
                  placeholder="编写可复用的处理步骤、约束或输出规范"
                  onChange={(event) =>
                    changeSkill(selected.id, { instructions: event.target.value })
                  }
                />
              </label>
              {!selected.instructions.trim() && (
                <p className="text-xs text-muted-foreground">
                  指令为空，此指令块暂不会提供额外指令。
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Agent 的系统指令与选中指令块合计最多 16,000 字符。修改会影响所有引用此指令块的 Agent
                的后续请求。
              </p>
              <div className="live-panel-actions">
                <Button variant="outline" onClick={() => setPanel("agents")}>
                  到 Agent 中选用
                </Button>
                <Button variant="destructive" onClick={() => deleteSkill(selected)}>
                  删除指令块
                </Button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
