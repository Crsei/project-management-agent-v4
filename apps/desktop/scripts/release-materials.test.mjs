import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { create as createTar, extract as extractTar } from "tar";
import { asarTools, inspectPackagedApplication } from "./packaged-application.mjs";
import { captureSource, checksumDelivery, collectLegal, contentDigest, fileRecord, publicSourcePath, refreshVerification, requireUnchangedSource } from "./release-materials.mjs";
import { verifyDelivery, verifyDeliveryFiles } from "./verify-delivery.mjs";
import { inspectDeployment } from "./stage-workspace.mjs";
import { inventoryTree, prepareNodeDistribution, RUNTIME_MANIFEST_VERSION, runtimeSources, verifyRuntime } from "./runtime-manifest.mjs";
import { archiveMemberPath, inspectFinalArtifacts, verifyInstalledApplication } from "./final-artifact.mjs";
import { dependencyLayoutManifest } from "./dependency-layout-verifier.mjs";
import { computeMigrationsSha256, createInstallStamp } from "./install-stamp.mjs";
import { inspectShippedSBOM } from "./sbom.mjs";
import { scanSBOM } from "./osv.mjs";
import { createInstallationManifest } from "../src/uninstall.mjs";
import { HOST_SOURCE_COMMIT, HOST_UPSTREAM_VERSION, verifyHost } from "../../server/agent/scripts/cc-switch.mjs";
import { createReceiptFixture } from "./install-e2e/fixtures.mjs";
import { INSTALL_E2E_HARNESS } from "./install-e2e/evidence.mjs";
import { desktopUpdatePolicy } from "../src/update-policy.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execute = promisify(execFile);
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-release-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, name, value) {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), value);
}
async function snapshot(root, extra = {}) {
  const entries = {
    "README.md": "public fixture source\n",
    "apps/desktop/package.json": JSON.stringify({ name: "@agent-workspace/desktop", version: "0.1.0" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    ...extra,
  };
  const files = [];
  for (const name of Object.keys(entries).sort()) {
    await put(root, name, entries[name]);
    files.push({ path: name, bytes: Buffer.byteLength(entries[name]), mode: 0o644, sha256: hash(entries[name]) });
  }
  const source = { schemaVersion: 1, commit: "a".repeat(40), dirty: true, files, sha256: contentDigest(files) };
  await put(root, "desktop-source.json", JSON.stringify(source));
  return source;
}

test("source selection excludes private, credential, generated and internal-history paths", () => {
  for (const path of [".env", "apps/server/.env.agent", "apps/web/.envrc", "apps/desktop/credentials.json", "apps/desktop/token", "apps/desktop/signing.pfx", "apps/desktop/.cache/archive", "apps/desktop/.runtime/runtime", "apps/desktop/releases/installer.exe", "apps/web/node_modules/a/index.js", "vendor/x/target/binary", "docs/implementation/internal.md", ".git/config", ".local/evidence/report", "Home/credentials", "../README.md", "apps/../README.md", "apps\\server\\code.ts"]) {
    assert.equal(publicSourcePath(path), false, path);
  }
  for (const path of ["LICENSE", "pnpm-lock.yaml", "turbo.json", ".github/workflows/desktop.yml", "apps/desktop/scripts/package.mjs", "vendor/t3code/source-manifest.json", "docs/guides/desktop.md"]) assert.equal(publicSourcePath(path), true, path);
});

test("gitless reviewed snapshot preserves exact identity and never copies private siblings", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  const source = await snapshot(input);
  await put(input, ".env", "PRIVATE_SENTINEL_NOT_A_REAL_CREDENTIAL");
  await put(input, ".local/token", "PRIVATE_SENTINEL_NOT_A_REAL_CREDENTIAL");
  const output = join(root, "captured");
  assert.deepEqual(await captureSource(output, input), source);
  assert.deepEqual((await readdir(output)).sort(), ["README.md", "apps", "desktop-source.json", "pnpm-lock.yaml"]);
  await assert.rejects(lstat(join(output, ".env")), { code: "ENOENT" });
  await requireUnchangedSource(source, input);
  await put(input, "README.md", "different source bytes\n");
  await assert.rejects(requireUnchangedSource(source, input), /Source changed/);
  await assert.rejects(captureSource(join(root, "changed"), input), /Snapshot source bytes differ/);
});

test("gitless snapshot refuses unrecorded public code instead of attributing it to HEAD", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input);
  await put(input, "apps/desktop/unrecorded.mjs", "export const changed = true;\n");
  await assert.rejects(captureSource(join(root, "captured"), input), /unrecorded public source/);
});

async function fixtureGit(root, args) {
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, ".local/no-global-config"), HOME: join(root, ".local/home"), XDG_CONFIG_HOME: join(root, ".local/home") });
  return execute("git", ["-c", "user.name=Source fixture", "-c", "user.email=source-fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, ".local/empty-hooks")}`, ...args], { cwd: root, env: environment, windowsHide: true });
}

for (const gitBacked of [false, true]) {
  test(`${gitBacked ? "Git" : "gitless"} source captures and archives exact Turbo configuration and rejects its mutation or removal`, async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    const turboBytes = '{\n  "tasks": { "build": { "outputs": ["dist/**"] } }\n}\n';
    await snapshot(input, { "turbo.json": turboBytes });
    if (gitBacked) {
      await fixtureGit(input, ["init"]);
      await fixtureGit(input, ["add", "--", "README.md", "apps", "pnpm-lock.yaml", "turbo.json"]);
      await fixtureGit(input, ["commit", "-m", "Synthetic Turbo source fixture"]);
    }
    await put(input, ".env", "PRIVATE_SYNTHETIC_SENTINEL");
    await put(input, ".local/token", "PRIVATE_SYNTHETIC_SENTINEL");
    await put(input, "node_modules/generated.js", "GENERATED_SYNTHETIC_SENTINEL");
    const captured = join(root, "captured");
    const source = await captureSource(captured, input);
    assert.deepEqual(source.files.find((file) => file.path === "turbo.json"), {
      path: "turbo.json", bytes: Buffer.byteLength(turboBytes), mode: 0o644, sha256: hash(turboBytes),
    });
    assert.equal(await readFile(join(captured, "turbo.json"), "utf8"), turboBytes);
    for (const path of [".env", ".local/token", "node_modules/generated.js"])
      await assert.rejects(lstat(join(captured, path)), { code: "ENOENT" });

    const resources = join(root, "app/resources");
    for (const path of [
      "workspace-runtime/licenses/LICENSE", "workspace-runtime/apps/web/dist/licenses/LICENSE",
      "desktop-runtime/node/LICENSE", "desktop-runtime/postgres/LICENSE", "desktop-runtime/THIRD-PARTY-NOTICES.json",
      "desktop-runtime/node-tooling-notices/node_modules/npm/LICENSE",
    ]) await put(resources, path, "synthetic legal fixture\n");
    await mkdir(join(resources, "workspace-runtime/apps/web/dist/fonts"), { recursive: true });
    await put(join(root, "app"), "LICENSE.electron.txt", "synthetic Electron legal fixture\n");
    await put(join(root, "app"), "LICENSES.chromium.html", "synthetic Chromium legal fixture\n");
    await put(resources, "desktop-install-stamp.json", JSON.stringify(createInstallStamp({
      commit: source.commit, source: { sha256: source.sha256, dirty: source.dirty },
      version: "0.1.0", platform: "win32", arch: "x64", distribution: "nsis", signing: "unsigned",
      compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "d".repeat(64) },
    })));
    const output = join(root, "materials");
    await mkdir(output);
    const artifactName = "PM-Agent-v4-0.1.0-win-x64-unsigned.exe";
    await put(output, artifactName, "Synthetic archive-writer installer fixture; not native evidence");
    for (const name of ["desktop-sbom.cdx.json", "desktop-osv.json", "desktop-vulnerabilities.sarif"])
      await put(output, name, '{"scope":"synthetic archive-writer material fixture"}\n');
    const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
    // Exercise the real archive writer without inheriting the hosted run's SHA.
    await execute(process.execPath, ["--input-type=module", "--eval",
      `import { writeReleaseMaterials } from ${JSON.stringify(new URL("./release-materials.mjs", import.meta.url).href)}; await writeReleaseMaterials(JSON.parse(process.argv[1]));`,
      JSON.stringify({
        output, resources, platform: "win32", sourceRoot: captured, source, legalRoot: join(root, "legal"),
        manifest: { version: "0.1.0", target: "win32-x64", signing: "unsigned", artifacts: [await fileRecord(output, artifactName)] },
        verification: { schemaVersion: 1, nativeSmoke: { status: "not-run" }, published: false },
      }),
    ], { cwd: root, env: environment, windowsHide: true });
    const expanded = join(root, "expanded");
    await mkdir(expanded);
    await extractTar({ file: join(output, "desktop-source.tar.gz"), cwd: expanded });
    assert.equal(await readFile(join(expanded, "turbo.json"), "utf8"), turboBytes);
    assert.deepEqual(JSON.parse(await readFile(join(expanded, "desktop-source.json"), "utf8")).files, source.files);

    await requireUnchangedSource(source, input);
    await put(input, "turbo.json", '{"tasks":{"different":{}}}\n');
    await assert.rejects(requireUnchangedSource(source, input));
    await put(input, "turbo.json", turboBytes);
    await requireUnchangedSource(source, input);
    await rm(join(input, "turbo.json"));
    await assert.rejects(requireUnchangedSource(source, input));
    assert.equal(await readFile(join(captured, "turbo.json"), "utf8"), turboBytes);
    assert.equal(await readFile(join(expanded, "turbo.json"), "utf8"), turboBytes);
  });
}

