import assert from "node:assert/strict";
import test from "node:test";
import { providerSendIssue } from "./provider-send-issue.ts";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";

const base = { instanceId: "codex", driver: "codex", label: "Codex", enabled: true, models: [], authStatus: "unknown" } as unknown as ProviderInstance;

test("provider send issues use only explicit configuration states", () => {
  assert.equal(providerSendIssue(undefined), "missing");
  assert.equal(providerSendIssue({ ...base, enabled: false }), "disabled");
  assert.equal(providerSendIssue({ ...base, installation: { status: "not-installed" } } as unknown as ProviderInstance), "not-installed");
  assert.equal(providerSendIssue({ ...base, installation: { status: "installed" } } as unknown as ProviderInstance), undefined);
  assert.equal(providerSendIssue(base), undefined);
});
