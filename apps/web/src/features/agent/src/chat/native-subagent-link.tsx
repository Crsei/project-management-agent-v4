import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { useAgentText } from "../i18n";
import { useChatActions } from "./chat-actions";
import { resolveSubagent } from "./thread-actions";
import { formatElapsedMs, subagentElapsedMs } from "./output-detail-model";

function shortSessionId(value: string): string {
  return /^[\w-]{9,}$/u.test(value) ? `${value.slice(0, 8)}…` : value;
}

const STATUS_LABEL: Record<NativeOutputItem["status"], readonly [string, string]> = {
  pending: ["待处理", "Pending"],
  running: ["进行中", "Running"],
  waiting: ["等待中", "Waiting"],
  completed: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  cancelled: ["已取消", "Cancelled"],
  interrupted: ["已中断", "Interrupted"],
  unknown: ["待核实", "Awaiting reconciliation"],
} as const;

/** Provider child IDs are not assumed to be authorized local thread IDs. */
export function NativeSubagentLink({ generationId, item }: { generationId: string; item: NativeOutputItem }) {
  const t = useAgentText();
  const actions = useChatActions();
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const [error, setError] = useState<string>();
  const elapsed = subagentElapsedMs(item);
  const [zh, en] = STATUS_LABEL[item.status];
  const open = async () => {
    if (!actions || pending) return;
    setPending(true); setError(undefined); setUnavailable(undefined);
    try {
      const result = await resolveSubagent(generationId, item.id);
      if (result.threadId) await actions.navigateSession(result.threadId);
      else setUnavailable(result.reason || t("此原生子代理没有可访问的工作台会话。", "This native subagent has no accessible workspace session."));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <div className="native-subagent-bar" data-status={item.status}>
    <div className="native-subagent-facts">
      <span className="native-subagent-model" title={item.model}>{item.model || t("模型未报告", "Model not reported")}</span>
      <span className="native-subagent-status">{t(zh, en)}</span>
      {elapsed !== undefined && <span className="native-subagent-elapsed" title={t("开始与结束时间均由 Provider 提供。", "Both the start and end timestamps came from the provider.")}>{formatElapsedMs(elapsed)}</span>}
      {item.childSessionId && <span className="native-subagent-child" title={item.childSessionId}>{t("子会话", "Child session")} <code>{shortSessionId(item.childSessionId)}</code></span>}
    </div>
    <Button type="button" variant="outline" size="sm" disabled={!actions || pending} onClick={() => void open()}><GitBranch aria-hidden="true" />{pending ? t("正在解析会话…", "Resolving session…") : t("打开子代理会话", "Open subagent session")}</Button>
    {unavailable && <p role="status">{unavailable}</p>}
    {error && <p role="alert" className="native-error">{error}</p>}
  </div>;
}
