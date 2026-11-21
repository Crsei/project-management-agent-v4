import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeEnvironment } from "./native-environment.ts";

test("evaluation release labels remain host-only and cannot change native Provider environment identity", () => {
  const keys = ["AGENT_EVALUATION_ARTIFACT_SHA256", "AGENT_EVALUATION_SOURCE_SHA256", "NATIVE_EVALUATION_ENV_FIXTURE"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "a".repeat(64);
    process.env.AGENT_EVALUATION_SOURCE_SHA256 = "b".repeat(64);
    process.env.NATIVE_EVALUATION_ENV_FIXTURE = "native-config-a";
    const baseline = nativeEnvironment();
    assert.equal(baseline.AGENT_EVALUATION_ARTIFACT_SHA256, undefined);
    assert.equal(baseline.AGENT_EVALUATION_SOURCE_SHA256, undefined);
    process.env.AGENT_EVALUATION_ARTIFACT_SHA256 = "c".repeat(64);
    assert.deepEqual(nativeEnvironment(), baseline, "a release observation label is not a native execution configuration change");
    const overridden = nativeEnvironment({ AGENT_EVALUATION_ARTIFACT_SHA256: "d".repeat(64), AGENT_EVALUATION_SOURCE_SHA256: "e".repeat(64) });
    assert.deepEqual(overridden, baseline, "instance-provided environment must not inject host evaluation identity into native children");
    process.env.NATIVE_EVALUATION_ENV_FIXTURE = "native-config-b";
    assert.notDeepEqual(nativeEnvironment(), baseline, "genuine native configuration changes remain visible to its identity fingerprint");
    assert.equal(nativeEnvironment().NATIVE_EVALUATION_ENV_FIXTURE, "native-config-b");
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
