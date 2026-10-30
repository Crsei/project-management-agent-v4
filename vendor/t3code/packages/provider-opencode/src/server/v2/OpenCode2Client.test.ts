import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_BODY = '{"version":"2.0.18","pid":4242,"urls":[],"paths":{"tmp":"/tmp"}}';

const authorizationFor = (password: string | Redacted.Redacted) => {
  const seen: Array<string | undefined> = [];
  const layerCapturing = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          new Response(INFO_BODY, { headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
  return Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password });
    yield* client.server.info();
    return seen[0];
  }).pipe(Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerCapturing))));
};

const utf8Basic = (password: string) =>
  `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;

describe("OpenCode2Client authorization", () => {
  // OpenCode requires UTF-8 Basic auth; btoa rejects or misencodes non-ASCII.
  it.effect("encodes non-ASCII passwords as UTF-8", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* authorizationFor("pässwörd"), utf8Basic("pässwörd"));
      assert.strictEqual(yield* authorizationFor("pass€word"), utf8Basic("pass€word"));
      assert.strictEqual(yield* authorizationFor(Redacted.make("pässwörd")), utf8Basic("pässwörd"));
    }),
  );
});

it.effect("decodes UTF-8 and CRLF SSE split at every byte through the original typed client", () =>
  Effect.gen(function* () {
    const event = { id: "evt_fragmented", type: "session.text.delta", created: 1793318400000,
      data: { sessionID: "ses_fragmented", assistantMessageID: "msg_fragmented", ordinal: 0, delta: "計算=42" } };
    const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
    const http = HttpClient.make(request => Effect.succeed(HttpClientResponse.fromWeb(request,
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    )));
    const api = yield* OpenCode2Client.make.pipe(Effect.provideService(HttpClient.HttpClient, http));
    const connection = yield* api.connect({ baseUrl: "http://fixture.invalid", password: "" });
    const events = yield* connection.events;
    assert.deepStrictEqual<unknown>(yield* Stream.runCollect(events), [event]);
  }),
);
