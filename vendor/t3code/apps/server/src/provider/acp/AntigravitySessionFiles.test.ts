import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { readAntigravitySessionMetadata, removeAntigravitySessionFiles } from "./AntigravitySessionFiles.ts";

const nativeSessionId = "72dd4d92-af0c-4680-9233-1cc2fa30befe";
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pm-antigravity-metadata-" });
  const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
  const cwd = path.join(profileDirectory, "owned-workspace");
  yield* fs.makeDirectory(conversations, { recursive: true });
  yield* fs.makeDirectory(cwd);
  const base = path.join(conversations, nativeSessionId);
  yield* fs.writeFileString(`${base}.meta`, JSON.stringify({ cwd }));
  // Native resume performs the protocol-level verification. This reader only establishes
  // filesystem ownership and cwd; bytes/usage rows cannot invent a completed turn.
  yield* fs.writeFileString(`${base}.db`, "native history remains opaque");
  return { fs, path, profileDirectory, cwd, base };
});

it.effect("reads only actual native cwd metadata and rejects opaque IDs or missing history", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.deepEqual(yield* readAntigravitySessionMetadata({ profileDirectory: f.profileDirectory, nativeSessionId }), { cwd: f.cwd });
    assert.isTrue(Exit.isFailure(yield* readAntigravitySessionMetadata({ profileDirectory: f.profileDirectory, nativeSessionId: "../foreign" }).pipe(Effect.exit)));
    yield* f.fs.remove(`${f.base}.db`);
    assert.isTrue(Exit.isFailure(yield* readAntigravitySessionMetadata({ profileDirectory: f.profileDirectory, nativeSessionId }).pipe(Effect.exit)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("does not adopt malformed or relative native cwd metadata", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const value of ["{", JSON.stringify({ cwd: "relative" }), JSON.stringify({ cwd: 12 })]) {
      yield* f.fs.writeFileString(`${f.base}.meta`, value);
      assert.isTrue(Exit.isFailure(yield* readAntigravitySessionMetadata({ profileDirectory: f.profileDirectory, nativeSessionId }).pipe(Effect.exit)));
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.skipIf(!symlinksSupported)("rejects a native metadata symlink outside the owned profile", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const outside = yield* f.fs.makeTempDirectoryScoped({ prefix: "pm-antigravity-foreign-" });
    const file = f.path.join(outside, "foreign.meta");
    yield* f.fs.writeFileString(file, JSON.stringify({ cwd: outside }));
    yield* f.fs.remove(`${f.base}.meta`);
    yield* f.fs.symlink(file, `${f.base}.meta`);
    assert.isTrue(Exit.isFailure(yield* readAntigravitySessionMetadata({ profileDirectory: f.profileDirectory, nativeSessionId }).pipe(Effect.exit)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("temporary session cleanup preserves foreign cwd and deletes only the exact native session", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* removeAntigravitySessionFiles({ profileDirectory: f.profileDirectory, sessionId: nativeSessionId, cwd: f.path.join(f.profileDirectory, "foreign") });
    assert.isTrue(yield* f.fs.exists(`${f.base}.db`));
    const brain = f.path.join(f.profileDirectory, "antigravity-acp", "brain", nativeSessionId);
    yield* f.fs.makeDirectory(brain, { recursive: true });
    yield* f.fs.writeFileString(`${f.base}.db-wal`, "owned journal");
    yield* removeAntigravitySessionFiles({ profileDirectory: f.profileDirectory, sessionId: nativeSessionId, cwd: f.cwd });
    for (const file of [`${f.base}.db`, `${f.base}.meta`, `${f.base}.db-wal`, brain]) assert.isFalse(yield* f.fs.exists(file));
    assert.isTrue(yield* f.fs.exists(f.cwd));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
