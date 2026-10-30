import assert from "node:assert/strict";
import { test } from "node:test";
import { fxAdapter } from "./fx.ts";
import { createAcpTestHarness } from "./acp-test-harness.ts";

test("FX public config stays source-schema backed and rejects non-native settings", () => {
  assert.equal(fxAdapter.validateConfig({}).binaryPath, "fx");
  assert.throws(() => fxAdapter.validateConfig({ provider: "gateway" }));
  assert.throws(() => fxAdapter.validateConfig({ binaryPath: "bad\0path" }));
});

test("original FX status probes preserve native models/login without creating a native session", { timeout: 30_000 }, async t => {
  const f = await createAcpTestHarness("fx");
  try {
    const status = await fxAdapter.check(f.context, t.signal);
    assert.equal(status.installation.status, "installed"); assert.equal(status.authentication, "authenticated");
    assert.deepEqual(status.models.map(model => model.id), ["default", "native/default", "native/other"]);
    assert.deepEqual(status.methods, []); assert.equal(status.canLogout, false);
    const wire = await f.records();
    const probes = wire.filter(record => record.method === "cli");
    assert.ok(probes.some(record => JSON.stringify(record.args) === JSON.stringify(["status", "--json"])));
    assert.ok(probes.some(record => JSON.stringify(record.args) === JSON.stringify(["models", "--json"])));
    assert.ok(probes.every(record => record.home === f.context.homeDirectory && record.cwd === f.context.cwd));
    assert.equal(wire.some(record => record.method === "initialize" || record.method === "session/new" || record.method === "session/prompt"), false);
    await assert.rejects(fxAdapter.authenticate(f.context, { signal: t.signal, onUpdate() {}, readInput: async () => "" }),
      { code: "unsupported_auth", status: 409 });
    await assert.rejects(fxAdapter.logout(f.context, t.signal), { code: "unsupported_logout", status: 409 });
    assert.equal((await f.records()).some(record => record.method === "session/prompt" || record.method === "auth/login"), false);
  } finally { await f.close(); }
});

test("original FX selects native model/effort and forces the first supervised mode through typed ACP v2", { timeout: 30_000 }, async t => {
  const f = await createAcpTestHarness("fx");
  try {
    const result = await f.run(f.context, { model: "default", prompt: "ADD 6 7", signal: t.signal,
      modelOptions: [{ id: "effort", value: "medium" }] });
    assert.equal(result.text, "Native total=13");
    const wire = await f.records();
    const config = wire.filter(record => record.method === "session/set_config_option");
    assert.ok(config.every(record => record.type === "id"), "Raw v1-shaped requests must not bypass the ACP-v2 type discriminator");
    assert.ok(config.some(record => record.configId === "model" && record.value === "native/default"));
    assert.ok(config.some(record => record.configId === "mode" && record.value === "ask"));
    assert.ok(config.some(record => record.configId === "effort" && record.value === "medium"));
    const prompt = wire.find(record => record.method === "session/prompt");
    assert.equal(prompt?.enforcedMode, "ask"); assert.equal(prompt?.model, "native/default"); assert.equal(prompt?.effort, "medium");
    const promptIndex = wire.findIndex(record => record.method === "session/prompt");
    for (const configId of ["model", "mode", "effort"]) {
      const configIndex = wire.findIndex(record => record.method === "session/set_config_option" && record.configId === configId);
      assert.ok(configIndex >= 0 && configIndex < promptIndex);
    }
    const launch = wire.find(record => record.method === "cli" && JSON.stringify(record.args) === JSON.stringify(["acp"]));
    assert.equal(launch?.home, f.context.homeDirectory); assert.equal(launch?.cwd, f.context.cwd);
    const initialized = wire.find(record => record.method === "initialize");
    assert.equal(initialized?.home, f.context.homeDirectory); assert.equal(initialized?.cwd, f.context.cwd);
    assert.equal(result.nativeSession?.driver, "fx"); assert.equal(result.nativeSession?.cwd, f.context.cwd);
    assert.equal(wire.filter(record => record.method === "session/new").length, 1);
  } finally { await f.close(); }
});