test("dirty Git source refuses a tracked directory redirected into private checkout data", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  const publicBytes = "export const publicValue = true;\n";
  await snapshot(input, { "apps/example/config.ts": publicBytes });
  await put(input, ".gitignore", ".local/\n");
  await fixtureGit(input, ["init"]);
  await fixtureGit(input, ["add", "--", "README.md", ".gitignore", "apps", "pnpm-lock.yaml"]);
  await fixtureGit(input, ["commit", "-m", "Synthetic source fixture"]);
  const source = await captureSource(join(root, "before"), input);
  const privateBytes = "PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL";
  await put(input, ".local/private/config.ts", privateBytes);
  await rename(join(input, "apps/example"), join(input, ".local/original-example"));
  await symlink(join(input, ".local/private"), join(input, "apps/example"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await lstat(join(input, "apps/example"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(input, "apps/example/config.ts"), "utf8"), privateBytes);
  const output = join(root, "rejected");
  await assert.rejects(captureSource(output, input));
  await assert.rejects(lstat(join(output, "apps/example/config.ts")), { code: "ENOENT" });
  await assert.rejects(lstat(join(output, "desktop-source.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(input, ".local/private/config.ts"), "utf8"), privateBytes);
  // Equal content is not permission to follow a replaced source directory.
  await put(input, ".local/private/config.ts", publicBytes);
  await assert.rejects(requireUnchangedSource(source, input));
});

test("gitless source refuses an internal ancestor junction before copying its leaf", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input, { "apps/example/config.ts": "public source bytes" });
  await put(input, ".local/private/config.ts", "PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL");
  await rename(join(input, "apps/example"), join(input, ".local/original-example"));
  await symlink(join(input, ".local/private"), join(input, "apps/example"), process.platform === "win32" ? "junction" : "dir");
  const output = join(root, "rejected");
  await assert.rejects(captureSource(output, input), /link|junction|directory/i);
  await assert.rejects(lstat(join(output, "apps/example/config.ts")), { code: "ENOENT" });
});

test("source ancestor replacement during an opened-file copy rejects and removes the partial copy", {
  skip: process.platform === "win32" ? "POSIX rename-after-open fixture; Windows rejects renaming this open source directory. Separate junction/reparse cases still run." : false,
}, async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input);
  const privateBytes = "PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL";
  await put(input, ".local/private-desktop/package.json", privateBytes);
  const output = join(root, "rejected");
  const original = fs.createWriteStream;
  let replaced = false;
  const mocked = t.mock.method(fs, "createWriteStream", (filename, options) => {
    if (filename === join(output, "apps/desktop/package.json")) {
      fs.renameSync(join(input, "apps/desktop"), join(input, ".local/original-desktop"));
      fs.symlinkSync(join(input, ".local/private-desktop"), join(input, "apps/desktop"), process.platform === "win32" ? "junction" : "dir");
      replaced = true;
    }
    return original(filename, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(captureSource(output, input));
    assert.equal(replaced, true);
    assert.equal((await lstat(join(input, "apps/desktop"))).isSymbolicLink(), true);
    await assert.rejects(lstat(join(output, "apps/desktop/package.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(output, "desktop-source.json")), { code: "ENOENT" });
    assert.equal(await readFile(join(input, ".local/private-desktop/package.json"), "utf8"), privateBytes);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const gitBacked of [false, true]) {
  test(`${gitBacked ? "Git" : "gitless"} source accepts stable file-dependency hardlinks but still rejects changed content`, async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    const sourcePath = "vendor/t3code/third-party/mdast-util-math/index.d.ts";
    const approvedBytes = "export interface ApprovedPublicFileDependency {}\n";
    await snapshot(input, { [sourcePath]: approvedBytes });
    if (gitBacked) {
      await fixtureGit(input, ["init"]);
      await fixtureGit(input, ["add", "--", "README.md", "apps", "vendor", "pnpm-lock.yaml"]);
      await fixtureGit(input, ["commit", "-m", "Synthetic public file dependency"]);
    }
    const before = await captureSource(join(root, "before-install"), input);
    const installedAlias = join(input, "node_modules/file-dependency/index.d.ts");
    await mkdir(dirname(installedAlias), { recursive: true });
    await link(join(input, sourcePath), installedAlias);
    assert.equal((await lstat(join(input, sourcePath))).nlink, 2);
    await requireUnchangedSource(before, input);
    const afterRoot = join(root, "after-install");
    const after = await captureSource(afterRoot, input);
    assert.deepEqual(after.files, before.files);
    assert.equal(after.sha256, before.sha256);
    if (gitBacked) assert.equal(after.dirty, false);
    const copy = await lstat(join(afterRoot, sourcePath));
    const original = await lstat(join(input, sourcePath));
    assert.equal(copy.nlink, 1);
    assert.notEqual(`${copy.dev}:${copy.ino}`, `${original.dev}:${original.ino}`);
    await writeFile(installedAlias, "changed through the dependency's hardlinked inode\n");
    await assert.rejects(requireUnchangedSource(before, input), /Source changed/);
    assert.equal(await readFile(join(afterRoot, sourcePath), "utf8"), approvedBytes);
  });
}

test("source dirty identity compares actual bytes with HEAD even under assume-unchanged", async (t) => {
  const root = await temporary(t);
  const input = join(root, "input");
  await snapshot(input);
  await fixtureGit(input, ["init"]);
  await fixtureGit(input, ["add", "--", "README.md", "apps", "pnpm-lock.yaml"]);
  await fixtureGit(input, ["commit", "-m", "Synthetic source fixture"]);
  assert.equal((await captureSource(join(root, "clean"), input)).dirty, false);
  await fixtureGit(input, ["update-index", "--assume-unchanged", "--", "README.md"]);
  await put(input, "README.md", "changed raw source bytes hidden from git status\n");
  assert.equal((await fixtureGit(input, ["status", "--porcelain", "--", "README.md"])).stdout, "");
  const changed = await captureSource(join(root, "changed"), input);
  assert.equal(changed.dirty, true);
  assert.equal(changed.files.find((file) => file.path === "README.md").sha256, hash("changed raw source bytes hidden from git status\n"));
});

for (const gitBacked of [false, true]) {
  test(`${gitBacked ? "Git" : "gitless"} source recheck rejects approved-path additions and removals`, async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    await snapshot(input);
    if (gitBacked) {
      await fixtureGit(input, ["init"]);
      await fixtureGit(input, ["add", "--", "README.md", "apps", "pnpm-lock.yaml"]);
      await fixtureGit(input, ["commit", "-m", "Synthetic source fixture"]);
    }
    const source = await captureSource(join(root, "before"), input);
    const addition = "apps/desktop/scripts/release-materials.test.mjs";
    await put(input, addition, "new approved public source path\n");
    await assert.rejects(requireUnchangedSource(source, input), /Source selection changed/);
    if (gitBacked) {
      const withAddition = await captureSource(join(root, "with-addition"), input);
      await rm(join(input, addition));
      await assert.rejects(requireUnchangedSource(withAddition, input), /Source selection changed/);
    } else {
      await rm(join(input, addition));
      await rm(join(input, "README.md"));
      await assert.rejects(requireUnchangedSource(source, input), /Source selection changed/);
    }
  });
}

// Native-only registration keeps the backend runner's no-skips contract. These
// cases must run on Windows; Linux results do not exercise the attribute helper.
if (process.platform === "win32") {
  test("Windows many-file capture batches native checks while preserving every source byte", async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    const entries = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
      `apps/example/group-${index % 4}/file-${index.toString().padStart(3, "0")}.ts`,
      `export const source${index} = ${JSON.stringify(`public fixture ${index}\n`)};\n`,
    ]));
    const expected = await snapshot(input, entries);
    const reports = [];
    const output = join(root, "captured");
    const actual = await captureSource(output, input, { onMetrics: (metrics) => reports.push(metrics) });
    assert.deepEqual(actual, expected);
    for (const file of expected.files) {
      const bytes = await readFile(join(output, file.path));
      assert.equal(bytes.length, file.bytes, file.path);
      assert.equal(hash(bytes), file.sha256, file.path);
    }
    assert.deepEqual(JSON.parse(await readFile(join(output, "desktop-source.json"), "utf8")), expected);
    const captured = reports.find((metrics) => metrics.status === "end");
    assert.ok(captured, "capture must expose completed native work without changing the source manifest");
    assert.equal(captured.files, expected.files.length);
    assert.equal(captured.bytes, expected.files.reduce((total, file) => total + file.bytes, 0));
    assert.ok(captured.nativeCalls > 0, "the real Windows helper must execute");
    assert.ok(captured.nativeCalls < expected.files.length, "stable files must not cause one helper launch per file");
    assert.ok(captured.cacheHits >= expected.files.length);
    const rechecks = [];
    await requireUnchangedSource(expected, input, { onMetrics: (metrics) => rechecks.push(metrics) });
    assert.equal(rechecks.find((metrics) => metrics.status === "end")?.files, expected.files.length);
  });

  for (const mutation of ["replace", "content", "junction"]) {
    test(`Windows capture rejects ${mutation} mutation after batch prewarm without publishing a source manifest`, async (t) => {
      const root = await temporary(t);
      const input = join(root, "input");
      const filename = "apps/example/config.ts";
      const publicBytes = "export const approved = true;\n";
      await snapshot(input, { [filename]: publicBytes });
      await put(input, ".local/private/config.ts", mutation === "junction" ? publicBytes : "PRIVATE_TEST_SENTINEL_NOT_A_REAL_CREDENTIAL");
      const output = join(root, "rejected");
      const reports = [];
      const original = fs.createWriteStream;
      let changed = false;
      const mocked = t.mock.method(fs, "createWriteStream", (name, options) => {
        // README is sorted before the future leaf; capture has already prewarmed
        // its selected paths, but has not opened the leaf/ancestor being changed.
        if (!changed && name === join(output, "README.md")) {
          changed = true;
          if (mutation === "junction") {
            fs.renameSync(join(input, "apps/example"), join(input, ".local/original-example"));
            fs.symlinkSync(join(input, ".local/private"), join(input, "apps/example"), "junction");
          } else if (mutation === "replace") {
            fs.renameSync(join(input, filename), join(input, ".local/original-config.ts"));
            fs.writeFileSync(join(input, filename), "export const approved = null;\n");
          } else {
            fs.writeFileSync(join(input, filename), "export const approved = null;\n");
          }
        }
        return original(name, options);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(captureSource(output, input, { onMetrics: (metrics) => reports.push(metrics) }));
        assert.equal(reports.length, 1);
        assert.equal(reports[0].status, "failure");
        assert.ok(reports[0].nativeCalls > 0);
        assert.equal(changed, true);
        await assert.rejects(lstat(join(output, "desktop-source.json")), { code: "ENOENT" });
        if (mutation === "junction") {
          await assert.rejects(lstat(join(output, filename)), { code: "ENOENT" });
          assert.equal(await readFile(join(input, ".local/private/config.ts"), "utf8"), publicBytes);
        }
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }

  test("Windows source prewarm rejects UNC roots before any path or native helper query", async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    const source = await snapshot(input);
    const unc = "\\\\unreachable.invalid\\share\\source";
    const original = fs.lstatSync;
    let touched = false;
    const mocked = t.mock.method(fs, "lstatSync", (filename, ...options) => {
      if (String(filename).startsWith("\\\\")) {
        touched = true;
        throw new Error("UNC metadata I/O must never be attempted by this fixture");
      }
      return original(filename, ...options);
    });
    syncBuiltinESMExports();
    try {
      const reports = [];
      await assert.rejects(captureSource(join(root, "rejected"), unc, { onMetrics: (metrics) => reports.push(metrics) }), /canonical local absolute/);
      await assert.rejects(requireUnchangedSource(source, unc, { onMetrics: (metrics) => reports.push(metrics) }), /canonical local absolute/);
      assert.equal(touched, false);
      assert.equal(reports.length, 2);
      for (const report of reports) {
        assert.equal(report.status, "failure");
        assert.equal(report.nativeCalls, 0);
      }
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });

  test("Windows selected device and trailing-dot aliases are rejected before attribute metadata I/O", async (t) => {
    const root = await temporary(t);
    const input = join(root, "input");
    const initial = await snapshot(input);
    await fixtureGit(input, ["init"]);
    await fixtureGit(input, ["add", "--", "README.md", "apps", "pnpm-lock.yaml"]);
    await fixtureGit(input, ["commit", "-m", "Synthetic safe source"]);
    const blob = (await fixtureGit(input, ["rev-parse", "HEAD:README.md"])).stdout.trim();
    const aliases = ["apps/CON.md", "apps/trailing."];
    // Add adversarial index entries only; do not commit/refresh them against
    // the worktree. This fixture setting never changes the capture guards.
    for (const path of aliases)
      await fixtureGit(input, ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    const records = new Map(initial.files.map((file) => [file.path, file]));
    for (const path of aliases) records.set(path, { ...records.get("README.md"), path });
    const files = [...records.keys()].sort().map((path) => records.get(path));
    const source = { ...initial, commit: (await fixtureGit(input, ["rev-parse", "HEAD"])).stdout.trim(), dirty: true, files, sha256: contentDigest(files) };
    const original = fs.lstatSync;
    let touched = false;
    const mocked = t.mock.method(fs, "lstatSync", (filename, ...options) => {
      if (aliases.some((path) => String(filename).toLowerCase() === join(input, path).toLowerCase())) {
        touched = true;
        throw new Error("Unsafe alias metadata I/O must never be attempted by this fixture");
      }
      return original(filename, ...options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(captureSource(join(root, "rejected"), input), /Unsafe source path component/);
      await assert.rejects(requireUnchangedSource(source, input), /Unsafe source path component/);
      assert.equal(touched, false);
      await assert.rejects(lstat(join(root, "rejected/desktop-source.json")), { code: "ENOENT" });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

async function hostFixture(resources) {
  const host = join(resources, "workspace-runtime/apps/server/agent/dist/cc-switch/host");
  for (const [path, content] of Object.entries({
    "main.mjs": "// Synthetic separately bundled CC Switch host fixture\n",
    "LICENSE": "Synthetic host license fixture\n", "NOTICE.md": "Synthetic host notice fixture\n",
    "PROVENANCE.md": "Synthetic host provenance fixture\n", "UPSTREAM-SOURCES.md": "Synthetic source fixture\n", "upstream.json": "{}\n",
    "licenses/dependencies/0000/LICENSE": "Synthetic jsonc-parser notice\n",
    "licenses/dependencies/0001/LICENSE": "Synthetic smol-toml notice\n",
  })) await put(host, path, content);
  await put(host, "licenses/dependencies/index.json", JSON.stringify({ scope: "Synthetic actual-host-bundle contract fixture", packages: [
    { name: "jsonc-parser", version: "3.3.1", license: "MIT", files: ["licenses/dependencies/0000/LICENSE"] },
    { name: "smol-toml", version: "1.3.1", license: "MIT", files: ["licenses/dependencies/0001/LICENSE"] },
  ] }));
  const files = await inventoryTree(host);
  await put(host, "manifest.json", JSON.stringify({ version: 1, implementation: "typescript", entry: "main.mjs", node: ">=24 <25",
    sourceCommit: HOST_SOURCE_COMMIT, upstreamVersion: HOST_UPSTREAM_VERSION, files }));
  return { implementation: "typescript", sourceCommit: HOST_SOURCE_COMMIT, upstreamVersion: HOST_UPSTREAM_VERSION,
    manifest: "apps/server/agent/dist/cc-switch/host/manifest.json", manifestSha256: hash(await readFile(join(host, "manifest.json"))) };
}

async function archive(root, files) {
  const application = join(root, "application");
  const resources = join(root, "resources");
  await put(application, "package.json", JSON.stringify({ name: "pm-agent-v4-desktop", version: "0.1.0", main: "dist/main.mjs" }));
  await put(application, "dist/main.mjs", "export const desktop = true;\n");
  const instances = [];
  const dependencies = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (name.startsWith("node_modules/") && name.endsWith("/package.json")) {
      const metadata = { version: "1.0.0", ...JSON.parse(bytes) };
      await put(application, name, JSON.stringify(metadata));
      const path = name.slice(0, -"/package.json".length);
      dependencies[path.slice("node_modules/".length)] = path;
      instances.push({ id: path, path, sourceId: `original/${path}`, name: metadata.name, version: metadata.version, dependencies: {}, absentDependencies: [], files: [] });
    } else await put(application, name, bytes);
  }
  for (const instance of instances) instance.files = await inventoryTree(join(application, instance.path));
  await put(application, dependencyLayoutManifest, JSON.stringify({ schemaVersion: 1, contexts: [{ id: "electron", root: ".", dependencies, instances, absentDependencies: [], effectSingleton: null }] }));
  await mkdir(resources);
  await asarTools().createPackage(application, join(resources, "app.asar"));
  await put(resources, `workspace-runtime/${dependencyLayoutManifest}`, JSON.stringify({ schemaVersion: 1, contexts: [
    { id: "pm", root: ".", dependencies: {}, instances: [], absentDependencies: [], effectSingleton: null },
    { id: "agent", root: "apps/server/agent", dependencies: {}, instances: [], absentDependencies: [], effectSingleton: null },
  ] }));
  await put(resources, "workspace-runtime/desktop-runtime-native.json", JSON.stringify({ schemaVersion: 1, files: [] }));
  await put(resources, "workspace-runtime/apps/desktop/package.json", JSON.stringify({ name: "@agent-workspace/desktop", version: "0.1.0" }));
  await put(resources, "workspace-runtime/packages/infrastructure/migrations/001-fixture.sql", "-- Synthetic migration fingerprint fixture\n");
  await put(resources, "workspace-runtime/apps/server/agent/dist/index.mjs", "// Synthetic Agent state-code fingerprint fixture\n");
  const ccSwitchHost = await hostFixture(resources);
  const source = await readFile(join(dirname(root), "input/desktop-source.json"), "utf8").then(JSON.parse).catch((cause) => {
    if (cause.code === "ENOENT") return { commit: "a".repeat(40), dirty: true, sha256: "b".repeat(64) };
    throw cause;
  });
  await put(resources, "desktop-install-stamp.json", JSON.stringify(createInstallStamp({ commit: source.commit, source: { sha256: source.sha256, dirty: source.dirty },
    version: "0.1.0", platform: "win32", arch: "x64", distribution: "nsis", signing: "unsigned",
    compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: await computeMigrationsSha256(join(resources, "workspace-runtime")) } })));
  await put(resources, "workspace-runtime/agent-artifact-manifest.json", JSON.stringify({ upstreamCommit: "c".repeat(40), bundled: [], ccSwitchHost }));
  await put(resources, "workspace-runtime/apps/web/dist/index.js", "Synthetic Web bundle fixture");
  await put(resources, "workspace-runtime/apps/web/dist/desktop-bundle-inputs.json", JSON.stringify({ schemaVersion: 1, packages: [],
    outputs: [{ path: "index.js", sha256: hash("Synthetic Web bundle fixture") }] }));
  return resources;
}

test("final application refuses missing or mismatched maintenance application version", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {});
  await preparedRuntimeFixture(resources);
  const inspect = () => inspectPackagedApplication(resources, "0.1.0", { target: "win32-x64" });
  assert.equal((await inspect()).status, "passed");
  const metadata = join(resources, "workspace-runtime/apps/desktop/package.json");
  await rm(metadata);
  await assert.rejects(inspect());
  await put(resources, "workspace-runtime/apps/desktop/package.json", JSON.stringify({ version: "0.2.0" }));
  await assert.rejects(inspect());
});

test("final ASAR inspection rejects Claude CLI metadata aliases inside the real archive", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {
    "node_modules/renamed-platform/package.json": JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-win32-x64" }),
    "node_modules/renamed-platform/claude.exe": "unit fixture, not a real executable",
  });
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"), /External Agent CLI packages/);
});

test("final inspection includes orphaned unpacked package bytes and preserves unrelated names", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json": JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk" }),
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": "export const sdk = true;\n",
    "node_modules/other/package.json": JSON.stringify({ name: "other" }),
    "node_modules/other/claude.exe": "unrelated unit resource",
  });
  assert.equal((await inspectPackagedApplication(resources, "0.1.0")).status, "passed");
  await assert.rejects(inspectPackagedApplication(resources, "0.2.0"), /identity\/version/);
  await put(resources, "app.asar.unpacked/node_modules/alias/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-linux-x64" }));
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"), /External Agent CLI packages/);
});

