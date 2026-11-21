import assert from "node:assert/strict";
import test from "node:test";
import { sidecarEnvironment } from "./rpc.ts";

const base = { dataDir: "/tmp/context", homeDir: "/tmp/home", appDirs: {}, secretKey: "" };
const ambient = { PATH: "/usr/bin", HTTPS_PROXY: "http://ambient.invalid:8080", NO_PROXY: "127.0.0.1,localhost" };

test("project sidecars keep ambient proxy variables without enabling Node env proxy", () => {
  const env = sidecarEnvironment(base, ambient);
  assert.equal(env.HTTPS_PROXY, ambient.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, ambient.NO_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, undefined);
});

test("native sidecars prefer the provider proxy and enable Node env proxy", () => {
  const env = sidecarEnvironment({ ...base, proxyEnv: { HTTPS_PROXY: "http://provider.invalid:7890", NO_PROXY: "localhost,::1" } }, ambient);
  assert.equal(env.HTTPS_PROXY, "http://provider.invalid:7890");
  assert.equal(env.NO_PROXY, "localhost,::1,127.0.0.1");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("native sidecars without a provider proxy may use ambient proxy routing", () => {
  const env = sidecarEnvironment({ ...base, proxyEnv: {} }, ambient);
  assert.equal(env.HTTPS_PROXY, ambient.HTTPS_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});
