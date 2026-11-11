import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopUpdater, desktopUpdateTargetArch, readCandidateRelease, verifyDownloadedInstaller } from "./updater.mjs";
import { installStamp, updateRelease } from "./tests/updater-fixture.mjs";

const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("electron-updater"))("semver");

async function controller(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-updater-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = updateRelease({ current: overrides.stamp || installStamp(), targetArch: overrides.targetArch });
  const path = join(directory, release.artifact.path);
  await writeFile(path, release.payload);
  const calls = { check: 0, download: 0, confirm: 0, stop: 0, install: 0, quitAndInstall: 0 };
  const updater = Object.assign(new EventEmitter(), {
    currentVersion: parse(release.current.version),
    setFeedURL(value) { this.feed = value; },
    checkForUpdates: async () => { calls.check++; return { isUpdateAvailable: true, updateInfo: release.info }; },
    downloadUpdate: async () => { calls.download++; return [path]; },
    quitAndInstall: () => { calls.quitAndInstall++; },
  });
  const states = [];
  const runtime = new DesktopUpdater({
    version: release.current.version, stamp: release.current, packaged: true, updater, fetch: release.fetch,
    createCancellationToken: () => ({ cancel() { this.cancelled = true; } }),
    confirmInstall: async () => { calls.confirm++; return true; },
    stop: async () => { calls.stop++; }, install: async start => { calls.install++; start(); },
    onState: value => states.push(value), ...overrides,
  });
  return { runtime, updater, release, calls, states, path };
}

async function downloaded(value) {
  assert.equal((await value.runtime.check()).status, "available");
  assert.equal((await value.runtime.download()).status, "downloaded");
}

test("updater is fixed to public GitHub with explicit download/install and no downgrade or signature override", async t => {
  const value = await controller(t);
  assert.deepEqual(value.updater.feed, { provider: "github", owner: "Crsei", repo: "project-management-agent-v4", channel: "preview", private: false });
  assert.equal(value.updater.autoDownload, false);
  assert.equal(value.updater.autoInstallOnAppQuit, false);
  assert.equal(value.updater.allowDowngrade, false);
  assert.equal(value.updater.allowPrerelease, true);
  assert.equal(value.updater.disableWebInstaller, true);
  assert.equal(value.updater.verifyUpdateCodeSignature, undefined);
  assert.equal(value.calls.check, 0);
  const checked = await value.runtime.check();
  assert.equal(checked.status, "available");
  assert.equal(checked.targetVersion, "0.1.1-preview.2");
  assert.equal(value.calls.download, 0);
  assert.equal(value.calls.stop, 0);
  assert.equal(value.calls.install, 0);
  assert.equal(value.release.requests.every(value => value.options.credentials === "omit" && !Object.hasOwn(value.options.headers, "Authorization")), true);
  assert.equal(JSON.stringify(checked).includes(value.path), false);
});

test("development, OS-managed distributions, unsigned macOS/stable and unknown prerelease channels never enable updates", async t => {
  for (const overrides of [
    { packaged: false },
    { stamp: installStamp("0.1.1-preview.1", { distribution: "os-managed", ownership: { installation: "os-managed", scope: "per-user" } }) },
    { stamp: installStamp("0.1.1-preview.1", { platform: "darwin", distribution: "dmg", ownership: { installation: "os-managed", scope: "per-user" } }) },
    { stamp: installStamp("0.1.1") },
    { stamp: installStamp("0.1.1-nightly.1") },
  ]) {
    const value = await controller(t, overrides);
    assert.equal(value.runtime.snapshot().enabled, false);
    await assert.rejects(value.runtime.check());
    assert.equal(value.calls.check, 0);
    assert.equal(value.calls.stop, 0);
  }
});

test("no update is a genuine upstream result, while missing or failed GitHub metadata stays an error", async t => {
  const value = await controller(t);
  value.updater.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: value.release.info });
  assert.equal((await value.runtime.check()).status, "current");
  assert.equal(value.release.requests.length, 0);
  value.updater.checkForUpdates = async () => { throw new Error("GitHub preview feed not found (HTTP 404)."); };
  const failed = await value.runtime.check();
  assert.equal(failed.status, "error");
  assert.match(failed.error, /404/);
  assert.equal(failed.canInstall, false);
});

