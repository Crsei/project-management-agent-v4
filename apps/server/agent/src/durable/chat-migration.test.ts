import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import {
  migrateLocalChatHistory,
  ensureChatMigration,
  CHAT_MIGRATION_BACKUP_KEY,
  CHAT_MIGRATION_MARKER_KEY,
} from "../../../../web/src/features/agent/src/chat/migration.ts";
import { chatRoutes } from "../chat.ts";
import { closeStore } from "./store.ts";
import { getThread, getThreadHistory, saveFormattedMessage } from "./threads.ts";

class BrowserStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
const originalFetch = globalThis.fetch;
const originalDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chat-migration-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  closeStore();
  await rm(directory, { recursive: true, force: true });
  if (originalDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDirectory;
});
function legacyStorage() {
  const storage = new BrowserStorage();
  storage.setItem(
    "agent-workspace:threads",
    JSON.stringify([{ remoteId: "legacy-thread", title: "原会话", status: "regular" }]),
  );
  storage.setItem(
    "agent-workspace:chat-settings",
    JSON.stringify({
      model: "deepseek-reasoner",
      systemPrompt: "旧指令",
      temperature: 0.7,
      dictation: true,
    }),
  );
  storage.setItem(
    'agent-workspace:formatted-messages:["legacy-thread","ai-sdk/v6"]',
    JSON.stringify({
      messages: [
        {
          id: "user-legacy",
          parent_id: null,
          format: "ai-sdk/v6",
          content: {
            role: "user",
            parts: [{ type: "text", text: "旧问题" }],
            metadata: { custom: { quote: { text: "持久引用", messageId: "quoted" } } },
          },
        },
        {
          id: "assistant-legacy",
          parent_id: "user-legacy",
          format: "ai-sdk/v6",
          content: { role: "assistant", parts: [{ type: "text", text: "旧回答" }] },
        },
      ],
    }),
  );
  return storage;
}
function useLocalRoutes() {
  const app = new Hono().route("/agent/api", chatRoutes);
  globalThis.fetch = async (input, init) => app.request(`http://localhost${String(input)}`, init);
}

test("migration retains an immutable backup and original keys, migrates quotes/settings, and repeats idempotently", async () => {
  useLocalRoutes();
  const storage = legacyStorage();
  const original = storage.getItem("agent-workspace:threads");
  await migrateLocalChatHistory(storage);
  const backup = storage.getItem(CHAT_MIGRATION_BACKUP_KEY);
  assert.ok(backup);
  assert.ok(storage.getItem(CHAT_MIGRATION_MARKER_KEY));
  assert.equal(storage.getItem("agent-workspace:threads"), original);
  assert.equal(getThread("legacy-thread")!.settings.model, "deepseek-reasoner");
  assert.match(JSON.stringify(getThreadHistory("legacy-thread")), /持久引用/);
  saveFormattedMessage(
    "legacy-thread",
    {
      id: "live-output",
      parent_id: "assistant-legacy",
      format: "ai-sdk/v6",
      content: { role: "assistant", parts: [{ type: "text", text: "authoritative live result" }] },
    },
    true,
  );
  storage.removeItem(CHAT_MIGRATION_MARKER_KEY); // Simulate a crash after remote commit, before local marker.
  await migrateLocalChatHistory(storage);
  assert.equal(storage.getItem(CHAT_MIGRATION_BACKUP_KEY), backup);
  assert.match(JSON.stringify(getThreadHistory("legacy-thread")), /authoritative live result/);
});

test("failed network import keeps backup and input, then retries without starting a generation", async () => {
  const storage = legacyStorage();
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };
  await assert.rejects(migrateLocalChatHistory(storage), /network unavailable/);
  const backup = storage.getItem(CHAT_MIGRATION_BACKUP_KEY);
  assert.ok(backup);
  assert.equal(storage.getItem(CHAT_MIGRATION_MARKER_KEY), null);
  assert.match(storage.getItem("agent-workspace:threads")!, /原会话/);
  assert.equal(getThread("legacy-thread"), null);
  useLocalRoutes();
  await migrateLocalChatHistory(storage);
  assert.equal(storage.getItem(CHAT_MIGRATION_BACKUP_KEY), backup);
  assert.equal(getThreadHistory("legacy-thread").messages.length, 2);
});

test("corrupt legacy data never imports a partial thread or clears the source", async () => {
  useLocalRoutes();
  const storage = legacyStorage();
  storage.setItem('agent-workspace:formatted-messages:["legacy-thread","ai-sdk/v6"]', "not-json{");
  await assert.rejects(migrateLocalChatHistory(storage));
  assert.ok(storage.getItem(CHAT_MIGRATION_BACKUP_KEY));
  assert.equal(storage.getItem(CHAT_MIGRATION_MARKER_KEY), null);
  assert.equal(getThread("legacy-thread"), null);
  assert.equal(
    storage.getItem('agent-workspace:formatted-messages:["legacy-thread","ai-sdk/v6"]'),
    "not-json{",
  );
});

test("backup failure prevents remote import and leaves all original keys available", async () => {
  const storage = legacyStorage();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("must not send");
  };
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === CHAT_MIGRATION_BACKUP_KEY) throw new Error("quota exceeded");
    setItem(key, value);
  };
  await assert.rejects(migrateLocalChatHistory(storage), /quota exceeded/);
  assert.equal(requests, 0);
  assert.equal(storage.getItem(CHAT_MIGRATION_MARKER_KEY), null);
  assert.ok(storage.getItem("agent-workspace:threads"));
});

test("migration failure localization follows the current browser language and retains retryable backup", async (t) => {
  const descriptors = new Map(["document", "localStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const storage = legacyStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Reflect.deleteProperty(globalThis, "document");
  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  await assert.rejects(ensureChatMigration(), /旧会话迁移失败.*network unavailable/);
  const backup = storage.getItem(CHAT_MIGRATION_BACKUP_KEY);
  assert.ok(backup);
  assert.equal(storage.getItem(CHAT_MIGRATION_MARKER_KEY), null);
  const document = { documentElement: { lang: "en" } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  await assert.rejects(ensureChatMigration(), /Migrating old sessions failed.*network unavailable/);
  document.documentElement.lang = "zh-CN";
  await assert.rejects(ensureChatMigration(), /旧会话迁移失败.*network unavailable/);
  assert.equal(storage.getItem(CHAT_MIGRATION_BACKUP_KEY), backup);
  assert.ok(storage.getItem("agent-workspace:threads"));
  assert.equal(getThread("legacy-thread"), null);
  useLocalRoutes();
  await ensureChatMigration();
  assert.equal(storage.getItem(CHAT_MIGRATION_BACKUP_KEY), backup);
  assert.ok(storage.getItem(CHAT_MIGRATION_MARKER_KEY));
  assert.equal(getThreadHistory("legacy-thread").messages.length, 2);
});
