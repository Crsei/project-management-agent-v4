import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  decodePreparedAcpRegistryAgent, resolveAcpRegistryDistribution, resolveAcpRegistryPlatformTarget,
} from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { getStoredInstance, providerContext } from "../instances.ts";
import { readPreparedAcpRegistryConfigMigration } from "../t3code/families/acp-registry-migration.ts";
import { acpRegistryAdapter } from "./acpRegistry.ts";
import { createAcpTestHarness } from "./acp-test-harness.ts";

const agent = { id: "example", name: "Example Agent", description: "A controlled registry distribution", version: "1.2.3",
  distribution: { npx: { package: "@example/agent@1.2.3" } } };

test("original registry schema rejects floating distributions and public settings preserve argument boundaries", () => {
  assert.equal(decodePreparedAcpRegistryAgent(agent).id, "example");
  assert.throws(() => decodePreparedAcpRegistryAgent({ ...agent, distribution: { npx: { package: "agent@latest" } } }));
  assert.throws(() => decodePreparedAcpRegistryAgent({ ...agent, version: ".." }));
  const selected = resolveAcpRegistryDistribution({ agent, preference: "auto", platformTarget: resolveAcpRegistryPlatformTarget(process.platform, process.arch) });
  assert.equal(selected?.kind, "npx"); assert.equal(selected?.packageName, "@example/agent@1.2.3");
  const args = ["--profile", "", " spaced ", "$(touch injected); $VALUE"];
  assert.deepEqual(acpRegistryAdapter.validateConfig({ source: "local", commandPath: process.execPath, commandArgs: args }).commandArgs, args);
  assert.throws(() => acpRegistryAdapter.validateConfig({ source: "local", shell: true }));
  assert.throws(() => acpRegistryAdapter.validateConfig({ commandArgs: ["bad\0argument"] }));
});

test("Registry local source preparation and readiness preserve unknown authentication without inference", { timeout: 30_000 }, async t => {
  const f = await createAcpTestHarness("acpRegistry");
  try {
    await acpRegistryAdapter.prepare!(f.context, t.signal);
    assert.deepEqual(f.context, providerContext(getStoredInstance(f.context.instanceId)!, f.context.cwd));
    assert.equal((await f.records()).some(record => record.method === "session/prompt" || record.method === "auth/login"), false);
    const status = await acpRegistryAdapter.check(f.context, t.signal);
    assert.equal(status.installation.status, "installed"); assert.equal(status.authentication, "unknown");
    assert.equal(status.nativeSessionReady, true);
    assert.equal(status.canLogout, false); assert.deepEqual(status.methods, []);
    assert.equal((await f.records()).filter(record => record.method === "session/prompt").length, 0);
  } finally { await f.close(); }
});

test("Registry runs the named native ACP agent with its selected model and bound Home/cwd", { timeout: 30_000 }, async t => {
  const f = await createAcpTestHarness("acpRegistry");
  try {
    const result = await f.run(f.context, { model: "native/default", prompt: "ADD 19 23", signal: t.signal });
    assert.equal(result.text, "Native total=42");
    assert.equal(result.nativeSession?.driver, "acpRegistry");
    assert.equal(result.nativeSession?.cwd, f.context.cwd);
    const wire = await f.records();
    const initialized = wire.find(record => record.method === "initialize");
    assert.equal(initialized?.agentName, "pm-acp-native-fixture");
    assert.equal(initialized?.home, f.context.homeDirectory); assert.equal(initialized?.cwd, f.context.cwd);
    assert.ok(wire.some(record => record.method === "session/new" && record.cwd === f.context.cwd));
    assert.ok(wire.some(record => record.method === "session/set_config_option"
      && record.type === "id" && record.configId === "model" && record.value === "native/default"));
    assert.equal(wire.find(record => record.method === "session/prompt")?.model, "native/default");
    assert.equal(wire.filter(record => record.method === "session/prompt").length, 1);
    assert.equal(wire.some(record => record.method === "auth/login"), false);
  } finally { await f.close(); }
});

test("one-time registry preparation conversion preserves the exact owned executable without reinstalling or changing instance metadata", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-acp-prepared-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const binary = { archive: "https://downloads.example.test/agent.tar.gz", cmd: "bin/agent", args: ["--acp"], env: { NATIVE_PROFILE: "registry" } };
  const preparedAgent = { id: "example", name: "Example Agent", description: "Test", version: "1.2.3", distribution: { binary: { [target]: binary } } };
  const installRoot = path.join(root, ".acp-registry", "tools", "example", "1.2.3", target);
  const commandPath = path.join(installRoot, "bin", "agent");
  await mkdir(path.dirname(commandPath), { recursive: true }); await writeFile(commandPath, "controlled executable metadata", { mode: 0o700 });
  const previousDistribution = { kind: "binary", binary, target, args: binary.args, env: binary.env };
  const receipt = { agent: preparedAgent, distribution: "binary", commandPath, installRoot,
    fingerprint: createHash("sha256").update(JSON.stringify(["example", "1.2.3", previousDistribution])).digest("hex") };
  const key = createHash("sha256").update(JSON.stringify(["example", "auto"])).digest("hex").slice(0, 24);
  const receiptPath = path.join(root, ".acp-registry", `${key}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt));
  const context: ProviderDriverContext = { instanceId: "existing-registry-instance", driver: "acpRegistry", revision: 7,
    config: acpRegistryAdapter.validateConfig({ agentId: "example" }), cwd: root, stateDirectory: root, homeDirectory: root, env: { HOME: root } };
  const migrated = await readPreparedAcpRegistryConfigMigration(context);
  assert.equal(migrated?.commandPath, commandPath); assert.equal(migrated?.distribution, "binary");
  assert.equal(context.revision, 7); assert.equal(context.config.commandPath, "");
  await writeFile(receiptPath, JSON.stringify({ ...receipt, fingerprint: "invalid" }));
  await assert.rejects(readPreparedAcpRegistryConfigMigration(context), /original distribution/);
});
