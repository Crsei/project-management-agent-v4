import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAuiState } from "@assistant-ui/react";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { useAgentText } from "../i18n";
import { chatStreams } from "./transport";
import { useGenerationOutput } from "./output-stream";
import { canRespondToInteraction } from "./output-presenter";
import { clampIndex } from "./native-interaction-model";
import { NativeInteraction } from "./native-interaction";
import "./output-timeline.css";

const panels = new Map<string, number>();
const panelListeners = new Set<() => void>();
const publish = () => { for (const listener of panelListeners) listener(); };
const subscribePanels = (listener: () => void) => { panelListeners.add(listener); return () => { panelListeners.delete(listener); }; };

/** A timeline still renders its actionable request if no composer panel is mounted. */
export function useComposerRequestPanelMounted(generationId: string): boolean {
  return useSyncExternalStore(subscribePanels, () => (panels.get(generationId) ?? 0) > 0, () => false);
}

function GenerationRequests({ generationId }: { generationId: string }) {
  const t = useAgentText();
  const { snapshot, error } = useGenerationOutput(generationId);
  const requests = snapshot?.items.filter(item => canRespondToInteraction(item, snapshot.status)) ?? [];
  const hasRequests = requests.length > 0;
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setIndex(0); setCollapsed(false); }, [generationId]);
  useEffect(() => { setIndex(value => clampIndex(value, requests.length)); }, [requests.length]);
  useEffect(() => {
    if (!hasRequests) return;
    panels.set(generationId, (panels.get(generationId) ?? 0) + 1); publish();
    return () => {
      const count = (panels.get(generationId) ?? 1) - 1;
      if (count > 0) panels.set(generationId, count); else panels.delete(generationId);
      publish();
    };
  }, [generationId, hasRequests]);
  if (error && !hasRequests) return <p className="native-error" role="alert">{t("待响应请求读取失败：", "Could not load pending requests: ")}{error}</p>;
  if (!hasRequests || !snapshot) return null;
  const currentIndex = clampIndex(index, requests.length);
  const current = requests[currentIndex]!;
  const request = current.request;
  const title = request?.title || current.title || t("需要响应", "Response needed");
  return <section className="native-composer-requests native-request-banner" id={`native-requests-${generationId}`} aria-label={t("等待你的响应", "Awaiting your response")} data-collapsed={collapsed || undefined}>
    <header className="native-request-banner-header">
      <AlertTriangle aria-hidden="true" className="native-request-banner-icon" />
      <strong className="native-request-banner-title" title={title}>{title}</strong>
      {requests.length > 1 && <span className="native-request-banner-count" aria-label={t(`第 ${currentIndex + 1} 个，共 ${requests.length} 个请求`, `Request ${currentIndex + 1} of ${requests.length}`)}>{currentIndex + 1}/{requests.length}</span>}
      {requests.length > 1 && <span className="native-request-banner-nav">
        <button type="button" disabled={currentIndex === 0} aria-label={t("上一个请求", "Previous request")} onClick={() => setIndex(value => clampIndex(value - 1, requests.length))}><ChevronLeft aria-hidden="true" /></button>
        <button type="button" disabled={currentIndex >= requests.length - 1} aria-label={t("下一个请求", "Next request")} onClick={() => setIndex(value => clampIndex(value + 1, requests.length))}><ChevronRight aria-hidden="true" /></button>
      </span>}
      <button type="button" className="native-request-banner-collapse" aria-expanded={!collapsed} aria-label={collapsed ? t("展开待响应请求", "Expand pending request") : t("收起待响应请求", "Collapse pending request")} onClick={() => setCollapsed(value => !value)}>
        {collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
      </button>
    </header>
    {!collapsed && <div className="native-request-banner-body">
      {error && <p className="native-error" role="alert">{error}</p>}
      <NativeInteraction key={request?.id ?? current.id} item={current} generationId={generationId} generationStatus={snapshot.status} />
    </div>}
  </section>;
}

export function ComposerPendingRequests() {
  const localId = useAuiState(state => state.threads.mainThreadId);
  const subscribe = useCallback((listener: () => void) => chatStreams.subscribe?.(listener, localId) ?? (() => {}), [localId]);
  const getSnapshot = useCallback(() => chatStreams.getStreamId(localId), [localId]);
  const generationId = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return generationId ? <GenerationRequests key={generationId} generationId={generationId} /> : null;
}
