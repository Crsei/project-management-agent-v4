import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useAgentText } from "../i18n";
import { chatStreams } from "./transport";
import { useGenerationOutput } from "./output-stream";
import { canRespondToInteraction } from "./output-presenter";
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
  useEffect(() => {
    if (!hasRequests) return;
    panels.set(generationId, (panels.get(generationId) ?? 0) + 1); publish();
    return () => {
      const count = (panels.get(generationId) ?? 1) - 1;
      if (count > 0) panels.set(generationId, count); else panels.delete(generationId);
      publish();
    };
  }, [generationId, hasRequests]);
  if (!hasRequests || !snapshot) return error ? <p className="native-error" role="alert">{t("待响应请求读取失败：", "Could not load pending requests: ")}{error}</p> : null;
  return <section className="native-composer-requests" id={`native-requests-${generationId}`} aria-label={t("等待你的响应", "Awaiting your response")}>
    {error && <p className="native-error" role="alert">{error}</p>}
    {requests.map(item => <section key={item.request?.id ?? item.id} className="native-composer-request">
      <h3>{item.request?.title || item.title || t("需要响应", "Response needed")}</h3>
      <NativeInteraction item={item} generationId={generationId} generationStatus={snapshot.status} />
    </section>)}
  </section>;
}

export function ComposerPendingRequests() {
  const localId = useAuiState(state => state.threads.mainThreadId);
  const subscribe = useCallback((listener: () => void) => chatStreams.subscribe?.(listener, localId) ?? (() => {}), [localId]);
  const getSnapshot = useCallback(() => chatStreams.getStreamId(localId), [localId]);
  const generationId = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return generationId ? <GenerationRequests key={generationId} generationId={generationId} /> : null;
}