async function delivery(root, extraSources = {}) {
  const input = join(root, "input");
  const source = await snapshot(input, extraSources);
  const output = join(root, "delivery");
  await mkdir(output);
  await put(output, "PM-Agent-v4-0.1.0-win-x64-unsigned.exe", "unit installer bytes; not a real installer");
  await put(output, "desktop-source.json", JSON.stringify(source));
  await createTar({ cwd: input, gzip: true, portable: true, file: join(output, "desktop-source.tar.gz") }, [...source.files.map((file) => file.path), "desktop-source.json"]);
  await put(output, "desktop-legal.tar.gz", "unit legal archive bytes");
  const installStamp = createInstallStamp({ commit: source.commit, version: "0.1.0", platform: "win32", arch: "x64", distribution: "nsis", signing: "unsigned",
    source: { sha256: source.sha256, dirty: source.dirty }, compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) } });
  await put(output, "desktop-install-stamp-win32-x64.json", JSON.stringify(installStamp));
  const manifest = {
    schemaVersion: 3, version: "0.1.0", target: "win32-x64", signing: "unsigned",
    source: { commit: source.commit, dirty: source.dirty, sha256: source.sha256 },
    installStamp, updates: desktopUpdatePolicy({ version: "0.1.0", platform: "win32", signing: "unsigned" }),
    artifacts: [await fileRecord(output, "PM-Agent-v4-0.1.0-win-x64-unsigned.exe")],
    materials: await Promise.all(["desktop-source.json", "desktop-source.tar.gz", "desktop-legal.tar.gz", "desktop-install-stamp-win32-x64.json"].map((name) => fileRecord(output, name))),
    toolchain: { electron: "42.0.0" },
  };
  await scanFixture(output, manifest);
  await refreshVerification(output, manifest, { schemaVersion: 1, nativeSmoke: { status: "not-run" }, published: false });
  return { output, manifest };
}

