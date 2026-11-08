import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readPrivateJson, writePrivateJson } from "./private-state.mjs";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const entry = (path, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
async function request(connection, path, { body, method = "GET", cookie, agent = false } = {}) {
  const response = await fetch(`${connection.origin}${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { origin: connection.origin, ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(agent ? { authorization: `Bearer ${connection.token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  check(response.ok, `Installed lifecycle API failed (${path}, HTTP ${response.status}).`);
  return response;
}

export async function exerciseInstalledHealth(connection, credentials) {
  check(new URL(connection.origin).hostname === "127.0.0.1", "Installed controller cannot target a remote service.");
  for (const path of ["/pm", "/agent/workspace"]) {
    const response = await request(connection, path);
    check(response.headers.get("content-type")?.includes("text/html"), "Bundled workspace HTML is missing.");
    await response.arrayBuffer();
  }
  const ready = await (await request(connection, "/health/ready")).json();
  check(ready.status === "ready" && ["database", "storage", "worker", "core"].every(key => ready.checks?.[key] === true), "Installed workspace is not ready.");
  const anonymous = await (await request(connection, "/agent/api/access")).json();
  check(anonymous.authorized === false, "Anonymous Agent access was not denied.");
  const agent = await (await request(connection, "/agent/api/access", { agent: true })).json();
  check(agent.authorized === true && agent.configured === true, "Installed Agent authentication failed.");
  check(credentials && typeof credentials.email === "string" && typeof credentials.password === "string", "Real PM login credentials must be supplied in the private request.");
  const login = await request(connection, "/api/v1/auth/login", { method: "POST", body: { email: credentials.email, password: credentials.password } });
  const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).find(value => value.startsWith("pm_v4_session="));
  check(cookie, "Installed PM did not issue a login session.");
  await login.arrayBuffer();
  const workspaces = await (await request(connection, "/api/v1/workspaces", { cookie })).json();
  check(Array.isArray(workspaces.items) && workspaces.items.length === 1 && typeof workspaces.items[0].id === "string", "Installed fixture must have exactly one authorized workspace.");
  return { ready: true, database: true, storage: true, worker: true, core: true, pmPasswordLogin: true, agentAuthenticated: true, anonymousAgentDenied: true, workspaceId: workspaces.items[0].id };
}

export async function createInstalledFixture({ request: input, connection, health }) {
  const file = join(input.userDataDir, "desktop-lifecycle-fixture.json");
  check(!(await readPrivateJson(file)), "An installed fixture already exists; refusing to reseed preserved data.");
  const id = `desktop-install-${input.fixtureId}`;
  await (await request(connection, "/agent/api/chat/threads", { method: "POST", agent: true, body: { id, executionSelection: { version: 2, agentWorkspaceId: null, agentWorkspaceRevision: null } } })).arrayBuffer();
  const saved = await (await request(connection, `/agent/api/chat/threads/${id}/history`, { method: "PUT", agent: true, body: { id: input.fixtureId, parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: `Preserve installed lifecycle fixture ${input.fixtureId}` }] } } })).json();
  check(saved.saved === true, "The real Agent fixture message was not persisted.");
  // This is the normal saved connection format, not a replacement database or
  // fake fixture backend. It is also exercised by subsequent GUI launches.
  await writePrivateJson(join(input.userDataDir, "connection.json"), { version: 2, mode: "local", dataDir: input.dataDir, projectRoot: input.projectRoot });
  await writePrivateJson(file, { formatVersion: 1, fixtureId: input.fixtureId, workspaceId: health.workspaceId, threadId: id }, { exclusive: true });
}

async function markdownEntries(dataDir) {
  const entries = [];
  async function visit(directory) {
    let stat;
    try { stat = await lstat(directory); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    check(stat.isDirectory() && !stat.isSymbolicLink(), "Unsafe installed Markdown root.");
    for (const name of (await readdir(directory)).sort()) {
      if (["cache", "node_modules", ".git"].includes(name)) continue;
      const file = join(directory, name);
      const current = await lstat(file);
      check(!current.isSymbolicLink(), "Linked installed fixture content is not supported.");
      if (current.isDirectory()) await visit(file);
      else if (current.isFile() && name.endsWith(".md")) {
        check(current.nlink === 1 && current.size <= 16 * 1024 * 1024, "Unsafe installed Markdown file.");
        entries.push(entry(relative(dataDir, file).replaceAll("\\", "/"), await readFile(file)));
      }
      check(entries.length <= 20_000, "Installed Markdown fixture exceeds its bounded snapshot.");
    }
  }
  await visit(join(dataDir, "pm-workspaces"));
  await visit(join(dataDir, "projects"));
  check(entries.length > 0, "Installed fixture has no actual Markdown project content.");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function snapshotInstalledFixture({ request: input, server, connection }) {
  check(server?.ready && server.postgres?.ready && connection, "Snapshot requires the live installed managed instance; call start-health first.");
  const fixture = await readPrivateJson(join(input.userDataDir, "desktop-lifecycle-fixture.json"));
  check(fixture?.formatVersion === 1 && fixture.fixtureId === input.fixtureId, "Installed lifecycle fixture identity is missing or changed.");
  const client = server.postgres.createClient();
  let accounts, workspaces;
  try {
    await client.connect();
    await server.postgres.identify(client);
    accounts = (await client.query("SELECT id,email,name FROM users ORDER BY id")).rows;
    workspaces = (await client.query("SELECT id,name,owner_id FROM workspaces ORDER BY id")).rows;
  } finally { await client.end().catch(() => {}); }
  check(accounts.length > 0 && workspaces.some(row => row.id === fixture.workspaceId), "Real PM account/workspace data was not preserved.");
  const thread = (await (await request(connection, `/agent/api/chat/threads/${fixture.threadId}`, { agent: true })).json()).thread;
  const history = await (await request(connection, `/agent/api/chat/threads/${fixture.threadId}/history`, { agent: true })).json();
  const message = history.messages?.find(value => value.id === input.fixtureId);
  check(thread?.remoteId === fixture.threadId && message && JSON.stringify(message).includes(input.fixtureId), "Actual Agent thread/message data was not preserved.");
  const configuration = await readPrivateJson(join(input.userDataDir, "connection.json"));
  check(configuration?.version === 2 && resolve(configuration.dataDir) === input.dataDir && resolve(configuration.projectRoot) === input.projectRoot, "Saved userData connection was not preserved.");
  return {
    fixtureId: fixture.fixtureId,
    components: {
      postgres: { entries: [entry("logical/users", accounts), entry("logical/workspaces", workspaces)] },
      markdown: { entries: await markdownEntries(input.dataDir) },
      agent: { entries: [entry("logical/thread", { remoteId: thread.remoteId, executionSelection: thread.executionSelection }), entry("logical/user-message", { id: message.id, content: message.content ?? message })] },
      userData: { entries: [entry("connection.json", configuration), entry("desktop-lifecycle-fixture.json", fixture)] },
    },
  };
}
