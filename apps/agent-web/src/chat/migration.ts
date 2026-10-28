import { z } from "zod";
import { workspaceClient } from "../network.ts";

export const CHAT_MIGRATION_BACKUP_KEY = "agent-workspace:chat-migration-backup:v1";
export const CHAT_MIGRATION_MARKER_KEY = "agent-workspace:chat-migration-complete:v1";
const metadataSchema = z.array(
  z.object({
    remoteId: z.string().min(1),
    title: z.string().optional(),
    status: z.enum(["regular", "archived"]).default("regular"),
    custom: z.record(z.string(), z.unknown()).optional(),
  }),
);
const historySchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      parent_id: z.string().nullable(),
      format: z.string(),
      content: z
        .object({
          role: z.enum(["system", "user", "assistant"]),
          parts: z.array(z.object({ type: z.string() }).loose()),
          metadata: z.unknown().optional(),
        })
        .loose(),
    }),
  ),
});
// Historical defaults identify the original model; they never select a replacement native Agent.
const oldSettingsSchema = z.object({
  providerInstanceId: z.string().default("deepseek"),
  model: z.string().default("deepseek-chat"),
  systemPrompt: z.string().default(""),
  temperature: z.number().min(0).max(2).default(1),
});
let pendingMigration: Promise<void> | undefined;

export async function migrateLocalChatHistory(storage: Storage = localStorage): Promise<void> {
  if (storage.getItem(CHAT_MIGRATION_MARKER_KEY)) return;
  let backup = storage.getItem(CHAT_MIGRATION_BACKUP_KEY);
  if (!backup) {
    const entries: Record<string, string> = {};
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (
        !key ||
        !(
          key === "agent-workspace:threads" ||
          key === "agent-workspace:chat-settings" ||
          key.startsWith("agent-workspace:formatted-messages:") ||
          key.startsWith("agent-workspace:messages:")
        )
      )
        continue;
      const value = storage.getItem(key);
      if (value !== null) entries[key] = value;
    }
    if (!entries["agent-workspace:threads"]) return;
    backup = JSON.stringify({ version: 1, entries });
    // Backup must land before parsing or making any remote writes. Original keys
    // remain untouched, including on schema errors, network failures and conflicts.
    storage.setItem(CHAT_MIGRATION_BACKUP_KEY, backup);
  }
  const snapshot = z
    .object({ version: z.literal(1), entries: z.record(z.string(), z.string()) })
    .parse(JSON.parse(backup));
  const metadata = metadataSchema.parse(
    JSON.parse(snapshot.entries["agent-workspace:threads"] ?? "[]"),
  );
  const settings = snapshot.entries["agent-workspace:chat-settings"]
    ? oldSettingsSchema.parse(JSON.parse(snapshot.entries["agent-workspace:chat-settings"]))
    : undefined;
  const threads = metadata.map((thread) => {
    const histories: { format: string; messages: z.infer<typeof historySchema>["messages"] }[] = [];
    for (const [key, value] of Object.entries(snapshot.entries)) {
      if (!key.startsWith("agent-workspace:formatted-messages:")) continue;
      const [id, format] = z
        .tuple([z.string(), z.string()])
        .parse(JSON.parse(key.slice("agent-workspace:formatted-messages:".length)));
      if (id !== thread.remoteId) continue;
      histories.push({ format, ...historySchema.parse(JSON.parse(value)) });
    }
    return { ...thread, settings, histories };
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(backup));
  const migrationId = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await workspaceClient.json("/api/chat/import", {
    method: "POST",
    body: JSON.stringify({ migrationId, threads }),
  });
  storage.setItem(
    CHAT_MIGRATION_MARKER_KEY,
    JSON.stringify({ migrationId, backupKey: CHAT_MIGRATION_BACKUP_KEY }),
  );
}
export function ensureChatMigration(): Promise<void> {
  if (!pendingMigration)
    pendingMigration = migrateLocalChatHistory().catch((error: unknown) => {
      pendingMigration = undefined;
      throw new Error(
        `旧会话迁移失败，本地原件未删除；已写入的备份会保留：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  return pendingMigration;
}
