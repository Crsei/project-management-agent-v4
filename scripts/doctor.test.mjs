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
  await writeFile(path.join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.95.0"\nprofile = "minimal"\n');
  return root;
}

function tools(replacements = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command in replacements) return replacements[command];
    const stdout = command.startsWith("pnpm") ? "11.9.0\n"
      : command === "rustc" ? "rustc 1.95.0 (reviewed compiler)\n"
        : command === "cargo" ? "cargo 1.95.0 (reviewed compiler)\n"
          : command === "rustup" ? `/installed/toolchain/bin/${args[1]}\n` : "available\n";
    return { status: 0, stdout, stderr: "" };
  };
  return { run, calls };
}

const settings = { platform: "linux", nodeVersion: "24.21.0", env: {} };

test("preflight only queries existing tools from the real Cargo cwd", async (t) => {
  const root = await fixture(t);
  const { run, calls } = tools();
  const checks = await assertBuildPrerequisites({ ...settings, root, run });
  assert.ok(checks.every((check) => check.ok));
  assert.equal(calls[0].command, "pnpm");
  for (const { command, args, options } of calls) {
    assert.equal(options.cwd, path.join(root, "apps/server/cc-switch-host"));
    assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
    assert.equal(options.env.npm_config_manage_package_manager_versions, "false");
    assert.equal(options.env.RUSTUP_AUTO_INSTALL, "0");
    assert.deepEqual(args, command === "rustup" ? ["which", args[1]] : ["--version"]);
    assert.ok(!args.some((arg) => /install|metadata|build|fetch|update/.test(arg)));
  }
});

test("missing Rust is rejected without invoking download-capable shims", async (t) => {
  const root = await fixture(t);
  const { run, calls } = tools({ rustup: { status: 1, stdout: "", stderr: "toolchain not installed" } });
  await assert.rejects(assertBuildPrerequisites({ ...settings, root, run }), /Rust\/Cargo: install Rust 1\.95\.0/);
  assert.ok(!calls.some(({ command }) => command === "cargo" || command === "rustc"));
});

test("wrong pins and missing compiler are reported before build execution", async (t) => {
  const root = await fixture(t);
  const { run } = tools({
    pnpm: { status: 0, stdout: "11.8.0\n" },
    rustc: { status: 0, stdout: "rustc 1.94.0 (old compiler)\n" },
    cc: { status: null, error: new Error("not found") },
  });
  const checks = await inspectBuildPrerequisites({ ...settings, nodeVersion: "24.20.0", root, run });
  assert.deepEqual(checks.filter(({ ok }) => !ok).map(({ name }) => name), ["Node.js", "pnpm", "Rust", "C compiler"]);
});


test("inexact toolchain declarations fail without running any command", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.95"\n');
  const { run, calls } = tools();
  await assert.rejects(assertBuildPrerequisites({ ...settings, root, run }), /exact Node, pnpm and Rust/);
  assert.equal(calls.length, 0);
});
