import { useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, RefreshCwIcon, SettingsIcon, SlidersHorizontalIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import type { ProviderSendIssue } from "../chat/provider-send-issue";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import {
  environmentStatusItem,
  generationStatusItem,
  providerCatalogStatusItem,
  providerAuthStatusItem,
  providerReadinessItem,
  providerStatusItem,
  readDismissed,
  rememberDismissed,
  sortStatusItems,
  visibleStatusItems,
  type ChatStatusAction,
  type ChatStatusItem,
} from "./chat-status-model";
import styles from "./chat-status-banner.module.css";

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Latest generation record drives generation banners. It is read once per
 * session and after a run finishes, never polled: a missing record hides the
 * banner instead of assuming an outcome.
 */
function useLatestGeneration(threadId: string | undefined, running: boolean): ChatGenerationView | undefined {
  const [generation, setGeneration] = useState<ChatGenerationView>();
  useEffect(() => {
    setGeneration(undefined);
    if (!threadId) return;
    let alive = true;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const body = await workspaceClient.json<{ generations: ChatGenerationView[] }>(
          `/api/chat/threads/${encodeURIComponent(threadId)}/generations`,
          { cache: "no-store" },
        );
        if (alive) setGeneration(body.generations[0]);
      } catch {
        if (alive) setGeneration(undefined);
      } finally {
        busy = false;
      }
    };
    void read();
    const online = () => void read();
    window.addEventListener("online", online);
    return () => {
      alive = false;
      window.removeEventListener("online", online);
    };
  }, [threadId, running]);
  return generation;
}

const actionIcons: Record<ChatStatusAction, typeof RefreshCwIcon> = {
  retry: RefreshCwIcon,
  "provider-settings": SettingsIcon,
  "session-settings": SlidersHorizontalIcon,
};

/**
 * Floating status lane above the transcript. It never covers the composer, and
 * dismissals are remembered per session so a resolved banner stays quiet.
 */
export function ChatStatusLane({
  threadId,
  running,
  provider,
  catalogError,
  environmentError,
  onRetryCatalog,
  onRetryEnvironment,
  onOpenProviderSettings,
  onOpenSessionSettings,
}: {
  threadId?: string;
  running: boolean;
  provider?: {
    instanceId: string;
    name?: string;
    issue?: ProviderSendIssue;
    authStatus?: string;
    nativeSessionReady?: boolean;
    modelCount?: number;
    lastError?: string;
  };
  catalogError?: string;
  environmentError?: string;
  onRetryCatalog?: () => void;
  onRetryEnvironment?: () => void;
  onOpenProviderSettings?: () => void;
  onOpenSessionSettings?: () => void;
}) {
  const t = useAgentText();
  const generation = useLatestGeneration(threadId, running);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set<string>());
  useEffect(() => {
    const store = sessionStore();
    setDismissed(store ? readDismissed(store, threadId) : new Set<string>());
  }, [threadId]);
  const items = useMemo(() => {
    const next: ChatStatusItem[] = [];
    const environment = environmentStatusItem(environmentError, t);
    if (environment) next.push(environment);
    const failed = generationStatusItem(generation, t);
    if (failed) next.push(failed);
    if (provider) {
      if (provider.issue) {
        next.push(providerStatusItem({ instanceId: provider.instanceId, name: provider.name, issue: provider.issue }, t));
      } else {
        const auth = providerAuthStatusItem(
          {
            instanceId: provider.instanceId,
            name: provider.name,
            authStatus: provider.authStatus ?? "unknown",
            nativeSessionReady: provider.nativeSessionReady ?? true,
          },
          t,
        );
        if (auth) next.push(auth);
        else {
          const readiness = providerReadinessItem(
            {
              instanceId: provider.instanceId,
              name: provider.name,
              nativeSessionReady: provider.nativeSessionReady,
              modelCount: provider.modelCount,
              lastError: provider.lastError,
            },
            t,
          );
          if (readiness) next.push(readiness);
        }
      }
    }
    const catalog = providerCatalogStatusItem(catalogError, t);
    if (catalog) next.push(catalog);
    return sortStatusItems(next);
  }, [catalogError, environmentError, generation, provider, t]);
  const visible = visibleStatusItems(items, dismissed);
  if (!visible.length) return null;

  const dismiss = (item: ChatStatusItem) => {
    const store = sessionStore();
    setDismissed((current) => store ? rememberDismissed(store, threadId, item.id) : new Set(current).add(item.id));
  };
  const act = (action: ChatStatusAction, item: ChatStatusItem) => {
    if (action === "retry") {
      if (item.category === "environment") onRetryEnvironment?.();
      else onRetryCatalog?.();
    } else if (action === "provider-settings") onOpenProviderSettings?.();
    else onOpenSessionSettings?.();
  };
  const actionLabels: Record<ChatStatusAction, string> = {
    retry: t("重试", "Retry"),
    "provider-settings": t("Provider 设置", "Provider settings"),
    "session-settings": t("会话参数", "Session settings"),
  };

  return (
    <div className={styles.lane} role="region" aria-label={t("会话状态与错误", "Session status and errors")}>
      {visible.map((item) => {
        const reset = item.resetAt ? Date.parse(item.resetAt) : NaN;
        return (
          <article
            key={item.id}
            className={styles.item}
            data-tone={item.tone}
            role={item.tone === "error" ? "alert" : "status"}
          >
            {item.tone === "error"
              ? <CircleAlertIcon className={styles.icon} aria-hidden="true" />
              : <TriangleAlertIcon className={styles.icon} aria-hidden="true" />}
            <div className={styles.copy}>
              <div className={styles.heading}>
                <strong>{item.title}</strong>
                {item.code && <code className={styles.code} title={t("服务器报告的错误分类", "Error class reported by the server")}>{item.code}</code>}
              </div>
              <p className={styles.message}>{item.message}</p>
              {Number.isFinite(reset) && (
                <p className={styles.meta}>{t(`额度重置：${new Date(reset).toLocaleString()}`, `Quota reset: ${new Date(reset).toLocaleString()}`)}</p>
              )}
            </div>
            <div className={styles.actions}>
              {item.actions.map((action) => {
                const Icon = actionIcons[action];
                return (
                  <button key={action} type="button" className={styles.action} onClick={() => act(action, item)}>
                    <Icon aria-hidden="true" />
                    {actionLabels[action]}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.dismiss}
              aria-label={t("本次会话不再显示此提示", "Dismiss this notice for this session")}
              title={t("本次会话不再显示此提示", "Dismiss this notice for this session")}
              onClick={() => dismiss(item)}
            >
              <XIcon aria-hidden="true" />
            </button>
          </article>
        );
      })}
    </div>
  );
}
