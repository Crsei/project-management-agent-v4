import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertWindowsInstallFileLimit, inspectPayloadFiles, payloadBudgets, WINDOWS_INSTALL_FILE_LIMIT } from "./payload-files.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-payload-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

test("payload report counts files, bytes and top-level areas", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "resources/nested"), { recursive: true });
  await writeFile(join(root, "app.asar"), "asar");
  await writeFile(join(root, "resources/a.js"), "a");
  await writeFile(join(root, "resources/c.js"), "c");
  await writeFile(join(root, "resources/nested/b.bin"), "bb");

  const report = await inspectPayloadFiles(root);
  assert.equal(report.files, 4);
  assert.equal(report.bytes, 8);
  assert.deepEqual(report.topLevel, { "app.asar": 1, resources: 3 });
  assert.deepEqual(report.topDirectories.slice(0, 2), [
    { path: "resources", files: 2, bytes: 2 },
    { path: ".", files: 1, bytes: 4 },
  ]);
});

test("Windows install file budget rejects over-limit payloads only", () => {
  assert.doesNotThrow(() => assertWindowsInstallFileLimit("win32-x64", 45_000));
  assert.throws(() => assertWindowsInstallFileLimit("win32-x64", 45_001));
  assert.throws(() => assertWindowsInstallFileLimit("win32-arm64", 45_001));
  assert.doesNotThrow(() => assertWindowsInstallFileLimit("darwin-arm64", 1_000_000));
});

test("component accounting is a deterministic disjoint PM/Agent/Electron/runtime allowlist", async (t) => {
  const root = await fixture(t);
  const files = [
    ["resources/workspace-runtime/node_modules/pm-dependency/index.js", "pm", 3],
    ["resources/workspace-runtime/apps/server/pm/src/main.ts", "pm", 5],
    ["resources/workspace-runtime/apps/server/worker/src/main.ts", "pm", 7],
    ["resources/workspace-runtime/apps/server/gateway.ts", "pm", 11],
    ["resources/workspace-runtime/packages/pm-core/src/index.ts", "pm", 13],
    ["resources/workspace-runtime/apps/server/agent/dist/index.mjs", "agent", 17],
    ["resources/workspace-runtime/apps/server/agent/node_modules/effect/index.js", "agent", 19],
    ["resources/desktop-runtime/node/node.exe", "runtime", 23],
    ["resources/desktop-runtime/postgres/bin/postgres.exe", "runtime", 29],
    ["resources/app.asar", "electron", 31],
    ["resources/app.asar.unpacked/node_modules/native.node", "electron", 37],
    ["PM Agent v4.exe", "electron", 41],
    ["locales/zh-CN.pak", "electron", 43],
    ["resources/workspace-runtime/apps/web/dist/index.html", "shared", 47],
    ["resources/workspace-runtime/packages/agent-contracts/src/index.ts", "shared", 53],
    ["resources/workspace-runtime/licenses/desktop-web/NOTICE", "shared", 59],
    ["resources/workspace-runtime/desktop-dependency-layout.json", "shared", 61],
    ["resources/workspace-runtime/apps/desktop/package.json", "shared", 2],
    ["resources/workspace-runtime/desktop-runtime-native.json", "shared", 4],
    ["resources/desktop-install-stamp.json", "shared", 6],
    ["resources/desktop-install-files.json", "shared", 8],
    ["resources/workspace-runtime/apps/server/agentish/mystery", "other", 67],
    ["resources/workspace-runtime/node_modules-old/mystery", "other", 71],
    ["resources/unexpected/node_modules/agent/file", "other", 73],
    ["unknown.dll", "other", 79],
  ];
  for (const [path, , bytes] of files.toReversed()) await put(root, path, Buffer.alloc(bytes));
  const report = await inspectPayloadFiles(root);
  const expected = Object.fromEntries(["pm", "agent", "electron", "runtime", "shared", "other"]
    .map((name) => [name, { files: 0, bytes: 0, links: 0 }]));
  for (const [, component, bytes] of files) { expected[component].files++; expected[component].bytes += bytes; }
  assert.deepEqual(report.components, expected);
  assert.equal(report.files, files.length);
  assert.equal(report.bytes, files.reduce((sum, [, , bytes]) => sum + bytes, 0));
  assert.equal(Object.values(report.components).reduce((sum, component) => sum + component.files, 0), report.files);
  assert.equal(Object.values(report.components).reduce((sum, component) => sum + component.bytes, 0), report.bytes);
  assert.equal(Object.values(report.topLevel).reduce((sum, count) => sum + count, 0), report.files);
  assert.equal(Object.values(report.topLevelBytes).reduce((sum, bytes) => sum + bytes, 0), report.bytes);
  assert.deepEqual(Object.keys(report.classification.categories), Object.keys(expected));
  assert.deepEqual(Object.keys(report.topLevel), ["PM Agent v4.exe", "locales", "resources", "unknown.dll"]);
  assert.deepEqual(await inspectPayloadFiles(root), report);
});

