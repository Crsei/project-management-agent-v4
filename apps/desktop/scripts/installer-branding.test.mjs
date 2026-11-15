import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { desktopBuilderConfig, installerLifecycleInclude } from "../electron-builder.config.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = join(desktopRoot, "build");
const assetsRoot = join(desktopRoot, "assets");
const stamp = {
  version: "0.1.0", arch: "x64",
  compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) },
};

function bmpInfo(bytes) {
  assert.equal(bytes.toString("ascii", 0, 2), "BM");
  const width = bytes.readUInt32LE(18);
  const height = bytes.readInt32LE(22);
  assert.ok(height > 0, "MUI bitmaps must be bottom-up 24-bit BMPs");
  const stride = Math.ceil(width * 3 / 4) * 4;
  assert.equal(bytes.readUInt32LE(2), bytes.length);
  assert.equal(bytes.readUInt32LE(10), 54);
  assert.equal(bytes.readUInt32LE(14), 40);
  assert.equal(bytes.readUInt16LE(26), 1);
  assert.equal(bytes.readUInt32LE(30), 0, "NSIS bitmaps must be uncompressed");
  assert.equal(bytes.length, 54 + stride * height);
  return { width, height, bitsPerPixel: bytes.readUInt16LE(28) };
}

function icoCount(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  return bytes.readUInt16LE(4);
}

test("assisted installer exposes a branded, path-selectable per-user wizard that launches onboarding", async () => {
  const config = desktopBuilderConfig({
    application: join(desktopRoot, "fixture-application"),
    prepackedApplication: { directory: join(desktopRoot, "fixture-application"), sha256: "a".repeat(64) },
    workspaceRuntime: join(desktopRoot, "fixture-workspace"),
    desktopRuntime: join(desktopRoot, "fixture-runtime"),
    output: join(desktopRoot, "fixture-output"),
    electronVersion: "45.0.0", mode: "unsigned", platform: "win32", nativeBinaries: [], installStamp: stamp,
  });
  const nsis = config.nsis;
  assert.equal(nsis.oneClick, false);
  assert.equal(nsis.perMachine, false);
  assert.equal(nsis.allowElevation, false);
  assert.equal(nsis.allowToChangeInstallationDirectory, true);
  assert.equal(nsis.runAfterFinish, true);
  assert.equal(nsis.createDesktopShortcut, true);
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.shortcutName, "Dovspace");
  assert.equal(config.productName, "Dovspace");
  assert.equal(nsis.include, join(desktopRoot, "fixture-output", "desktop-lifecycle.generated.nsh"));
  assert.ok(icoCount(await readFile(nsis.installerIcon)) >= 1);
  assert.ok(icoCount(await readFile(nsis.uninstallerIcon)) >= 1);
});

test("installer artwork matches the exact MUI assisted bitmap contract", async () => {
  for (const [name, expected] of [["installerHeader.bmp", { width: 150, height: 57 }], ["installerSidebar.bmp", { width: 164, height: 314 }]]) {
    const info = bmpInfo(await readFile(join(buildRoot, name)));
    assert.deepEqual({ width: info.width, height: info.height }, expected, name);
    assert.equal(info.bitsPerPixel, 24, `${name} must be a 24-bit RGB bitmap`);
  }
});

test("desktop and web icon containers retain complete PNG size representations", async () => {
  const pngSize = bytes => {
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
    const width = bytes.readUInt32BE(16);
    assert.equal(bytes.readUInt32BE(20), width);
    return width;
  };
  assert.equal(pngSize(await readFile(join(buildRoot, "icon.png"))), 1024);
  for (const path of [join(buildRoot, "icon.ico"), join(desktopRoot, "../web/public/favicon.ico")]) {
    const bytes = await readFile(path);
    const count = icoCount(bytes);
    const sizes = [];
    let end = 6 + count * 16;
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16;
      const size = bytes[entry] || 256;
      assert.equal(bytes[entry + 1] || 256, size);
      assert.equal(bytes.readUInt16LE(entry + 4), 1);
      assert.equal(bytes.readUInt16LE(entry + 6), 32);
      const length = bytes.readUInt32LE(entry + 8);
      assert.equal(bytes.readUInt32LE(entry + 12), end);
      assert.ok(length > 0 && end + length <= bytes.length);
      assert.equal(pngSize(bytes.subarray(end, end + length)), size);
      sizes.push(size);
      end += length;
    }
    assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
    assert.equal(end, bytes.length);
  }
  const bytes = await readFile(join(buildRoot, "icon.icns"));
  assert.equal(bytes.toString("ascii", 0, 4), "icns");
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  let offset = 8;
  for (const [type, size] of [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]]) {
    assert.equal(bytes.toString("ascii", offset, offset + 4), type);
    const length = bytes.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= bytes.length);
    assert.equal(pngSize(bytes.subarray(offset + 8, offset + length)), size);
    offset += length;
  }
  assert.equal(offset, bytes.length);
});

test("branding include compiles before unchanged lifecycle gates and stays presentation-only", async () => {
  const source = installerLifecycleInclude({ migrationsSha256: stamp.compatibility.migrationsSha256, assets: assetsRoot });
  const lines = source.trim().split("\n");
  assert.equal(lines[0], `!define DOVSPACE_MIGRATIONS_SHA256 "${stamp.compatibility.migrationsSha256}"`);
  assert.equal(lines[1], `!include "${join(assetsRoot, "installer-branding.nsh")}"`);
  assert.equal(lines[2], `!include "${join(assetsRoot, "desktop-lifecycle.nsh")}"`);
  assert.throws(() => installerLifecycleInclude({ migrationsSha256: "not-a-digest", assets: assetsRoot }), /migrations digest/);

  const branding = (await readFile(join(assetsRoot, "installer-branding.nsh"), "utf8")).split("\n");
  const code = branding.map((line) => line.replace(/;.*$/, "").trim()).filter(Boolean);
  assert.equal(code.filter((line) => line.startsWith("!macro ")).length, code.filter((line) => line === "!macroend").length);
  for (const macro of ["customWelcomePage", "customUnWelcomePage"]) assert.ok(code.includes(`!macro ${macro}`), macro);
  for (const line of code) {
    assert.doesNotMatch(line, /^!include /, "branding must not pull in additional scripts");
    assert.doesNotMatch(line, /^(?:File|Exec|ExecWait|Delete|RMDir|WriteReg|DeleteReg|CreateShortCut|SetOutPath|CopyFiles|NSISdl|inetc)\b/i,
      `branding must stay presentation-only: ${line}`);
  }
  const text = code.join("\n");
  assert.match(text, /MUI_PAGE_WELCOME/);
  assert.match(text, /MUI_UNPAGE_WELCOME/);
  assert.match(text, /MUI_FINISHPAGE_RUN_TEXT "启动 Dovspace"/);
  assert.match(text, /Dovspace/);
});
