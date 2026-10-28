import {
  chatDefaultsSchema,
  chatDefaultsUpdateSchema,
  UNSELECTED_THREAD_SETTINGS,
  type ChatDefaults,
  type ChatDefaultsResponse,
} from "@agent-workspace/contracts/settings";
import { probeProviderInstance, resolveCatalogModel } from "../providers/catalog.ts";
import { getStoredInstance } from "../providers/instances.ts";
import { readRecord, transaction, writeRecord } from "../durable/store.ts";

const SETTINGS = "settings:chat-defaults";
const KEY = "default";

export class ChatDefaultsError extends Error {
  readonly status: 400 | 409 | 500;
  readonly code: string;
  constructor(status: 400 | 409 | 500, code: string, message: string) {
    super(message);
    this.name = "ChatDefaultsError";
    this.status = status;
    this.code = code;
  }
}

export function readChatDefaults(): ChatDefaults {
  const stored = readRecord<unknown>(SETTINGS, KEY);
  if (stored === null) return { revision: 0, selection: null };
  const parsed = chatDefaultsSchema.safeParse(stored);
  if (!parsed.success)
    throw new ChatDefaultsError(500, "invalid_chat_defaults", "默认模型设置已损坏，请检查本机 Agent 数据；不会自动替换模型。");
  return parsed.data;
}

/** Dynamic native catalogs are warmed only when the saved model is not known locally. */
async function validateSelection(selection: NonNullable<ChatDefaults["selection"]>): Promise<number> {
  const instance = getStoredInstance(selection.providerInstanceId);
  if (!instance) throw Object.assign(new Error("所选提供商已删除、已停用或不再受支持，请明确重新选择。"), { code: "unknown_provider" });
  if (!instance.enabled) throw Object.assign(new Error("所选提供商已禁用，请明确启用或重新选择。"), { code: "disabled_provider" });
  try {
    resolveCatalogModel(selection.providerInstanceId, selection.model);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "invalid_model") throw error;
    await probeProviderInstance(selection.providerInstanceId);
    if (getStoredInstance(selection.providerInstanceId)?.revision !== instance.revision)
      throw Object.assign(new Error("提供商已在检查时更改，请重新选择后保存。"), { status: 409, code: "provider_changed" });
    resolveCatalogModel(selection.providerInstanceId, selection.model);
  }
  return instance.revision;
}

export async function getChatDefaults(): Promise<ChatDefaultsResponse> {
  const defaults = readChatDefaults();
  if (!defaults.selection) return { defaults, availability: { status: "unset" } };
  try {
    await validateSelection(defaults.selection);
    return { defaults, availability: { status: "available" } };
  } catch (error) {
    return {
      defaults,
      availability: {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "默认模型已不可用，请重新选择。",
      },
    };
  }
}

export async function saveChatDefaults(input: unknown): Promise<ChatDefaultsResponse> {
  const update = chatDefaultsUpdateSchema.parse(input);
  const current = readChatDefaults();
  if (update.revision !== current.revision)
    throw new ChatDefaultsError(409, "chat_defaults_conflict", "默认模型已在另一页面更改。草稿已保留，请重新读取当前版本后再保存。");
  let instanceRevision: number | undefined;
  if (update.selection) {
    try {
      instanceRevision = await validateSelection(update.selection);
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 409)
        throw new ChatDefaultsError(409, "provider_changed", "提供商已在检查时更改，请重新选择后保存。");
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "invalid_model";
      throw new ChatDefaultsError(400, code, error instanceof Error ? error.message : "请选择已登记的模型提供商和模型。");
    }
  }
  const next = transaction(() => {
    if (readChatDefaults().revision !== update.revision)
      throw new ChatDefaultsError(409, "chat_defaults_conflict", "默认模型已在另一页面更改。草稿已保留，请重新读取当前版本后再保存。");
    if (update.selection) {
      const instance = getStoredInstance(update.selection.providerInstanceId);
      if (!instance?.enabled || instance.revision !== instanceRevision)
        throw new ChatDefaultsError(409, "provider_changed", "提供商已在检查时更改，请重新选择后保存。");
      try { resolveCatalogModel(update.selection.providerInstanceId, update.selection.model); }
      catch { throw new ChatDefaultsError(400, "invalid_model", "所选模型已移除，请重新选择。"); }
    }
    const defaults: ChatDefaults = { revision: update.revision + 1, selection: update.selection };
    writeRecord(SETTINGS, KEY, defaults);
    return defaults;
  });
  return { defaults: next, availability: { status: next.selection ? "available" : "unset" } };
}

/** Copy once at thread creation; later global edits never rewrite saved threads. */
export function newThreadSettingsSnapshot() {
  const defaults = readChatDefaults();
  return {
    settings: { ...UNSELECTED_THREAD_SETTINGS, ...defaults.selection },
    defaultsRevision: defaults.revision,
  };
}
