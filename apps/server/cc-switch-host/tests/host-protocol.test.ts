/** Protocol-level tests for the translated host. Run after `node scripts/build.mjs`. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const hostEntry = path.resolve(import.meta.dirname, "../dist/main.mjs");

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #sequence = 0;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly events: Array<Record<string, unknown>> = [];

  constructor() {
    this.child = spawn(process.execPath, [hostEntry], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.#accept(chunk));
    this.child.stderr.resume();
  }

  #accept(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.event === "string") { this.events.push(message); continue; }
      const waiter = this.#pending.get(String(message.id));
      if (!waiter) continue;
      this.#pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  }

  call<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = String(++this.#sequence);
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    this.child.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
    return promise;
  }

  close(): void {
    this.child.stdin.end();
  }
}

interface Fixture {
  root: string;
  dataDir: string;
  homeDir: string;
  appDirs: Record<string, string>;
  claudeMcpFile: string;
  secretKey: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-ts-host-"));
  const appDirs: Record<string, string> = {};
  for (const app of ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes", "pi", "mcode", "kimi", "dsh", "agy", "omp"]) {
    appDirs[app] = path.join(root, "apps", app);
    await mkdir(appDirs[app], { recursive: true });
  }
  const dataDir = path.join(root, "data");
  const homeDir = path.join(root, "home");
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  return { root, dataDir, homeDir, appDirs, claudeMcpFile: path.join(homeDir, ".claude.json"), secretKey: randomBytes(32).toString("base64") };
}

async function initialized(): Promise<{ client: Client; fixture: Fixture }> {
  const value = await fixture();
  const client = new Client();
  const result = await client.call<{ initialized: boolean; apps: string[] }>("host_initialize", {
    dataDir: value.dataDir, homeDir: value.homeDir, appDirs: value.appDirs, claudeMcpFile: value.claudeMcpFile, secretKey: value.secretKey,
  });
  assert.equal(result.initialized, true);
  return { client, fixture: value };
}

test("MCP definitions, assignments, overrides and native projection stay coherent", async () => {
  const { client, fixture: f } = await initialized();
  try {
    await client.call("save_mcp_definition", {
      definition: { id: "demo", name: "Demo", server: { type: "stdio", command: "node", args: ["-e", ""], env: { BASE: "1" } }, tags: [] },
    });
    await client.call("set_mcp_agent_configuration", { serverId: "demo", app: "claude", enabled: true });
    await client.call("set_mcp_agent_configuration", {
      serverId: "demo", app: "claude", enabled: true, override: { env: { BASE: null, AGENT: "1" } },
    });
    const management = await client.call<{
      definitions: Record<string, { server: Record<string, unknown> }>;
      agentConfigurations: Record<string, Record<string, { sync: { state: string }; effective: { env: Record<string, string> } }>>;
    }>("get_mcp_management");
    assert.deepEqual(management.definitions.demo!.server.env, { BASE: "1" });
    assert.equal(management.agentConfigurations.demo!.claude!.sync.state, "synced");
    assert.deepEqual(management.agentConfigurations.demo!.claude!.effective.env, { AGENT: "1" });
    const native = JSON.parse(await readFile(f.claudeMcpFile, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
    assert.deepEqual(native.mcpServers.demo!.env, { AGENT: "1" });
    assert.equal(await client.call("delete_mcp_server", { id: "demo" }), true);
    const after = JSON.parse(await readFile(f.claudeMcpFile, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.equal(Object.hasOwn(after.mcpServers, "demo"), false);
  } finally {
    client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("wrong context key is rejected without replacing the protected database", async () => {
  const { client, fixture: f } = await initialized();
  client.close();
  const second = new Client();
  try {
    const result = await second.call<unknown>("host_initialize", {
      dataDir: f.dataDir, homeDir: f.homeDir, appDirs: f.appDirs, claudeMcpFile: f.claudeMcpFile,
      secretKey: randomBytes(32).toString("base64"),
    });
    assert.fail(`expected initialization failure, received ${JSON.stringify(result)}`);
  } catch (error) {
    assert.match(String(error), /INITIALIZATION_FAILED/);
  } finally {
    second.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("settings, default repositories and empty skill state are exposed", async () => {
  const { client, fixture: f } = await initialized();
  try {
    assert.deepEqual(await client.call("get_settings"), { skillSyncMethod: "auto", skillStorageLocation: "cc_switch", visibleApps: {} });
    assert.deepEqual(await client.call("get_installed_skills"), []);
    const repos = await client.call<Array<{ owner: string }>>("get_skill_repos");
    assert.deepEqual(repos.map((repo) => repo.owner), ["ComposioHQ", "JimLiu", "anthropics", "cexll"]);
    assert.deepEqual(await client.call("scan_unmanaged_skills"), []);
  } finally {
    client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