async function scanFixture(output, manifest, sbom) {
  sbom ??= { bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: { properties: [{ name: "dovspace:source", value: JSON.stringify(manifest.source) }, { name: "dovspace:final-artifacts", value: JSON.stringify(manifest.artifacts) }] },
    components: [{ name: "synthetic-unit-fixture", version: "1.0.0", purl: "pkg:npm/synthetic-unit-fixture@1.0.0", "bom-ref": "unit-fixture" }] };
  const scan = await scanSBOM(sbom, { fetcher: async (_url, options) => new Response(JSON.stringify({ results: JSON.parse(options.body).queries.map(() => ({})) }), { status: 200 }) });
  for (const [name, value] of [["desktop-sbom.cdx.json", sbom], ["desktop-osv.json", scan.report], ["desktop-vulnerabilities.sarif", scan.sarif]]) {
    await put(output, name, JSON.stringify(value, null, 2) + "\n");
    manifest.materials = manifest.materials.filter((entry) => entry.path !== name);
    manifest.materials.push(await fileRecord(output, name));
  }
}

// Static inventory fixture only: these are not executable Node/PG binaries or
// evidence for an official archive download. Native Actions exercises those.
async function preparedRuntimeFixture(resources, { cliAlias = false } = {}) {
  const runtime = join(resources, "desktop-runtime");
  const files = {
    "node/node.exe": "static Node executable fixture",
    "node/LICENSE": "Node legal fixture",
    "node/npm.cmd": "static npm launcher fixture",
    "node/npx.cmd": "static npx launcher fixture",
    "node/node_modules/npm/package.json": JSON.stringify({ name: "npm", version: "unit-fixture" }),
    "node/node_modules/npm/LICENSE": "npm legal fixture",
    "node/node_modules/npm/NOTICE": "",
    "node/node_modules/npm/bin/npm-cli.js": "// static npm fixture\n",
    "postgres/LICENSE": "PostgreSQL legal fixture",
    "THIRD-PARTY-NOTICES.json": "{}",
  };
  for (const tool of ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"])
    files[`postgres/bin/${tool}.exe`] = `static ${tool} executable fixture`;
  if (cliAlias) files["postgres/share/node_modules/renamed-cli/package.json"] = JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-win32-x64" });
  for (const [name, bytes] of Object.entries(files)) await put(runtime, name, bytes);
  const nodeDistribution = await prepareNodeDistribution(runtime, "win32-x64");
  const manifest = { version: RUNTIME_MANIFEST_VERSION, target: "win32-x64", sources: runtimeSources("win32-x64"), nodeDistribution, files: await inventoryTree(runtime) };
  await put(runtime, "runtime-manifest.json", JSON.stringify(manifest));
  return { runtime, manifest };
}

// Model afterPack's public installation modes without changing inventory bytes.
async function installationModes(directory) {
  await chmod(directory, 0o755);
  for (const name of await readdir(directory)) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isDirectory()) await installationModes(path);
    else if (info.isFile()) await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
    else throw new Error("Final payload fixture must contain real owned resources.");
  }
}

