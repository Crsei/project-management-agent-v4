import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test, { before, after } from "node:test";
import WebSocket, { type RawData } from "ws";
import type { TerminalServerMessage } from "@agent-workspace/contracts/inspector";
import { attachTerminalUpgrade } from "./terminal.ts";
import pty from "@lydell/node-pty";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import { ensureThread } from "../durable/threads.ts";
import { closeStore } from "../durable/store.ts";

const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "inspector-terminal-"));
const alphaRoot = await mkdtemp(path.join(fixtureDirectory, "alpha-"));
const betaRoot = await mkdtemp(path.join(fixtureDirectory, "beta-"));
const originalDataDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalPmUrl = process.env.PM_API_URL;
process.env.AGENT_WORKSPACE_DATA_DIR = path.join(fixtureDirectory, "data");
const workspaceId = "terminal-workspace";
const scopeRoots = new Map<string, string>([["alpha", alphaRoot], ["beta", betaRoot]]);
const pmRequests: { scope: AgentScope; cookie?: string; authorization?: string }[] = [];
let pmServer: Server;
let pmStatus = 200;
let pmGate: { started: () => void; wait: Promise<void>; finished: () => void } | undefined;

before(async () => {
  await writeFile(path.join(alphaRoot, "scope-marker"), "ONLY-ALPHA-PTY\n");
  await writeFile(path.join(betaRoot, "scope-marker"), "ONLY-BETA-PTY\n");
  ensureThread("terminal-alpha", undefined, { workspaceId, projectId: "alpha" });
  ensureThread("terminal-legacy");
  pmServer = createServer(async (request, response) => {
    assert.equal(request.url, "/api/v1/agent-contexts/resolve");
    let body = "";
    for await (const chunk of request) body += chunk;
    const scope = JSON.parse(body) as AgentScope;
    pmRequests.push({ scope, cookie: request.headers.cookie, authorization: request.headers.authorization });
    const gate = pmGate;
    if (gate) {
      gate.started();
      await gate.wait;
    }
    const root = scope.workspaceId === workspaceId ? scopeRoots.get(scope.projectId ?? "alpha") : undefined;
    response.writeHead(pmStatus !== 200 ? pmStatus : root ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(root
      ? { scope, path: root, workspaceName: "Terminal", projectName: scope.projectId }
      : { error: "not_found_or_forbidden" }), () => gate?.finished());
  });
  const port = await listen(pmServer);
  process.env.PM_API_URL = `http://127.0.0.1:${port}`;
});

