import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyStoppedRecoverySet } from "../apps/server/agent/src/maintenance/recovery-set.ts";
import { restoreAgentBackup, verifyAgentBackup } from "../apps/server/agent/src/maintenance/agent-backup.ts";
import { restoreLocalProjectCheckpoint, localProjectCheckpointSchema } from "../packages/infrastructure/src/project-storage-checkpoint.ts";
import { readBlobBackupManifest } from "../packages/infrastructure/src/blob-storage-backup.ts";
import { verifyInventoryObjects } from "../packages/infrastructure/src/blob-storage-inventory.ts";
import { LocalBlobStore } from "../packages/infrastructure/src/blobs.ts";
import { makePrivatePath } from "../packages/pm-core/private-path.ts";

const { values } = parseArgs({ strict: true, options: { directory: { type: "string" }, stopped: { type: "boolean" } } });
if (!values.directory || !values.stopped || !path.isAbsolute(values.directory))
  throw new Error("Usage: node --conditions=development scripts/verify-recovery-set.ts --directory /private/stopped-recovery-set --stopped. This reads the supplied set and restores only into a new private temporary directory; SQL is not executed.");
const set = await verifyStoppedRecoverySet(values.directory);
const temporary = await mkdtemp(path.join(tmpdir(), "agent-recovery-set-verify-"));
makePrivatePath(temporary);
try {
  const core = localProjectCheckpointSchema.parse(JSON.parse(readFileSync(path.join(values.directory, "files/manifest.json"), "utf8")));
  await restoreLocalProjectCheckpoint({ directory: path.join(values.directory, "files"), manifest: core,
    expectedManifestSha256: set.components.coreManifestSha256, targetCoreRoot: path.join(temporary, "core"), targetProjectsRoot: path.join(temporary, "projects"), stopped: true });
  const blobs = await readBlobBackupManifest(path.join(values.directory, "blobs"));
  const store = new LocalBlobStore(path.join(values.directory, "blobs/objects"));
  try { await verifyInventoryObjects(store, blobs.entries); } finally { store.close(); }
  if (set.agent) {
    restoreAgentBackup({ bundle: path.join(values.directory, "agent"), target: path.join(temporary, "agent"), stopped: true });
    verifyAgentBackup({ bundle: path.join(values.directory, "agent"), target: path.join(temporary, "agent"), stopped: true });
  }
  console.log(JSON.stringify({ recoverySetId: set.recoverySetId, componentsVerified: true, projectBytesVerified: true,
    blobBytesVerified: true, agentSQLiteIsolatedRestoreVerified: Boolean(set.agent), sqlDigestVerified: true,
    sqlExecutionVerified: false, productionMigrationAuthorized: false, executionRestored: false }));
} finally { await rm(temporary, { recursive: true, force: true }); }
