import { AlertTriangleIcon, CircleCheckIcon, XIcon } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { fanoutOutcomeSummary, type FanoutOutcome } from "./model-fanout";
import "./model-fanout-banner.css";

/** Shows the server receipt for every fanout child; partial failures stay visible. */
export function ModelFanoutBanner({
  outcome,
  onOpenThread,
  onDismiss,
}: {
  outcome: FanoutOutcome;
  onOpenThread?: (threadId: string) => void;
  onDismiss?: () => void;
}) {
  const t = useAgentText();
  const summary = fanoutOutcomeSummary(outcome);
  const title = outcome.status === "created"
    ? t(`已创建 ${summary.created} 个并行会话`, `Created ${summary.created} parallel sessions`)
    : outcome.status === "partial"
      ? t(`部分会话已创建（成功 ${summary.created}，失败 ${summary.failed}）`, `Partially created (${summary.created} created, ${summary.failed} failed)`)
      : t("多模型会话创建失败", "Multi-model sessions failed");
  return <section className="model-fanout-banner" data-status={outcome.status} aria-live="polite" aria-label={t("多模型会话结果", "Multi-model result")}>
    <header>
      {outcome.status === "created" ? <CircleCheckIcon aria-hidden="true" /> : <AlertTriangleIcon aria-hidden="true" />}
      <strong>{title}</strong>
      {onDismiss && <Button type="button" size="icon" variant="ghost" aria-label={t("关闭多模型结果", "Dismiss multi-model result")} onClick={onDismiss}><XIcon aria-hidden="true" /></Button>}
    </header>
    <ul>
      {outcome.children.map((child) => <li key={child.threadId} data-error={child.error ? true : undefined}>
        <span className="model-fanout-model">{child.selection.model}</span>
        {child.error
          ? <span role="alert" className="model-fanout-error">{child.error}</span>
          : <Button type="button" size="sm" variant="outline" disabled={!onOpenThread} onClick={() => onOpenThread?.(child.threadId)}>{t("打开会话", "Open session")}</Button>}
      </li>)}
    </ul>
    <p>{t("每个模型拥有独立会话与工作树；多模型结果不会自动完成 PM 工作项。", "Each model has its own session and worktree; multi-model results never complete PM work items.")}</p>
  </section>;
}