// A real two-level 7z container fixture exercises member listing/extraction. It
// is deliberately NOT an executable NSIS installer or native execution evidence.
async function sealPayload(output, manifest, payloadRoot = join(dirname(output), "payload")) {
  await installationModes(join(payloadRoot, "resources/workspace-runtime"));
  const scratch = join(dirname(output), "archive-fixture");
  const stamp = JSON.parse(await readFile(join(payloadRoot, "resources/desktop-install-stamp.json"), "utf8"));
  manifest.installStamp = stamp;
  await put(output, "desktop-install-stamp-win32-x64.json", JSON.stringify(stamp));
  manifest.materials = manifest.materials.filter((file) => file.path !== "desktop-install-stamp-win32-x64.json");
  manifest.materials.push(await fileRecord(output, "desktop-install-stamp-win32-x64.json"));
  const ownership = await createInstallationManifest(payloadRoot, stamp);
  // This real archive fixture ships resources only, not its source ASAR directory.
  ownership.files = ownership.files.filter((file) => file.path.startsWith("resources/"));
  ownership.directories = ownership.directories.filter((path) => path === "resources" || path.startsWith("resources/"));
  await put(payloadRoot, "resources/desktop-install-files.json", JSON.stringify(ownership));
  await mkdir(join(scratch, "$PLUGINSDIR"), { recursive: true });
  const payload = join(scratch, "$PLUGINSDIR", "app-64.7z");
  await rm(payload, { force: true });
  await execute("7z", ["a", "-t7z", payload, "resources"], { cwd: payloadRoot });
  const artifact = manifest.artifacts[0].path;
  await rm(join(output, artifact));
  await execute("7z", ["a", "-t7z", join(output, artifact), "$PLUGINSDIR"], { cwd: scratch });
  manifest.artifacts = [await fileRecord(output, artifact)];
  const sbom = await inspectShippedSBOM(join(payloadRoot, "resources"), { ...manifest, electronVersion: manifest.toolchain.electron });
  await scanFixture(output, manifest, sbom);
  return inspectFinalArtifacts(output, manifest.artifacts, manifest);
}

test("final delivery is authoritative even when old unpacked staging bytes change", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(dirname(output), "payload"), {});
  const prepared = await preparedRuntimeFixture(resources);
  await verifyRuntime(prepared.runtime, manifest.target);
  const application = await inspectPackagedApplication(resources, manifest.version);
  manifest.applicationResources = "win-unpacked/resources";
  const finalArtifacts = await sealPayload(output, manifest);
  await refreshVerification(output, manifest, { checks: { application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  assert.equal((await verifyDelivery(output)).target, manifest.target);
  assert.ok(prepared.manifest.files.some((file) => file.path === "node-tooling-notices/node_modules/npm/NOTICE" && file.bytes === 0));
  assert.equal(await readFile(join(prepared.runtime, "node-tooling-notices/node_modules/npm/NOTICE"), "utf8"), "");
  const originalInventory = await readFile(join(prepared.runtime, "runtime-manifest.json"));
  await put(prepared.runtime, "node-tooling-notices/node_modules/npm/NOTICE", "# changed runtime fixture bytes\n");
  // Staging bytes are no longer authority for a downloaded installer. The final
  // archive still contains the unchanged pinned runtime and remains verifiable.
  assert.equal((await verifyDelivery(output)).target, manifest.target);
  await assert.rejects(verifyRuntime(prepared.runtime, manifest.target));
  assert.deepEqual(await readFile(join(prepared.runtime, "runtime-manifest.json")), originalInventory);
});

for (const location of ["app.asar", "app.asar.unpacked", "workspace-runtime"]) {
  test(`private configuration remains forbidden in ${location} beside a valid runtime`, async (t) => {
    const root = await temporary(t);
    const resources = await archive(root, {});
    const prepared = await preparedRuntimeFixture(resources);
    await verifyRuntime(prepared.runtime, "win32-x64");
    assert.equal((await inspectPackagedApplication(resources, "0.1.0")).status, "passed");
    const privateBytes = "private configuration fixture, not real credentials";
    if (location === "app.asar") {
      await put(join(root, "application"), ".npmrc", privateBytes);
      await asarTools().createPackage(join(root, "application"), join(resources, "app.asar"));
    } else await put(resources, `${location}/.npmrc`, privateBytes);
    await assert.rejects(inspectPackagedApplication(resources, "0.1.0"));
    assert.equal(await readFile(location === "app.asar" ? join(root, "application/.npmrc") : join(resources, location, ".npmrc"), "utf8"), privateBytes);
    assert.equal(await readFile(join(prepared.runtime, "node-tooling-notices/node_modules/npm/NOTICE"), "utf8"), "");
  });
}

test("external Claude CLI identity is rejected in runtime even when its file inventory matches", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {});
  const prepared = await preparedRuntimeFixture(resources, { cliAlias: true });
  await verifyRuntime(prepared.runtime, "win32-x64");
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"));
});

