import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { extractAntigravityArchive, resolveAntigravityInstallation } from "./antigravity-installation.ts";
import { resolveAntigravityReleaseAsset, type AntigravityReleaseAsset } from "./antigravity-release.ts";

type ZipMember = { name: string; text: string; mode?: number; flags?: number };
function archive(members: ZipMember[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name); const data = Buffer.from(member.text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(member.flags ?? 0, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(member.flags ?? 0, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(((member.mode ?? 0o100755) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
const asset: AntigravityReleaseAsset = { version: "test", url: "https://dl.google.com/test-only", sha256: "0".repeat(64), archiveBytes: 0, executable: { name: "agy_acp_server.par", bytes: 6 }, harness: { name: "localharness_external", bytes: 7 } };
const validMembers: ZipMember[] = [{ name: asset.executable.name, text: "server" }, { name: asset.harness.name, text: "harness" }];

test("release manifests pin exact native runtime pairs and reject unpublished host architectures", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) for (const arch of ["x64", "arm64"]) {
    const release = resolveAntigravityReleaseAsset(platform, arch)!;
    assert.equal(release.version, "1.3.0"); assert.match(release.sha256, /^[a-f0-9]{64}$/); assert.equal(new URL(release.url).origin, "https://dl.google.com");
    assert.ok(release.archiveBytes > 100_000_000); assert.ok(release.executable.bytes > 80_000_000); assert.ok(release.harness.bytes > 100_000_000);
    assert.equal(release.executable.name.endsWith(".exe"), platform === "win32");
  }
  assert.equal(resolveAntigravityReleaseAsset("linux", "riscv64"), null);
});

test("verified extraction accepts only the exact regular-file runtime pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "pm-antigravity-zip-"));
  try {
    const archivePath = join(root, "runtime.zip"); const destination = join(root, "runtime"); await mkdir(destination);
    await writeFile(archivePath, archive(validMembers)); await extractAntigravityArchive(archivePath, destination, asset);
    assert.equal(await readFile(join(destination, asset.executable.name), "utf8"), "server"); assert.equal(await readFile(join(destination, asset.harness.name), "utf8"), "harness");
    assert.deepEqual((await readdir(destination)).sort(), [asset.executable.name, asset.harness.name].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive extraction rejects traversal, extra members, duplicates, symlinks, encryption, size mismatch and cancellation", async () => {
  const invalid: { members: ZipMember[]; expected?: AntigravityReleaseAsset }[] = [
    { members: [...validMembers, { name: "unexpected", text: "payload" }] },
    { members: [validMembers[0]!, validMembers[0]!] },
    { members: [{ name: "../escape", text: "server" }, validMembers[1]!] },
    { members: [{ ...validMembers[0]!, mode: 0o120777 }, validMembers[1]!] },
    { members: [{ ...validMembers[0]!, flags: 1 }, validMembers[1]!] },
    { members: validMembers, expected: { ...asset, executable: { ...asset.executable, bytes: 1 } } },
  ];
  const root = await mkdtemp(join(tmpdir(), "pm-antigravity-unsafe-zip-"));
  try {
    for (const [index, entry] of invalid.entries()) {
      const archivePath = join(root, `${index}.zip`); const destination = join(root, `output-${index}`); await mkdir(destination);
      await writeFile(archivePath, archive(entry.members)); await assert.rejects(extractAntigravityArchive(archivePath, destination, entry.expected ?? asset));
    }
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(extractAntigravityArchive(join(root, "0.zip"), root, asset, cancelled.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
    await assert.rejects(readFile(join(root, "escape")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native executable resolution requires the actual harness sibling and never substitutes a generic CLI", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pm-antigravity-resolve-"));
  try {
    const context: ProviderDriverContext = { instanceId: "resolve", driver: "antigravity", config: {}, homeDirectory: join(root, "home"), cwd: root, env: { PATH: root, HOME: join(root, "home") }, revision: 1 };
    await assert.rejects(resolveAntigravityInstallation(context, ""), /not installed/);
    const executable = join(root, "custom-native"); await writeFile(executable, "native"); await chmod(executable, 0o700);
    await assert.rejects(resolveAntigravityInstallation(context, executable), /harness_external sibling is missing/);
    await writeFile(join(root, "localharness_external"), "native-harness"); await chmod(join(root, "localharness_external"), 0o700);
    const installation = await resolveAntigravityInstallation(context, "custom-native");
    assert.equal(installation.executablePath, executable); assert.equal(installation.harnessPath, join(root, "localharness_external")); assert.equal(installation.source, "override");
    const managed = join(context.homeDirectory, "tools", "antigravity-acp", `${process.platform}-${process.arch}`); await mkdir(managed, { recursive: true }); await writeFile(join(managed, "active.json"), JSON.stringify({ releaseId: "../../untrusted" }));
    await assert.rejects(resolveAntigravityInstallation(context, ""), /identifier is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
