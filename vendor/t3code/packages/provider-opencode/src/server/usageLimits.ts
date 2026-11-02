import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const AuthFile = Schema.Struct({
  "opencode-go": Schema.optionalKey(Schema.Unknown),
  opencode: Schema.optionalKey(Schema.Unknown),
});
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api".
const StoredKey = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ server: Schema.optionalKey(Schema.Unknown) })),
  ),
});
const decodeStoredKey = Schema.decodeOption(Schema.fromJsonString(StoredKey));
const UsageWindow = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(["ok", "rate-limited"])),
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});
const decodeEntitlementError = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("error"),
    error: Schema.Struct({ type: Schema.Literal("EntitlementError") }),
  }),
);
const usedPercent = (window: typeof UsageWindow.Type) =>
  window.status === "rate-limited" ? 100 : clampPercent(window.percent);

// Select before decoding so an OAuth or self-hosted connection cannot fall
// through to another stored account. NULL-active rows predate the selection flag.
const readStoredApiKey = (databasePath: string) =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          `SELECT value FROM credential
           WHERE integration_id IN ('opencode-go', 'opencode') AND active IS NOT 0
           ORDER BY CASE integration_id WHEN 'opencode-go' THEN 0 ELSE 1 END,
                    active DESC, time_created DESC, id DESC LIMIT 1`,
        )
        .get();
      const stored =
        typeof row?.value === "string"
          ? Option.getOrUndefined(decodeStoredKey(row.value))
          : undefined;
      const server = stored?.metadata?.server;
      if (typeof server === "string") {
        const url = new URL(server);
        if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console")
          return undefined;
      }
      return stored?.key.trim();
    } finally {
      database.close();
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    // Read legacy credentials only when needed. A stale/malformed auth.json must
    // not block a valid selected OpenCode 2 connection.
    const readLegacyKey = Effect.gen(function* () {
      const contents =
        env.OPENCODE_AUTH_CONTENT ||
        (yield* fs.readFileString(path.join(dataHome, "opencode", "auth.json")).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
          }),
        ));
      const auth = yield* decodeAuthFile(contents);
      const apiAuth = decodeApiAuth(auth["opencode-go"] ?? auth.opencode);
      // Preserve OpenCode's stored-over-environment credential precedence.
      return (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    });
    // Inline auth explicitly overrides the local database. Native Go entries
    // precede the legacy public Console alias; never enumerate other accounts.
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const storedKey =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? undefined
        : yield* readStoredApiKey(path.resolve(dataHome, "opencode", databaseFile));
    let apiKey = storedKey || (yield* readLegacyKey);
    if (!apiKey) return unsupported;

    const client = yield* HttpClient.HttpClient;
    const readUsage = (key: string) =>
      client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.setHeader("Accept", "application/json"),
        ),
      );
    let response = yield* readUsage(apiKey);
    if ((response.status === 401 || response.status === 403) && storedKey) {
      const legacyKey = yield* readLegacyKey;
      if (legacyKey && legacyKey !== apiKey) {
        apiKey = legacyKey;
        response = yield* readUsage(apiKey);
      }
    }
    // Only an explicit entitlement response proves the absence of a Go plan.
    if (response.status === 403) {
      const errorBody = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
      if (Option.isSome(decodeEntitlementError(errorBody))) return unsupported;
    }
    if (response.status < 200 || response.status >= 300)
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: `OpenCode Go usage request failed (HTTP ${response.status}).`,
      });
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: usedPercent(body.usage.rolling),
        resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: usedPercent(body.usage.weekly),
        resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: usedPercent(body.usage.monthly),
        resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
      },
    ];
    const crypto = yield* Crypto.Crypto;
    // Unkeyed hashes match across environments; random Go keys resist offline guessing.
    const credentialFingerprint = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`opencode-go\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