test("shipped SBOM accepts the execution-only runtime without npm directories and records its provenance", async (t) => {
  const root = await temporary(t);
  const resources = await archive(root, {});
  const prepared = await preparedRuntimeFixture(resources);
  await installationModes(join(resources, "workspace-runtime"));
  const inputs = { target: "win32-x64", version: "0.1.0", electronVersion: "40.0.0",
    source: { commit: "a".repeat(40), dirty: false, sha256: "b".repeat(64) },
    artifacts: [{ path: "fixture.exe", bytes: 1, sha256: "c".repeat(64) }] };
  const sbom = await inspectShippedSBOM(resources, inputs);
  await assert.rejects(lstat(join(prepared.runtime, "node/node_modules")), { code: "ENOENT" });
  assert.equal(sbom.components.some((entry) => entry["bom-ref"].startsWith("desktop-runtime/node/node_modules")), false);
  const node = sbom.components.find((entry) => entry["bom-ref"] === "desktop-runtime/node");
  assert.equal(node.properties.find((property) => property.name === "dovspace:runtime-profile").value, "execution-only-v1");
  assert.equal(node.properties.find((property) => property.name === "dovspace:source-archive-sha256").value, runtimeSources("win32-x64").node.sha256);
  await put(prepared.runtime, "node/node_modules/npm/package.json", JSON.stringify({ name: "npm", version: "1.0.0" }));
  await assert.rejects(inspectShippedSBOM(resources, inputs), /forbidden tooling/);
});

test("delivery checksums cover every material and manifest without self-reference", async (t) => {
  const { output, manifest } = await delivery(await temporary(t));
  const checked = await verifyDeliveryFiles(output);
  assert.equal(checked.names.length, 11);
  const checksums = await readFile(join(output, "SHA256SUMS"), "utf8");
  assert.ok(checksums.includes("  desktop-package.json\n"));
  assert.ok(!checksums.includes("  SHA256SUMS\n"));
  await refreshVerification(output, manifest, { schemaVersion: 1, nativeSmoke: { status: "passed" }, published: false });
  await verifyDeliveryFiles(output);
  await put(output, manifest.artifacts[0].path, "tampered installer");
  await assert.rejects(verifyDeliveryFiles(output), /hash\/size mismatch/);
});

test("public candidate install stamp is checksum-bound and cannot detach from release source identity", async (t) => {
  const { output, manifest } = await delivery(await temporary(t));
  const name = "desktop-install-stamp-win32-x64.json";
  const path = join(output, name);
  assert.ok((await readFile(join(output, "SHA256SUMS"), "utf8")).includes(`  ${name}\n`));
  const original = await readFile(path, "utf8");
  const stamp = JSON.parse(original);
  stamp.source.sha256 = "f".repeat(64);
  await put(output, name, JSON.stringify(stamp));
  await assert.rejects(verifyDeliveryFiles(output), /hash\/size mismatch/);
  manifest.materials = manifest.materials.map((file) => file.path === name ? { ...file } : file);
  manifest.materials[manifest.materials.findIndex((file) => file.path === name)] = await fileRecord(output, name);
  manifest.installStamp = stamp;
  await refreshVerification(output, manifest, { schemaVersion: 1, nativeSmoke: { status: "not-run" }, published: false });
  await assert.rejects(verifyDeliveryFiles(output), /install stamp.*source/);
  await put(output, name, original);
});

test("delivery refuses partial uploads, unconfigured updater metadata, unknown archives and path escapes", async (t) => {
  const { output, manifest } = await delivery(await temporary(t));
  await put(output, "latest.yml", "version: 0.1.0\n");
  await assert.rejects(verifyDeliveryFiles(output), /update feed/);
  await rm(join(output, "latest.yml"));
  await put(output, "extra.zip", "unrecorded archive");
  await assert.rejects(verifyDeliveryFiles(output), /Unrecorded release artifact/);
  await rm(join(output, "extra.zip"));
  manifest.materials = manifest.materials.filter((file) => file.path !== "desktop-legal.tar.gz");
  await put(output, "desktop-package.json", JSON.stringify(manifest));
  await checksumDelivery(output, manifest);
  await assert.rejects(verifyDeliveryFiles(output), /missing required/);
  await assert.rejects(fileRecord(output, "../outside.exe"), /safe flat filenames/);
});

