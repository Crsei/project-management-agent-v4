import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./payload-report.mjs", import.meta.url));
function report(args) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => accept({ code, signal, stdout, stderr }));
  });
}

test("payload CLI reports conserved components and enforces independent file and logical-byte budgets", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-payload-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "resources/desktop-runtime/node"), { recursive: true });
  await writeFile(join(root, "resources/desktop-runtime/node/node.exe"), "12345");
  const defaultRun = await report(["--root", root]);
  assert.equal(defaultRun.code, 0, defaultRun.stderr);
  const inventory = JSON.parse(defaultRun.stdout);
  assert.equal(inventory.files, 1);
  assert.equal(inventory.bytes, 5);
  assert.deepEqual(inventory.components.runtime, { files: 1, bytes: 5, links: 0 });
  assert.equal(inventory.limit, 45_000);
  assert.equal(inventory.byteLimit, null);
  assert.equal(inventory.budgets.logicalBytes.withinLimit, null);
  assert.equal(inventory.accounting.diskUsageMeasured, false);
  assert.equal(inventory.withinLimit, true);
  const atBoundary = await report(["--root", root, "--limit", "1", "--byte-limit", "5"]);
  assert.equal(atBoundary.code, 0, atBoundary.stderr);
  const byteFailure = await report(["--root", root, "--byte-limit", "4"]);
  assert.equal(byteFailure.code, 1, byteFailure.stderr);
  const bytes = JSON.parse(byteFailure.stdout);
  assert.equal(bytes.budgets.files.withinLimit, true);
  assert.equal(bytes.budgets.logicalBytes.remaining, -1);
  assert.equal(bytes.withinLimit, false);
  const fileFailure = await report(["--root", root, "--limit", "0"]);
  assert.equal(fileFailure.code, 1, fileFailure.stderr);
  assert.equal(JSON.parse(fileFailure.stdout).budgets.files.remaining, -1);
});

test("payload CLI rejects missing, duplicate, relative and unsafe numeric arguments", async () => {
  for (const args of [
    [], ["--root"], ["--root", "relative"], ["--unknown", "value"],
    ["--root", "/unused", "--limit", "-1"],
    ["--root", "/unused", "--byte-limit", "0.5"],
    ["--root", "/unused", "--byte-limit", "9007199254740992"],
    ["--root", "/unused", "--root", "/again"],
    ["--root", "/unused", "--limit", "1", "--limit", "2"],
    ["--root", "/unused", "--byte-limit", "1", "--byte-limit", "2"],
    ["--root", "/unused", "--allow-contained-symlinks", "--allow-contained-symlinks"],
  ]) {
    const result = await report(args);
    assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.equal(result.stdout, "", JSON.stringify(args));
    assert.ok(result.stderr.length > 0, JSON.stringify(args));
  }
});
