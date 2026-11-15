import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { localProjectCheckpointSchema, localProjectCheckpointSha256 } from "../../../../../packages/infrastructure/src/project-storage-checkpoint.ts";
import { blobBackupManifestSchema, blobBackupManifestSha256 } from "../../../../../packages/infrastructure/src/blob-storage-backup.ts";
import { treeManifestSchema, verifyTree, type TreeManifest } from "../../../../../packages/infrastructure/src/maintenance-tree.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const desktopChatInventorySchema = z.object({ chatFiles: treeManifestSchema.nullable() }).loose();
export const recoverySetSchema = z.strictObject({
  format: z.literal("pm-agent-stopped-recovery-set"), version: z.literal(1), recoverySetId: z.uuid(), complete: z.literal(true),
  createdAt: z.iso.datetime(), applicationVersion: z.string().min(1),
  quiescence: z.strictObject({ barrierId: z.uuid(), startedAt: z.iso.datetime(), endedAt: z.iso.datetime(),
    writers: z.array(z.enum(["pm-api", "pm-worker", "pm-markdown-editors", "agent", "owned-native-processes"])).min(5),
    operatorConfirmedStopped: z.literal(true), sourceRechecked: z.literal(true) }),
  components: z.strictObject({ databaseDumpSha256: digest, coreManifestSha256: digest, blobManifestSha256: digest,
    agentManifestSha256: digest.nullable(), chatFilesSha256: digest.nullable() }),
  agent: z.strictObject({ sourceStoreId: z.string().min(1), restoreEpoch: z.number().int().nonnegative(),
    sourceFingerprint: digest, secrets: z.enum(["include", "exclude"]) }).nullable(),
  exclusions: z.array(z.string()), externalSideEffectsCheckpointed: z.literal(false), executionRestored: z.literal(false),
}).superRefine((value, ctx) => {
  if (new Set(value.quiescence.writers).size !== 5 || Date.parse(value.quiescence.endedAt) < Date.parse(value.quiescence.startedAt))
    ctx.addIssue({ code: "custom", path: ["quiescence"], message: "A complete same-barrier writer scope and ordered timestamps are required." });
  if ((value.agent === null) !== (value.components.agentManifestSha256 === null))
    ctx.addIssue({ code: "custom", path: ["agent"], message: "Agent identity and bundle coverage must agree." });
});
export type StoppedRecoverySet = z.infer<typeof recoverySetSchema>;
export const recoverySetSha256 = (set: StoppedRecoverySet): string => createHash("sha256").update(JSON.stringify(recoverySetSchema.parse(set))).digest("hex");
export function createStoppedRecoverySet(input: Omit<StoppedRecoverySet, "format" | "version" | "recoverySetId" | "complete" | "createdAt" | "externalSideEffectsCheckpointed" | "executionRestored">): StoppedRecoverySet {
  return recoverySetSchema.parse({ ...input, format: "pm-agent-stopped-recovery-set", version: 1, recoverySetId: randomUUID(), complete: true,
    createdAt: new Date().toISOString(), externalSideEffectsCheckpointed: false, executionRestored: false });
}
/** Validate actual component files, not only matching metadata labels. Call before any target writes. */
export async function verifyStoppedRecoverySet(directory: string, expected?: StoppedRecoverySet): Promise<StoppedRecoverySet> {
  const filename = path.join(directory, "recovery-set.json");
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe recovery-set manifest.");
  assertPrivatePath(filename);
  const set = recoverySetSchema.parse(JSON.parse(readFileSync(filename, "utf8")));
  if (expected && recoverySetSha256(set) !== recoverySetSha256(expected)) throw new Error("Recovery-set identity differs from the enclosing manifest.");
  await verifyRecoveryComponents(directory, set);
  return set;
}
async function verifyRecoveryComponents(directory: string, set: StoppedRecoverySet): Promise<void> {
  const componentFiles = [
    ["database.dump", set.components.databaseDumpSha256], ["files/manifest.json", set.components.coreManifestSha256],
    ["blobs/manifest.json", set.components.blobManifestSha256], ["agent/manifest.json", set.components.agentManifestSha256],
  ] as const;
  for (const [relative, hash] of componentFiles) {
    if (hash === null) continue;
    const member = path.join(directory, relative), stat = lstatSync(member);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe recovery-set component.");
    const bytes = readFileSync(member);
    const actual = relative === "files/manifest.json" ? localProjectCheckpointSha256(localProjectCheckpointSchema.parse(JSON.parse(bytes.toString("utf8"))))
      : relative === "blobs/manifest.json" ? blobBackupManifestSha256(blobBackupManifestSchema.parse(JSON.parse(bytes.toString("utf8"))))
      : createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) throw new Error("Recovery-set component changed or belongs to another checkpoint.");
  }
  const blobs = blobBackupManifestSchema.parse(JSON.parse(readFileSync(path.join(directory, "blobs/manifest.json"), "utf8")));
  if (blobs.databaseDumpSha256 !== set.components.databaseDumpSha256 || blobs.coreManifestSha256 !== set.components.coreManifestSha256)
    throw new Error("Blob references do not belong to the recovery-set SQL/core checkpoint.");
  if (set.agent) {
    const manifest = JSON.parse(readFileSync(path.join(directory, "agent/manifest.json"), "utf8")) as { sourceIdentity?: { storeId?: string; restoreEpoch?: number }; secrets?: string };
    if (manifest.sourceIdentity?.storeId !== set.agent.sourceStoreId || manifest.sourceIdentity.restoreEpoch !== set.agent.restoreEpoch || manifest.secrets !== set.agent.secrets)
      throw new Error("Agent bundle identity/secret policy differs from this recovery set.");
  }
  let chatInventory: TreeManifest | null = null;
  try {
    const desktopManifest = path.join(directory, "desktop-backup.json"), stat = lstatSync(desktopManifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe desktop chat inventory.");
    assertPrivatePath(desktopManifest);
    chatInventory = desktopChatInventorySchema.parse(JSON.parse(readFileSync(desktopManifest, "utf8"))).chatFiles;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (set.components.chatFilesSha256 !== null) {
    const chatFiles = treeManifestSchema.parse(chatInventory);
    if (createHash("sha256").update(JSON.stringify(chatFiles)).digest("hex") !== set.components.chatFilesSha256)
      throw new Error("Desktop chat inventory differs from the declared recovery-set component.");
    await verifyTree(path.join(directory, "chat-spaces"), chatFiles);
  } else {
    if (chatInventory !== null) throw new Error("Desktop chat inventory is missing its recovery-set digest.");
    try {
      lstatSync(path.join(directory, "chat-spaces"));
      throw new Error("Recovery set contains an undeclared desktop chat tree.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
export async function writeStoppedRecoverySet(directory: string, set: StoppedRecoverySet): Promise<void> {
  // Verify before publication; a failed component never publishes a complete set.
  const parsed = recoverySetSchema.parse(set), file = path.join(directory, "recovery-set.json");
  await verifyRecoveryComponents(directory, parsed);
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