test("delivery rejects changed ASAR bytes even when application identity and version are unchanged", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const appRoot = join(dirname(output), "payload");
  const resources = await archive(appRoot, {});
  await preparedRuntimeFixture(resources);
  const application = await inspectPackagedApplication(resources, manifest.version);
  manifest.applicationResources = "win-unpacked/resources";
  const finalArtifacts = await sealPayload(output, manifest);
  await refreshVerification(output, manifest, { checks: { application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  await put(join(appRoot, "application"), "dist/main.mjs", "export const desktop = 'different bytes, same identity';\n");
  await asarTools().createPackage(join(appRoot, "application"), join(resources, "app.asar"));
  const scratch = join(dirname(output), "archive-fixture");
  await rm(join(scratch, "$PLUGINSDIR/app-64.7z"));
  await execute("7z", ["a", "-t7z", join(scratch, "$PLUGINSDIR/app-64.7z"), "resources"], { cwd: appRoot });
  await rm(join(output, manifest.artifacts[0].path));
  await execute("7z", ["a", "-t7z", join(output, manifest.artifacts[0].path), "$PLUGINSDIR"], { cwd: scratch });
  manifest.artifacts = [await fileRecord(output, manifest.artifacts[0].path)];
  await refreshVerification(output, manifest, { checks: { application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  await assert.rejects(verifyDelivery(output), /SBOM|Final distributable payload differs/);
});

test("legal derivation rejects a resource-internal relative link that escapes the copied legal root", {
  skip: process.platform === "win32" ? "Relative file symlinks require optional Windows developer privileges; source junction regressions run without them." : false,
}, async (t) => {
  const root = await temporary(t);
  const resources = join(root, "app/resources");
  for (const [name, bytes] of Object.entries({
    "workspace-runtime/licenses/LICENSE": "root license",
    "workspace-runtime/apps/web/dist/licenses/LICENSE": "web license",
    "workspace-runtime/apps/web/dist/fonts/Inter-LICENSE.txt": "font license",
    "desktop-runtime/node/LICENSE": "node license",
    "desktop-runtime/node-tooling-notices/node_modules/npm/LICENSE": "npm license",
    "desktop-runtime/postgres/LICENSE": "postgres license",
    "desktop-runtime/THIRD-PARTY-NOTICES.json": "{}",
    "app.asar": "unit resource bytes, not an executable archive",
  })) await put(resources, name, bytes);
  await put(join(root, "app"), "LICENSE.electron.txt", "electron license");
  await put(join(root, "app"), "LICENSES.chromium.html", "chromium license");
  await symlink("../../../../../app.asar", join(resources, "workspace-runtime/apps/web/dist/licenses/cross"));
  await inspectDeployment(resources);
  await assert.rejects(collectLegal(resources, "win32", join(root, "legal")), /nonportable symlink|ENOENT|ELOOP/);
});

test("legal archive collection retains original Node and omitted-tooling notices unchanged", async (t) => {
  const root = await temporary(t), resources = join(root, "app/resources");
  const legal = {
    "workspace-runtime/licenses/LICENSE": "workspace legal",
    "workspace-runtime/apps/web/dist/licenses/LICENSE": "web legal",
    "desktop-runtime/node/LICENSE": "complete original Node and bundled third-party licenses\n",
    "desktop-runtime/node-tooling-notices/node_modules/npm/LICENSE": "original npm license\n",
    "desktop-runtime/node-tooling-notices/node_modules/npm/node_modules/dependency/NOTICE": "original dependency notice\n",
    "desktop-runtime/postgres/LICENSE": "original PostgreSQL legal",
    "desktop-runtime/THIRD-PARTY-NOTICES.json": "{}",
  };
  for (const [name, bytes] of Object.entries(legal)) await put(resources, name, bytes);
  await mkdir(join(resources, "workspace-runtime/apps/web/dist/fonts"));
  await put(join(root, "app"), "LICENSE.electron.txt", "electron legal");
  await put(join(root, "app"), "LICENSES.chromium.html", "chromium legal");
  const destination = join(root, "legal");
  await collectLegal(resources, "win32", destination);
  assert.equal(await readFile(join(destination, "runtime/node-LICENSE"), "utf8"), legal["desktop-runtime/node/LICENSE"]);
  for (const path of ["node_modules/npm/LICENSE", "node_modules/npm/node_modules/dependency/NOTICE"])
    assert.equal(await readFile(join(destination, "runtime/node-tooling-notices", path), "utf8"), legal[`desktop-runtime/node-tooling-notices/${path}`]);
});

test("archive member safety rejects traversal, absolute paths and alternate data streams", () => {
  for (const path of ["../outside", "/absolute", "C:\\outside", "resources/../outside", "resources/file:stream", "resources//file", "resources/./file"])
    assert.throws(() => archiveMemberPath(path), /Unsafe final archive/);
  assert.equal(archiveMemberPath("$PLUGINSDIR\\app-64.7z"), "$PLUGINSDIR/app-64.7z");
});

test("actual final archive expansion is rejected while the independent staging layout remains correct", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(dirname(output), "payload"), {});
  await preparedRuntimeFixture(resources);
  const workspace = join(resources, "workspace-runtime");
  await put(workspace, "node_modules/one/package.json", JSON.stringify({ name: "one", version: "1.0.0" }));
  await put(workspace, "node_modules/one/index.js", "module.exports = { retained: true };");
  const instance = { id: "node_modules/one", path: "node_modules/one", sourceId: "original/one", name: "one", version: "1.0.0",
    dependencies: {}, absentDependencies: [], files: await inventoryTree(join(workspace, "node_modules/one")) };
  await put(workspace, dependencyLayoutManifest, JSON.stringify({ schemaVersion: 1, contexts: [
    { id: "pm", root: ".", dependencies: { one: instance.id }, instances: [instance], absentDependencies: [], effectSingleton: null },
    { id: "agent", root: "apps/server/agent", dependencies: {}, instances: [], absentDependencies: [], effectSingleton: null },
  ] }));
  assert.equal((await inspectPackagedApplication(resources, manifest.version)).status, "passed");
  const correct = await sealPayload(output, manifest);
  assert.equal(correct.status, "passed");
  assert.equal(correct.artifacts[0].sha256, manifest.artifacts[0].sha256);
  assert.ok(correct.artifacts[0].tree.files > 0 && correct.artifacts[0].tree.logicalBytes > 0);
  const expanded = join(root, "expanded-payload");
  await cp(resources, join(expanded, "resources"), { recursive: true });
  const packageRoot = join(expanded, "resources/workspace-runtime/node_modules/one");
  await cp(join(workspace, "node_modules/one"), join(packageRoot, "node_modules/one"), { recursive: true });
  await assert.rejects(sealPayload(output, manifest, expanded), /Undeclared or recursively expanded dependency/);
  assert.equal((await inspectPackagedApplication(resources, manifest.version)).status, "passed");
});

test("supplied installed resources bind all bytes to the current final artifact, not their self-declared layout", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(dirname(output), "payload"), {});
  await preparedRuntimeFixture(resources);
  await put(resources, "workspace-runtime/apps/server/pm/src/source.js", "original packaged application bytes");
  const report = await sealPayload(output, manifest);
  const payload = report.artifacts[0];
  const installed = join(root, "supplied-installed-tree/resources");
  await cp(resources, installed, { recursive: true });
  const checked = await verifyInstalledApplication(installed, payload, manifest);
  assert.equal(checked.sourceArtifact.sha256, manifest.artifacts[0].sha256);
  assert.equal(checked.installationExecutedByThisCommand, false);
  await put(installed, "workspace-runtime/apps/server/pm/src/source.js", "modified bytes outside dependency own-file inventory");
  await assert.rejects(verifyInstalledApplication(installed, payload, manifest), /differs from the current final distributable/);
  await assert.rejects(verifyInstalledApplication(installed, null, manifest), /current inspected final artifact digest/);
});

test("files-only transport remains valid for historical deliveries but cannot promote old win-unpacked smoke", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  await refreshVerification(output, manifest, { checks: {}, nativeSmoke: { status: "passed" }, published: false });
  assert.equal((await verifyDelivery(output, { filesOnly: true })).target, manifest.target);
  await assert.rejects(verifyDelivery(output), /actual final distributable payloads/);
  await assert.rejects(verifyDelivery(output, { filesOnly: true, stage: join(root, "staged") }), /bound to this final distributable payload/);
});

test("unreferenced loose ASAR dependency copies cannot hide outside the archive inventory", async (t) => {
  const resources = await archive(await temporary(t), {});
  await put(resources, "app.asar.unpacked/node_modules/orphan/package.json", JSON.stringify({ name: "orphan", version: "1.0.0" }));
  await assert.rejects(inspectPackagedApplication(resources, "0.1.0"), /Unrecorded or linked ASAR unpacked resource/);
});

test("corresponding-source archive is checked against actual inventoried bytes even after transport hashes are refreshed", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  await put(join(root, "input"), "README.md", "different archived source bytes\n");
  await createTar({ cwd: join(root, "input"), gzip: true, portable: true, file: join(output, "desktop-source.tar.gz") },
    ["README.md", "apps/desktop/package.json", "pnpm-lock.yaml", "desktop-source.json"]);
  manifest.materials = manifest.materials.filter((entry) => entry.path !== "desktop-source.tar.gz");
  manifest.materials.push(await fileRecord(output, "desktop-source.tar.gz"));
  await refreshVerification(output, manifest, { schemaVersion: 1, nativeSmoke: { status: "not-run" }, published: false });
  await assert.rejects(verifyDeliveryFiles(output), /Corresponding-source archive/);
});

test("final payload refuses a stamp with unchanged commit but a different dirty-source digest", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(root, "payload"), {});
  await preparedRuntimeFixture(resources);
  const path = join(resources, "desktop-install-stamp.json");
  const stamp = JSON.parse(await readFile(path, "utf8"));
  stamp.source.sha256 = "e".repeat(64);
  await put(resources, "desktop-install-stamp.json", JSON.stringify(stamp));
  await assert.rejects(sealPayload(output, manifest));
});

