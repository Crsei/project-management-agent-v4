import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createWorkspaceClient, WorkspaceClientError } from "./index.ts";

test("HTTP and WebSocket URLs retain encoded API paths and the trusted service origin", () => {
  const client = createWorkspaceClient({ baseUrl: "https://service.example:8443/" });
  const path = `/api/chat/streams/${encodeURIComponent("stream/a?b")}?after=3&format=ai-sdk%2Fv6`;
  assert.equal(client.url(path), `https://service.example:8443${path}`);
  assert.equal(client.webSocketUrl("/api/terminal"), "wss://service.example:8443/api/terminal");
  assert.equal(
    createWorkspaceClient({ baseUrl: "http://[::1]:3000" }).webSocketUrl("/api/terminal"),
    "ws://[::1]:3000/api/terminal",
  );
  const relative = createWorkspaceClient();
  assert.equal(relative.url("/api/chat?after=2"), "/api/chat?after=2");
  assert.throws(() => relative.url("https://service.example/api/chat"), TypeError);
  assert.throws(() => relative.webSocketUrl("/api/terminal"), TypeError);
});

test("mount prefixes are applied once to strings, URLs, Requests and WebSockets", async () => {
  const controller = new AbortController();
  const client = createWorkspaceClient({
    baseUrl: "https://service.example",
    basePath: "/agent/",
    fetch: async (input, init) => {
      const sent = new Request(input, init);
      assert.equal(sent.url, "https://service.example/agent/api/chat?after=3");
      assert.equal(sent.method, "POST");
      assert.equal(sent.credentials, "same-origin");
      assert.equal(sent.redirect, "error");
      assert.equal(sent.headers.get("x-message"), "stable");
      assert.equal(await sent.text(), "message");
      controller.abort();
      assert.equal(sent.signal.aborted, true);
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(client.url("/api/chat"), "https://service.example/agent/api/chat");
  assert.equal(client.url(client.url("/api/chat")), "https://service.example/agent/api/chat");
  assert.equal(client.url(new URL("https://service.example/api/chat")), "https://service.example/agent/api/chat");
  assert.equal(client.webSocketUrl("/api/terminal"), "wss://service.example/agent/api/terminal");
  assert.equal(createWorkspaceClient({ basePath: "/agent" }).url("/api/chat"), "/agent/api/chat");
  await client.fetch(new Request("https://service.example/api/chat?after=3", {
    method: "POST", body: "message", credentials: "same-origin",
    headers: { "x-message": "stable" }, signal: controller.signal,
  }));
  for (const basePath of ["agent", "//other.example", "/a/../agent", "/agent?token=x", "/agent#x", "/\\evil"])
    assert.throws(() => createWorkspaceClient({ basePath }), TypeError);
  await assert.rejects(client.fetch("https://other.example/api/chat"), TypeError);
});

test("unsafe destinations fail before credentials are read or any request is dispatched", async () => {
  let credentialsRead = 0;
  let requests = 0;
  const client = createWorkspaceClient({
    baseUrl: "https://service.example",
    getHeaders: () => {
      credentialsRead++;
      return { authorization: "Bearer private" };
    },
    fetch: async () => {
      requests++;
      return new Response();
    },
  });
  for (const input of [
    "https://other.example/api/chat",
    "http://service.example/api/chat",
    "//other.example/api/chat",
    "/\\other.example/api/chat",
    "/\n/other.example/api/chat",
    " https://service.example/api/chat",
    "https://user:password@service.example/api/chat",
    "/api/chat#access-token",
    "data:text/plain,private",
    new Request("https://other.example/api/chat"),
  ]) {
    await assert.rejects(client.fetch(input), TypeError);
  }
  assert.equal(credentialsRead, 0);
  assert.equal(requests, 0);
  for (const baseUrl of [
    "file:///workspace",
    "https://user:password@service.example",
    "https://service.example/#token",
    "https://service.example/?token=private",
  ]) {
    assert.throws(() => createWorkspaceClient({ baseUrl }), TypeError);
  }
});

test("auth headers are refreshed and merged with Headers and tuples without losing mutation identity", async () => {
  let token = "first";
  const controller = new AbortController();
  const body = JSON.stringify({ idempotencyKey: "stable-submission", input: "x".repeat(8192) });
  const requests: { input: Parameters<typeof globalThis.fetch>[0]; init?: RequestInit }[] = [];
  const client = createWorkspaceClient({
    baseUrl: "https://service.example",
    getHeaders: async () => new Headers({ authorization: `Bearer ${token}`, "x-host": "desktop" }),
    fetch: async (input, init) => {
      requests.push({ input, init });
      return Response.json({ ok: true });
    },
  });
  await client.json("/api/workspace/runs", {
    method: "POST",
    body,
    signal: controller.signal,
    credentials: "include",
    headers: [["Idempotency-Key", "stable-submission"]],
  });
  token = "rotated";
  await client.fetch("/api/providers", { headers: new Headers({ accept: "application/json" }) });
  assert.equal(requests.length, 2);
  const first = requests[0]!;
  const headers = new Headers(first.init?.headers);
  assert.equal(first.input, "https://service.example/api/workspace/runs");
  assert.equal(first.init?.body, body);
  assert.equal(first.init?.method, "POST");
  assert.equal(first.init?.signal, controller.signal);
  assert.equal(first.init?.credentials, "include");
  assert.equal(first.init?.redirect, "error");
  assert.equal(headers.get("authorization"), "Bearer first");
  assert.equal(headers.get("idempotency-key"), "stable-submission");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-host"), "desktop");
  assert.equal(new Headers(requests[1]!.init?.headers).get("authorization"), "Bearer rotated");
});

test("SDK Request inputs retain their body, signal, cookies and caller header overrides", async () => {
  const controller = new AbortController();
  const input = new Request("https://service.example/api/chat", {
    method: "POST",
    body: JSON.stringify({ messageId: "message-1" }),
    headers: { "content-type": "application/json", "x-request": "original" },
    credentials: "same-origin",
    signal: controller.signal,
  });
  const client = createWorkspaceClient({
    baseUrl: "https://service.example",
    getHeaders: () => ({ authorization: "Bearer private" }),
    fetch: async (request, init) => {
      assert.equal(request, input);
      const sent = new Request(request, init);
      assert.equal(sent.method, "POST");
      assert.equal(sent.credentials, "same-origin");
      assert.equal(sent.headers.get("x-request"), "overridden");
      assert.equal(sent.headers.get("authorization"), "Bearer private");
      assert.deepEqual(await sent.json(), { messageId: "message-1" });
      controller.abort();
      assert.equal(sent.signal.aborted, true);
      return new Response(null, { status: 204 });
    },
  });
  await client.fetch(input, { headers: [["x-request", "overridden"]] });
});

test("successful streaming responses are returned untouched and disconnect only cancels the reader", async () => {
  let requests = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"snapshot"}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
  const client = createWorkspaceClient({
    fetch: async () => {
      requests++;
      return response;
    },
  });
  const actual = await client.request("/api/chat/streams/generation-1");
  assert.equal(actual, response);
  assert.equal(actual.body, stream);
  assert.equal(actual.bodyUsed, false);
  const reader = actual.body!.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /snapshot/);
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(requests, 1);
});

test("raw fetch preserves non-2xx Response bodies for SDK handling", async () => {
  const response = Response.json({ error: "access required" }, { status: 401 });
  const client = createWorkspaceClient({ fetch: async () => response });
  assert.equal(await client.fetch("/api/chat"), response);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { error: "access required" });
});

