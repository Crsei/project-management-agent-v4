import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { desktopRoot, inside, requireNativeTarget } from "./runtime-manifest.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (!["--server-root", "--runtime-root"].includes(name) || !process.argv[index + 1] || !isAbsolute(process.argv[index + 1]))
    throw new Error("Usage: smoke-managed.mjs --server-root ABSOLUTE_DIRECTORY --runtime-root ABSOLUTE_DIRECTORY");
  options.set(name, process.argv[++index]);
}
if (options.size !== 2) throw new Error("Both absolute --server-root and --runtime-root are required.");
const target = requireNativeTarget();
const serverRoot = await realpath(options.get("--server-root"));
const runtimeRoot = await realpath(options.get("--runtime-root"));
const { LocalServer } = await import(pathToFileURL(join(desktopRoot, "dist/local-server.mjs")).href);
const { ownsLiveProcess, spawnOwned, stopOwned } = await import(pathToFileURL(join(desktopRoot, "dist/local-process.mjs")).href);
const { ensurePrivateDirectory } = await import(pathToFileURL(join(desktopRoot, "dist/private-state.mjs")).href);
let temporary;
let server;
let stage = "private-temporary-root";
let unexpectedExit = false;
let failure;
const previousPath = process.env.PATH;
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function verifyNativeClosure(projectRoot) {
  const environment = Object.fromEntries(["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  Object.assign(environment, { PATH: "", HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: join(temporary, ".config"), XDG_DATA_HOME: join(temporary, ".local/share"), XDG_CACHE_HOME: join(temporary, ".cache") });
  const source = `
    import {createRequire} from "node:module";
    import {pathToFileURL} from "node:url";
    import {readFile} from "node:fs/promises";
    import path from "node:path";
    const root=process.argv[1], work=process.argv[2];
    const require=createRequire(path.join(root,"apps/server/agent/dist/index.mjs"));
    require("@lydell/node-pty");
    for(const name of ["@anthropic-ai/claude-agent-sdk","@cursor/sdk","@muse-code/sdk"])
      await import(pathToFileURL(require.resolve(name)).href);
    const store=await require("@cursor/sdk/sqlite").SqliteLocalAgentStore.open({workspaceRef:work,stateRoot:path.join(work,"native-store")});
    await store.dispose();
    const layout=JSON.parse(await readFile(path.join(root,"desktop-dependency-layout.json"),"utf8"));
    const agent=layout.contexts.find(context=>context.id==="agent");
    if(!agent || typeof agent.effectSingleton!=="string") throw new Error("Missing Agent Effect singleton identity.");
    let canonicalEsm,canonicalCjs,consumers=0;
    for(const owner of [agent,...agent.instances]) {
      if(!owner.dependencies.effect) continue;
      if(owner.dependencies.effect!==agent.effectSingleton) throw new Error("Agent Effect graph has split identities.");
      const parent=pathToFileURL(path.join(root,owner.path??owner.root,"__desktop_effect_identity__.mjs")).href;
      const namespace=await import(import.meta.resolve("effect",parent));
      const required=createRequire(parent)("effect");
      canonicalEsm??=namespace;
      canonicalCjs??=required;
      if(namespace!==canonicalEsm || required!==canonicalCjs || namespace.Effect!==required.Effect)
        throw new Error("Agent Effect runtime module object differs between consumers.");
      if(namespace.Effect.runSync(namespace.Effect.succeed(42))!==42) throw new Error("Agent Effect runtime failed.");
      consumers++;
    }
    if(!consumers) throw new Error("Agent Effect singleton has no exercised consumers.");
  `;
  const node = join(runtimeRoot, "node", process.platform === "win32" ? "node.exe" : "bin/node");
  const child = spawnOwned(node, ["--experimental-import-meta-resolve", "--input-type=module", "--eval", source, serverRoot, projectRoot], { cwd: temporary, env: environment });
  child.stdin.end();
  child.stdout.resume();
  child.stderr.resume();
  let timer;
  try {
    await new Promise((done, reject) => {
      timer = setTimeout(() => reject(new Error("Bundled native dependency smoke timed out.")), 60_000);
      child.once("error", () => reject(new Error("Bundled native dependency helper failed.")));
      child.once("close", (code) => code === 0 ? done() : reject(new Error("Bundled Provider/PTY native closure failed.")));
    });
  } finally {
    clearTimeout(timer);
    await stopOwned(child, { force: true });
  }
}
async function request(origin, path, init = {}) {
  return fetch(`${origin}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
}
async function exercise(connection, credentials, expectedWorkspace) {
  check(new URL(connection.origin).hostname === "127.0.0.1", "Managed origin is not loopback.");
  check(typeof connection.instanceId === "string" && connection.instanceId.length > 0, "Missing managed instance identity.");
  for (const path of ["/pm", "/agent/workspace"]) {
    const response = await request(connection.origin, path);
    check(response.ok && response.headers.get("content-type")?.includes("text/html"), "Bundled Web path is not ready.");
    await response.arrayBuffer();
  }
  const anonymous = await request(connection.origin, "/agent/api/access");
  check(anonymous.ok && (await anonymous.json()).authorized === false, "Agent anonymous access was not denied.");
  const agent = await request(connection.origin, "/agent/api/access", { headers: { authorization: `Bearer ${connection.token}` } });
  const access = await agent.json();
  check(agent.ok && access.configured === true && access.authorized === true, "Agent token access is not ready.");
  const denied = await request(connection.origin, "/api/v1/workspaces");
  check(denied.status === 401, "PM workspaces were accessible without PM login.");
  await denied.arrayBuffer();
  const login = await request(connection.origin, "/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json", origin: connection.origin },
    body: JSON.stringify(credentials),
  });
  check(login.ok, "Real PM password login failed.");
  const cookies = login.headers.getSetCookie();
  const session = cookies.map((cookie) => cookie.split(";", 1)[0]).find((cookie) => cookie.startsWith("pm_v4_session="));
  check(Boolean(session), "PM login did not issue its existing session cookie.");
  await login.arrayBuffer();
  const response = await request(connection.origin, "/api/v1/workspaces", { headers: { cookie: session } });
  check(response.ok, "Authorized workspace query failed.");
  const value = await response.json();
  check(Array.isArray(value.items) && value.items.length === 1 && typeof value.items[0].id === "string", "Bootstrap did not create exactly one accessible workspace.");
  if (expectedWorkspace) check(value.items[0].id === expectedWorkspace, "Workspace identity changed after reconnect.");
  check(!unexpectedExit && server.ready && server.processCount >= 5, "An owned local service exited during smoke.");
  return value.items[0].id;
}
async function stopAndAssert() {
  if (!server) return;
  const services = [...server.children.values()];
  const postgres = [...(server.postgres?.children ?? [])];
  await server.stop();
  check(server.processCount === 0 && server.children.size === 0 && !server.running, "Owned process map was not empty after stop.");
  check(services.every((child) => !ownsLiveProcess(child)), "An owned service process tree survived stop.");
  check(postgres.every((child) => child.exitCode !== null || child.signalCode !== null), "An owned PostgreSQL child survived stop.");
}
try {
  temporary = await realpath(await mkdtemp(join(await realpath(tmpdir()), "pm-desktop-managed-smoke-")));
  check(!inside(resolve(desktopRoot, "../.."), temporary) && !inside(serverRoot, temporary), "Smoke data must be outside the checkout and packaged server root.");
  await ensurePrivateDirectory(temporary, { newlyCreated: true });
  const projectRoot = await ensurePrivateDirectory(join(temporary, "projects"));
  const dataDir = join(temporary, "instance");
  const credentials = { email: `desktop-${randomUUID()}@smoke.invalid`, password: `${randomBytes(32).toString("base64url")}Aa1!` };
  // Demonstrate that startup uses explicit bundled Node/PG executables rather
  // than a user's Node/Postgres/Python installation or shell configuration.
  process.env.PATH = "";
  stage = "bundled-node-provider-and-pty-native-closure";
  await verifyNativeClosure(projectRoot);
  const createServer = () => new LocalServer({ serverRoot, runtimeRoot, webRoot: join(serverRoot, "apps/web/dist"), onExit: () => { unexpectedExit = true; } });
  stage = "fresh-managed-start";
  server = createServer();
  const first = await server.start({ mode: "local", dataDir, projectRoot, setup: { ...credentials, name: "Desktop Smoke", workspaceName: "Desktop Smoke Workspace" } });
  stage = "fresh-pm-login-and-authorized-workspace";
  const workspace = await exercise(first, credentials);
  stage = "first-owned-shutdown";
  await stopAndAssert();
  stage = "same-root-reconnect-without-setup";
  server = createServer();
  const second = await server.start({ mode: "local", dataDir, projectRoot });
  check(second.instanceId === first.instanceId && second.origin === first.origin, "Instance identity/origin changed after reconnect.");
  stage = "reconnect-pm-login-and-same-workspace";
  await exercise(second, credentials, workspace);
  stage = "reconnect-owned-shutdown";
  await stopAndAssert();
} catch (error) {
  failure = error;
} finally {
  try { await stopAndAssert(); } catch (error) { failure ??= error; stage = "owned-shutdown"; }
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  // The root was freshly created by this invocation, never supplied by a user.
  // Do not remove a live instance if owned shutdown failed.
  if (temporary && (!server || !server.running)) await rm(temporary, { recursive: true, force: true });
}
if (failure) {
  // Never print service logs, setup values, cookies, URLs with authority, or an
  // exception whose library context could contain a connection string.
  console.log(JSON.stringify({ ok: false, target, stage, error: "managed_desktop_smoke_failed" }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, target, providerAndPtyNativeClosure: true, effectSingletonRuntimeIdentity: true, managedPostgres: true, migrationsAndStorageBootstrap: true, pmPasswordLogin: true, authorizedWorkspace: true, agentAccess: true, bundledWeb: true, sameInstanceAndWorkspaceAfterRestart: true, ownedProcessCleanup: true, ambientPathUsed: false }));
