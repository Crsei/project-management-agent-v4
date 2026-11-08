import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { create as createTar, extract as extractTar, list as listTar } from "tar";
import { verifyInstallE2EReceipt, safeMaterialPath } from "./install-e2e/evidence.mjs";
import { fileRecord } from "./release-materials.mjs";

export async function importNativeReceipt(output, receiptPath, manifest, finalArtifacts) {
  const verified = await verifyInstallE2EReceipt(receiptPath, { output, manifest, finalArtifacts });
  const receiptName = "install-e2e-receipt.json", evidenceName = "install-e2e-evidence.tar.gz";
  const receiptBefore = await readFile(receiptPath);
  await createTar({ cwd: dirname(receiptPath), gzip: true, portable: true, file: join(output, evidenceName), follow: false }, verified.materials.map((file) => file.path));
  await writeFile(join(output, receiptName), receiptBefore, { flag: "wx" });
  // Rehash the archived copy, not just its mutable original material directory.
  const nativeReceipt = { receipt: receiptName, evidence: evidenceName, summary: verified.summary };
  await verifyNativeReceiptMaterials(output, { ...manifest, nativeReceipt }, finalArtifacts);
  return nativeReceipt;
}
export async function verifyNativeReceiptMaterials(output, manifest, finalArtifacts) {
  const binding = manifest.nativeReceipt;
  if (!binding || binding.receipt !== "install-e2e-receipt.json" || binding.evidence !== "install-e2e-evidence.tar.gz") throw new Error("Invalid native receipt material binding.");
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-receipt-")));
  try {
    const originals = await Promise.all([binding.receipt, binding.evidence].map((name) => fileRecord(output, name)));
    for (const expected of originals) {
      await copyFile(join(output, expected.path), join(temporary, expected.path));
      const actual = await fileRecord(temporary, expected.path);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error("Native receipt material changed while snapshotting.");
    }
    const receipt = JSON.parse(await readFile(join(temporary, binding.receipt), "utf8"));
    const names = new Set();
    const members = [];
    await listTar({ file: join(temporary, binding.evidence), strict: true, onReadEntry(entry) {
      const path = entry.path.replace(/\/$/, "");
      if (!safeMaterialPath(path) || posix.isAbsolute(path) || names.has(path) || !["File", "Directory"].includes(entry.type))
        throw new Error("Unsafe, linked, duplicate or unrecorded native evidence archive entry.");
      names.add(path);
      if (entry.type === "File") {
        const expected = receipt.materials?.find((file) => file.path === path);
        if (!expected || expected.bytes !== entry.size) throw new Error("Native evidence archive size differs from its exact receipt materials.");
        members.push(path);
      }
    } });
    if (!Array.isArray(receipt.materials) || JSON.stringify(members.sort()) !== JSON.stringify(receipt.materials.map((file) => file.path).sort()))
      throw new Error("Native evidence archive must contain exactly the receipt's hashed material set.");
    await extractTar({ file: join(temporary, binding.evidence), cwd: temporary, strict: true, preserveOwner: false, noChmod: true, noMtime: true });
    const checked = await verifyInstallE2EReceipt(join(temporary, binding.receipt), { output, manifest, finalArtifacts });
    if (JSON.stringify(checked.summary) !== JSON.stringify(binding.summary)) throw new Error("Native receipt report summary differs from exact verified receipt materials.");
    for (const expected of originals) {
      const actual = await fileRecord(output, expected.path);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error("Native receipt material changed during verification.");
    }
    return { ...checked.summary, receipt: originals[0], evidence: originals[1] };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
