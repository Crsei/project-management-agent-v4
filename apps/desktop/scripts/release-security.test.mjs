import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertExactDeliveryDirectory, configuredArtifactNames, deliveryMaterialNames, validateDeliveryAssets } from "./delivery-assets.mjs";
import { comparableFinalArtifactReport, peContentRecord, validateWindowsSignature, verifyFinalSignatures, windowsSignerIdentity } from "./signatures.mjs";
import { requireCleanVulnerabilityReport, scanSBOM } from "./osv.mjs";
import { finalDmgNotarizationOptions, notarizeFinalDmg } from "./mac-notarization.mjs";

const identity = { subject: "CN=Synthetic release test signer", sha256: "a".repeat(64) };
function unsignedPE(contentBytes = 512, trailingZeros = 0) {
  const content = Buffer.alloc(contentBytes, 0x31);
  content.fill(0, content.length - trailingZeros);
  content.write("MZ", 0, "ascii"); content.writeUInt32LE(0x80, 0x3c);
  content.write("PE\0\0", 0x80, "ascii"); content.writeUInt16LE(224, 0x80 + 20);
  const optional = 0x80 + 24;
  content.writeUInt16LE(0x10b, optional);
  content.writeUInt32LE(0, optional + 96 + 32); content.writeUInt32LE(0, optional + 96 + 36);
  return content;
}
function signedPE(original, certificate = Buffer.alloc(16, 0x71)) {
  const offset = original.length + (8 - original.length % 8) % 8;
  const signed = Buffer.concat([original, Buffer.alloc(offset - original.length), certificate]);
  signed.writeUInt32LE(offset, 0x80 + 24 + 96 + 32);
  signed.writeUInt32LE(certificate.length, 0x80 + 24 + 96 + 36);
  return signed;
}
test("PE signing preserves all original zero/overlay bytes with every possible alignment length", () => {
  for (const contentBytes of [512, 513, 514, 515, 516, 517, 518, 519]) {
    for (const trailingZeros of [0, 1, 7, 8, 17]) {
      const original = unsignedPE(contentBytes, trailingZeros);
      const record = peContentRecord(original);
      assert.equal(record.contentBytes, contentBytes);
      const signed = signedPE(original);
      signed.writeUInt32LE(0x12345678, 0x80 + 24 + 64);
      assert.deepEqual(peContentRecord(signed, record.contentBytes), record);
      signed[contentBytes - 1] ^= 0x7f;
      assert.notEqual(peContentRecord(signed, record.contentBytes).sha256, record.sha256, "original trailing bytes must not be treated as removable padding");
    }
  }
});
test("PE re-signing preserves the complete original certificate prefix, including preexisting zero overlay/alignment", () => {
  const original = signedPE(unsignedPE(513, 17));
  const record = peContentRecord(original);
  assert.equal(record.contentBytes, 520);
  const resigned = signedPE(original.subarray(0, record.contentBytes), Buffer.alloc(32, 0x72));
  assert.deepEqual(peContentRecord(resigned, record.contentBytes), record);
  resigned[400] ^= 0xff;
  assert.notEqual(peContentRecord(resigned, record.contentBytes).sha256, record.sha256);
});
test("PE integrity rejects nonzero/oversized alignment and unsafe certificate layouts", () => {
  const original = unsignedPE(513, 17), record = peContentRecord(original);
  const badPadding = signedPE(original);
  badPadding[original.length] = 1;
  assert.throws(() => peContentRecord(badPadding, record.contentBytes), /alignment/);
  const extraPadding = signedPE(Buffer.concat([unsignedPE(512, 17), Buffer.alloc(8)]));
  assert.throws(() => peContentRecord(extraPadding, 512), /alignment/);
  const malformed = signedPE(original);
  malformed.writeUInt32LE(128, 0x80 + 24 + 96 + 32);
  assert.throws(() => peContentRecord(malformed, record.contentBytes), /certificate layout/);
  assert.throws(() => peContentRecord(Buffer.concat([signedPE(original), Buffer.alloc(1)]), record.contentBytes), /certificate layout/);
  assert.equal(peContentRecord(Buffer.from("not a native executable")), null);
});
test("final report equality tolerates cache annotations only and retains raw Gatekeeper command/result/signer evidence", () => {
  const fresh = { signatures: { identity: { teamId: "ABCDEFGHIJ" }, reports: [{
    command: "/usr/sbin/spctl", args: ["--assess", "--ignore-cache", "--no-cache", "<final-app>"], exitCode: 0, stdout: "",
    stderr: "<final-app>: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Fixture (ABCDEFGHIJ)\n",
  }] } };
  const cached = structuredClone(fresh);
  cached.signatures.reports[0].stderr = cached.signatures.reports[0].stderr.replace(": accepted", ": accepted (cached)").replace("source=Notarized Developer ID", "source=Notarized Developer ID (cached)");
  assert.equal(comparableFinalArtifactReport(fresh), comparableFinalArtifactReport(cached));
  assert.match(cached.signatures.reports[0].stderr, /\(cached\)/, "comparison must not overwrite actual native diagnostics");
  for (const mutate of [
    (report) => { report.stderr = report.stderr.replace("accepted", "rejected"); },
    (report) => { report.stderr = report.stderr.replace("Notarized Developer ID", "Unnotarized Developer ID"); },
    (report) => { report.stderr = report.stderr.replace("ABCDEFGHIJ", "ANOTHER123"); },
    (report) => { report.exitCode = 1; },
    (report) => { report.args = ["--assess", "--type", "install"]; },
  ]) {
    const changed = structuredClone(fresh);
    mutate(changed.signatures.reports[0]);
    assert.notEqual(comparableFinalArtifactReport(fresh), comparableFinalArtifactReport(changed));
  }
});
test("signed Windows evidence requires exact certificate subject and SHA256, never only Valid status", () => {
  assert.throws(() => windowsSignerIdentity({}), /requires/);
  assert.deepEqual(windowsSignerIdentity({ PM_DESKTOP_WINDOWS_SIGNER_SUBJECT: identity.subject, PM_DESKTOP_WINDOWS_SIGNER_SHA256: identity.sha256.toUpperCase() }), identity);
  assert.equal(validateWindowsSignature({ status: "Valid", subject: identity.subject, certificateSha256: identity.sha256 }, identity).status, "passed");
  for (const mutation of [{ status: "NotSigned" }, { subject: "CN=Another signer" }, { certificateSha256: "b".repeat(64) }])
    assert.throws(() => validateWindowsSignature({ status: "Valid", subject: identity.subject, certificateSha256: identity.sha256, ...mutation }, identity), /mismatch/);
});
test("unsigned verification cannot advertise signatures or notarization", async () => {
  const result = await verifyFinalSignatures("unread-path", "unread-installer", { target: "win32-x64", signing: "unsigned" });
  assert.equal(result.status, "not-applicable"); assert.equal(result.signing, "unsigned");
  if (process.platform !== "win32") await assert.rejects(verifyFinalSignatures("unread-path", "unread-installer", { target: "win32-x64", signing: "signed", signer: identity }), /native/);
});
function sbom() {
  return { components: [{ name: "fixture", version: "1.0.0", purl: "pkg:npm/fixture@1.0.0", "bom-ref": "workspace/node_modules/fixture" }], metadata: { properties: [
    { name: "dovspace:source", value: JSON.stringify({ commit: "a".repeat(40), dirty: true, sha256: "b".repeat(64) }) },
    { name: "dovspace:final-artifacts", value: JSON.stringify([{ path: "fixture.exe", bytes: 1, sha256: "c".repeat(64) }]) },
  ] } };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
test("OSV distinguishes network failure, unsupported feed, incomplete coverage and a clean exact scan", async () => {
  const bom = sbom();
  const network = await scanSBOM(bom, { fetcher: async () => { throw new Error("synthetic connection failure"); } });
  assert.equal(network.report.status, "network-error"); assert.equal(network.sarif.runs[0].invocations[0].executionSuccessful, false);
  assert.throws(() => requireCleanVulnerabilityReport(network.report), /network-error/);
  for (const invalid of [{ results: [] }, { results: [{ error: { code: 400 } }] }]) {
    const scan = await scanSBOM(bom, { fetcher: async () => response(invalid) });
    assert.equal(scan.report.status, "feed-error"); assert.throws(() => requireCleanVulnerabilityReport(scan.report), /feed-error/);
  }
  const clean = await scanSBOM(bom, { fetcher: async () => response({ results: [{}] }) });
  assert.equal(clean.report.status, "passed"); requireCleanVulnerabilityReport(clean.report, bom);
  const expanded = structuredClone(bom); expanded.components.push({ purl: "pkg:npm/missing@1.0.0", "bom-ref": "unscanned-package" });
  assert.throws(() => requireCleanVulnerabilityReport(clean.report, expanded), /complete shipped SBOM/);
});
test("OSV blocks an unwithdrawn advisory even without severity and emits actionable fixes and exact component identity", async () => {
  const advisory = { id: "GHSA-synthetic-test", summary: "Synthetic advisory fixture", affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }], references: [{ url: "https://example.invalid/advisory" }] };
  const scan = await scanSBOM(sbom(), { fetcher: async (url) => response(url.includes("querybatch") ? { results: [{ vulns: [{ id: advisory.id }] }] } : advisory) });
  assert.equal(scan.report.status, "vulnerabilities-found"); assert.throws(() => requireCleanVulnerabilityReport(scan.report), /vulnerabilities-found/);
  assert.deepEqual(scan.report.vulnerabilities[0].fixedVersions, ["1.0.1"]);
  assert.match(scan.sarif.runs[0].results[0].message.text, /workspace\/node_modules\/fixture.*1\.0\.1/);
  const tampered = { ...scan.report, status: "passed", vulnerabilities: [] };
  assert.throws(() => requireCleanVulnerabilityReport(tampered), /gate failed/);
});
test("asset policy rejects arbitrary extras, missing native target and duplicate material names", async (t) => {
  const manifest = { version: "0.1.0", target: "win32-x64", signing: "unsigned", artifacts: [], materials: [] };
  manifest.materials = deliveryMaterialNames(manifest).map((path) => ({ path }));
  const name = configuredArtifactNames(manifest).required[0]; manifest.artifacts.push({ path: name });
  const names = validateDeliveryAssets(manifest);
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-delivery-assets-"))); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of names) await writeFile(join(root, path), "synthetic material fixture");
  await assertExactDeliveryDirectory(root, names);
  await writeFile(join(root, "hidden-extra.txt"), "not in allowlist");
  await assert.rejects(assertExactDeliveryDirectory(root, names), /exact allowlist/);
  await rm(join(root, "hidden-extra.txt")); await mkdir(join(root, "extra-directory"));
  await assert.rejects(assertExactDeliveryDirectory(root, names), /exact allowlist/);
  assert.throws(() => validateDeliveryAssets({ ...manifest, artifacts: [] }), /native installer/);
  assert.throws(() => validateDeliveryAssets({ ...manifest, materials: [...manifest.materials, manifest.materials[0]] }), /extra material/);
});