test("aborts and uncertain mutations propagate unchanged, without retry or cancellation requests", async () => {
  const abort = new DOMException("reader disconnected", "AbortError");
  const controller = new AbortController();
  controller.abort(abort);
  let requests = 0;
  const client = createWorkspaceClient({
    fetch: async (_input, init) => {
      requests++;
      assert.equal(init?.signal, controller.signal);
      throw abort;
    },
  });
  await assert.rejects(
    client.json("/api/workspace/runs", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "same-identity" }),
      signal: controller.signal,
    }),
    (error) => error === abort,
  );
  assert.equal(requests, 1);
});

test("HTTP failures preserve structured conflict details even when error responses are not JSON", async () => {
  const body = {
    error: "版本冲突",
    code: "revision_conflict",
    workspace: { threadId: "thread-1", revision: 4 },
  };
  const client = createWorkspaceClient({
    fetch: async () => Response.json(body, { status: 409 }),
  });
  await assert.rejects(client.json("/api/workspace/threads/thread-1"), (error) => {
    assert.ok(error instanceof WorkspaceClientError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "revision_conflict");
    assert.deepEqual(error.body, body);
    assert.equal(error.url, "/api/workspace/threads/thread-1");
    assert.equal(error.kind, "http");
    assert.equal(error.message, "版本冲突");
    return true;
  });
  const proxy = createWorkspaceClient({
    fetch: async () => new Response("<html>Gateway unavailable</html>", { status: 502 }),
  });
  await assert.rejects(proxy.request("/api/providers"), (error) => {
    assert.ok(error instanceof WorkspaceClientError);
    assert.equal(error.status, 502);
    assert.equal(error.kind, "http");
    assert.match(error.message, /502/);
    return true;
  });
});

test("JSON handles empty responses and reports malformed successful bodies distinctly", async () => {
  for (const response of [new Response(null, { status: 204 }), new Response(" \n ")]) {
    const client = createWorkspaceClient({ fetch: async () => response });
    assert.equal(await client.json("/api/providers/provider-1/credentials"), undefined);
  }
  const invalid = createWorkspaceClient({ fetch: async () => new Response("not JSON") });
  await assert.rejects(invalid.json("/api/providers"), (error) => {
    assert.ok(error instanceof WorkspaceClientError);
    assert.equal(error.kind, "invalid-response");
    assert.equal(error.status, 200);
    return true;
  });
});

test("authenticated redirects are not followed or replayed by native fetch", async (context) => {
  let originals = 0;
  let destinations = 0;
  const server = createServer((request, response) => {
    if (request.url === "/api/start") {
      originals++;
      assert.equal(request.headers.authorization, "Bearer private");
      response.writeHead(307, { location: "/destination" });
    } else {
      destinations++;
      response.writeHead(200);
    }
    response.end();
  });
  context.after(() => {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    return closed.promise;
  });
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = createWorkspaceClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getHeaders: () => ({ authorization: "Bearer private" }),
  });
  await assert.rejects(
    client.fetch("/api/start", {
      method: "POST",
      body: "private body",
      redirect: "follow",
    }),
    TypeError,
  );
  assert.equal(originals, 1);
  assert.equal(destinations, 0);
});
