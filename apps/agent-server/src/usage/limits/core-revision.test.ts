import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderInstance, updateProviderInstance } from "../../providers/instances.ts";
import { consumeCoreResetCredit } from "./core.ts";

test("Claude does not send a reset if the instance changes after the credits read", async () => {
  if (process.platform === "darwin") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-revision-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR; const fetchBefore = globalThis.fetch;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  try {
    const cli = path.join(root, "claude"); await writeFile(cli, "#!/bin/sh\necho 'claude 2.1.219'\n"); await chmod(cli, 0o755);
    const instance = createProviderInstance({ driver: "claude", label: "Fixture", config: { binaryPath: cli } });
    await writeFile(path.join(instance.homeDirectory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } }));
    await writeFile(path.join(instance.homeDirectory, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org" } }));
    let calls = 0;
    globalThis.fetch = async () => { calls++; updateProviderInstance(instance.instanceId, { label: "Changed" }); return Response.json({ cedar_ember: { eligible: true, next_grant_id: "grant", grants: [{ id: "grant", resets_left: 1, usable_now: true }] } }); };
    await assert.rejects(consumeCoreResetCredit(instance), /could not confirm/); assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetchBefore; if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
