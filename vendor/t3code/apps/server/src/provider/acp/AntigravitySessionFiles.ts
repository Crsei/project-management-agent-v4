import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/** Native-owned metadata only: no prompt, credential access or session creation. */
export const readAntigravitySessionMetadata = Effect.fn("readAntigravitySessionMetadata")(
  function* (input: { readonly profileDirectory: string; readonly nativeSessionId: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!isNativeSessionId(input.nativeSessionId)) {
      return yield* AcpErrors.AcpRequestError.invalidParams("Antigravity native session ID is invalid.");
    }
    const directory = path.join(input.profileDirectory, "antigravity-acp", "conversations");
    const canonical = yield* fs.realPath(directory);
    if (canonical !== path.resolve(directory)) {
      return yield* AcpErrors.AcpRequestError.invalidParams("Antigravity session metadata escaped its private profile.");
    }
    const base = path.join(canonical, input.nativeSessionId);
    for (const suffix of [".meta", ".db"]) {
      const file = `${base}${suffix}`;
      const info = yield* fs.stat(file);
      if (info.type !== "File" || (suffix === ".meta" && Number(info.size) > 64 * 1024)
        || (yield* fs.realPath(file)) !== file) {
        return yield* AcpErrors.AcpRequestError.invalidParams("Antigravity native session metadata is invalid.");
      }
    }
    const metadata = yield* fs.readFileString(`${base}.meta`).pipe(Effect.flatMap(decodeSessionMetadata));
    if (!path.isAbsolute(metadata.cwd) || metadata.cwd.includes("\0")) {
      return yield* AcpErrors.AcpRequestError.invalidParams("Antigravity native session directory is invalid.");
    }
    return { cwd: metadata.cwd };
  },
  Effect.mapError(() => AcpErrors.AcpRequestError.invalidParams(
    "The Antigravity session could not be verified in this account's private native history.",
  )),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

/** Sweep only private runtimes before launch; Windows does not protect live extracted data files from deletion. */
export const removeAntigravityRuntimeTempDirs = Effect.fn("removeAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDirectory, { recursive: true, force: true });
  },
  Effect.catch(() =>
    Effect.logWarning("Could not remove leftover Antigravity runtime temp files."),
  ),
);
