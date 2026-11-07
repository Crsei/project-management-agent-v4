import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const token = "hosting-test-" + "a".repeat(40);
async function host(t: TestContext, apiOnly: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-hosting-"));
  const webDist = path.join(directory, "web");
  if (!apiOnly) {
    await mkdir(webDist);
    await writeFile(
      path.join(webDist, "index.html"),
      "<!doctype html><title>hosting boundary</title>",
    );
    await writeFile(path.join(webDist, "asset.txt"), "static asset");
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      AGENT_WORKSPACE_API_ONLY: apiOnly ? "1" : "0",
      AGENT_WORKSPACE_WEB_DIST: webDist,
      AGENT_WORKSPACE_PROJECT_ROOT: directory,
      AGENT_WORKSPACE_DATA_DIR: path.join(directory, "data"),
      AGENT_WORKSPACE_ACCESS_TOKEN: token,
      AGENT_APPROVAL_MODE: "ask",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  assert.ok(child.stdout && child.stderr);
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // Real-process watchdog only; readiness/exit use events, not guessed sleeps.
      const deadline = setTimeout(() => child.kill("SIGKILL"), 17_000);
      if (child.connected) child.send({ type: "agent-workspace:shutdown" });
      else child.kill("SIGTERM");
      await exited;
      clearTimeout(deadline);
    }
    await rm(directory, { recursive: true, force: true });
  });
  const { promise: ready, resolve, reject } = Promise.withResolvers<string>();
  let output = "";
  // A hung external Node process cannot be advanced with this test's fake clock.
  const timeout = setTimeout(() => {
    reject(new Error(`Server readiness timed out: ${errors}`));
  }, 20_000);
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = /agent-workspace listening on (http:\/\/127\.0\.0\.1:(\d+))/.exec(output);
    if (!match) return;
    clearTimeout(timeout);
    if (Number(match[2]) === 0) reject(new Error("Readiness must report the assigned port."));
    else resolve(match[1]);
  });
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`Server exited before readiness (${code}): ${errors}`));
  });
  const url = await ready;
  return { child, exited, url };
}

test("API-only hosting needs no Web build, reports PORT=0 and shuts down through parent IPC", async (t) => {
  const { child, exited, url } = await host(t, true);
  const unauthorized = await fetch(`${url}/api/access`);
  assert.equal(unauthorized.status, 200);
  assert.deepEqual(await unauthorized.json(), {
    authorized: false,
    configured: true,
    approvalMode: "ask",
    message: null,
  });
  const authorized = await fetch(`${url}/api/access`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await authorized.json(), { authorized: true, configured: true, approvalMode: "ask", message: null });
  assert.equal((await fetch(`${url}/workspace`)).status, 404);
  child.send({ type: "agent-workspace:shutdown" });
  const [code] = await exited;
  assert.equal(code, 0);
});

test("configured Web hosting is cwd-independent and keeps SPA fallback", async (t) => {
  const { url } = await host(t, false);
  assert.match(await (await fetch(`${url}/workspace`)).text(), /hosting boundary/);
  assert.equal(await (await fetch(`${url}/asset.txt`)).text(), "static asset");
  assert.match(await (await fetch(`${url}/agent/workspace`)).text(), /hosting boundary/);
  assert.equal(await (await fetch(`${url}/agent/asset.txt`)).text(), "static asset");
  const prefixedApi = await fetch(`${url}/agent/api/does-not-exist`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(prefixedApi.status, 404);
  assert.doesNotMatch(await prefixedApi.text(), /hosting boundary/);
  const missing = await fetch(`${url}/api/does-not-exist`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /hosting boundary/);
});
