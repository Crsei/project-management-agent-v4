"use client";

import { AlertTriangleIcon, ArrowUpIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { TooltipIconButton } from "@agent/components/assistant-ui/elements/tooltip-icon-button";
import { useAgentText } from "../i18n";
import type { ComposerFanoutCopy } from "./composer-fanout.ts";
import "./composer-fanout.css";

/**
 * The primary send control while models are stacked. It stays clickable when a
 * blocker exists so pressing it surfaces the explicit reason, but it can never
 * fall through to a single-session send.
 */
export function FanoutSendButton({
  pending,
  blocker,
  onClick,
}: {
  pending: boolean;
  blocker?: ComposerFanoutCopy | null;
  onClick: () => void;
}) {
  const t = useAgentText();
  const label = t("多模型发送", "Multi-model send");
  const tooltip = blocker
    ? t(blocker.zh, blocker.en)
    : t("向叠选的每个模型并行发送纯文字消息", "Fan out this plain-text message to every stacked model");
  return <TooltipIconButton
    type="button"
    tooltip={tooltip}
    aria-label={label}
    aria-busy={pending || undefined}
    disabled={pending}
    variant="default"
    size="icon"
    className="aui-composer-send composer-fanout-send size-7 rounded-full"
    onClick={onClick}
  >
    {pending
      ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      : <ArrowUpIcon className="size-4" aria-hidden="true" />}
  </TooltipIconButton>;
}

/**
 * Composer-local feedback for a blocked or failed fanout. Retrying re-posts the
 * stored operation id instead of creating a new operation.
 */
export function ComposerFanoutStatus({
  message,
  pending,
  canRetry,
  onRetry,
  onDismiss,
}: {
  message: string;
  pending: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onDismiss?: () => void;
}) {
  const t = useAgentText();
  return <section className="composer-fanout-status" role="alert" aria-live="assertive" data-pending={pending || undefined}>
    <AlertTriangleIcon aria-hidden="true" />
    <p>{message}</p>
    {canRetry && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onRetry}>
      {pending ? t("正在核对…", "Checking…") : t("重新核对同一操作", "Re-check the same operation")}
    </Button>}
    {onDismiss && <Button type="button" size="icon" variant="ghost" aria-label={t("关闭提示", "Dismiss notice")} onClick={onDismiss}>
      <XIcon aria-hidden="true" />
    </Button>}
  </section>;
}
