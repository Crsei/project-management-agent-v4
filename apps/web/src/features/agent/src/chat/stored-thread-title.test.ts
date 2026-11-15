import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadMessage } from "@assistant-ui/react";
import { createStoredThreadTitleReader, storedThreadTitle } from "./stored-thread-title.ts";

const promptMessages: readonly ThreadMessage[] = [{
  id: "first-user-message",
  role: "user",
  createdAt: new Date("2026-11-15T00:00:00Z"),
  content: [{ type: "text", text: "Please help me implement the first user request, which must never automatically become the conversation title." }],
  attachments: [],
  metadata: { custom: {} },
}];

async function readTitle(stream: ReadableStream<{ type: string; textDelta?: string }>) {
  let title: string | undefined;
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return title;
      if (next.value.type === "text-delta" && typeof next.value.textDelta === "string") {
        title = (title ?? "") + next.value.textDelta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createTitleBackend(initialTitle?: string) {
  let thread = { title: initialTitle };
  let nextRead: { started: () => void; gate: Promise<void> } | undefined;
  const client = {
    async json<T>(_path: string, init?: RequestInit): Promise<T> {
      if (init?.method === "PUT") {
        const patch = JSON.parse(String(init.body)) as { title: string };
        thread = { ...thread, title: patch.title };
        return { thread: { ...thread } } as T;
      }
      if ((init?.method ?? "GET") !== "GET") throw new Error("Unsupported title operation");
      const snapshot = { thread: { ...thread } };
      const delayed = nextRead;
      nextRead = undefined;
      if (delayed) {
        delayed.started();
        await delayed.gate;
      }
      return snapshot as T;
    },
  };
  return {
    client,
    delayNextRead() {
      const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      nextRead = { started: signalStarted, gate };
      return { started, release };
    },
  };
}

test("automatic title hook preserves a nontrivial saved title instead of deriving the first prompt", async () => {
  const title = "  RunLedger · 运行面板验证  ";
  const { client } = createTitleBackend(title);
  const emitted = await readTitle(await createStoredThreadTitleReader(client)("session", promptMessages));
  assert.equal(emitted, title);
  assert.equal((await client.json<{ thread: { title: string } }>("/api/chat/threads/session")).thread.title, title);
});

test("missing or blank saved titles leave localized UI fallbacks intact without streaming a blank title", async () => {
  for (const title of [undefined, "", "  \n\t"]) {
    assert.equal(storedThreadTitle({ title }), undefined);
    const { client } = createTitleBackend(title);
    assert.equal(await readTitle(await createStoredThreadTitleReader(client)("untitled", promptMessages)), undefined);
    assert.equal((await client.json<{ thread: { title?: string } }>("/api/chat/threads/untitled")).thread.title, title);
  }
  assert.equal(storedThreadTitle({ title: "  User chosen title  " }), "  User chosen title  ");
});

test("a delayed automatic title read cannot clobber a concurrent persisted rename", async () => {
  const backend = createTitleBackend("Earlier persisted title");
  const delayed = backend.delayNextRead();
  const generateTitle = createStoredThreadTitleReader(backend.client);
  const pending = generateTitle("racing-session", promptMessages);
  await delayed.started;
  const winningTitle = "RunLedger · 运行面板验证";
  await backend.client.json("/api/chat/threads/racing-session", {
    method: "PUT",
    body: JSON.stringify({ title: winningTitle }),
  });
  delayed.release();
  await readTitle(await pending);
  const saved = await backend.client.json<{ thread: { title: string } }>("/api/chat/threads/racing-session");
  assert.equal(saved.thread.title, winningTitle, "automatic completion must not re-persist an older title");
  assert.equal(await readTitle(await generateTitle("racing-session", promptMessages)), winningTitle);
});

test("a failed title read propagates rather than replacing a saved title with a fallback", async () => {
  const failure = new Error("title metadata unavailable");
  const client = { async json<T>(): Promise<T> { throw failure; } };
  await assert.rejects(createStoredThreadTitleReader(client)("unavailable", promptMessages), error => error === failure);
});
