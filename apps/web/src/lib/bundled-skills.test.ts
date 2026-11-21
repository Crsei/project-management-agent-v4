import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BundledSkillsError, bundledSkillProviderIdentity, bundledSkillProviderReady, bundledSkillProviderWritable, bundledSkillProvidersSchema,
  readBundledSkillsCatalog,
  type BundledSkillProvider,
} from "./bundled-skills.ts";

const provider: BundledSkillProvider = {
  instanceId: "native-one", label: "Native one", driver: "codex", enabled: true,
  configured: true, nativeSessionReady: true, authStatus: "authenticated", revision: 2,
  email: "one@example.test", credentialSource: "provider",
};

test("reviewed provider identity changes with account, revision and readiness, not its display label", () => {
  const reviewed = bundledSkillProviderIdentity(provider);
  assert.equal(bundledSkillProviderIdentity({ ...provider, label: "Renamed" }), reviewed);
  for (const changed of [
    { ...provider, email: "two@example.test" }, { ...provider, revision: 3 },
    { ...provider, driver: "claude" }, { ...provider, enabled: false },
    { ...provider, nativeSessionReady: false }, { ...provider, authStatus: "unknown" as const },
  ]) assert.notEqual(bundledSkillProviderIdentity(changed), reviewed);
});

test("readiness uses actual enabled/configured/native facts, not account attribution alone", () => {
  assert.equal(bundledSkillProviderReady(provider), true);
  assert.equal(bundledSkillProviderReady({ ...provider, authStatus: "unknown", email: undefined }), true);
  for (const flag of ["enabled", "configured", "nativeSessionReady"] as const) {
    assert.equal(bundledSkillProviderReady({ ...provider, [flag]: false }), false);
  }
  const projected = bundledSkillProvidersSchema.parse({ providers: [{ ...provider, config: { ignored: "not-retained" }, environment: [{ value: "not-retained" }] }] });
  assert.equal("config" in projected.providers[0]!, false);
  assert.equal("environment" in projected.providers[0]!, false);
});

test("installation requires an enabled provider and an authoritative target, not a live session", () => {
  assert.equal(bundledSkillProviderWritable(provider), true);
  assert.equal(bundledSkillProviderWritable({ ...provider, configured: false, nativeSessionReady: false }), true);
  assert.equal(bundledSkillProviderWritable({ ...provider, enabled: false }), false);
});


test("access failure is not treated as an empty source catalog or successful installation", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    ++calls;
    return new Response(JSON.stringify({ code: "access_required", error: "Independent access required" }), { status: 403 });
  });
  await assert.rejects(readBundledSkillsCatalog(), (cause: unknown) => cause instanceof BundledSkillsError && cause.status === 403 && cause.code === "access_required");
  assert.equal(calls, 1);
});
