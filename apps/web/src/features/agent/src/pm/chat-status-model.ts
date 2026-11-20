import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import type { AgentText } from "../i18n";
import type { ProviderSendIssue } from "../chat/provider-send-issue";

/**
 * One classified banner item. Text and codes come from reported state only; a
 * missing error class never invents a code, and a missing message stays marked
 * as unreported instead of being paraphrased into a cause.
 */
export type ChatStatusCategory = "environment" | "generation" | "provider";
export type ChatStatusTone = "error" | "warning";
export type ChatStatusAction = "retry" | "provider-settings" | "session-settings";

export type ChatStatusItem = {
  id: string;
  category: ChatStatusCategory;
  tone: ChatStatusTone;
  title: string;
  message: string;
  /** Reported `errorClass` verbatim; absent when the server reported none. */
  code?: string;
  resetAt?: string;
  actions: readonly ChatStatusAction[];
};

const providerActions: readonly ChatStatusAction[] = ["provider-settings"];

export function generationStatusItem(
  generation: Pick<ChatGenerationView, "id" | "status" | "error" | "errorClass" | "resetAt"> | undefined,
  t: AgentText,
): ChatStatusItem | undefined {
  if (!generation || generation.status !== "failed") return undefined;
  const code = generation.errorClass?.trim() || undefined;
  return {
    id: `generation:${generation.id}`,
    category: "generation",
    tone: "error",
    title: t("本轮回复失败", "This reply failed"),
    message: generation.error?.trim() || t("未报告错误详情。", "No error details were reported."),
    ...(code ? { code } : {}),
    ...(generation.resetAt ? { resetAt: generation.resetAt } : {}),
    actions:
      code === "authentication" || code === "usage_limit" || code === "provider_error"
        ? providerActions
        : code === "unsupported"
          ? ["session-settings"]
          : [],
  };
}

export function providerStatusItem(
  input: { instanceId: string; name?: string; issue: ProviderSendIssue },
  t: AgentText,
): ChatStatusItem {
  const name = input.name?.trim() || input.instanceId;
  const base = { id: `provider:${input.instanceId}:${input.issue}`, category: "provider" as const, actions: providerActions };
  if (input.issue === "missing") {
    return {
      ...base,
      tone: "error",
      title: t("未找到 Provider 配置", "Provider configuration not found"),
      message: t("当前会话选择的 Provider 不在目录中；发送已被阻止。", "The Provider selected for this session is not in the catalog; sending is blocked."),
    };
  }
  if (input.issue === "disabled") {
    return {
      ...base,
      tone: "warning",
      title: t(`${name} 已停用`, `${name} is disabled`),
      message: t("在 Provider 设置中启用后才能发送。", "Enable it in provider settings before sending."),
    };
  }
  return {
    ...base,
    tone: "error",
    title: t(`${name} 未安装`, `${name} is not installed`),
    message: t("未检测到可执行文件；请在 Provider 设置中安装。", "No executable was detected; install it in provider settings."),
  };
}

export function providerAuthStatusItem(
  input: { instanceId: string; name?: string; authStatus: string; nativeSessionReady: boolean },
  t: AgentText,
): ChatStatusItem | undefined {
  // Only a checked, failed readiness state is reported; unknown stays silent.
  if (input.authStatus !== "unauthenticated" || input.nativeSessionReady) return undefined;
  const name = input.name?.trim() || input.instanceId;
  return {
    id: `provider-auth:${input.instanceId}:unauthenticated`,
    category: "provider",
    tone: "warning",
    title: t(`${name} 报告未认证`, `${name} reports unauthenticated`),
    message: t("Provider 执行器尚未就绪；请在 Provider 设置中确认登录状态。", "The provider runtime is not ready; confirm its sign-in state in provider settings."),
    actions: providerActions,
  };
}

/**
 * A checked runtime that cannot serve the selected model blocks sending even
 * when the provider is enabled and installed. The probe error is reported
 * verbatim; a missing readiness observation stays silent.
 */
export function providerReadinessItem(
  input: { instanceId: string; name?: string; nativeSessionReady?: boolean; modelCount?: number; lastError?: string },
  t: AgentText,
): ChatStatusItem | undefined {
  if (input.nativeSessionReady === undefined && input.modelCount === undefined) return undefined;
  if (input.nativeSessionReady !== false && (input.modelCount ?? 0) > 0) return undefined;
  const name = input.name?.trim() || input.instanceId;
  const detail = input.lastError?.trim();
  const reason = input.nativeSessionReady === false
    ? t("执行器尚未就绪，没有可用的模型目录。", "The runtime is not ready and reported no usable model catalog.")
    : t("没有可用的模型目录。", "No usable model catalog was reported.");
  return {
    id: `provider-readiness:${input.instanceId}:${input.nativeSessionReady === false ? "not-ready" : "no-models"}${detail ? `:${detail}` : ""}`,
    category: "provider",
    tone: "warning",
    title: t("Provider 暂不可用", "Provider is unavailable"),
    message: [
      `${name}：${reason}`,
      detail ? t(`服务端探测结果：${detail}`, `Server probe: ${detail}`) : undefined,
      t("发送已暂停；可在 Provider 设置中检查连接或登录状态。", "Sending is paused; check the connection or sign-in state in provider settings."),
    ].filter((part): part is string => !!part).join(" "),
    actions: providerActions,
  };
}

export function providerCatalogStatusItem(error: string | undefined, t: AgentText): ChatStatusItem | undefined {
  const message = error?.trim();
  if (!message) return undefined;
  return {
    id: `provider-catalog:${message}`,
    category: "provider",
    tone: "error",
    title: t("Provider 目录读取失败", "Failed to load the provider catalog"),
    message,
    actions: ["retry", "provider-settings"],
  };
}

export function environmentStatusItem(error: string | undefined, t: AgentText): ChatStatusItem | undefined {
  const message = error?.trim();
  if (!message) return undefined;
  return {
    id: `environment:${message}`,
    category: "environment",
    tone: "error",
    title: t("执行环境不可用", "Execution environment unavailable"),
    message,
    actions: ["retry"],
  };
}

const categoryOrder: Record<ChatStatusCategory, number> = { environment: 0, generation: 1, provider: 2 };

export function sortStatusItems(items: readonly ChatStatusItem[]): ChatStatusItem[] {
  return [...items].sort((left, right) => {
    if (left.tone !== right.tone) return left.tone === "error" ? -1 : 1;
    return categoryOrder[left.category] - categoryOrder[right.category];
  });
}

const DISMISS_PREFIX = "pm-agent-chat-status:v1";

/** Dismissal is scoped to the session (drafts share one scope); never global. */
export function dismissStorageKey(threadId: string | undefined): string {
  return `${DISMISS_PREFIX}:${threadId ?? "draft"}`;
}

export function readDismissed(
  storage: Pick<Storage, "getItem">,
  threadId: string | undefined,
): ReadonlySet<string> {
  try {
    const raw = storage.getItem(dismissStorageKey(threadId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberDismissed(
  storage: Pick<Storage, "getItem" | "setItem">,
  threadId: string | undefined,
  itemId: string,
): ReadonlySet<string> {
  const next = new Set(readDismissed(storage, threadId));
  next.add(itemId);
  try {
    storage.setItem(dismissStorageKey(threadId), JSON.stringify([...next]));
  } catch {
    // A blocked storage only forgets the dismissal; the banner stays truthful.
  }
  return next;
}

export function visibleStatusItems(
  items: readonly ChatStatusItem[],
  dismissed: ReadonlySet<string>,
): ChatStatusItem[] {
  return items.filter((item) => !dismissed.has(item.id));
}
