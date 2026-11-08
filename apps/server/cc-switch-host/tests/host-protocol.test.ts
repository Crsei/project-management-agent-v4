/** Protocol-level tests for the translated host. Run after `node scripts/build.mjs`. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectSkillImportTree } from "../src/skills/fs.ts";

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

async function initialized(storage: "cc_switch" | "unified" = "cc_switch"): Promise<{ client: Client; fixture: Fixture }> {
  const value = await fixture();
  if (storage === "unified") {
    await writeFile(path.join(value.dataDir, "settings.json"), JSON.stringify({ skillStorageLocation: storage }));
  }
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

test("native Skills scan observes shared Home without creating storage or reading unbound roots", async () => {
  const f = await fixture();
  const client = new Client();
  try {
    await client.call("host_initialize", { dataDir: f.dataDir, homeDir: f.homeDir, appDirs: { opencode: f.appDirs.opencode }, secretKey: f.secretKey });
    const native = path.join(f.appDirs.opencode!, "skills", "native");
    const shared = path.join(f.homeDir, ".agents", "skills", "shared");
    const unbound = path.join(f.dataDir, "unbound", "claude", "skills", "not-authorized");
    const body = "---\nname: Synthetic native\n---\n# Native\n";
    for (const directory of [native, shared, unbound]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), body);
    }
    const observed = await client.call<Array<{ directory: string; foundIn: string[] }>>("scan_unmanaged_skills");
    assert.deepEqual(observed.map(({ directory, foundIn }) => ({ directory, foundIn })), [
      { directory: "native", foundIn: ["opencode"] }, { directory: "shared", foundIn: ["agents"] },
    ]);
    assert.deepEqual((await client.call<Array<{ directory: string; managed: boolean }>>("scan_native_skills")).map(({ directory, managed }) => ({ directory, managed })), [
      { directory: "native", managed: false }, { directory: "shared", managed: false },
    ]);
    await assert.rejects(readdir(path.join(f.dataDir, "skills")), { code: "ENOENT" });
    assert.deepEqual(await client.call("get_installed_skills"), []);
    assert.deepEqual(client.events, []);
    for (const directory of [native, shared, unbound]) assert.equal(await readFile(path.join(directory, "SKILL.md"), "utf8"), body);
  } finally {
    client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("project-private host cannot observe native shared Home skills", async () => {
  const f = await fixture();
  const client = new Client();
  try {
    const native = path.join(f.homeDir, ".agents", "skills", "not-authorized");
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "SKILL.md"), "---\nname: Private boundary\n---\n");
    await client.call("host_initialize", { dataDir: f.dataDir, homeDir: f.homeDir, appDirs: {}, secretKey: f.secretKey });
    assert.deepEqual(await client.call("scan_unmanaged_skills"), []);
    assert.deepEqual(await client.call("scan_native_skills"), []);
    await assert.rejects(readdir(path.join(f.dataDir, "skills")), { code: "ENOENT" });
    assert.deepEqual(await client.call("get_installed_skills"), []);
  } finally {
    client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

/** Fixture snapshots never follow links, including the deliberately unsafe ones. */
async function snapshotSyntheticTree(root: string): Promise<unknown> {
  const metadata = await lstat(root);
  const identity = { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode };
  if (metadata.isSymbolicLink()) return { ...identity, link: await readlink(root) };
  if (metadata.isFile()) return { ...identity, bytes: (await readFile(root)).toString("base64") };
  const children = [];
  for (const name of (await readdir(root)).sort()) children.push([name, await snapshotSyntheticTree(path.join(root, name))]);
  return { ...identity, children };
}

