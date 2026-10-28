import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as tar from "tar";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { ACP_REGISTRY_URL, decodeAcpRegistryIndex, prepareAcpRegistry, registryCommandSegments, resolveAcpRegistry, searchAcpRegistry, selectAcpRegistryDistribution, validateAcpRegistryConfig, type AcpRegistryAgent } from "./acp-registry-support.ts";

const agent: AcpRegistryAgent = { id: "example", name: "Example Agent", description: "A coding agent", version: "1.2.3", authors: ["Example Team"], distribution: { binary: { "linux-x86_64": { archive: "https://downloads.example.test/agent.tar.gz", cmd: "bin/agent", args: ["--acp"], env: { NATIVE_PROFILE: "registry" } } }, npx: { package: "@example/agent@1.2.3" }, uvx: { package: "example-agent==1.2.3" } } };

test("Official registry schema rejects floating package versions, unsafe URLs and path versions", () => {
  const index = decodeAcpRegistryIndex({ version: "1", agents: [agent, { ...agent, id: "floating", distribution: { npx: { package: "agent@latest" } } }, { ...agent, id: "bad-url", website: "http://insecure.test" }, { ...agent, id: "bad-version", version: ".." }] });
  assert.deepEqual(index.map((entry) => entry.id), ["example"]);
  assert.throws(() => decodeAcpRegistryIndex({ version: "..", agents: [] }));
});
test("Registry distribution selection follows source precedence and Windows ARM fallback", () => {
  assert.equal(selectAcpRegistryDistribution(agent, "auto", "linux", "x64").kind, "binary");
  assert.equal(selectAcpRegistryDistribution(agent, "npx", "linux", "x64").packageSpec, "@example/agent@1.2.3");
  assert.equal(selectAcpRegistryDistribution(agent, "auto", "linux", "arm64").kind, "npx");
  const windows: AcpRegistryAgent = { ...agent, distribution: { binary: { "windows-x86_64": { archive: "https://downloads.example.test/windows.zip", cmd: "agent.exe" } } } };
  assert.equal(selectAcpRegistryDistribution(windows, "binary", "win32", "arm64").target, "windows-x86_64");
  assert.throws(() => selectAcpRegistryDistribution(agent, "binary", "linux", "arm64"), /no compatible/);
});
test("Registry command paths reject traversal, absolute paths and Windows drive escapes", () => {
  assert.deepEqual(registryCommandSegments("./bin/agent"), ["bin", "agent"]);
  for (const value of ["../agent", "/tmp/agent", "C:\\agent.exe", "bin/../../agent", "bin\\..\\agent", "./"]) assert.throws(() => registryCommandSegments(value));
  assert.equal(validateAcpRegistryConfig({}).source, "registry");
  assert.equal(validateAcpRegistryConfig({ source: "local" }).commandPath, "");
  assert.throws(() => validateAcpRegistryConfig({ source: "local", shell: true }));
});
test("Local ACP resolution never contacts registry and preserves argument boundaries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-acp-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Local resolution must not use network"); });
  const args = ["--profile", "", " spaced ", "$(touch injected); $VALUE"];
  const context: ProviderDriverContext = { instanceId: "local", driver: "acpRegistry", config: validateAcpRegistryConfig({ source: "local", commandPath: process.execPath, commandArgs: args }), env: { HOME: root, PATH: process.env.PATH }, cwd: root, homeDirectory: root, revision: 1 };
  const resolved = await resolveAcpRegistry(context);
  assert.equal(resolved.distribution, "local"); assert.deepEqual(resolved.spawn.args, args); assert.equal(resolved.commandPath, process.execPath);
  await assert.rejects(resolveAcpRegistry({ ...context, config: validateAcpRegistryConfig({ agentId: "not-prepared" }) }), /not prepared/);
});
test("Explicit preparation verifies SHA-256, rejects symlink archives and persists only safe managed commands", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-acp-prepare-")); t.after(() => rm(root, { recursive: true, force: true }));
  const staging = path.join(root, "staging"); await mkdir(staging);
  await symlink("/etc/passwd", path.join(staging, "agent"));
  const archive = path.join(root, "unsafe.tgz"); await tar.c({ file: archive, cwd: staging, gzip: true }, ["agent"]);
  const unsafeBytes = await readFile(archive); const safeBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const registryAgents = [
    { id: "safe", name: "Safe Agent", version: "1.0.0", description: "Safe", distribution: { binary: { [platform]: { archive: "https://downloads.example.test/safe.bin", cmd: "bin/agent", sha256: createHash("sha256").update(safeBytes).digest("hex"), args: ["--acp", " spaced "] } } } },
    { id: "bad-hash", name: "Bad Hash", version: "1.0.0", description: "Bad hash", distribution: { binary: { [platform]: { archive: "https://downloads.example.test/safe.bin", cmd: "agent", sha256: "0".repeat(64) } } } },
    { id: "bad-link", name: "Bad Link", version: "1.0.0", description: "Bad link", distribution: { binary: { [platform]: { archive: "https://downloads.example.test/unsafe.tgz", cmd: "agent" } } } },
    { ...agent, id: "safe-prefix", name: "Safe companion", authors: [], description: "Native helper" },
    { ...agent, id: "author-match", name: "Native helper", authors: ["Safe Team"], description: "Native helper" },
    { ...agent, id: "description-match", name: "Reference helper", authors: [], description: "For safe tasks" },
  ];
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input); requests.push(url);
    if (url === ACP_REGISTRY_URL) return new Response(JSON.stringify({ version: "1", agents: registryAgents }));
    if (url.endsWith("safe.bin")) return new Response(new Uint8Array(safeBytes));
    if (url.endsWith("unsafe.tgz")) return new Response(new Uint8Array(unsafeBytes));
    throw new Error(`Unexpected registry request: ${url}`);
  });
  const context: ProviderDriverContext = { instanceId: "registry", driver: "acpRegistry", config: validateAcpRegistryConfig({ agentId: "safe" }), env: { HOME: root, PATH: process.env.PATH }, cwd: root, homeDirectory: path.join(root, "home"), revision: 1 };
  await assert.rejects(resolveAcpRegistry(context), /not prepared/); assert.equal(requests.length, 0);
  const prepared = await prepareAcpRegistry(context); assert.equal(prepared.agentId, "safe"); assert.deepEqual(prepared.spawn.args, ["--acp", " spaced "]);
  assert.equal(await readFile(prepared.commandPath, "utf8"), safeBytes.toString());
  const before = requests.length; assert.equal((await resolveAcpRegistry(context)).commandPath, prepared.commandPath); assert.equal(requests.length, before);
  await assert.rejects(prepareAcpRegistry({ ...context, config: validateAcpRegistryConfig({ agentId: "bad-hash" }) }), /SHA-256/);
  await assert.rejects(prepareAcpRegistry({ ...context, config: validateAcpRegistryConfig({ agentId: "bad-link" }) }), /links\/special/);
  const search = await searchAcpRegistry({ query: "safe", limit: 20 });
  assert.deepEqual(search.agents.map((entry) => entry.id), ["safe", "safe-prefix", "author-match", "description-match"]);
  const linkedHome = path.join(root, "linked-home"); const outside = path.join(root, "outside");
  await mkdir(linkedHome); await mkdir(outside);
  await symlink(outside, path.join(linkedHome, ".acp-registry"), "dir");
  await assert.rejects(prepareAcpRegistry({ ...context, homeDirectory: linkedHome }), /symlinks/);
});
