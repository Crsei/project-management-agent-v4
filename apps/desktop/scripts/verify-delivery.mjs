import { copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectPackagedApplication } from "./packaged-application.mjs";
import { fileRecord, refreshVerification, validateSource } from "./release-materials.mjs";
import { inside, requireNativeTarget, requirePinnedNode, verifyRuntime } from "./runtime-manifest.mjs";
import { run } from "./stage-workspace.mjs";

const deliveryMaterials = ["desktop-source.tar.gz", "desktop-source.json", "desktop-legal.tar.gz", "desktop-verification.json"];
export async function verifyDeliveryFiles(output) {
  const manifest = JSON.parse(await readFile(join(output, "desktop-package.json"), "utf8"));
  if (manifest.schemaVersion !== 2 || !["win32-x64", "darwin-x64", "darwin-arm64"].includes(manifest.target)
    || !["unsigned", "signed"].includes(manifest.signing) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    || !/^[a-f0-9]{40}$/.test(manifest.source?.commit) || !/^[a-f0-9]{64}$/.test(manifest.source?.sha256)
    || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.materials))
    throw new Error("Invalid desktop release identity or unsupported delivery manifest.");
  if (JSON.stringify(manifest.materials.map((file) => file.path).sort()) !== JSON.stringify([...deliveryMaterials].sort()))
    throw new Error("Delivery is missing required source, legal or verification materials.");
  const suffixes = manifest.target.startsWith("win32-") ? [".exe"] : [".dmg", ".zip"];
  if (suffixes.some((suffix) => !manifest.artifacts.some((file) => file.path.endsWith(suffix)))
    || manifest.artifacts.some((file) => !/\.(?:exe|dmg|zip|blockmap)$/.test(file.path)))
    throw new Error("Delivery does not contain the required native installer targets.");
  const records = [...manifest.artifacts, ...manifest.materials];
  if (new Set(records.map((file) => file.path)).size !== records.length) throw new Error("Duplicate delivery file.");
  for (const expected of records) {
    const actual = await fileRecord(output, expected.path);
    if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes)
      throw new Error(`Delivery file hash/size mismatch: ${expected.path}`);
  }
  const source = JSON.parse(await readFile(join(output, "desktop-source.json"), "utf8"));
  if (source.commit !== manifest.source.commit || source.dirty !== manifest.source.dirty || source.sha256 !== manifest.source.sha256)
    throw new Error("Delivery corresponding-source identity mismatch.");
  const sums = [...records, await fileRecord(output, "desktop-package.json")].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  validateSource(source);
  const expectedSums = sums.map((file) => `${file.sha256}  ${file.path}\n`).join("");
  if (await readFile(join(output, "SHA256SUMS"), "utf8") !== expectedSums)
    throw new Error("SHA256SUMS does not cover the exact complete delivery.");
  const names = new Set([...records.map((file) => file.path), "desktop-package.json", "SHA256SUMS"]);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (/^(?:latest|nightly).*\.ya?ml$/i.test(entry.name)) throw new Error("An update feed is not configured; updater metadata must not be delivered.");
    if (entry.isFile() && /\.(?:exe|dmg|zip|blockmap|tar\.gz)$/.test(entry.name) && !names.has(entry.name))
      throw new Error(`Unrecorded release artifact: ${entry.name}`);
  }
  return { manifest, names: [...names].sort() };
}