test("native adoption preserves selected root aliases and contained internal resources", async () => {
  const { client, fixture: f } = await initialized();
  try {
    const repository = path.join(f.root, "synthetic-repository");
    await mkdir(path.join(repository, "resources"), { recursive: true });
    await writeFile(path.join(repository, "SKILL.md"), "---\nname: Safe alias\n---\n");
    await writeFile(path.join(repository, "resources", "data.txt"), "owned internal resource");
    await writeFile(path.join(repository, ".hidden"), "owned hidden resource");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(path.join(repository, "resources"), path.join(repository, "linked-resources"), linkType);
    await symlink(path.join(repository, "resources", "data.txt"), path.join(repository, "linked-file.txt"), "file");
    const native = path.join(f.homeDir, ".agents", "skills", "safe-alias");
    await mkdir(path.dirname(native), { recursive: true });
    await symlink(repository, native, linkType);
    const before = await snapshotSyntheticTree(repository);
    const aliasBefore = await snapshotSyntheticTree(native);

    const imported = await client.call<Array<{ directory: string; apps: Record<string, boolean> }>>("import_skills_from_apps", {
      imports: [{ directory: "safe-alias", apps: {} }],
    });
    assert.equal(imported[0]!.directory, "safe-alias");
    assert.equal(Object.values(imported[0]!.apps).some(Boolean), false);
    const destination = path.join(f.dataDir, "skills", "safe-alias");
    assert.equal(await readFile(path.join(destination, "linked-resources", "data.txt"), "utf8"), "owned internal resource");
    assert.equal(await readFile(path.join(destination, "linked-file.txt"), "utf8"), "owned internal resource");
    assert.equal((await lstat(path.join(destination, "linked-file.txt"))).isSymbolicLink(), false);
    assert.equal((await lstat(path.join(destination, "linked-resources"))).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(destination, ".hidden"), "utf8"), "owned hidden resource");
    assert.deepEqual(await snapshotSyntheticTree(repository), before);
    assert.deepEqual(await snapshotSyntheticTree(native), aliasBefore);
    assert.deepEqual((await client.call<Array<{ directory: string }>>("get_installed_skills")).map(skill => skill.directory), ["safe-alias"]);
  } finally {
    client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const kind of ["outside-file", "outside-directory", "cycle", "unified-outside-file"] as const) {
  test(`native adoption refuses ${kind} without managed, native or repository changes`, async () => {
    const { client, fixture: f } = await initialized(kind === "unified-outside-file" ? "unified" : "cc_switch");
    try {
      const source = path.join(f.homeDir, ".agents", "skills", "unsafe");
      const storage = kind === "unified-outside-file" ? path.dirname(source) : path.join(f.dataDir, "skills");
      const outside = path.join(f.root, "synthetic-outside");
      await mkdir(path.join(source, ".resources"), { recursive: true });
      await mkdir(outside);
      await writeFile(path.join(source, "SKILL.md"), "---\nname: Unsafe fixture\n---\n");
      await writeFile(path.join(outside, "sentinel.txt"), "synthetic outside bytes");
      await mkdir(storage, { recursive: true });
      await writeFile(path.join(storage, ".keep"), "existing managed sentinel");
      await writeFile(path.join(f.homeDir, ".agents", ".skill-lock.json"), JSON.stringify({
        skills: { unsafe: { sourceType: "github", source: "synthetic-owner/synthetic-repo" } },
      }));
      const link = path.join(source, ".resources", "unsafe-link");
      if (kind === "outside-file" || kind === "unified-outside-file") {
        await symlink(path.join(outside, "sentinel.txt"), link, "file");
      } else {
        await symlink(kind === "cycle" ? source : outside, link, process.platform === "win32" ? "junction" : "dir");
      }
      const before = await snapshotSyntheticTree(f.homeDir);
      const storageBefore = await snapshotSyntheticTree(storage);
      const outsideBefore = await snapshotSyntheticTree(outside);
      const nativeBefore = await snapshotSyntheticTree(path.join(f.root, "apps"));
      const reposBefore = await client.call("get_skill_repos");

      await assert.rejects(client.call("import_skills_from_apps", { imports: [{ directory: "unsafe", apps: {} }] }));
      assert.deepEqual(await snapshotSyntheticTree(f.homeDir), before);
      assert.deepEqual(await snapshotSyntheticTree(storage), storageBefore);
      assert.deepEqual(await snapshotSyntheticTree(outside), outsideBefore);
      assert.deepEqual(await snapshotSyntheticTree(path.join(f.root, "apps")), nativeBefore);
      assert.deepEqual(await client.call("get_installed_skills"), []);
      assert.deepEqual(await client.call("get_skill_repos"), reposBefore);
      assert.equal((await readdir(storage)).some(name => name.startsWith(".skill-import-")), false);
    } finally {
      client.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["linked-root", "escaping-descendant"] as const) {
  test(`native adoption validates an existing ${kind} managed destination`, async () => {
    const { client, fixture: f } = await initialized();
    try {
      const source = path.join(f.homeDir, ".agents", "skills", "orphan");
      const storage = path.join(f.dataDir, "skills");
      const destination = path.join(storage, "orphan");
      const outside = path.join(f.root, "synthetic-outside");
      for (const directory of [source, storage, outside]) await mkdir(directory, { recursive: true });
      const body = "---\nname: Existing orphan\n---\n";
      await writeFile(path.join(source, "SKILL.md"), body);
      await writeFile(path.join(outside, "SKILL.md"), body);
      await writeFile(path.join(outside, "sentinel.txt"), "synthetic outside bytes");
      if (kind === "linked-root") {
        await symlink(outside, destination, process.platform === "win32" ? "junction" : "dir");
      } else {
        await mkdir(destination);
        await writeFile(path.join(destination, "SKILL.md"), body);
        await symlink(path.join(outside, "sentinel.txt"), path.join(destination, "outside.txt"), "file");
      }
      const before = await snapshotSyntheticTree(storage);
      const sourceBefore = await snapshotSyntheticTree(source);
      const outsideBefore = await snapshotSyntheticTree(outside);

      await assert.rejects(client.call("import_skills_from_apps", { imports: [{ directory: "orphan", apps: {} }] }));
      assert.deepEqual(await snapshotSyntheticTree(storage), before);
      assert.deepEqual(await snapshotSyntheticTree(source), sourceBefore);
      assert.deepEqual(await snapshotSyntheticTree(outside), outsideBefore);
      assert.deepEqual(await client.call("get_installed_skills"), []);
    } finally {
      client.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["root-alias", "ancestor-directory", "regular-file"] as const) {
  test(`import snapshots reject ${kind} replacement before publishing a copy`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-switch-import-identity-"));
    try {
      const source = path.join(root, "source");
      const other = path.join(root, "other");
      const destination = path.join(root, "managed", "skill");
      for (const directory of [path.join(source, "resources"), other, path.dirname(destination)]) await mkdir(directory, { recursive: true });
      await writeFile(path.join(source, "SKILL.md"), "# Synthetic identity fixture\n");
      const file = path.join(source, "resources", "data.txt");
      await writeFile(file, "original synthetic bytes");
      await writeFile(path.join(other, "data.txt"), "different synthetic bytes");
      let selected = source;
      if (kind === "root-alias") {
        selected = path.join(root, "selected");
        await symlink(source, selected, process.platform === "win32" ? "junction" : "dir");
      }
      const tree = inspectSkillImportTree(selected);
      if (kind === "root-alias") {
        await unlink(selected);
        await symlink(other, selected, process.platform === "win32" ? "junction" : "dir");
      } else if (kind === "ancestor-directory") {
        await rename(path.join(source, "resources"), path.join(source, "original-resources"));
        await symlink(other, path.join(source, "resources"), process.platform === "win32" ? "junction" : "dir");
      } else {
        await rename(file, path.join(source, "original-data.txt"));
        await symlink(path.join(other, "data.txt"), file, "file");
      }
      const before = await snapshotSyntheticTree(source);
      const outsideBefore = await snapshotSyntheticTree(other);
      assert.throws(() => tree.copyTo(destination), /changed|unsafe/);
      assert.deepEqual(await readdir(path.dirname(destination)), []);
      assert.deepEqual(await snapshotSyntheticTree(source), before);
      assert.deepEqual(await snapshotSyntheticTree(other), outsideBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
