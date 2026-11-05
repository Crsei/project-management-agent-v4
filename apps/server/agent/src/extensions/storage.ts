import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { extensionProjectScopeSchema, type ExtensionProjectScope } from "@agent-workspace/contracts/extensions";
import { assertPrivatePath, makePrivatePath } from "../../../../../packages/pm-core/private-path.ts";
import { dataDirectory } from "../paths.ts";
import { ExtensionError } from "./rpc.ts";
import type { ExtensionProviderBinding } from "./provider-bindings.ts";
import type { ExternalExtensionTarget } from "./external-targets.ts";

export type StoredExtensionContext = {
  id: string;
  label: string;
  kind: "native" | "project";
  scope?: ExtensionProjectScope;
  binding?: ExtensionProviderBinding;
  createdAt: string;
  unifiedSkillsOwned?: boolean;
  providerBinding?: ExtensionProviderBinding;
  externalTargets?: ExternalExtensionTarget[];
};
const storedSchema = z.strictObject({ id: z.string().regex(/^(?:[0-9a-f-]{36}|pm-[0-9a-f]{32})$/), label: z.string(), kind: z.enum(["native", "project"]), scope: extensionProjectScopeSchema.optional(), binding: z.record(z.string(), z.unknown()).optional(), providerBinding: z.record(z.string(), z.unknown()).optional(), externalTargets: z.array(z.record(z.string(), z.unknown())).optional(), createdAt: z.iso.datetime(), unifiedSkillsOwned: z.boolean().optional() });
export function extensionDataDirectory(): string { return path.join(dataDirectory(), "cc-switch"); }
export function projectExtensionContextId(scope: ExtensionProjectScope): string {
  return `pm-${createHash("sha256").update(`${scope.actorId}\0${scope.workspaceId}\0${scope.projectId}`).digest("hex").slice(0, 32)}`;
}
export async function privateDirectory(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExtensionError(503, "private_storage_unsafe", "Configuration storage must be a host-owned directory, not a symbolic link.");
  try { if (created) makePrivatePath(directory); else assertPrivatePath(directory); }
  catch { throw new ExtensionError(503, "private_storage_unsafe", "Configuration storage must exclude all other accounts, including a current-user-only ACL on Windows."); }
}
export function contextDataDirectory(contextId: string): string {
  if (!/^(?:[0-9a-f-]{36}|pm-[0-9a-f]{32})$/.test(contextId)) throw new ExtensionError(404, "context_not_found", "Unknown management context.");
  return path.join(extensionDataDirectory(), "contexts", contextId);
}
export async function readExtensionContexts(): Promise<StoredExtensionContext[]> {
  await privateDirectory(extensionDataDirectory());
  const filename = path.join(extensionDataDirectory(), "contexts.json");
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe registry");
    assertPrivatePath(filename);
    const parsed = z.array(storedSchema).parse(JSON.parse(await readFile(filename, "utf8")));
    if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new Error("duplicate context");
    for (const item of parsed) {
      if (item.kind === "project" && (!item.scope || item.binding || item.providerBinding || item.externalTargets || item.unifiedSkillsOwned || item.id !== projectExtensionContextId(item.scope))) throw new Error("invalid project context");
      if (item.kind === "native" && (!item.binding || item.scope)) throw new Error("invalid native context");
    }
    return parsed as unknown as StoredExtensionContext[];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw new ExtensionError(503, "context_registry_unavailable", "The private context registry is invalid or unavailable; no replacement registry was created.");
  }
}
export async function saveExtensionContexts(contexts: StoredExtensionContext[]): Promise<void> {
  const root = extensionDataDirectory();
  await privateDirectory(root);
  const temporary = path.join(root, `.contexts-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { makePrivatePath(temporary); await file.writeFile(JSON.stringify(contexts)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path.join(root, "contexts.json"));
  } finally { await unlink(temporary).catch(() => undefined); }
}
let nativeKeyQueue: Promise<void> = Promise.resolve();
export async function contextSecretKey(context: StoredExtensionContext): Promise<string> {
  let key: Buffer;
  if (context.kind === "project") {
    const encoded = process.env.PM_AUTOMATION_INTEGRATIONS_KEY;
    if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new ExtensionError(503, "project_private_storage_unavailable", "Configure the existing PM_AUTOMATION_INTEGRATIONS_KEY deployment key before accessing private project definitions.");
    key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new ExtensionError(503, "project_private_storage_unavailable", "The project credential deployment key is invalid.");
  } else {
    const previous = nativeKeyQueue;
    const gate = Promise.withResolvers<void>();
    nativeKeyQueue = previous.then(() => gate.promise);
    await previous;
    try {
    await privateDirectory(extensionDataDirectory());
    const filename = path.join(extensionDataDirectory(), "secret.key");
    const keyExists = await lstat(filename).then(() => true, error => { if (error?.code === "ENOENT") return false; throw error; });
    if (!keyExists) {
      for (const previous of await readExtensionContexts()) {
        if (previous.kind !== "native") continue;
        const databaseExists = await lstat(path.join(contextDataDirectory(previous.id), "cc-switch.db")).then(() => true, error => { if (error?.code === "ENOENT") return false; throw error; });
        if (databaseExists) throw new ExtensionError(503, "private_key_restore_required", "A native configuration database already exists without its matching encryption key. Restore the private backup; no replacement key was generated.");
      }
    }
    let file;
    try {
      file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        makePrivatePath(filename);
        const generated = randomBytes(32);
        try { await file.writeFile(generated); await file.sync(); } finally { generated.fill(0); }
      } finally { await file.close(); }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw new ExtensionError(503, "private_key_unavailable", "The native configuration encryption key could not be created safely.");
    }
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new ExtensionError(503, "private_key_unavailable", "The native configuration encryption key is unavailable."); });
    try {
      assertPrivatePath(filename);
      const stat = await handle.stat();
      if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) throw new ExtensionError(503, "private_key_permissions", "The native encryption key must be owned by the Agent account with mode 0600.");
      key = await handle.readFile();
      if (key.length !== 32) throw new ExtensionError(503, "private_key_invalid", "The native configuration encryption key is invalid; restore the matching private backup.");
    } finally { await handle.close(); }
    } finally { gate.resolve(); }
  }
  try {
    const identity = context.kind === "project" ? `${context.id}\0${context.scope!.actorId}\0${context.scope!.workspaceId}\0${context.scope!.projectId}` : context.id;
    return createHmac("sha256", key).update(`cc-switch:context-key:v1\0${identity}`).digest("base64");
  } finally { key.fill(0); }
}
