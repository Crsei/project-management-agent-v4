import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { EnvironmentId } from "@t3tools/contracts";
import { ServerEnvironmentIdentity } from "./upstream-services/server-environment.ts";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import type { ProviderCredentials } from "@t3tools/provider-core/server/ProviderHost";
import { make as makeUpstreamCredentials } from "../../../../../../vendor/t3code/apps/server/src/provider/ProviderCredentialStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { providerDataDirectory } from "../instances.ts";
import { SecretStoreError, ServerSecretStore } from "./upstream-services/server-secret-store.ts";

/** No native credential file is consulted: only explicit controller writes enter this store. */
export function makePmProviderCredentials(root = providerDataDirectory()) {
  const secrets = makePmServerSecretStore(root);
  const owner = createHash("sha256").update(path.resolve(root)).digest("hex");
  return (namespace: string, bindingId: string): Effect.Effect<ProviderCredentials> =>
    makeUpstreamCredentials(namespace, bindingId).pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provide(NodeCrypto.layer),
      Effect.map(credentials => ({
        binding: { owner: "t3" as const, key: `${owner}:${credentials.binding.key}` },
        get: credentials.get.pipe(Effect.mapError(cause => new ProviderCredentialError({ operation: "get", cause }))),
        set: bytes => credentials.set(bytes).pipe(Effect.mapError(cause => new ProviderCredentialError({ operation: "set", cause }))),
        remove: credentials.remove.pipe(Effect.mapError(cause => new ProviderCredentialError({ operation: "remove", cause }))),
      })),
    );
}
export function makePmServerSecretStore(root = providerDataDirectory()): ServerSecretStore["Service"] {
  const directory = path.join(path.resolve(root), "provider-private", "secrets");
  const file = (name: string) => {
    if (!name || name.includes("\0")) throw new Error("Invalid secret binding.");
    return path.join(directory, createHash("sha256").update(name).digest("hex") + ".bin");
  };
  const secureDirectory = () => {
    for (const dir of [path.dirname(directory), directory]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe private secret directory.");
      chmodSync(dir, 0o700);
    }
  };
  const assertFile = (target: string) => {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe private secret record.");
    chmodSync(target, 0o600);
  };
  const operation = <A>(op: SecretStoreError["operation"], name: string, use: () => A) =>
    Effect.try({ try: () => { secureDirectory(); return use(); }, catch: cause => new SecretStoreError({ operation: op, resource: "provider-private", cause }) });
  const read = (name: string): Option.Option<Uint8Array> => {
    const target = file(name);
    try { assertFile(target); return Option.some(readFileSync(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Option.none(); throw error; }
  };
  const publish = (name: string, value: Uint8Array, exclusive: boolean) => {
    const target = file(name);
    const temporary = path.join(directory, ".secret-" + randomUUID());
    let publicationFailure: { error: unknown } | undefined;
    try {
      writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
      if (exclusive) linkSync(temporary, target); else renameSync(temporary, target);
      assertFile(target);
    } catch (error) {
      publicationFailure = { error };
    }
    try { unlinkSync(temporary); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (publicationFailure) throw new AggregateError([publicationFailure.error, error], "Private credential publication and cleanup failed.");
        throw error;
      }
    }
    if (publicationFailure) throw publicationFailure.error;
  };
  return {
    directory,
    get: name => operation("get", name, () => read(name)),
    set: (name, value) => operation("set", name, () => publish(name, value, false)),
    create: (name, value) => operation("create", name, () => publish(name, value, true)),
    getOrCreateRandom: (name, bytes) => operation("random", name, () => {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1_048_576) throw new Error("Invalid random secret size.");
      const previous = read(name);
      if (Option.isSome(previous)) return previous.value;
      try { publish(name, randomBytes(bytes), true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      return Option.getOrThrow(read(name));
    }),
    remove: name => operation("remove", name, () => {
      const target = file(name);
      try { assertFile(target); unlinkSync(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }),
  };
}
export const makeIdentity = Effect.gen(function* () {
  const bytes = yield* makePmServerSecretStore().getOrCreateRandom("provider-environment-identity-v1", 16);
  const value = Uint8Array.from(bytes);
  if (value.length !== 16) return yield* Effect.die(new Error("Invalid private environment identity."));
  value[6] = (value[6]! & 15) | 64;
  value[8] = (value[8]! & 63) | 128;
  const hex = Buffer.from(value).toString("hex");
  const id = EnvironmentId.make(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  return ServerEnvironmentIdentity.of({ getEnvironmentId: Effect.succeed(id) });
}).pipe(Effect.orDie);
export const layerIdentity = Layer.effect(ServerEnvironmentIdentity, makeIdentity);