test("final DMG notarization accepts only a bounded exact DMG and complete protected credentials for the expected team", async () => {
  const path = "/synthetic/final-release.dmg";
  const environment = { PM_DESKTOP_MAC_TEAM_ID: "ABCDEFGHIJ", APPLE_ID: "synthetic@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "synthetic-password", APPLE_TEAM_ID: "ABCDEFGHIJ" };
  assert.deepEqual(finalDmgNotarizationOptions(path, environment), {
    tool: "notarytool", appPath: path, appleId: environment.APPLE_ID, appleIdPassword: environment.APPLE_APP_SPECIFIC_PASSWORD, teamId: environment.APPLE_TEAM_ID,
  });
  assert.deepEqual(finalDmgNotarizationOptions(path, { PM_DESKTOP_MAC_TEAM_ID: "ABCDEFGHIJ", APPLE_API_KEY: "/synthetic/private-key.p8", APPLE_API_KEY_ID: "SYNTHETIC1", APPLE_API_ISSUER: "synthetic-issuer" }), {
    tool: "notarytool", appPath: path, appleApiKey: "/synthetic/private-key.p8", appleApiKeyId: "SYNTHETIC1", appleApiIssuer: "synthetic-issuer",
  });
  for (const invalid of [{ PM_DESKTOP_MAC_TEAM_ID: "ABCDEFGHIJ" }, { ...environment, APPLE_TEAM_ID: "OTHERTEAM1" },
    { ...environment, APPLE_APP_SPECIFIC_PASSWORD: "x".repeat(4097) }])
    assert.throws(() => finalDmgNotarizationOptions(path, invalid), /requires|configuration|differs/);
  for (const invalidPath of ["../final.dmg", "/synthetic/final.zip", "/synthetic/final.dmg\n"])
    assert.throws(() => finalDmgNotarizationOptions(invalidPath, environment), /exact absolute DMG/);
  if (process.platform !== "darwin") await assert.rejects(notarizeFinalDmg(path), /native macOS/);
});
