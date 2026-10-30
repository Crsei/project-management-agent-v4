import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makePmProviderCredentials, makePmServerSecretStore } from "./credentials.ts";

test("application-private credentials isolate namespaces, roots and opaque bindings with secure atomic records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-provider-credentials-"));
  try {
    const make = makePmProviderCredentials(root);
    const a = await Effect.runPromise(make("cursor", "../../personal"));
    const same = await Effect.runPromise(make("cursor", "../../personal"));
    const other = await Effect.runPromise(make("other", "../../personal"));
    const separate = await Effect.runPromise(makePmProviderCredentials(path.join(root, "other-root"))("cursor", "../../personal"));
    assert.deepEqual(a.binding, same.binding); assert.notDeepEqual(a.binding, separate.binding);
    assert.equal(Option.isNone(await Effect.runPromise(a.get)), true);
    const bytes = Uint8Array.from([0, 255, 128, 1]);
    await Effect.runPromise(a.set(bytes));
    assert.deepEqual([...Option.getOrThrow(await Effect.runPromise(same.get))], [...bytes]);
    assert.equal(Option.isNone(await Effect.runPromise(other.get)), true);
    const directory = path.join(root, "provider-private", "secrets");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const name of await readdir(directory)) assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600);
    await Effect.runPromise(a.remove);
    assert.equal(Option.isNone(await Effect.runPromise(same.get)), true);
    assert.equal(Option.isNone(await Effect.runPromise(separate.get)), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exclusive secret creation has one winner and private backend failures are not missing credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-provider-secret-"));
  try {
    const store = makePmServerSecretStore(root);
    const created = await Promise.allSettled([Effect.runPromise(store.create("binding", Uint8Array.of(1))), Effect.runPromise(store.create("binding", Uint8Array.of(2)))]);
    assert.equal(created.filter(result => result.status === "fulfilled").length, 1);
    const random = await Promise.all([Effect.runPromise(store.getOrCreateRandom("identity", 16)), Effect.runPromise(store.getOrCreateRandom("identity", 16))]);
    assert.deepEqual([...random[0]!], [...random[1]!]);
    const bad = path.join(root, "unsafe");
    await mkdir(bad);
    await symlink(path.join(root, "provider-private"), path.join(bad, "provider-private"));
    const credential = await Effect.runPromise(makePmProviderCredentials(bad)("cursor", "one"));
    await assert.rejects(Effect.runPromise(credential.get), /ProviderCredentialError|credential/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
