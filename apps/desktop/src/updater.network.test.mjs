import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import updaterPackage from "electron-updater";
import { DesktopUpdater } from "./updater.mjs";
import { updateRelease } from "./tests/updater-fixture.mjs";

const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve("electron-updater"));
const { ElectronHttpExecutor } = updaterRequire("./electronHttpExecutor.js");

// The genuine GitHubProvider, AppUpdater and upstream download/hash pipeline run
// unchanged. Only network transport is redirected to a real isolated HTTP server;
// no public release, native installer, signature or OS-install success is claimed.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "desktop-real-updater-"));
  const release = updateRelease();
  const paths = [];
  let feedVersion = release.info.version;
  let corruptDownload = false;
  let previewMissing = false;
  const server = createServer((incoming, response) => {
    const path = new URL(incoming.url, "http://fixture.invalid").pathname;
    paths.push(path);
    if (path === "/Crsei/project-management-agent-v4/releases.atom") {
      response.setHeader("content-type", "application/atom+xml");
      response.end(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Preview fixture</title><link href="https://github.com/Crsei/project-management-agent-v4/releases/tag/v${release.info.version}"/><content>Inert network integrity fixture only.</content></entry></feed>`);
      return;
    }
    if (path.endsWith("/preview.yml") || path.endsWith("/latest.yml")) {
      if (previewMissing && path.endsWith("/preview.yml")) { response.writeHead(404); response.end("missing preview feed"); return; }
      response.setHeader("content-type", "application/yaml");
      response.end(JSON.stringify({ version: feedVersion, files: release.info.files, path: release.info.path, sha512: release.info.sha512 }));
      return;
    }
    let bytes = release.routes().get(path);
    if (bytes && path.endsWith(".exe") && corruptDownload) bytes = Buffer.alloc(bytes.length, 0);
    if (!bytes) { response.writeHead(404); response.end("missing fixture route"); return; }
    response.setHeader("content-length", bytes.length);
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  class FixtureHttpExecutor extends ElectronHttpExecutor {
    createRequest(options, callback) {
      return request({ ...options, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1", port, agent: false }, callback);
    }
  }
  const config = join(root, "app-update.yml");
  await writeFile(config, JSON.stringify({ provider: "github", owner: "Crsei", repo: "project-management-agent-v4", updaterCacheDirName: "fixture-cache" }));
  const app = {
    version: release.current.version, name: "desktop-updater-network-fixture", isPackaged: true,
    appUpdateConfigPath: config, userDataPath: join(root, "user-data"), baseCachePath: join(root, "cache"),
    whenReady: async () => {}, relaunch() { throw new Error("Network fixture must not relaunch."); },
    quit() { throw new Error("Network fixture must not quit or install."); }, onQuit() {},
  };
  const updater = new updaterPackage.NsisUpdater(null, app);
  updater.httpExecutor = new FixtureHttpExecutor();
  updater._testOnlyOptions = { platform: "win32", isUseDifferentialDownload: false };
  updater.disableDifferentialDownload = true;
  let stops = 0;
  const runtime = new DesktopUpdater({
    version: app.version, stamp: release.current, packaged: true, updater,
    createCancellationToken: () => new updaterPackage.CancellationToken(),
    fetch: (url, options) => fetch(`${origin}${new URL(url).pathname}`, options),
    confirmInstall: async () => false, stop: async () => { stops++; },
    install: async () => { throw new Error("Network fixture must not install."); },
  });
  return { runtime, updater, paths, release, get stops() { return stops; },
    corruptDownload() { corruptDownload = true; }, stableFallback() { previewMissing = true; feedVersion = "0.1.2"; } };
}

test("actual GitHub updater selects preview release and downloads SHA512-verified bytes over isolated HTTP", async t => {
  const value = await fixture(t);
  assert.equal((await value.runtime.check()).status, "available");
  assert.equal(value.paths.some(path => path.endsWith("/preview.yml")), true);
  assert.equal(value.paths.some(path => path.endsWith(".exe")), false, "automatic checks must not download");
  const result = await value.runtime.download();
  assert.equal(result.status, "downloaded", result.error);
  assert.equal(result.targetVersion, "0.1.1-preview.2");
  assert.equal(value.paths.some(path => path.endsWith(value.release.artifact.path)), true);
  assert.equal(value.stops, 0);
  assert.equal(value.updater.autoInstallOnAppQuit, false);
  assert.equal((await value.runtime.restartAndInstall()).status, "downloaded", "declined confirmation preserves the downloaded update");
  assert.equal(value.stops, 0);
});

test("actual upstream download rejects wrong SHA512 bytes and cannot reach installation", async t => {
  const value = await fixture(t);
  assert.equal((await value.runtime.check()).status, "available");
  value.corruptDownload();
  const result = await value.runtime.download();
  assert.equal(result.status, "error");
  assert.match(result.error, /sha512|checksum/i);
  assert.equal(result.canInstall, false);
  assert.equal(value.stops, 0);
});

test("actual GitHubProvider preview-to-latest fallback cannot cross the controller's release channel guard", async t => {
  const value = await fixture(t);
  value.stableFallback();
  const result = await value.runtime.check();
  assert.equal(value.paths.some(path => path.endsWith("/latest.yml")), true, "upstream provider exercises its real fallback");
  assert.equal(result.status, "error");
  assert.match(result.error, /release channel|channel changes/);
  assert.equal(result.canDownload, false);
  assert.equal(value.paths.some(path => path.endsWith(".exe")), false);
  assert.equal(value.stops, 0);
});
