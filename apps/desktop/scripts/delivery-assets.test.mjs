import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { stringify } from "yaml";
import { configuredArtifactNames, deliveryMaterialNames, parseUpdateMetadata, validateDeliveryAssets, verifyPackagedUpdateConfiguration, verifyUpdateDelivery } from "./delivery-assets.mjs";
import { createInstallStamp } from "./install-stamp.mjs";
import { desktopUpdatePolicy, updateInstallStampAssetName } from "../src/update-policy.mjs";

async function fixture(t, { target = "win32-x64", signing = "unsigned", version = "1.2.3-preview.2" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-update-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [platform, arch] = target.split("-");
  const source = { commit: "a".repeat(40), sha256: "b".repeat(64), dirty: false };
  const installStamp = createInstallStamp({ version, platform, arch, signing, commit: source.commit, source: { sha256: source.sha256, dirty: false }, distribution: platform === "win32" ? "nsis" : "dmg", compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) } });
  const manifest = { target, signing, version, source, installStamp, updates: desktopUpdatePolicy({ version, platform, signing }), artifacts: [], materials: [] };
  const configured = configuredArtifactNames(manifest);
  const payload = Buffer.from("synthetic updater target, not an executable native installer");
  const record = async (name, bytes) => {
    await writeFile(join(directory, name), bytes);
    return { path: name, bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const digest = createHash("sha512").update(payload).digest("base64");
  const metadata = { version, files: [{ url: configured.update.artifactName, sha512: digest, size: payload.length }], path: configured.update.artifactName, sha512: digest, releaseDate: "2026-11-12T00:00:00.000Z" };
  for (const name of configured.required) {
    const bytes = name.endsWith(".yml") ? stringify(metadata) : name.endsWith(".blockmap") ? gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, sizes: [payload.length], checksums: [Buffer.alloc(18).toString("base64")] }] })) : payload;
    manifest.artifacts.push(await record(name, bytes));
  }
  for (const name of deliveryMaterialNames(manifest)) manifest.materials.push(await record(name, name === updateInstallStampAssetName({ platform, arch }) ? JSON.stringify(installStamp) : "synthetic material"));
  return { directory, manifest, configured, metadata, record };
}

test("native update feeds and public candidate metadata use exact noncolliding names", async (t) => {
  for (const [target, signing, version, feed] of [
    ["win32-x64", "unsigned", "1.2.3-preview.2", "preview.yml"],
    ["win32-x64", "signed", "1.2.3", "latest.yml"],
    ["darwin-x64", "signed", "1.2.3-preview.2", "preview-mac-x64.yml"],
    ["darwin-arm64", "signed", "1.2.3", "latest-mac-arm64.yml"],
    ["win32-x64", "unsigned", "1.2.3", null],
    ["darwin-arm64", "unsigned", "1.2.3-preview.2", null],
  ]) {
    const f = await fixture(t, { target, signing, version });
    assert.equal(f.configured.update.feedName, feed);
    const checked = await verifyUpdateDelivery(f.directory, f.manifest);
    assert.equal(checked.policy.enabled, feed !== null);
    assert.ok(validateDeliveryAssets(f.manifest).includes(`desktop-install-stamp-${target}.json`));
    if (feed) {
      assert.ok(f.configured.required.includes(`${f.configured.update.artifactName}.blockmap`));
      assert.equal(checked.feed.files[0].url, f.configured.update.artifactName);
    }
  }
  assert.throws(() => configuredArtifactNames({ version: "1.2.3-preview.2", target: "linux-x64", signing: "signed" }), /Unsupported/);
});

test("updater asset allowlist rejects absent metadata, foreign channels and target collisions", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.manifest);
  for (const removed of [f.configured.update.feedName, `${f.configured.update.artifactName}.blockmap`]) {
    f.manifest.artifacts = original.artifacts.filter((file) => file.path !== removed);
    assert.throws(() => validateDeliveryAssets(f.manifest), /exact configured/);
  }
  f.manifest.artifacts = [...original.artifacts, { path: "nightly.yml" }];
  assert.throws(() => validateDeliveryAssets(f.manifest), /exact configured/);
  f.manifest.artifacts = [...original.artifacts, original.artifacts[0]];
  assert.throws(() => validateDeliveryAssets(f.manifest), /exact configured/);
  f.manifest.artifacts = original.artifacts;
  f.manifest.materials = original.materials.filter((file) => !file.path.startsWith("desktop-install-stamp-"));
  assert.throws(() => validateDeliveryAssets(f.manifest), /missing required/);
});

