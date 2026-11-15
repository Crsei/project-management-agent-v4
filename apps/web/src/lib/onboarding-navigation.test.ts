import assert from "node:assert/strict"
import { test } from "node:test"
import { onboardingProviderUrl, onboardingReturnTo } from "./onboarding-navigation.ts"

test("provider settings round trip retains only a PM guide target", () => {
  const target = "/pm/9a3d8e7c-6b51-4f02-8a93-c0d3e6f9a512/onboarding"
  const url = new URL(onboardingProviderUrl(target), "http://localhost")
  assert.equal(url.pathname, "/agent/settings/providers")
  assert.equal(onboardingReturnTo(url.search), target)
  for (const value of ["https://evil.test", "//evil.test/pm", `${target}/../settings`, `${target}?next=https://evil.test`, `${target}#token=secret`, "/pm/not-a-workspace/onboarding", "/pm/9a3d8e7c-6b51-4f02-8a93-c0d3e6f9a512/settings"]) {
    assert.equal(onboardingReturnTo(new URLSearchParams({ setupReturnTo: value }).toString()), null)
    assert.equal(onboardingProviderUrl(value), "/agent/settings/providers")
  }
})
