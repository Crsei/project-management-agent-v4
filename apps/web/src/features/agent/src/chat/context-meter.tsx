import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { ThreadUsageSnapshot } from "@agent-workspace/contracts/usage";
import { useAgentText } from "../i18n";
import { usageApi } from "../usage/api";
import { contextMeterState, formatContextPercent, formatContextTokens } from "./context-meter-model";
import "./context-meter.css";

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Read-only context window indicator. A limit or compaction action is never fabricated. */
export function ContextMeter() {
  const t = useAgentText();
  const threadId = useAuiState(state => state.threads.threadItems.find(item => item.id === state.threads.mainThreadId)?.remoteId);
  const running = useAuiState(state => state.thread.isRunning);
  const [snapshot, setSnapshot] = useState<ThreadUsageSnapshot>();
  useEffect(() => {
    if (!threadId) { setSnapshot(undefined); return; }
    let alive = true;
    let timer: number | undefined;
    const load = () => {
      void usageApi.thread(threadId).then(value => { if (alive) setSnapshot(value); }, () => { /* Keep the last authorized snapshot; composer must not surface usage noise. */ });
    };
    load();
    if (running) timer = window.setInterval(load, 5000);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [threadId, running]);
  const state = contextMeterState(snapshot);
  if (!threadId || !state) return null;
  const percent = formatContextPercent(state.percent);
  const label = percent
    ? t(`上下文窗口已用 ${percent}`, `Context window ${percent} used`)
    : t(`上下文已用 ${formatContextTokens(state.usedTokens)} tokens`, `Context ${formatContextTokens(state.usedTokens)} tokens used`);
  const offset = RING_CIRCUMFERENCE * (1 - (state.percent ?? 0) / 100);
  return <Popover>
    <PopoverTrigger render={<button type="button" className="context-meter" aria-label={label} title={label} />}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="context-meter-ring" data-empty={state.percent === undefined || undefined}>
        <circle cx="12" cy="12" r={RING_RADIUS} className="context-meter-track" />
        {state.percent !== undefined && <circle cx="12" cy="12" r={RING_RADIUS} className="context-meter-value" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={offset} transform="rotate(-90 12 12)" />}
      </svg>
      <span className="context-meter-label" aria-hidden="true">{percent ?? formatContextTokens(state.usedTokens)}</span>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-[min(20rem,90vw)] space-y-2 p-3 text-xs">
      <PopoverTitle className="text-sm font-medium">{t("上下文窗口", "Context window")}</PopoverTitle>
      <dl className="context-meter-facts">
        <dt>{t("已用", "Used")}</dt><dd>{formatContextTokens(state.usedTokens)} tokens</dd>
        <dt>{t("上限", "Limit")}</dt><dd>{state.maxTokens === undefined ? t("未报告", "Not reported") : `${formatContextTokens(state.maxTokens)} tokens`}</dd>
        {percent && <><dt>{t("占比", "Share")}</dt><dd>{percent}</dd></>}
        {state.model && <><dt>{t("模型", "Model")}</dt><dd>{state.model}</dd></>}
        <dt>{t("观测时间", "Observed")}</dt><dd>{new Date(state.updatedAt).toLocaleString()}</dd>
      </dl>
      <p className="text-muted-foreground">{t("只读快照；不会自动压缩上下文。", "Read-only snapshot; context is not compacted automatically.")}</p>
    </PopoverContent>
  </Popover>;
}