test("final delivery retains unversioned bundled source identities without invented registry versions or successful OSV queries", async (t) => {
  const root = await temporary(t);
  const names = ["@t3tools/provider-core", "@t3tools/client-runtime", "effect-acp"];
  const { output, manifest } = await delivery(root, Object.fromEntries(names.map((name, index) =>
    [`vendor/t3code/synthetic-source-${index}/package.json`, JSON.stringify({ name, private: true })])));
  const resources = await archive(join(root, "payload"), {});
  await preparedRuntimeFixture(resources);
  const agentPath = join(resources, "workspace-runtime/agent-artifact-manifest.json");
  const agent = JSON.parse(await readFile(agentPath, "utf8"));
  agent.bundled = names.map((name) => ({ name, version: null, license: "MIT", notices: [] }));
  await writeFile(agentPath, JSON.stringify(agent));
  const finalArtifacts = await sealPayload(output, manifest);
  await refreshVerification(output, manifest, { checks: { application: finalArtifacts.artifacts[0].application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  await verifyDelivery(output);
  const bom = JSON.parse(await readFile(join(output, "desktop-sbom.cdx.json"), "utf8"));
  const scan = JSON.parse(await readFile(join(output, "desktop-osv.json"), "utf8"));
  for (const name of names) {
    const entry = bom.components.find((component) => component.name === name);
    assert.ok(entry);
    assert.equal(Object.hasOwn(entry, "version"), false);
    assert.equal(Object.hasOwn(entry, "purl"), false);
    const source = JSON.parse(entry.properties.find((property) => property.name === "dovspace:source-provenance").value);
    assert.equal(source.source.sha256, manifest.source.sha256);
    assert.equal(source.inventory.sha256, hash(await readFile(agentPath)));
    assert.equal(scan.sourceComponents.find((component) => component.name === name)?.status, "not-scanned-source-provenance");
    assert.ok(!scan.queries.some((query) => query.components.includes(entry["bom-ref"])));
  }
});

test("final SBOM and OSV include separately bundled CC Switch dependency versions and reject modified host evidence", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root);
  const resources = await archive(join(root, "payload"), {});
  await preparedRuntimeFixture(resources);
  const finalArtifacts = await sealPayload(output, manifest);
  await refreshVerification(output, manifest, { checks: { application: finalArtifacts.artifacts[0].application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  await verifyDelivery(output);
  const bom = JSON.parse(await readFile(join(output, "desktop-sbom.cdx.json"), "utf8"));
  const scan = JSON.parse(await readFile(join(output, "desktop-osv.json"), "utf8"));
  for (const [name, version] of [["jsonc-parser", "3.3.1"], ["smol-toml", "1.3.1"]]) {
    const component = bom.components.find((entry) => entry.name === name && entry["bom-ref"].startsWith("cc-switch-host-bundled/"));
    assert.equal(component?.version, version);
    assert.ok(scan.queries.some((query) => query.purl === component.purl && query.components.includes(component["bom-ref"])));
  }
  await put(resources, "workspace-runtime/apps/server/agent/dist/cc-switch/host/licenses/dependencies/0000/LICENSE", "changed host notice");
  await assert.rejects(inspectShippedSBOM(resources, { ...manifest, electronVersion: manifest.toolchain.electron }), /Host resource changed/);
});

test("consumer receipt import registers both exact native materials in manifest/checksums and survives files-only verification", async (t) => {
  const root = await temporary(t);
  const { output, manifest } = await delivery(root, Object.fromEntries(INSTALL_E2E_HARNESS.map((path) => [path, "synthetic harness source fixture; never executed\n"])));
  const resources = await archive(join(root, "payload"), {});
  await preparedRuntimeFixture(resources);
  manifest.installStamp = JSON.parse(await readFile(join(resources, "desktop-install-stamp.json"), "utf8"));
  const finalArtifacts = await sealPayload(output, manifest);
  await refreshVerification(output, manifest, { checks: { application: finalArtifacts.artifacts[0].application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
  const fixture = await createReceiptFixture(join(root, "native-contract-fixture"));
  const previous = structuredClone(fixture.receipt);
  const artifact = manifest.artifacts[0];
  const replacements = new Map([[previous.source.commit, manifest.source.commit], [previous.source.sha256, manifest.source.sha256],
    [previous.version, manifest.version], [previous.baseline.version, "0.0.9"], [previous.artifact.sha256, artifact.sha256],
    [previous.controller.appAsarSha256, finalArtifacts.artifacts[0].application.sha256],
    [previous.compatibility.migrationsSha256, manifest.installStamp.compatibility.migrationsSha256]]);
  const rebind = (value) => {
    if (Array.isArray(value)) return value.map(rebind);
    if (value && typeof value === "object") {
      if (value.path === previous.artifact.path && value.sha256 === previous.artifact.sha256) return { ...artifact };
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebind(entry)]));
    }
    return typeof value === "string" ? replacements.get(value) ?? value.replaceAll(previous.artifact.path, artifact.path) : value;
  };
  Object.assign(fixture.receipt, rebind(fixture.receipt));
  const source = JSON.parse(await readFile(join(output, "desktop-source.json"), "utf8"));
  fixture.receipt.harness.files = INSTALL_E2E_HARNESS.map((path) => {
    const file = source.files.find((entry) => entry.path === path);
    return { path, sha256: file.sha256, bytes: file.bytes };
  });
  for (const [path, document] of fixture.documents) fixture.documents.set(path, rebind(document));
  await fixture.persist();
  // Synthetic validator documents only: this test runs no native installer.
  await verifyDelivery(output, { installE2EReceipt: fixture.receiptPath });
  const delivered = JSON.parse(await readFile(join(output, "desktop-package.json"), "utf8"));
  const sums = await readFile(join(output, "SHA256SUMS"), "utf8");
  for (const name of ["install-e2e-receipt.json", "install-e2e-evidence.tar.gz"]) {
    assert.deepEqual(delivered.materials.find((entry) => entry.path === name), await fileRecord(output, name));
    assert.ok(sums.includes(`  ${name}\n`));
  }
  const checked = await verifyDelivery(output, { filesOnly: true });
  assert.ok(checked.files.includes("install-e2e-receipt.json") && checked.files.includes("install-e2e-evidence.tar.gz"));
});

if (process.platform !== "win32") {
  test("final host verification accepts real 0600/0700 to canonical installation modes without relaxing bytes or executable identity", async (t) => {
    const root = await temporary(t);
    const { output, manifest } = await delivery(root);
    const resources = await archive(join(root, "payload"), {});
    await preparedRuntimeFixture(resources);
    const workspace = join(resources, "workspace-runtime");
    const buildRoot = join(workspace, "apps/server/agent/dist");
    const host = join(buildRoot, "cc-switch/host");
    const hostManifestPath = join(host, "manifest.json");
    const hostManifest = JSON.parse(await readFile(hostManifestPath, "utf8"));
    await chmod(join(host, "main.mjs"), 0o600);
    hostManifest.files.find((entry) => entry.path === "main.mjs").mode = (await lstat(join(host, "main.mjs"))).mode & 0o777;
    await put(host, "helper.mjs", "// Synthetic executable host resource\n");
    await chmod(join(host, "helper.mjs"), 0o700);
    hostManifest.files.push((await inventoryTree(host)).find((entry) => entry.path === "helper.mjs"));
    await writeFile(hostManifestPath, JSON.stringify(hostManifest));
    await verifyHost(buildRoot);
    await assert.rejects(verifyHost(buildRoot, { installationModes: true }));
    // Apply exactly the afterPack installation convention with actual chmod.
    for (const entry of hostManifest.files) await chmod(join(host, entry.path), entry.mode & 0o111 ? 0o755 : 0o644);
    await chmod(hostManifestPath, 0o644);
    await assert.rejects(verifyHost(buildRoot));
    await verifyHost(buildRoot, { installationModes: true });
    const agentPath = join(workspace, "agent-artifact-manifest.json");
    const agent = JSON.parse(await readFile(agentPath, "utf8"));
    agent.ccSwitchHost.manifestSha256 = hash(await readFile(hostManifestPath));
    await writeFile(agentPath, JSON.stringify(agent));
    const stampPath = join(resources, "desktop-install-stamp.json");
    const stamp = JSON.parse(await readFile(stampPath, "utf8"));
    stamp.compatibility.migrationsSha256 = await computeMigrationsSha256(workspace);
    await writeFile(stampPath, JSON.stringify(stamp));
    const finalArtifacts = await sealPayload(output, manifest);
    await refreshVerification(output, manifest, { checks: { application: finalArtifacts.artifacts[0].application, finalArtifacts }, nativeSmoke: { status: "not-run" }, published: false });
    await verifyDelivery(output);
    const inspect = () => inspectShippedSBOM(resources, { ...manifest, electronVersion: manifest.toolchain.electron });
    await chmod(join(host, "helper.mjs"), 0o644);
    await assert.rejects(inspect());
    await chmod(join(host, "helper.mjs"), 0o755);
    await chmod(join(host, "main.mjs"), 0o755);
    await assert.rejects(inspect());
    await chmod(join(host, "main.mjs"), 0o644);
    await writeFile(join(host, "main.mjs"), "// changed content despite canonical mode\n");
    await assert.rejects(inspect());
  });
}
