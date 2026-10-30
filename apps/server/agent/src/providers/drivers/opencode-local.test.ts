import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getStoredInstance, providerContext, updateProviderInstance } from "../instances.ts";
import { stopPmProviderApplication } from "../t3code/application.ts";
import { opencodeAdapter } from "./opencode.ts";
import { createOpenCodeTestHarness } from "./opencode-test-harness.ts";
import { writeOpenCodeCliFixture, type OpenCodeCliVersionState } from "./opencode-cli-fixture.ts";

for (const generation of ["v1", "v2"] as const) {
  test(`original OpenCode ${generation} local launch preserves HOME/XDG and its native process ownership`, { timeout: 25_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const binary = path.join(f.root, "native-fixture.mjs"); const record = path.join(f.root, "native-processes.jsonl");
      const versionStatePath = path.join(f.root, "native-version.json");
      const version: OpenCodeCliVersionState = generation === "v2" ? { stdout: "opencode v2.1.2", version: "2.1.2" } : { stdout: "1.18.32", version: "1.18.32" };
      await writeFile(versionStatePath, JSON.stringify(version));
      await writeOpenCodeCliFixture({ binaryPath: binary, generation, versionStatePath, processRecordPath: record });
      const stored = updateProviderInstance(f.context.instanceId, { config: { binaryPath: binary, serverUrl: "", serverPassword: "configured-test-password" } }, f.context.revision);
      const context = providerContext(stored, f.context.cwd);
      const readProcesses = async () => (await readFile(record, "utf8")).trim().split("\n").map(line =>
        JSON.parse(line) as { pid: number; cwd: string; home: string; data: string; wrongPasswordPresent: boolean });
      const checked = await opencodeAdapter.check(context);
      assert.deepEqual(checked.models.map(model => model.id), ["native-api/model/one"]);
      const inventoryProcesses = await readProcesses();
      assert.ok(inventoryProcesses.length > 0, "The original catalog must launch an owned local server");
      for (const owned of inventoryProcesses) assert.doesNotThrow(() => process.kill(owned.pid, 0));
      const result = await f.run(context, { model: "native-api/model/one", prompt: "ADD 19 23" });
      assert.equal(result.text, "計算=42");
      const processes = await readProcesses();
      for (const owned of processes) {
        assert.equal(owned.cwd, context.cwd); assert.equal(owned.home, context.env.HOME); assert.equal(owned.data, context.env.XDG_DATA_HOME);
        if (generation === "v2") assert.equal(owned.wrongPasswordPresent, false);
      }
      const inventoryPids = new Set(inventoryProcesses.map(owned => owned.pid));
      const sessionProcesses = processes.filter(owned => !inventoryPids.has(owned.pid));
      if (generation === "v1") {
        // Native v1 sessions have their own scope; they do not borrow the catalog's server.
        assert.ok(sessionProcesses.length > 0, "OpenCode v1 must launch its native session child");
        for (const owned of sessionProcesses) assert.throws(() => process.kill(owned.pid, 0),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH",
          "The completed v1 session must reap its own child before returning");
      } else {
        assert.equal(sessionProcesses.length, 0, "OpenCode v2 must borrow the instance-owned catalog server");
      }
      for (const owned of inventoryProcesses) assert.doesNotThrow(() => process.kill(owned.pid, 0),
        "Closing a native session must not close the separately owned catalog server");
      await stopPmProviderApplication();
      for (const owned of processes) assert.throws(() => process.kill(owned.pid, 0),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH",
        "Application shutdown must reap every owned local server");
      const response = await fetch(`${f.wire.url}/${generation === "v2" ? "api/info" : "global/health"}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${f.wire.password}`, "utf8").toString("base64")}` } });
      assert.equal(response.status, 200, "Unrelated external listener must survive local cleanup"); f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} explicit npm update stays in its installed generation`, { timeout: 20_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const packageName = generation === "v2" ? "@opencode/cli" : "opencode-ai";
      const executable = path.join(f.root, "prefix", "lib", "node_modules", ...packageName.split("/"), "bin", "opencode");
      const bin = path.join(f.root, "bin"); const record = path.join(f.root, "npm-args.json");
      const versionStatePath = path.join(f.root, "npm-cli-version.json");
      const initial: OpenCodeCliVersionState = generation === "v2" ? { stdout: "opencode v2.1.2", version: "2.1.2" } : { stdout: "1.18.32", version: "1.18.32" };
      const updated: OpenCodeCliVersionState = generation === "v2" ? { stdout: "opencode v2.1.3", version: "2.1.3" } : { stdout: "1.18.33", version: "1.18.33" };
      await mkdir(path.dirname(executable), { recursive: true }); await mkdir(bin);
      await writeFile(versionStatePath, JSON.stringify(initial));
      await writeOpenCodeCliFixture({ binaryPath: executable, generation, versionStatePath });
      await symlink(executable, path.join(bin, "opencode"));
      // Extensionless npm fixture may be loaded as CJS or ESM by the native launcher.
      await writeFile(path.join(bin, "npm"), `#!${process.execPath}\nvoid import("node:fs").then(fs=>{fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));fs.writeFileSync(${JSON.stringify(versionStatePath)},${JSON.stringify(JSON.stringify(updated))});});\n`);
      await chmod(path.join(bin, "npm"), 0o700);
      const current = getStoredInstance(f.context.instanceId)!;
      const stored = updateProviderInstance(current.instanceId, { config: { binaryPath: path.join(bin, "opencode"), serverUrl: "", serverPassword: "" },
        environment: [...Object.entries(current.env).map(([name, value]) => ({ name, value, sensitive: false })), { name: "PATH", value: bin, sensitive: false }] }, current.revision);
      assert.ok(opencodeAdapter.update);
      await opencodeAdapter.update(providerContext(stored, f.context.cwd));
      assert.deepEqual(JSON.parse(await readFile(record, "utf8")), ["install", "-g", "--prefix", path.join(f.root, "prefix"), `--allow-scripts=${packageName}`, `${packageName}@latest`]);
      const after = getStoredInstance(stored.instanceId)!;
      const refreshed = await opencodeAdapter.check(providerContext(after, f.context.cwd));
      assert.equal(refreshed.installation.version, updated.version);
      assert.deepEqual(refreshed.models.map(model => model.id), ["native-api/model/one"]);
      const external = updateProviderInstance(after.instanceId, { config: { ...after.config, serverUrl: f.wire.url, serverPassword: f.wire.password } }, after.revision);
      // External server lifetime and the explicitly selected local CLI installation are distinct.
      // Restore an older local version so a no-op update cannot pass this assertion.
      await writeFile(versionStatePath, JSON.stringify(initial));
      const before = f.wire.requests.length;
      await opencodeAdapter.update(providerContext(external, f.context.cwd));
      assert.deepEqual(JSON.parse(await readFile(versionStatePath, "utf8")), updated);
      assert.deepEqual(JSON.parse(await readFile(record, "utf8")), ["install", "-g", "--prefix", path.join(f.root, "prefix"), `--allow-scripts=${packageName}`, `${packageName}@latest`]);
      assert.equal(f.wire.requests.slice(before).some(request => request.method !== "GET"), false, "Explicit CLI maintenance must not mutate or shut down the separately owned server");
      assert.equal(f.wire.prompts.length, 0); f.wire.assertClean();
    } finally { await f.close(); }
  });

  test(`original OpenCode ${generation} never borrows an unrelated listener announced by its failed owned startup`, { timeout: 25_000 }, async () => {
    const f = await createOpenCodeTestHarness(generation);
    try {
      const binary = path.join(f.root, "wrong-address.mjs"); const record = path.join(f.root, "owned-pid");
      await writeFile(binary, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nimport {createServer} from 'node:net';\nif(process.argv.includes('--version')){console.log(${JSON.stringify(generation === "v2" ? "opencode v2.1.2" : "1.18.32")});process.exit(0);}\nwriteFileSync(${JSON.stringify(record)},String(process.pid),{mode:0o600});\ncreateServer().listen(0,'127.0.0.1',()=>console.log('OpenCode server listening on '+${JSON.stringify(f.wire.url)}));\n`);
      await chmod(binary, 0o700);
      const stored = updateProviderInstance(f.context.instanceId, { config: { binaryPath: binary, serverUrl: "", serverPassword: "controlled-password" } }, f.context.revision);
      await assert.rejects(f.run(providerContext(stored, f.context.cwd), { model: "native-api/model/one", prompt: "ADD 19 23" }));
      assert.equal(f.wire.requests.length, 0, "A wrong listener must be rejected before sending it any probes or credentials");
      const pid = Number(await readFile(record, "utf8"));
      assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH");
      f.wire.assertClean();
    } finally { await f.close(); }
  });
}

test("original OpenCode preserves the v1 minimum-version gate", { timeout: 20_000 }, async () => {
  const f = await createOpenCodeTestHarness("v1", { version: "1.14.18" });
  try {
    await assert.rejects(f.run(f.context, { model: "native-api/model/one", prompt: "ADD 19 23" }));
    assert.equal(f.wire.prompts.length, 0); f.wire.assertClean();
  } finally { await f.close(); }
});
