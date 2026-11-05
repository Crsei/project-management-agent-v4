import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ExtensionError } from "./rpc.ts";
import { assertPrivatePath, makePrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { extensionDataDirectory, privateDirectory } from "./storage.ts";

export const extensionMaintenanceSchema = z.strictObject({ migrationId: z.string().regex(/^[0-9a-f]{64}$/) });
export type ExtensionMaintenance = z.infer<typeof extensionMaintenanceSchema>;
export async function readExtensionMaintenance(): Promise<ExtensionMaintenance | undefined> {
  const filename = path.join(extensionDataDirectory(), "maintenance.json");
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe migration gate");
    assertPrivatePath(filename);
    return extensionMaintenanceSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new ExtensionError(503, "migration_gate_unavailable", "The migration exclusion state is unreadable; reconcile its private snapshot before editing project definitions.");
  }
}
export async function saveExtensionMaintenance(value: ExtensionMaintenance | undefined): Promise<void> {
  const root = extensionDataDirectory();
  await privateDirectory(root);
  const filename = path.join(root, "maintenance.json");
  if (!value) { await unlink(filename).catch(error => { if (error?.code !== "ENOENT") throw error; }); return; }
  const temporary = path.join(root, `.maintenance-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { makePrivatePath(temporary); await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => undefined); }
}
