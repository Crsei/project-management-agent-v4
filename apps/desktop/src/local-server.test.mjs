import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalServer } from "./local-server.mjs";

test("local startup requires the unified application assets and never claims readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pm-v4-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = new LocalServer({ serverRoot: root, webRoot: join(root, "web"), configRoot: root, onExit: () => assert.fail("not started") });
  await assert.rejects(server.start({ projectRoot: root, dataDir: join(root, "data"), nodePath: "node" }), /Missing application asset/);
  assert.equal(server.child, null);
  assert.equal(server.ready, false);
  await server.stop();
});

test("local startup requires a separately configured user-managed database for each role", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pm-v4-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ["apps/server/pm/src/main.ts", "apps/server/worker/src/main.ts", "apps/server/agent/dist/index.mjs", "apps/server/gateway.ts", "apps/web/dist/index.html"]) {
    const path = join(root, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "");
  }
  await writeFile(join(root, ".env"), "DATABASE_URL=postgresql://localhost/example\n");
  await writeFile(join(root, ".env.worker"), "WORKER_INTERVAL_MS=500\n");
  const server = new LocalServer({ serverRoot: root, webRoot: join(root, "apps/web/dist"), configRoot: root, onExit: () => assert.fail("not started") });
  await assert.rejects(server.start({ projectRoot: root, dataDir: join(root, "data"), nodePath: "node" }), /DATABASE_URL is required in both/);
  assert.equal(server.child, null);
  assert.equal(server.ready, false);
  await server.stop();
});
