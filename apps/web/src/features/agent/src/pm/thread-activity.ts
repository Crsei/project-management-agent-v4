import type { ThreadSidebar } from "@agent-workspace/contracts/chat";
import type { AgentText } from "../i18n";

export type ThreadActivity = ThreadSidebar["activity"];

/** Display the server's chosen activity; environment and local UI flags are not status inputs. */
export function threadActivityPresentation(activity: ThreadActivity | undefined, t: AgentText) {
  const status = activity?.status ?? "idle";
  const label = {
    idle: t("空闲", "Idle"),
    queued: t("等待运行", "Queued"),
    running: t("正在运行", "Running"),
    waiting_approval: t("等待批准", "Awaiting approval"),
    waiting_input: t("等待回答", "Awaiting input"),
    failed: t("运行失败", "Failed"),
    cancelled: t("已取消", "Cancelled"),
    interrupted: t("已中断", "Interrupted"),
  }[status];
  const waiting = status === "waiting_input" || status === "waiting_approval";
  const active = waiting || status === "running" || status === "queued";
  const tone = waiting ? "warning" : status === "failed" || status === "interrupted" ? "error" : active ? "active" : "neutral";
  // Presentation priority only: request > execution > terminal > idle. Never re-derive activity.
  const priority = waiting ? 3 : active ? 2 : status === "idle" ? 0 : 1;
  return { status, label, tone, priority, active } as const;
}