async function stageDelivery(output, destination, names) {
  for (let current = destination; ; current = dirname(current)) {
    const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (current === destination || !info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Upload staging must be a new directory with real ancestors.");
    if (dirname(current) === current) break;
  }
  if (inside(output, destination) || inside(destination, output)) throw new Error("Upload staging must not overlap the package output.");
  await mkdir(destination, { recursive: true });
  for (const name of names) await copyFile(join(output, name), join(destination, name));
  const staged = await verifyDeliveryFiles(destination);
  if (JSON.stringify(staged.names) !== JSON.stringify(names) || JSON.stringify((await readdir(destination)).sort()) !== JSON.stringify(names))
    throw new Error("Upload staging is not the exact verified delivery file set.");
}

export async function verifyDelivery(output, { nativeSmoke = false, filesOnly = false, stage } = {}) {
  requirePinnedNode();
  output = await realpath(output);
  const { manifest, names } = await verifyDeliveryFiles(output);
  if (filesOnly && nativeSmoke) throw new Error("--files-only cannot run native smoke.");
  if (!filesOnly) {
    const resources = resolve(output, manifest.applicationResources);
    if (!inside(output, resources) || resources === output || await realpath(resources) !== resources)
      throw new Error("Packaged application resources must be real paths within this output.");
    const report = JSON.parse(await readFile(join(output, "desktop-verification.json"), "utf8"));
    const application = await inspectPackagedApplication(resources, manifest.version);
    if (report.checks?.application?.status !== "passed" || report.checks.application.version !== application.version
      || report.checks.application.sha256 !== application.sha256)
      throw new Error("Final ASAR bytes differ from the recorded application verification report.");
    // Native signing may change bundled executable bytes. afterPack checked the
    // pinned originals; the packager separately verifies final platform signatures.
    if (manifest.signing === "unsigned")
      await verifyRuntime(join(resources, "desktop-runtime"), manifest.target);
    if (nativeSmoke) {
      requireNativeTarget(...manifest.target.split("-"), true);
      report.nativeSmoke = {
        status: "running", target: manifest.target, startedAt: new Date().toISOString(), commands: [],
        runtimeInventory: manifest.signing === "unsigned" ? "Final unsigned bytes checked against pinned inventory." : "Packager checked pinned source bytes before signing. Pre-sign tool-version smoke is a separate workflow prerequisite; this command exercises the final signed managed runtime without comparing modified signature bytes to the pre-sign inventory.",
      };
      try {
        for (const [script, args] of [
          ["smoke-runtime.mjs", ["--runtime-root", join(resources, "desktop-runtime")]],
          ["smoke-managed.mjs", ["--server-root", join(resources, "workspace-runtime"), "--runtime-root", join(resources, "desktop-runtime")]],
        ].filter(([script]) => manifest.signing === "unsigned" || script !== "smoke-runtime.mjs")) {
          const entry = { script: `apps/desktop/scripts/${script}`, status: "running" };
          report.nativeSmoke.commands.push(entry);
          try {
            await run(process.execPath, [resolve(import.meta.dirname, script), ...args]);
            entry.status = "passed";
          } catch (cause) {
            entry.status = "failed";
            throw cause;
          }
        }
        report.nativeSmoke.status = "passed";
      } catch (cause) {
        report.nativeSmoke.status = "failed";
        throw cause;
      } finally {
        report.nativeSmoke.finishedAt = new Date().toISOString();
        await refreshVerification(output, manifest, report);
      }
    }
  }
  const verified = nativeSmoke ? await verifyDeliveryFiles(output) : { names };
  if (stage) {
    const report = JSON.parse(await readFile(join(output, "desktop-verification.json"), "utf8"));
    if (report.nativeSmoke?.status !== "passed") throw new Error("Actions delivery staging requires successful packaged native smoke.");
    await stageDelivery(output, resolve(stage), verified.names);
  }
  return { output, target: manifest.target, files: verified.names, checks: filesOnly ? "file hashes and complete delivery only" : "file hashes, final ASAR/unpacked/runtime boundary and application version", nativeSmoke: nativeSmoke ? "passed" : "not-executed-by-this-command", published: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let output;
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--native-smoke") options.nativeSmoke = true;
    else if (arg === "--files-only") options.filesOnly = true;
    else if (["--output", "--stage"].includes(arg) && process.argv[index + 1] && isAbsolute(process.argv[index + 1])) {
      const value = process.argv[++index];
      if (arg === "--output" && !output) output = value;
      else if (arg === "--stage" && !options.stage) options.stage = value;
      else throw new Error("Duplicate delivery argument.");
    } else throw new Error("Usage: verify-delivery.mjs --output ABS_DIRECTORY [--native-smoke | --files-only] [--stage NEW_ABS_DIRECTORY]");
  }
  if (!output) throw new Error("An explicit absolute package output is required.");
  console.log(JSON.stringify(await verifyDelivery(output, options)));
}
