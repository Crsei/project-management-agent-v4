import assert from "node:assert/strict";
import test from "node:test";
import { providerSendIssue } from "./provider-send-issue.ts";
import type { ProviderInstance } from "@agent-workspace/contracts/provider";

const base = { instanceId: "codex", driver: "codex", label: "Codex", enabled: true, models: [], authStatus: "unknown" } as unknown as ProviderInstance;

test("provider send issues use only explicit configuration states", () => {
  assert.equal(providerSendIssue(undefined, ""), "unselected");
  assert.equal(providerSendIssue(undefined, "codex"), "missing");
  assert.equal(providerSendIssue({ ...base, enabled: false }, "codex"), "disabled");
  assert.equal(providerSendIssue({ ...base, installation: { status: "not-installed" } } as unknown as ProviderInstance, "codex"), "not-installed");
  assert.equal(providerSendIssue({ ...base, installation: { status: "installed" } } as unknown as ProviderInstance, "codex"), undefined);
  assert.equal(providerSendIssue(base, "codex"), undefined);
});