test("updater feed cannot redirect, misidentify, truncate or change final installer hashes", async (t) => {
  const f = await fixture(t);
  const feedPath = join(f.directory, f.configured.update.feedName);
  for (const change of [
    (m) => { m.version = "1.2.3-preview.3"; },
    (m) => { m.files[0].url = m.path = "https://untrusted.invalid/installer.exe"; },
    (m) => { m.files[0].url = m.path = m.path.replace("x64", "arm64"); },
    (m) => { m.files[0].size++; },
    (m) => { m.files[0].sha512 = m.sha512 = Buffer.alloc(64).toString("base64"); },
    (m) => { m.path = "other.exe"; },
    (m) => { m.files.push({ ...m.files[0] }); },
    (m) => { m.files[0].extra = "unchecked"; },
    (m) => { m.stagingPercentage = 100; },
  ]) {
    const metadata = structuredClone(f.metadata); change(metadata);
    await writeFile(feedPath, stringify(metadata));
    await assert.rejects(verifyUpdateDelivery(f.directory, f.manifest), /updater/);
  }
  await writeFile(feedPath, stringify(f.metadata));
  await writeFile(join(f.directory, f.configured.update.artifactName), "tampered final bytes");
  await assert.rejects(verifyUpdateDelivery(f.directory, f.manifest), /SHA512/);
  for (const bytes of ["version: 1\nversion: 2\n", "version: &a [*a]\n", "!unsafe value\n", "[", " ".repeat(65 * 1024)]) assert.throws(() => parseUpdateMetadata(Buffer.from(bytes)), /metadata/);
});

test("candidate install stamp cannot detach from source version target signing or immutable manifest", async (t) => {
  const f = await fixture(t);
  const stampPath = join(f.directory, "desktop-install-stamp-win32-x64.json");
  const original = JSON.parse(await readFile(stampPath, "utf8"));
  for (const change of [
    (s) => { s.version = "1.2.3-preview.3"; }, (s) => { s.source.sha256 = "d".repeat(64); },
    (s) => { s.commit = "e".repeat(40); }, (s) => { s.source.dirty = true; },
    (s) => { s.signing = "signed"; }, (s) => { s.compatibility.migrationsSha256 = "f".repeat(64); },
    (s) => { s.updateMechanism = "none"; }, (s) => { s.arch = "arm64"; },
    (s) => { s.distribution = "os-managed"; s.ownership.installation = "os-managed"; },
  ]) {
    const value = structuredClone(original); change(value);
    await writeFile(stampPath, JSON.stringify(value));
    await assert.rejects(verifyUpdateDelivery(f.directory, f.manifest));
  }
  await writeFile(stampPath, JSON.stringify(original));
  f.manifest.updates = { ...f.manifest.updates, owner: "another-owner" };
  await assert.rejects(verifyUpdateDelivery(f.directory, f.manifest), /policy/);
});

test("malformed or incomplete blockmaps cannot become updater artifacts", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, `${f.configured.update.artifactName}.blockmap`);
  for (const bytes of [Buffer.from("not gzip"), gzipSync("{}"), gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, sizes: [1], checksums: [Buffer.alloc(18).toString("base64")] }] }))]) {
    await writeFile(path, bytes);
    await assert.rejects(verifyUpdateDelivery(f.directory, f.manifest), /blockmap/);
  }
});

test("final packaged updater config admits only the fixed public provider and native signing policy", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, "app-update.yml");
  await assert.rejects(verifyPackagedUpdateConfiguration(f.directory, f.manifest.installStamp), /Missing/);
  const value = { provider: "github", owner: "Crsei", repo: "project-management-agent-v4", channel: "preview", private: false, releaseType: "prerelease", updaterCacheDirName: "pm-agent-v4-desktop-updater" };
  await writeFile(path, stringify(value));
  assert.equal((await verifyPackagedUpdateConfiguration(f.directory, f.manifest.installStamp)).status, "passed");
  for (const change of [{ owner: "foreign" }, { repo: "foreign" }, { channel: "latest" }, { url: "https://untrusted.invalid" }, { token: "never-allowed" }, { private: true }, { updaterCacheDirName: "../redirect" }]) {
    await writeFile(path, stringify({ ...value, ...change }));
    await assert.rejects(verifyPackagedUpdateConfiguration(f.directory, f.manifest.installStamp), /fixed public/);
  }
  const unsignedMac = await fixture(t, { target: "darwin-arm64", signing: "unsigned" });
  await writeFile(join(unsignedMac.directory, "app-update.yml"), stringify(value));
  await assert.rejects(verifyPackagedUpdateConfiguration(unsignedMac.directory, unsignedMac.manifest.installStamp), /must not advertise/);
  const signedWin = await fixture(t, { target: "win32-x64", signing: "signed" });
  await writeFile(join(signedWin.directory, "app-update.yml"), stringify(value));
  await assert.rejects(verifyPackagedUpdateConfiguration(signedWin.directory, signedWin.manifest.installStamp), /publisher identity/);
  await writeFile(join(signedWin.directory, "app-update.yml"), stringify({ ...value, publisherName: ["Exact native publisher"] }));
  assert.equal((await verifyPackagedUpdateConfiguration(signedWin.directory, signedWin.manifest.installStamp)).status, "passed");
});
