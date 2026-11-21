import { agentsResponseSchema, type AgentDefinition } from "@agent-workspace/contracts/collaboration";
import type { StudioCapabilities, StudioConfig } from "../../../../../../../../packages/contracts/src/automation-studio";
import { workspaceClient } from "../../network";
import { useAgentText } from "../../i18n";
import { useAutomationQuery } from "./query";
import { StudioSetupField as Field } from "./studio-setup-field";
import styles from "./studio-setup.module.css";
import { RadixSelect } from "@/components/ui/radix-select";

type Props = {
  workspaceId: string; projectId: string; value: StudioConfig["executionAgent"]; action: StudioConfig["action"];
  capabilities: StudioCapabilities | null; disabled: boolean;
  onSelect: (agent: AgentDefinition | null) => void;
};
/** Picking an Agent pins its published version; Provider and model are taken from that frozen configuration. */
export function StudioExecutionAgent({ workspaceId, projectId, value, action, capabilities, disabled, onSelect }: Props) {
  const t = useAgentText();
  const query = useAutomationQuery(`studio-agents:${workspaceId}`, signal => workspaceClient.json<unknown>(`/api/collaboration/agents?workspaceId=${encodeURIComponent(workspaceId)}`, { signal }).then(raw => agentsResponseSchema.parse(raw)), Boolean(workspaceId));
  const agents = query.data?.agents.filter(agent => agent.state === "active") ?? [];
  const pinned = value ? agents.find(agent => agent.id === value.id) ?? query.data?.agents.find(agent => agent.id === value.id) : undefined;
  const analysisFeature = (providerInstanceId: string | null | undefined) => capabilities?.features?.find(feature => feature.id === `provider:${providerInstanceId ?? ""}:pmAnalysis`);
  const reason = (agent: AgentDefinition) => !agent.config.allowedProjectIds.includes(projectId)
    ? t("未分配此项目", "Not assigned to this project")
    : agent.config.executionMode !== "read-only" ? t("仅可选择只读 Agent", "Read-only Agents only") : analysisFeature(agent.config.providerInstanceId)?.available === false
      ? analysisFeature(agent.config.providerInstanceId)?.reason ?? t("Provider 不支持无工具分析", "Provider lacks no-tools analysis")
      : null;
  const chosen = value ? `${value.id}@${value.version}` : "";
  const selectedOption = pinned ? `${pinned.id}@${value!.version}` : "";
  return <div className={styles.agentBlock} aria-label={t("执行 Agent", "Execution Agent")}>
    <p className={styles.agentHelp}>{t("选择已发布的只读 Agent；执行使用它固定版本的 Provider、模型和受控指令。Agent 不授予 PM 写权限。", "Choose a published read-only Agent; execution uses that frozen version's Provider, model and bounded instructions. An Agent grants no PM write authority.")}</p>
    <Field label={t("由哪个 Agent 执行", "Which Agent executes")} issue={query.error ? t("Agent 目录读取失败；不会假定身份。", "Could not read the Agent catalog; identity is not assumed.") : undefined}>
      {id => <RadixSelect id={id} disabled={disabled || query.loading || !projectId} value={chosen || selectedOption} onChange={event => {
        const agent = agents.find(item => `${item.id}@${item.currentVersion}` === event.target.value);
        onSelect(agent ?? null);
      }}>
        <option value="">{t("自定义 Provider 与模型", "Custom Provider and model")}</option>
        {pinned && value && pinned.currentVersion !== value.version && <option value={selectedOption} disabled={reason(pinned) !== null}>{pinned.config.name} · v{value.version} {t("（已固定）", "(pinned)")}</option>}
        {agents.map(agent => <option key={agent.id} value={`${agent.id}@${agent.currentVersion}`} disabled={reason(agent) !== null}>{agent.config.name} · v{agent.currentVersion} · {agent.config.providerInstanceId} / {agent.config.model}{reason(agent) ? ` — ${reason(agent)}` : ""}</option>)}
      </RadixSelect>}
    </Field>
    {value && pinned && pinned.config.executionMode !== "read-only" && <p className={styles.dependency}>{t("此 Agent 的当前版本允许写入，不能用于只读自动化。请选择只读版本或重新配置。", "This Agent's current version allows writes and cannot run read-only automation. Select a read-only version or reconfigure it.")}</p>}
    {value && !pinned && !query.loading && <p className={styles.dependency}>{t("固定的 Agent 已停用或删除；请重新选择，原请求不会被自动改派。", "The pinned Agent is disabled or deleted; select another one. The original request is never reassigned automatically.")}</p>}
    {!query.loading && !agents.length && !query.error && <p className={styles.notice}>{t("当前工作区还没有可复用的 Agent。可继续直接选择 Provider/模型，或先创建只读 Agent。", "No reusable Agent exists in this workspace. Keep selecting a Provider/model directly, or create a read-only Agent first.")} <a href={`/agent/agents?workspaceId=${encodeURIComponent(workspaceId)}`}>{t("打开 Agents 页面", "Open Agents")}</a></p>}
    {query.error != null && <p className={styles.dependency}>{t("无法读取 Agent 目录；仍可直接选择 Provider/模型。", "The Agent catalog is unavailable; direct Provider/model selection remains available.")}</p>}
    {action.kind === "template" && action.providerInstanceId && <p className={styles.provenance}>{t("当前模型身份：", "Current model identity: ")}{value ? `${value.id}@v${value.version}` : `${action.providerInstanceId} / ${action.model}`}</p>}
  </div>;
}
