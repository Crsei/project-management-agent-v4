import { useId } from "react"
import { Brain, ChevronDown } from "lucide-react"
import type { AgentChatReasoningEffort, AgentChatStatus } from "@contracts"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useText } from "../service/pm-ui"
import styles from "./agent-chat.module.css"

const labels: Record<AgentChatReasoningEffort, [string, string]> = {
  auto: ["自动", "Auto"],
  none: ["关闭", "Off"],
  minimal: ["最低", "Minimal"],
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["超高", "Extra high"],
  max: ["最高", "Maximum"],
}

export function AgentReasoningPicker({ status, value, onChange, busy }: {
  status: AgentChatStatus | undefined
  value: AgentChatReasoningEffort
  onChange: (value: AgentChatReasoningEffort) => void
  busy: boolean
}) {
  const t = useText()
  const id = useId()
  const supported = !!status?.enabled && !!status.reasoning?.supported
  const efforts = supported ? status.reasoning!.efforts : ["auto" as const]
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" className={styles.permissionTrigger} aria-label={t("模型思考程度", "Model reasoning effort")}>
        <Brain size={14} aria-hidden="true" />
        <span>{t("思考", "Thinking")}: {t(...labels[value])}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" collisionPadding={12} className={styles.permissionPopover} aria-label={t("模型思考程度", "Model reasoning effort")}>
      <div className={styles.scopeForm}>
        <fieldset disabled={busy || !status?.enabled}>
          <legend>{t("模型思考程度", "Model reasoning effort")}</legend>
          {efforts.map(effort => <label key={effort} className={styles.scopeChoice}>
            <input type="radio" name={`${id}-reasoning`} value={effort} checked={value === effort} onChange={() => onChange(effort)} />
            <span>{t(...labels[effort])}</span>
          </label>)}
        </fieldset>
        <p className={styles.runtimeMuted}>{t("自动沿用模型默认设置；其他档位随下一条消息发送，适用于本轮全部工具调用。较高程度可能增加耗时和用量。刷新页面恢复自动，不改变 PM 权限。", "Auto uses the model default. Other levels apply to the next message and all its tool rounds. Higher effort may increase latency and usage. Reloading resets to Auto; PM permissions do not change.")}</p>
        {!status ? <p role="status">{t("正在读取模型能力…", "Loading model capabilities…")}</p> : !status.enabled ? <p>{t("模型未配置，暂不可设置。", "Configure a model before choosing its effort.")}</p> : !supported && <p>{t("当前模型或接口未声明受支持的思考档位，仅可使用默认设置。", "This model or endpoint has no declared effort support; only its default setting is available.")}</p>}
      </div>
    </PopoverContent>
  </Popover>
}
