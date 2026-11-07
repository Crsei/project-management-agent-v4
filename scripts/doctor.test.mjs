import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertBuildPrerequisites, inspectBuildPrerequisites } from "./doctor.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-build-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps/server/cc-switch-host"), { recursive: true });
  await writeFile(path.join(root, ".node-version"), "24.21.0\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.9.0" }));
  return root;
}

function tools(replacements = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command in replacements) return replacements[command];
    const stdout = command.startsWith("pnpm") ? "11.9.0\n" : "available\n";
    return { status: 0, stdout, stderr: "" };
  };
  return { run, calls };
}

const settings = { platform: "linux", nodeVersion: "24.21.0", env: {} };

test("preflight only queries existing tools from the host workspace cwd", async (t) => {
  const root = await fixture(t);
  const { run, calls } = tools();
  const checks = await assertBuildPrerequisites({ ...settings, root, run });
  assert.ok(checks.every((check) => check.ok));
  assert.equal(calls[0].command, "pnpm");
  for (const { command, args, options } of calls) {
    assert.equal(options.cwd, path.join(root, "apps/server/cc-switch-host"));
    assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
    assert.equal(options.env.npm_config_manage_package_manager_versions, "false");
    assert.deepEqual(args, ["--version"]);
    assert.ok(!args.some((arg) => /install|metadata|build|fetch|update/.test(arg)));
  }
});

test("a missing native compiler is reported without invoking download-capable tools", async (t) => {
  const root = await fixture(t);
  const { run } = tools({ cc: { status: null, error: new Error("not found") } });
  const checks = await inspectBuildPrerequisites({ ...settings, root, run });
  assert.equal(checks.find((check) => check.name === "C compiler").ok, false);
});

test("wrong pins and missing compiler are reported before build execution", async (t) => {
  const root = await fixture(t);
  const { run } = tools({
    pnpm: { status: 0, stdout: "11.8.0\n" },
    cc: { status: null, error: new Error("not found") },
  });
  const checks = await inspectBuildPrerequisites({ ...settings, nodeVersion: "24.20.0", root, run });
  assert.deepEqual(checks.filter(({ ok }) => !ok).map(({ name }) => name), ["Node.js", "pnpm", "C compiler"]);
});


test("inexact package-manager declarations fail without running any command", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11" }));
  const { run, calls } = tools();
  await assert.rejects(assertBuildPrerequisites({ ...settings, root, run }), /exact Node and pnpm/);
  assert.equal(calls.length, 0);
});

test("Windows preflight accepts MSVC help status but rejects failed or unrelated linkers", async (t) => {
  const root = await fixture(t);
  const help = "Microsoft (R) Incremental Linker Version 14.51.36260.0\n usage: LINK [options] [files]\n /OUT:filename\n";
  const scenarios = [
    { name: "zero help status", result: { status: 0, stdout: help }, expected: true },
    { name: "MSVC help status", result: { status: 1100, stdout: help }, expected: true },
    { name: "link failure", result: { status: 1104, stdout: help, stderr: "LINK : fatal error LNK1104: cannot open file" }, expected: false },
    { name: "help followed by error", result: { status: 1100, stdout: help, stderr: "LINK : fatal error LNK1100: invalid command line" }, expected: false },
    { name: "unrelated executable", result: { status: 1100, stdout: "link (GNU coreutils)" }, expected: false },
    { name: "empty failure", result: { status: 1100, stdout: "" }, expected: false },
    { name: "missing executable", result: { status: null, error: new Error("ENOENT") }, expected: false },
    { name: "incomplete help query", result: { status: 1100, stdout: help, error: new Error("ENOBUFS") }, expected: false },
  ];
  for (const scenario of scenarios) {
    const { run } = tools({ "link.exe": scenario.result });
    const checks = await inspectBuildPrerequisites({ ...settings, platform: "win32", root, run });
    assert.equal(checks.find((check) => check.name === "MSVC linker").ok, scenario.expected, scenario.name);
  }
});
