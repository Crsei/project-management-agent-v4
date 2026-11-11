import { copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectFinalArtifacts, verifyInstalledApplication } from "./final-artifact.mjs";
import { fileRecord, refreshVerification, validateSource, verifyCorrespondingSourceArchive } from "./release-materials.mjs";
import { inside, requireNativeTarget, requirePinnedNode } from "./runtime-manifest.mjs";
import { run } from "./stage-workspace.mjs";
import { assertExactDeliveryDirectory, nativeReceiptMaterials, validateDeliveryAssets, verifyUpdateDelivery } from "./delivery-assets.mjs";
import { importNativeReceipt, verifyNativeReceiptMaterials } from "./native-receipt.mjs";
import { inspectShippedSBOM } from "./sbom.mjs";
import { requireCleanVulnerabilityReport, vulnerabilitySARIF } from "./osv.mjs";
import { comparableFinalArtifactReport } from "./signatures.mjs";

const sameIdentity = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export async function verifyDeliveryFiles(output) {
  const manifest = JSON.parse(await readFile(join(output, "desktop-package.json"), "utf8"));
  if (manifest.schemaVersion !== 3 || !["win32-x64", "darwin-x64", "darwin-arm64"].includes(manifest.target)
    || !["unsigned", "signed"].includes(manifest.signing) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    || !/^[a-f0-9]{40}$/.test(manifest.source?.commit) || !/^[a-f0-9]{64}$/.test(manifest.source?.sha256)
    || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.materials))
    throw new Error("Invalid desktop release identity or unsupported delivery manifest.");
  const allowedNames = validateDeliveryAssets(manifest);
  const records = [...manifest.artifacts, ...manifest.materials];
  if (new Set(records.map((file) => file.path)).size !== records.length) throw new Error("Duplicate delivery file.");
  for (const expected of records) {
    const actual = await fileRecord(output, expected.path);
    if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes)
      throw new Error(`Delivery file hash/size mismatch: ${expected.path}`);
  }
  await verifyUpdateDelivery(output, manifest);
  const source = JSON.parse(await readFile(join(output, "desktop-source.json"), "utf8"));
  if (source.commit !== manifest.source.commit || source.dirty !== manifest.source.dirty || source.sha256 !== manifest.source.sha256)
    throw new Error("Delivery corresponding-source identity mismatch.");
  const sbom = JSON.parse(await readFile(join(output, "desktop-sbom.cdx.json"), "utf8"));
  const osv = JSON.parse(await readFile(join(output, "desktop-osv.json"), "utf8"));
  const properties = sbom.metadata?.properties;
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || !Array.isArray(properties)
    || properties.find((entry) => entry.name === "dovspace:source")?.value !== JSON.stringify({ commit: source.commit, dirty: source.dirty, sha256: source.sha256 })
    || properties.find((entry) => entry.name === "dovspace:final-artifacts")?.value !== JSON.stringify(manifest.artifacts)
    || osv.sbomSha256 !== (await fileRecord(output, "desktop-sbom.cdx.json")).sha256
    || !sameIdentity(osv.source, { commit: source.commit, dirty: source.dirty, sha256: source.sha256 }) || !sameIdentity(osv.artifacts, manifest.artifacts))
    throw new Error("SBOM/vulnerability report is not bound to these exact final source/artifact bytes.");
  requireCleanVulnerabilityReport(osv, sbom);
  if (!sameIdentity(JSON.parse(await readFile(join(output, "desktop-vulnerabilities.sarif"), "utf8")), vulnerabilitySARIF(osv)))
    throw new Error("Vulnerability SARIF differs from the exact recorded OSV scan.");
  const report = JSON.parse(await readFile(join(output, "desktop-verification.json"), "utf8"));
  if (!sameIdentity(report.source, { commit: source.commit, dirty: source.dirty, sha256: source.sha256 })
    || !sameIdentity(report.artifacts, manifest.artifacts) || report.target !== manifest.target || report.signing !== manifest.signing || report.version !== manifest.version)
    throw new Error("Desktop verification report differs from the exact final source/artifact release identity.");
  if (manifest.nativeReceipt) {
    const receipt = await verifyNativeReceiptMaterials(output, manifest, report.checks?.finalArtifacts);
    if (!sameIdentity(report.installE2E, receipt)) throw new Error("Desktop verification does not match its exact native receipt/evidence materials.");
  } else if (report.installE2E?.installationExecuted === true || report.installE2E?.status === "passed")
    throw new Error("Installer execution cannot pass without exact native receipt materials.");
  const sums = [...records, await fileRecord(output, "desktop-package.json")].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  validateSource(source);
  await verifyCorrespondingSourceArchive(output, source);
  const expectedSums = sums.map((file) => `${file.sha256}  ${file.path}\n`).join("");
  if (await readFile(join(output, "SHA256SUMS"), "utf8") !== expectedSums)
    throw new Error("SHA256SUMS does not cover the exact complete delivery.");
  const names = new Set([...records.map((file) => file.path), "desktop-package.json", "SHA256SUMS"]);
  await assertExactDeliveryDirectory(output, allowedNames);
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