test("stable fallback, wrong tag and downgrade candidates cannot download or stop services", async t => {
  for (const info of [
    { version: "0.1.2", tag: "v0.1.2" },
    { version: "0.1.1-preview.2", tag: "v0.1.2-preview.1" },
    { version: "0.1.1-preview.0", tag: "v0.1.1-preview.0" },
    { version: "0.1.1-nightly.2", tag: "v0.1.1-nightly.2" },
  ]) {
    const value = await controller(t);
    value.release.info = { ...value.release.info, ...info };
    const result = await value.runtime.check();
    assert.equal(result.status, "error");
    assert.equal(result.canDownload, false);
    assert.equal(value.calls.stop, 0);
    await assert.rejects(value.runtime.download(), /compatible update/);
  }
});

test("migration, signing, source and arbitrary feed path mismatches fail before any stop", async t => {
  for (const corrupt of [
    release => { release.stamp.compatibility.migrationsSha256 = "e".repeat(64); },
    release => { release.stamp.signing = "signed"; },
    release => { release.manifest.source.commit = "f".repeat(40); },
    release => { release.info.files[0].url = "https://untrusted.invalid/installer.exe"; },
    release => { release.info.files[0].url = "../installer.exe"; },
    release => { release.stamp.source.dirty = true; },
  ]) {
    const value = await controller(t);
    corrupt(value.release);
    assert.equal((await value.runtime.check()).status, "error");
    assert.equal(value.calls.stop, 0);
    assert.equal(value.calls.download, 0);
  }
});

test("candidate stamp bytes and release commit are authenticated against their delivery identities", async () => {
  const release = updateRelease();
  for (const kind of ["digest", "commit", "size"]) {
    const fetch_ = async (url, options) => {
      const response = await release.fetch(url, options);
      if (kind === "commit" && url.includes("/git/ref/")) return Response.json({ object: { type: "commit", sha: "f".repeat(40) } });
      if (url.endsWith(release.manifestName)) {
        const manifest = await response.json();
        if (kind === "digest") manifest.materials[0].sha256 = "e".repeat(64);
        if (kind === "size") manifest.materials[0].bytes++;
        return Response.json(manifest);
      }
      return response;
    };
    await assert.rejects(readCandidateRelease({ current: release.current, info: release.info, fetch: fetch_ }), /source commit|stamp bytes/);
  }
});

test("single-flight update reserves connection/maintenance/lifecycle admission and rejects overlap", async t => {
  const gate = Promise.withResolvers();
  let allowed = true;
  const value = await controller(t, { canOperate: () => allowed });
  value.updater.checkForUpdates = () => gate.promise;
  const checking = value.runtime.check();
  assert.equal(value.runtime.busy, true);
  await assert.rejects(value.runtime.check(), /current connection.*lifecycle/);
  gate.resolve({ isUpdateAvailable: false, updateInfo: value.release.info });
  await checking;
  assert.equal(value.runtime.busy, false);
  allowed = false;
  await assert.rejects(value.runtime.check(), /current connection.*lifecycle/);
  assert.equal(value.calls.stop, 0);
});

test("download cancellation and emitted upstream errors never authorize install", async t => {
  const value = await controller(t);
  await value.runtime.check();
  const gate = Promise.withResolvers();
  value.updater.downloadUpdate = token => { value.token = token; return gate.promise; };
  const pending = value.runtime.download();
  value.updater.emit("download-progress", { percent: 25, transferred: 10, total: 40, bytesPerSecond: 2 });
  assert.equal(value.runtime.snapshot().progress.percent, 25);
  assert.equal(value.runtime.snapshot().canCancel, true);
  value.runtime.cancel();
  assert.equal(value.token.cancelled, true);
  gate.resolve([value.path]);
  assert.equal((await pending).status, "available");
  assert.equal(value.calls.stop, 0);
  await assert.rejects(value.runtime.restartAndInstall(), /Download and verify/);
  value.updater.downloadUpdate = async () => { value.updater.emit("error", new Error("SHA512 verification failed.")); return [value.path]; };
  assert.equal((await value.runtime.download()).status, "error");
  assert.equal(value.calls.install, 0);
});

