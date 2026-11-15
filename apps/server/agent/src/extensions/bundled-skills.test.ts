import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { BundledSkillsCatalog, InstallBundledSkillsResult, ProviderBundledSkillsState } from "@agent-workspace/contracts/bundled-skills";
import type { ExtensionEvent } from "@agent-workspace/contracts/extensions";
import { readBundledPmSkills } from "../../../../../packages/skill-resources/catalog.ts";
import { accessGuard } from "../access.ts";
import { createProviderInstance, listStoredInstances, updateProviderInstance } from "../providers/instances.ts";
import { workspaceRoot } from "../paths.ts";
import { extensionRoutes } from "./routes.ts";
import { ExtensionHost, stopExtensionHost } from "./service.ts";
import { readExtensionContexts } from "./storage.ts";

const app = new Hono().use("/api/*", accessGuard).route("/api", extensionRoutes);

test("bundled routes retain browser/scope guards and reject unsupported targets or stale digest without creating context", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "bundled-skill-routes-"));
  try {
    delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CC_SWITCH_EXTERNAL_TARGETS_FILE"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    const environment = [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }];
    createProviderInstance({ instanceId: "bundled-disabled", driver: "codex", enabled: false, environment });
    createProviderInstance({ instanceId: "bundled-remote", driver: "opencode", config: { serverUrl: "http://127.0.0.1:4101" }, environment });
    createProviderInstance({ instanceId: "bundled-unsupported", driver: "cursor", environment });
    createProviderInstance({ instanceId: "bundled-custom", driver: "opencode", environment: [...environment, { name: "OPENCODE_CONFIG", value: path.join(root, "custom.json"), sensitive: false }] });
    createProviderInstance({ instanceId: "bundled-local", driver: "codex", config: { homePath: path.join(root, "native") }, environment });
    const catalogResponse = await app.request("http://127.0.0.1/api/extensions/bundled-skills", { headers: { host: "127.0.0.1" } });
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogResponse.headers.get("cache-control"), "no-store");
    const catalog = await catalogResponse.json() as BundledSkillsCatalog;
    assert.equal(catalog.skills.length, 9);
    assert.equal(catalog.skills.some(skill => skill.id === "upstream-source-update"), false);
    for (const skill of catalog.skills) {
      assert.equal(skill.sourceLabel, "Dovspace");
      assert.equal(skill.sha256, createHash("sha256").update(await readFile(path.join(workspaceRoot, skill.sourcePath))).digest("hex"));
    }
    const input = { skillIds: [catalog.skills[0]!.id], bundleDigest: catalog.bundleDigest, targetFingerprint: "0".repeat(64), confirmed: true };
    const request = (provider: string, body: unknown, headers: Record<string, string> = {}) => app.request(`http://127.0.0.1/api/extensions/providers/${provider}/bundled-skills`, { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await request("bundled-local", input, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await request("bundled-local", input, { authorization: "Bearer pm-mcp-access-v1.synthetic" })).status, 401);
    assert.equal((await request("bundled-local", input, { "x-pm-automation-signature": "synthetic" })).status, 403);
    for (const forged of [{ ...input, confirmed: false }, { ...input, homeDir: "/tmp/forged" }, { ...input, workspaceId: "forged", projectId: "PRJ-001" }, { ...input, skillIds: [input.skillIds[0], input.skillIds[0]] }]) assert.equal((await request("bundled-local", forged)).status, 400);
    const mismatch = await request("bundled-local", { ...input, bundleDigest: "0".repeat(64) });
    assert.equal(mismatch.status, 409);
    const mismatchBody: unknown = await mismatch.json();
    assert.ok(mismatchBody && typeof mismatchBody === "object" && "code" in mismatchBody);
    assert.equal(mismatchBody.code, "bundled_skills_catalog_changed");
    assert.equal((await request("bundled-local", { ...input, skillIds: ["upstream-source-update"] })).status, 400);
    const staleTarget = await request("bundled-local", input);
    assert.equal(staleTarget.status, 409);
    const staleTargetBody: unknown = await staleTarget.json();
    assert.ok(staleTargetBody && typeof staleTargetBody === "object" && "code" in staleTargetBody);
    assert.equal(staleTargetBody.code, "bundled_skills_target_changed");
    for (const provider of ["missing", "bundled-disabled", "bundled-remote", "bundled-custom", "bundled-unsupported"]) {
      const stateResponse = await app.request(`http://127.0.0.1/api/extensions/providers/${provider}/bundled-skills`, { headers: { host: "127.0.0.1" } });
      assert.equal(stateResponse.status, 200);
      const state = await stateResponse.json() as ProviderBundledSkillsState;
      assert.ok(state.skills.every(skill => skill.status === "unavailable" && skill.reason));
      const result = await request(provider, input);
      assert.equal(result.status, 200);
      assert.equal((await result.json() as InstallBundledSkillsResult).results[0]!.status, "unavailable");
    }
    assert.deepEqual(await readExtensionContexts(), []);
    const read = await app.request("http://127.0.0.1/api/extensions/providers/bundled-local/bundled-skills", { headers: { host: "127.0.0.1" } });
    assert.ok((await read.json() as ProviderBundledSkillsState).skills.every(skill => skill.status === "not-installed"));
    assert.deepEqual(await readExtensionContexts(), [], "provider inventory is not an enrollment write");
    const generic = await app.request("http://127.0.0.1/api/extensions/contexts/forged/invoke", { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ command: "install_bundled_skills", args: { skills: [] } }) });
    assert.equal(generic.status, 403, "private bundled byte commands are not a browser invoke capability");
  } finally {
    await stopExtensionHost();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("real provider bundle deployment works from a detached packaged root, isolates roots, updates verified bytes and reports native conflicts", async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "bundled-skill-provider-"));
  const packagedRoot = path.join(root, "packaged");
  const host = new ExtensionHost(packagedRoot);
  try {
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home"); process.env.USERPROFILE = process.env.HOME;
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CC_SWITCH_EXTERNAL_TARGETS_FILE"]) delete process.env[key];
    await mkdir(process.env.HOME, { recursive: true });
    for (const skill of await readBundledPmSkills(workspaceRoot)) {
      const target = path.join(packagedRoot, skill.sourcePath);
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, skill.content);
    }
    for (const instance of listStoredInstances()) updateProviderInstance(instance.instanceId, { enabled: false }, instance.revision);
    const environment = [{ name: "HOME", value: process.env.HOME, sensitive: false }, { name: "USERPROFILE", value: process.env.HOME, sensitive: false }];
    const one = path.join(root, "one"), two = path.join(root, "two");
    createProviderInstance({ instanceId: "bundle-one", driver: "codex", config: { homePath: one }, environment });
    createProviderInstance({ instanceId: "bundle-shared", driver: "codex", config: { homePath: one }, environment });
    createProviderInstance({ instanceId: "bundle-two", driver: "codex", config: { homePath: two }, environment });
    const catalog = await host.bundledSkillsCatalog();
    const input = { skillIds: catalog.skills.map(skill => skill.id), bundleDigest: catalog.bundleDigest, targetFingerprint: (await host.providerBundledSkills("bundle-one")).targetFingerprint!, confirmed: true as const };
    assert.ok((await host.providerBundledSkills("bundle-one")).skills.every(skill => skill.status === "not-installed"));
    assert.deepEqual(await readExtensionContexts(), []);
    const initial = await host.installProviderBundledSkills("bundle-one", input);
    assert.ok(initial.results.every(result => result.status === "installed"));
    assert.ok(initial.state.skills.every(skill => skill.status === "installed"));
    for (const skill of catalog.skills) assert.equal(createHash("sha256").update(await readFile(path.join(one, "skills", skill.id, "SKILL.md"))).digest("hex"), skill.sha256);
    assert.ok((await host.providerBundledSkills("bundle-two")).skills.every(skill => skill.status === "not-installed"));
    assert.ok((await host.providerBundledSkills("bundle-shared")).skills.every(skill => skill.status === "installed"));
    const owner = (await host.resolveProviderContext("bundle-one")).context;
    const events: ExtensionEvent[] = [];
    const unsubscribe = await host.subscribe(owner.id, event => events.push(event));
    const selected = catalog.skills[0]!;
    const resource = path.join(packagedRoot, selected.sourcePath);
    const revised = `${await readFile(resource, "utf8")}\nPackaged update.\n`;
    await writeFile(resource, revised);
    const nextCatalog = await host.bundledSkillsCatalog();
    assert.notEqual(nextCatalog.bundleDigest, catalog.bundleDigest);
    assert.equal((await host.providerBundledSkills("bundle-one")).skills[0]!.status, "update-available");
    await assert.rejects(host.installProviderBundledSkills("bundle-one", input), { code: "bundled_skills_catalog_changed" });
    const updated = await host.installProviderBundledSkills("bundle-one", { skillIds: [selected.id], bundleDigest: nextCatalog.bundleDigest, targetFingerprint: input.targetFingerprint, confirmed: true });
    assert.equal(updated.results[0]!.status, "updated");
    assert.equal(await readFile(path.join(one, "skills", selected.id, "SKILL.md"), "utf8"), revised);
    assert.ok(events.some(event => event.event === "changed" && event.data && typeof event.data === "object" && "liveSessionsReloaded" in event.data && event.data.liveSessionsReloaded === false));
    const foreign = path.join(one, "skills", selected.id, ".user-content");
    await writeFile(foreign, "preserve user edits");
    const conflict = await host.installProviderBundledSkills("bundle-one", { skillIds: [selected.id], bundleDigest: nextCatalog.bundleDigest, targetFingerprint: input.targetFingerprint, confirmed: true });
    assert.equal(conflict.results[0]!.status, "conflict");
    assert.equal(conflict.state.skills[0]!.status, "conflict");
    assert.equal(await readFile(foreign, "utf8"), "preserve user edits");
    const shared = await host.resolveProviderContext("bundle-shared");
    assert.equal(shared.context.id, owner.id);
    assert.equal((await host.installProviderBundledSkills("bundle-two", { skillIds: [selected.id], bundleDigest: nextCatalog.bundleDigest, targetFingerprint: (await host.providerBundledSkills("bundle-two")).targetFingerprint!, confirmed: true })).results[0]!.status, "installed");
    assert.equal(await readFile(path.join(two, "skills", selected.id, "SKILL.md"), "utf8"), revised);
    const currentProvider = listStoredInstances().find(instance => instance.instanceId === "bundle-one")!;
    updateProviderInstance(currentProvider.instanceId, { label: "Changed since review" }, currentProvider.revision);
    await assert.rejects(host.installProviderBundledSkills("bundle-one", { skillIds: [selected.id], bundleDigest: nextCatalog.bundleDigest, targetFingerprint: input.targetFingerprint, confirmed: true }), { code: "bundled_skills_target_changed" });
    unsubscribe();
  } finally {
    await host.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