after(async () => {
  closeStore();
  await closeServer(pmServer);
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
  if (originalDataDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = originalDataDirectory;
  await rm(fixtureDirectory, { recursive: true, force: true });
});

function terminalUrl(port: number, projectId = "alpha", threadId?: string): string {
  const url = new URL(`ws://127.0.0.1:${port}/api/terminal`);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("projectId", projectId);
  if (threadId !== undefined) url.searchParams.set("threadId", threadId);
  return url.toString();
}

async function rejectedHandshake(url: string, headers?: Record<string, string>): Promise<number> {
  const result = Promise.withResolvers<number>();
  const socket = new WebSocket(url, { headers });
  const timer = setTimeout(() => result.reject(new Error("Expected rejected terminal handshake")), 5000);
  socket.once("unexpected-response", (_request, response) => {
    response.resume();
    result.resolve(response.statusCode ?? 0);
    socket.terminate();
  });
  socket.once("open", () => result.reject(new Error("Unexpected terminal upgrade")));
  socket.on("error", result.reject);
  try {
    return await result.promise;
  } finally {
    clearTimeout(timer);
    await closed(socket);
  }
}

type Waiter = {
  predicate: (message: TerminalServerMessage) => boolean;
  resolve: (message: TerminalServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Collector = {
  messages: TerminalServerMessage[];
  waitFor: (
    predicate: (message: TerminalServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<TerminalServerMessage>;
  text: () => string;
};

function collect(socket: WebSocket): Collector {
  const messages: TerminalServerMessage[] = [];
  const waiters = new Set<Waiter>();

  socket.on("message", (raw: RawData) => {
    let message: TerminalServerMessage;
    try {
      message = JSON.parse(raw.toString()) as TerminalServerMessage;
    } catch {
      return;
    }
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  const waitFor = (
    predicate: (message: TerminalServerMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<TerminalServerMessage> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<TerminalServerMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("等待终端消息超时。"));
        }, timeoutMs),
      };
      waiter.timer.unref();
      waiters.add(waiter);
    });
  };

  return {
    messages,
    waitFor,
    text: () => messages.map((message) => (message.type === "output" ? message.data : "")).join(""),
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

test("terminal websocket spawns a PTY and echoes input", async () => {
  const previousShell = process.env.AGENT_WORKSPACE_TERMINAL_SHELL;
  process.env.AGENT_WORKSPACE_TERMINAL_SHELL = "/bin/sh";

  const server = createServer();
  attachTerminalUpgrade(server);
  attachTerminalUpgrade(server);
  assert.equal(server.listenerCount("upgrade"), 1, "attachTerminalUpgrade must be idempotent");

  const port = await listen(server);
  const socket = new WebSocket(terminalUrl(port));
  const collector = collect(socket);

  try {
    const ready = await collector.waitFor((message) => message.type === "ready");
    assert.equal(ready.type, "ready");
    if (ready.type !== "ready") throw new Error("expected ready");
    assert.equal(ready.shell, "/bin/sh");
    assert.equal(ready.cwd, alphaRoot);

    socket.send(JSON.stringify({ type: "input", data: "echo OMP-PTY-4827\n" }));
    await collector.waitFor(
      (message) => message.type === "output" && message.data.includes("OMP-PTY-4827"),
    );
    assert.ok(
      collector.text().includes("OMP-PTY-4827"),
      `did not observe echoed marker in output: ${collector.text()}`,
    );

    socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    socket.send(JSON.stringify({ type: "ping" }));
    await collector.waitFor((message) => message.type === "pong");
    assert.deepEqual(
      collector.messages.filter((message) => message.type === "error"),
      [],
      "resize/ping must not produce an error",
    );
  } finally {
    await closed(socket);
    await closeServer(server);
    if (previousShell === undefined) delete process.env.AGENT_WORKSPACE_TERMINAL_SHELL;
    else process.env.AGENT_WORKSPACE_TERMINAL_SHELL = previousShell;
  }
});

test("upgrades on other paths are not handled", async () => {
  const server = createServer();
  attachTerminalUpgrade(server);
  const port = await listen(server);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/other`);

  try {
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 5_000);
      timer.unref();
      socket.once("open", () => {
        clearTimeout(timer);
        resolve("open");
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve("error");
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve("close");
      });
    });
    assert.notEqual(outcome, "open");
    assert.notEqual(outcome, "timeout");
  } finally {
    await closed(socket);
    await closeServer(server);
  }
});

test("isolates simultaneous PTYs and freezes the resolved directory across restart", async () => {
  const previousShell = process.env.AGENT_WORKSPACE_TERMINAL_SHELL;
  process.env.AGENT_WORKSPACE_TERMINAL_SHELL = "/bin/sh";
  const cwd = process.cwd();
  const server = createServer();
  attachTerminalUpgrade(server);
  const port = await listen(server);
  const alpha = new WebSocket(terminalUrl(port, "alpha", "terminal-alpha"), {
    headers: { cookie: "pm_v3_session=alpha", authorization: "Bearer alpha" },
  });
  const beta = new WebSocket(terminalUrl(port, "beta"), {
    headers: { cookie: "pm_v3_session=beta", authorization: "Bearer beta" },
  });
  const a = collect(alpha);
  const b = collect(beta);
  try {
    const [readyA, readyB] = await Promise.all([
      a.waitFor((message) => message.type === "ready"),
      b.waitFor((message) => message.type === "ready"),
    ]);
    assert.equal(readyA.type === "ready" && readyA.cwd, alphaRoot);
    assert.equal(readyB.type === "ready" && readyB.cwd, betaRoot);
    alpha.send(JSON.stringify({ type: "input", data: "cat scope-marker\n" }));
    beta.send(JSON.stringify({ type: "input", data: "cat scope-marker\n" }));
    await Promise.all([
      a.waitFor((message) => message.type === "output" && a.text().includes("ONLY-ALPHA-PTY")),
      b.waitFor((message) => message.type === "output" && b.text().includes("ONLY-BETA-PTY")),
    ]);
    assert.ok(!a.text().includes("ONLY-BETA-PTY"));
    assert.ok(!b.text().includes("ONLY-ALPHA-PTY"));
    assert.ok(pmRequests.some((request) => request.scope.projectId === "alpha" && request.cookie === "pm_v3_session=alpha" && request.authorization === "Bearer alpha"));
    assert.ok(pmRequests.some((request) => request.scope.projectId === "beta" && request.cookie === "pm_v3_session=beta" && request.authorization === "Bearer beta"));

    scopeRoots.set("alpha", betaRoot);
    const resolves = pmRequests.length;
    const readyCount = a.messages.filter((message) => message.type === "ready").length;
    alpha.send(JSON.stringify({ type: "restart" }));
    const restarted = await a.waitFor((message) =>
      message.type === "ready" && a.messages.filter((entry) => entry.type === "ready").length > readyCount);
    assert.equal(restarted.type === "ready" && restarted.cwd, alphaRoot);
    const outputStart = a.messages.length;
    alpha.send(JSON.stringify({ type: "input", data: "cat scope-marker\n" }));
    await a.waitFor((message) => message.type === "output" && a.messages.slice(outputStart)
      .some((entry) => entry.type === "output" && entry.data.includes("ONLY-ALPHA-PTY")));
    assert.equal(pmRequests.length, resolves, "restart must not re-resolve another directory");
    assert.equal(process.cwd(), cwd);
  } finally {
    scopeRoots.set("alpha", alphaRoot);
    await Promise.all([closed(alpha), closed(beta)]);
    await closeServer(server);
    if (previousShell === undefined) delete process.env.AGENT_WORKSPACE_TERMINAL_SHELL;
    else process.env.AGENT_WORKSPACE_TERMINAL_SHELL = previousShell;
  }
});

test("rejects missing, malformed and mismatched terminal scopes before spawning a PTY", async (t) => {
  const spawn = t.mock.method(pty, "spawn", () => { throw new Error("Unauthorized PTY spawn"); });
  const server = createServer();
  attachTerminalUpgrade(server);
  const port = await listen(server);
  try {
    const requests = pmRequests.length;
    for (const [url, status] of [
      [`ws://127.0.0.1:${port}/api/terminal`, 400],
      [`ws://127.0.0.1:${port}/api/terminal?projectId=alpha`, 400],
      [terminalUrl(port, ""), 400],
      [terminalUrl(port, "alpha", ""), 400],
      [terminalUrl(port, "alpha", "missing"), 404],
      [terminalUrl(port, "alpha", "terminal-legacy"), 412],
      [terminalUrl(port, "beta", "terminal-alpha"), 409],
      [`${terminalUrl(port)}&workspaceId=forged`, 400],
      [`${terminalUrl(port)}&cwd=${encodeURIComponent(betaRoot)}`, 400],
    ] as const) {
      assert.equal(await rejectedHandshake(url), status);
    }
    assert.equal(pmRequests.length, requests);
    assert.equal(await rejectedHandshake(terminalUrl(port, "forged")), 404);
    for (const status of [401, 403, 503]) {
      pmStatus = status;
      assert.equal(await rejectedHandshake(terminalUrl(port)), status);
    }
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    pmStatus = 200;
    await closeServer(server);
  }
});

test("keeps terminal origin and access checks before PM resolution", async (t) => {
  const spawn = t.mock.method(pty, "spawn", () => { throw new Error("Unauthorized PTY spawn"); });
  const server = createServer();
  attachTerminalUpgrade(server);
  const port = await listen(server);
  const previousToken = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  try {
    const requests = pmRequests.length;
    assert.equal(await rejectedHandshake(terminalUrl(port), { origin: "https://evil.invalid" }), 403);
    process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "terminal-access-token-with-at-least-32-characters";
    assert.equal(await rejectedHandshake(terminalUrl(port)), 403);
    assert.equal(pmRequests.length, requests);
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    if (previousToken === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = previousToken;
    await closeServer(server);
  }
});

test("does not spawn a PTY when the client disconnects during PM authorization", async (t) => {
  const spawn = t.mock.method(pty, "spawn", () => { throw new Error("Disconnected PTY spawn"); });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  pmGate = { started: started.resolve, wait: release.promise, finished: finished.resolve };
  const server = createServer();
  attachTerminalUpgrade(server);
  const disconnected = Promise.withResolvers<void>();
  server.on("upgrade", (_request, socket) => socket.once("close", disconnected.resolve));
  const port = await listen(server);
  const socket = new WebSocket(terminalUrl(port));
  socket.on("error", () => {});
  try {
    await started.promise;
    socket.terminate();
    await disconnected.promise;
    release.resolve();
    await finished.promise;
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    release.resolve();
    pmGate = undefined;
    await closed(socket);
    await closeServer(server);
  }
});
