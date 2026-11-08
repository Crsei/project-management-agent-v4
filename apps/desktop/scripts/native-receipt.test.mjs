import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReceiptFixture } from "./install-e2e/fixtures.mjs";
import { importNativeReceipt, verifyNativeReceiptMaterials } from "./native-receipt.mjs";

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pm-native-receipt-archive-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createReceiptFixture(directory);
}
// The producer is explicitly synthetic contract evidence, never native execution.
// The real importer/verifier and real tar archive must nevertheless reject edits.
test("native receipt imports exact original bytes and all hashed evidence into independently verifiable delivery materials", async (t) => {
  const input = await fixture(t), original = await readFile(input.receiptPath);
  const nativeReceipt = await importNativeReceipt(input.output, input.receiptPath, input.manifest, input.finalArtifacts);
  assert.deepEqual(await readFile(join(input.output, nativeReceipt.receipt)), original);
  const verified = await verifyNativeReceiptMaterials(input.output, { ...input.manifest, nativeReceipt }, input.finalArtifacts);
  assert.equal(verified.status, "passed");
  assert.equal(verified.artifact.sha256, input.receipt.artifact.sha256);
  assert.equal(verified.source.sha256, input.receipt.source.sha256);
  assert.equal(verified.electronGuiExecuted, false);
  assert.ok(verified.receipt.bytes > 0 && verified.evidence.bytes > 0);
  await writeFile(join(input.output, nativeReceipt.evidence), "tampered archive bytes");
  await assert.rejects(verifyNativeReceiptMaterials(input.output, { ...input.manifest, nativeReceipt }, input.finalArtifacts));
});
test("native receipt cannot be rebound to different final artifact/source or omit real final app identity", async (t) => {
  const input = await fixture(t);
  await assert.rejects(importNativeReceipt(input.output, input.receiptPath, { ...input.manifest, source: { ...input.manifest.source, sha256: "f".repeat(64) } }, input.finalArtifacts), /source|digest|identity/i);
  await assert.rejects(importNativeReceipt(input.output, input.receiptPath, input.manifest, { status: "passed", artifacts: [] }), /final|artifact/i);
  const differentApp = structuredClone(input.finalArtifacts); differentApp.artifacts[0].application.sha256 = "e".repeat(64);
  await assert.rejects(importNativeReceipt(input.output, input.receiptPath, input.manifest, differentApp), /app.asar|controller|installer/i);
});
test("unrecorded native evidence fails before an archive or passed binding is produced", async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.receiptPath, "../evidence/unrecorded.log"), "synthetic unknown log");
  await assert.rejects(importNativeReceipt(input.output, input.receiptPath, input.manifest, input.finalArtifacts), /inventory.*exact|unrecorded|material/i);
});