test("macOS bundle classification keeps framework, app, PM, Agent and runtime bytes separate", async (t) => {
  const root = await fixture(t);
  await put(root, "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework", "framework");
  await put(root, "Contents/MacOS/PM Agent v4", "shell");
  await put(root, "Contents/Resources/app.asar", "archive");
  await put(root, "Contents/Resources/en.lproj/locale.pak", "locale");
  await put(root, "Contents/Resources/workspace-runtime/node_modules/package/index.js", "pm");
  await put(root, "Contents/Resources/workspace-runtime/apps/server/agent/dist/index.mjs", "agent");
  await put(root, "Contents/Resources/desktop-runtime/node/bin/node", "node");
  const report = await inspectPayloadFiles(root);
  assert.deepEqual(report.components.electron, { files: 4, bytes: 9 + 5 + 7 + 6, links: 0 });
  assert.deepEqual(report.components.pm, { files: 1, bytes: 2, links: 0 });
  assert.deepEqual(report.components.agent, { files: 1, bytes: 5, links: 0 });
  assert.deepEqual(report.components.runtime, { files: 1, bytes: 4, links: 0 });
  assert.equal(report.components.other.files, 0);
});

test("logical bytes count sparse lengths, hardlinked paths and opaque archives without claiming disk use", async (t) => {
  const root = await fixture(t);
  await put(root, "resources/app.asar", "not-expanded-even-if-it-looks-like-an-archive");
  const length = 16 * 1024 * 1024;
  const file = await open(join(root, "sparse.bin"), "wx");
  try { await file.truncate(length); } finally { await file.close(); }
  await link(join(root, "sparse.bin"), join(root, "hardlinked.bin"));
  const report = await inspectPayloadFiles(root);
  assert.equal(report.files, 3);
  assert.equal(report.bytes, length * 2 + Buffer.byteLength("not-expanded-even-if-it-looks-like-an-archive"));
  assert.equal(report.components.electron.files, 1);
  assert.equal(report.accounting.diskBytes, null);
  assert.equal(report.accounting.diskUsageMeasured, false);
  assert.equal(report.accounting.installationExecuted, false);
  assert.equal(report.accounting.uninstallTimingMeasured, false);
});

test("file and logical-byte budgets expose exact boundary and excess without inventing a byte ceiling", async (t) => {
  assert.equal(WINDOWS_INSTALL_FILE_LIMIT, 45_000);
  assert.deepEqual(payloadBudgets({ files: 45_000, bytes: 123 }).logicalBytes,
    { actual: 123, limit: null, remaining: null, withinLimit: null });
  const boundary = payloadBudgets({ files: 45_000, bytes: 123 }, { byteLimit: 123 });
  assert.equal(boundary.withinLimit, true);
  assert.equal(boundary.files.remaining, 0);
  assert.equal(boundary.logicalBytes.remaining, 0);
  const exceeded = payloadBudgets({ files: 45_001, bytes: 124 }, { byteLimit: 123 });
  assert.equal(exceeded.withinLimit, false);
  assert.equal(exceeded.files.remaining, -1);
  assert.equal(exceeded.logicalBytes.remaining, -1);
  for (const invalid of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => payloadBudgets({ files: invalid, bytes: 0 }));
    assert.throws(() => payloadBudgets({ files: 0, bytes: invalid }));
    assert.throws(() => payloadBudgets({ files: 0, bytes: 0 }, { fileLimit: invalid }));
    assert.throws(() => payloadBudgets({ files: 0, bytes: 0 }, { byteLimit: invalid }));
    assert.throws(() => assertWindowsInstallFileLimit("win32-x64", 1, invalid));
  }
  const root = await fixture(t);
  await put(root, "one.bin", "123");
  const report = await inspectPayloadFiles(root, { fileLimit: 1, byteLimit: 2 });
  assert.equal(report.budgets.files.withinLimit, true);
  assert.equal(report.budgets.logicalBytes.withinLimit, false);
  assert.equal(report.budgets.withinLimit, false);
});

test("payload roots, ancestors and descendants reject symbolic links and Windows junctions", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "real/nested"), { recursive: true });
  await put(root, "real/nested/file", "private");
  const kind = process.platform === "win32" ? "junction" : "dir";
  await symlink(join(root, "real"), join(root, "alias"), kind);
  await assert.rejects(inspectPayloadFiles(join(root, "alias")));
  await assert.rejects(inspectPayloadFiles(join(root, "alias/nested")));
  await assert.rejects(inspectPayloadFiles(root));
  if (process.platform === "win32")
    await assert.rejects(inspectPayloadFiles(root, { allowContainedSymlinks: true }));
});

if (process.platform !== "win32") {
  test("allowed contained links count once but never duplicate their targets or recurse into directory cycles", async (t) => {
    const root = await fixture(t);
    await put(root, "resources/desktop-runtime/node/bin/node", "node");
    await symlink("bin/node", join(root, "resources/desktop-runtime/node/current"));
    await symlink(".", join(root, "resources/desktop-runtime/node/loop"));
    const report = await inspectPayloadFiles(root, { allowContainedSymlinks: true });
    assert.deepEqual({ files: report.files, bytes: report.bytes, links: report.links }, { files: 1, bytes: 4, links: 2 });
    assert.deepEqual(report.components.runtime, { files: 1, bytes: 4, links: 2 });
    assert.equal(Object.values(report.components).reduce((sum, component) => sum + component.links, 0), report.links);
  });

  test("contained-link mode still rejects escaping, absolute and dangling links", async (t) => {
    const root = await fixture(t);
    await put(root, "safe/file", "inside");
    for (const target of ["../../outside", join(root, "safe/file"), "missing"]) {
      const filename = join(root, "bad");
      await symlink(target, filename);
      await assert.rejects(inspectPayloadFiles(root, { allowContainedSymlinks: true }));
      await rm(filename);
    }
  });
}