test("verified bytes and explicit confirmation precede the only stop/install path", async t => {
  const value = await controller(t);
  await downloaded(value);
  assert.equal(value.calls.confirm, 0);
  assert.equal(value.calls.stop, 0);
  assert.equal(value.calls.quitAndInstall, 0);
  await value.runtime.restartAndInstall();
  assert.equal(value.calls.confirm, 1);
  assert.equal(value.calls.stop, 1);
  assert.equal(value.calls.install, 1);
  assert.equal(value.calls.quitAndInstall, 1);
  assert.equal(value.states.findIndex(value => value.status === "preparing") < value.states.findIndex(value => value.status === "stopping"), true);
});

test("cancelled confirmation, draft guard and graceful shutdown failures keep installation blocked", async t => {
  for (const failure of ["confirm", "draft", "postgres", "flush"]) {
    const value = await controller(t);
    await downloaded(value);
    if (failure === "confirm") value.runtime.confirmInstall = async () => false;
    else value.runtime.stop = async () => { throw new Error(`${failure} did not permit shutdown.`); };
    const result = await value.runtime.restartAndInstall();
    assert.equal(result.status, failure === "confirm" ? "downloaded" : "error");
    assert.equal(value.calls.install, 0);
    assert.equal(value.calls.quitAndInstall, 0);
    if (failure === "confirm") assert.equal(value.calls.stop, 0);
  }
});

test("changed release metadata or replaced downloaded bytes are rejected before stop/install", async t => {
  for (const failure of ["metadata", "bytes"]) {
    const value = await controller(t);
    await downloaded(value);
    if (failure === "metadata") {
      value.release.stamp.source.sha256 = "e".repeat(64);
      value.release.manifest.source.sha256 = "e".repeat(64);
    } else await writeFile(value.path, Buffer.alloc(value.release.payload.length, 0));
    const result = await value.runtime.restartAndInstall();
    assert.equal(result.status, "error");
    assert.equal(value.calls.confirm, 0);
    assert.equal(value.calls.stop, 0);
    assert.equal(value.calls.install, 0);
  }
});

test("installer digest mismatch fails both delivery SHA256 and upstream SHA512 identity checks", async t => {
  const value = await controller(t);
  const candidate = await readCandidateRelease({ current: value.release.current, info: value.release.info, fetch: value.release.fetch });
  await verifyDownloadedInstaller(value.path, candidate);
  await assert.rejects(verifyDownloadedInstaller(value.path, { ...candidate, sha512: "A".repeat(86) + "==" }), /SHA256\/SHA512/);
});

test("macOS target selection follows native arm64 under Rosetta without changing the current install identity", async t => {
  for (const [platform, arch, translated, expected] of [
    ["darwin", "x64", true, "arm64"], ["darwin", "x64", false, "x64"],
    ["darwin", "arm64", false, "arm64"], ["win32", "x64", true, "x64"],
  ]) assert.equal(desktopUpdateTargetArch({ platform, arch, runningUnderARM64Translation: translated }), expected);
  const current = installStamp("0.1.1-preview.1", {
    platform: "darwin", arch: "x64", distribution: "dmg", signing: "signed",
    ownership: { installation: "os-managed", scope: "per-user" },
  });
  const targetArch = desktopUpdateTargetArch({ platform: "darwin", arch: current.arch, runningUnderARM64Translation: true });
  const value = await controller(t, { stamp: current, targetArch });
  assert.equal((await value.runtime.check()).status, "available");
  assert.equal(value.runtime.stamp.arch, "x64");
  assert.equal(value.runtime.candidate.stamp.arch, "arm64");
  assert.equal((await value.runtime.download()).status, "downloaded");
  assert.equal(value.calls.stop, 0);
  assert.equal(value.calls.install, 0);
  await assert.rejects(readCandidateRelease({ current, info: value.release.info, targetArch: "x64", fetch: value.release.fetch }), /HTTP 404/);
});