export async function verifyDelivery(output, { nativeSmoke = false, filesOnly = false, installedResources, installE2EReceipt, stage } = {}) {
  requirePinnedNode();
  output = await realpath(output);
  const { manifest, names } = await verifyDeliveryFiles(output);
  if (filesOnly && (nativeSmoke || installedResources || installE2EReceipt)) throw new Error("--files-only cannot execute, inspect application resources or import native execution evidence.");
  if (installedResources && !nativeSmoke) throw new Error("--installed-resources requires --native-smoke and an explicitly supplied installed application tree.");
  let finalArtifacts;
  if (!filesOnly) {
    const report = JSON.parse(await readFile(join(output, "desktop-verification.json"), "utf8"));
    const expected = report.checks?.finalArtifacts;
    if (expected?.status !== "passed" || !Array.isArray(expected.artifacts))
      throw new Error("Delivery lacks verification of its actual final distributable payloads; win-unpacked is not installation evidence.");
    if (nativeSmoke) requireNativeTarget(...manifest.target.split("-"), true);
    let smokeExecuted = false;
    const smoke = async (resources, artifact, checked, scope) => {
      report.nativeSmoke = {
        status: "running", target: manifest.target, startedAt: new Date().toISOString(), commands: [],
        scope, artifact: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes },
        installationExecuted: false, electronGuiExecuted: false,
        controllerScope: "Checkout-built desktop service controller; packaged backend/runtime resources. This does not execute installed Electron app.asar controller or GUI.",
        runtimeInventory: checked.runtime,
      };
      try {
        for (const [script, args] of [
          ["smoke-runtime.mjs", ["--runtime-root", join(resources, "desktop-runtime")]],
          ["smoke-managed.mjs", ["--server-root", join(resources, "workspace-runtime"), "--runtime-root", join(resources, "desktop-runtime")]],
        ].filter(([script]) => (manifest.signing === "unsigned" && manifest.target === "win32-x64") || script !== "smoke-runtime.mjs")) {
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
        smokeExecuted = true;
      } catch (cause) {
        report.nativeSmoke.status = "failed";
        throw cause;
      } finally {
        report.nativeSmoke.finishedAt = new Date().toISOString();
        await refreshVerification(output, manifest, report);
      }
    };
    finalArtifacts = await inspectFinalArtifacts(output, manifest.artifacts, manifest, async (resources, artifact, checked) => {
      const recorded = expected.artifacts.find((entry) => entry.path === artifact.path);
      if (comparableFinalArtifactReport(recorded) !== comparableFinalArtifactReport(checked))
        throw new Error(`Final distributable payload differs from its recorded verification: ${artifact.path}`);
      if (report.checks?.application?.status !== "passed" || report.checks.application.sha256 !== checked.application.sha256
        || report.checks.application.version !== checked.application.version)
        throw new Error("Final ASAR bytes differ from the recorded application verification report.");
      const currentSBOM = await inspectShippedSBOM(resources, { ...manifest, electronVersion: manifest.toolchain.electron, artifacts: manifest.artifacts });
      if (!sameIdentity(currentSBOM, JSON.parse(await readFile(join(output, "desktop-sbom.cdx.json"), "utf8"))))
        throw new Error("SBOM differs from actual final shipped closures.");
      if (nativeSmoke && !installedResources && !smokeExecuted)
        await smoke(resources, artifact, checked, "final-distributable-payload");
    });
    if (comparableFinalArtifactReport(expected) !== comparableFinalArtifactReport(finalArtifacts))
      throw new Error("Final distributable verification does not match the complete recorded payload report.");
    if (installedResources) {
      const final = finalArtifacts.artifacts[0];
      const checked = await verifyInstalledApplication(installedResources, final, manifest);
      report.installedTree = checked;
      await smoke(resolve(installedResources), final, checked, "supplied-installed-tree");
    }
  }
  if (installE2EReceipt) {
    if (!finalArtifacts) throw new Error("Native receipt import requires full final artifact inspection.");
    const current = JSON.parse(await readFile(join(output, "desktop-verification.json"), "utf8"));
    if (manifest.nativeReceipt) throw new Error("Native receipt materials are immutable; import into a delivery only once.");
    manifest.nativeReceipt = await importNativeReceipt(output, resolve(installE2EReceipt), manifest, finalArtifacts);
    current.installE2E = await verifyNativeReceiptMaterials(output, manifest, finalArtifacts);
    for (const name of nativeReceiptMaterials) {
      manifest.materials = manifest.materials.filter((entry) => entry.path !== name);
      manifest.materials.push(await fileRecord(output, name));
    }
    current.notCovered = (current.notCovered ?? []).filter((entry) => entry !== "Real installer install/upgrade/uninstall");
    await refreshVerification(output, manifest, current);
  }
  const verified = nativeSmoke || installE2EReceipt ? await verifyDeliveryFiles(output) : { names };
  if (stage) {
    const report = JSON.parse(await readFile(join(output, "desktop-verification.json"), "utf8"));
    const smoke = report.nativeSmoke;
    if (smoke?.status !== "passed" || !["final-distributable-payload", "supplied-installed-tree"].includes(smoke.scope)
      || report.checks?.finalArtifacts?.status !== "passed"
      || manifest.artifacts.filter((entry) => /\.(?:exe|dmg|zip)$/.test(entry.path)).some((entry) => !report.checks.finalArtifacts.artifacts?.some((checked) => checked.path === entry.path && checked.sha256 === entry.sha256 && checked.bytes === entry.bytes))
      || !manifest.artifacts.some((entry) => entry.path === smoke.artifact?.path && entry.sha256 === smoke.artifact.sha256 && entry.bytes === smoke.artifact.bytes))
      throw new Error("Actions delivery staging requires successful native smoke bound to this final distributable payload, not win-unpacked staging.");
    await stageDelivery(output, resolve(stage), verified.names);
  }
  return { output, target: manifest.target, files: verified.names,
    checks: filesOnly ? "file hashes and complete delivery only" : "file hashes, actual final distributable expansion, exact dependency resources/graph and application version",
    ...(finalArtifacts ? { finalArtifacts } : {}), installedTree: installedResources ? "supplied tree inspected; installer execution not performed" : "not-inspected",
    nativeSmoke: nativeSmoke ? "passed" : "not-executed-by-this-command",
    installE2E: manifest.nativeReceipt?.summary ?? { status: "not-run", installationExecuted: false },
    installationExecuted: manifest.nativeReceipt?.summary?.installationExecuted === true,
    nativeExecutionByThisCommand: nativeSmoke, signingVerification: filesOnly ? "recorded reports only; native signatures not re-executed" : "final native artifact signatures re-executed (unsigned is not-applicable)",
    electronGuiExecuted: false, published: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let output;
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--native-smoke") options.nativeSmoke = true;
    else if (arg === "--files-only") options.filesOnly = true;
    else if (["--output", "--stage", "--installed-resources", "--install-e2e-receipt"].includes(arg) && process.argv[index + 1] && isAbsolute(process.argv[index + 1])) {
      const value = process.argv[++index];
      if (arg === "--output" && !output) output = value;
      else if (arg === "--stage" && !options.stage) options.stage = value;
      else if (arg === "--installed-resources" && !options.installedResources) options.installedResources = value;
      else if (arg === "--install-e2e-receipt" && !options.installE2EReceipt) options.installE2EReceipt = value;
      else throw new Error("Duplicate delivery argument.");
    } else throw new Error("Usage: verify-delivery.mjs --output ABS_DIRECTORY [--native-smoke [--installed-resources ABS_RESOURCES] | --files-only] [--install-e2e-receipt ABS_JSON] [--stage NEW_ABS_DIRECTORY]");
  }
  if (!output) throw new Error("An explicit absolute package output is required.");
  console.log(JSON.stringify(await verifyDelivery(output, options)));
}
