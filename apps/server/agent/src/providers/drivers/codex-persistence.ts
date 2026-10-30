import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { z } from "zod";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { makePmServerSecretStore } from "../t3code/credentials.ts";
import { ServerSecretStore } from "../t3code/upstream-services/server-secret-store.ts";
import * as ProviderCredentialStore from "../../../../../../vendor/t3code/apps/server/src/provider/ProviderCredentialStore.ts";

const legacySchema = z.object({
  hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/i), activeClientId: z.string().nullable(),
  profiles: z.array(z.object({ clientId: z.string().regex(/^oaiapp_[A-Za-z0-9_-]+$/), subject: z.string(), email: z.string().nullable(),
    redirectUri: z.string().url(), accessToken: z.string().nullable(), refreshToken: z.string().nullable(), idToken: z.string().nullable(),
    expiresAt: z.number().finite(), earliestRefreshAt: z.number().finite().nullable(), scopes: z.array(z.string()) })),
});

/** Startup-only conversion of this application's old managed state. Never reads a native/global credential file. */
export async function migrateCodexManagedState(context: ProviderDriverContext): Promise<void> {
  if (context.driver !== "codex" || context.config.setupMode !== "managed") return;
  const directory = path.join(context.stateDirectory, ".managed-codex");
  const marker = path.join(directory, "source-auth-migration-v1.json");
  const missing = (error: unknown) => error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  try {
    const migrated = await lstat(marker);
    if (!migrated.isFile() || migrated.isSymbolicLink() || (migrated.mode & 0o077) !== 0
      || (process.getuid && migrated.uid !== process.getuid())) throw new Error("Unsafe managed Codex migration marker.");
    if (JSON.parse(await readFile(marker, "utf8"))?.version !== 1) throw new Error("Unsupported managed Codex migration marker.");
    return;
  } catch (error) { if (!missing(error)) throw error; }
  try { await lstat(path.join(directory, "credentials.json")); } catch (error) { if (missing(error)) return; throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Managed Codex state migration requires its private application directory.");
  const lock = path.join(directory, "credentials.lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    const file = path.join(directory, "credentials.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Managed Codex state migration refused an unsafe application credential record.");
    const legacy = legacySchema.parse(JSON.parse(await readFile(file, "utf8")));
    const ids = new Set(legacy.profiles.map(profile => profile.clientId));
    if (ids.size !== legacy.profiles.length || (legacy.activeClientId && !ids.has(legacy.activeClientId))) throw new Error("Managed Codex state migration found inconsistent account ownership.");
    const sessions = legacy.profiles.filter(profile => profile.accessToken).map(profile => ({ clientId: profile.clientId,
      subject: profile.subject, email: profile.email, accessToken: profile.accessToken, refreshToken: profile.refreshToken,
      expiresAt: profile.expiresAt, earliestRefreshAt: profile.earliestRefreshAt, scopes: profile.scopes,
      ...(profile.idToken ? { idToken: profile.idToken, issuer: "https://auth.openai.com" } : {}) }));
    const records = [
      { namespace: "codex-chatgpt", value: { activeClientId: sessions.some(session => session.clientId === legacy.activeClientId) ? legacy.activeClientId : null, sessions } },
      { namespace: "codex-chatgpt-registration", value: { lastClientId: legacy.activeClientId, profiles: legacy.profiles.map((profile, index) => ({
        clientId: profile.clientId, subject: profile.subject, email: profile.email, redirectUri: profile.redirectUri,
        connectionLabel: `Connection ${index + 1}`, sharingEnabled: profile.scopes.includes("chatgpt.tokens.use.direct"),
      })) } },
      { namespace: "codex-chatgpt-host", value: { hostId: legacy.hostId } },
    ];
    await Effect.runPromise(Effect.gen(function* () {
      const pending = [];
      // Check every namespace before publishing any: a later divergent destination must reject atomically.
      for (const record of records) {
        const target = yield* ProviderCredentialStore.make(record.namespace, context.instanceId);
        const bytes = new TextEncoder().encode(JSON.stringify(record.value));
        const existing = yield* target.get;
        if (Option.isSome(existing)) {
          if (new TextDecoder().decode(existing.value) !== new TextDecoder().decode(bytes)) throw new Error("Managed Codex source state already differs; migration did not overwrite either account.");
        } else pending.push({ target, bytes });
      }
      for (const { target, bytes } of pending) yield* target.set(bytes);
    }).pipe(Effect.provideService(ServerSecretStore, makePmServerSecretStore()), Effect.provide(NodeCrypto.layer)));
    const temporary = path.join(directory, `.source-migration-${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1 }), { mode: 0o600, flag: "wx" });
      await rename(temporary, marker);
    } finally { await rm(temporary, { force: true }); }
    // The original remains an operator rollback input; it is never consulted by production after cutover.
  } finally { await rm(lock, { recursive: true }); }
}
