import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import {
  MessageId, NodeId, ProjectId, ProviderInstanceId, ProviderSessionId, RunAttemptId, RunId, ThreadId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { openCodeTestRuntimeHostLayer } from "../runtimeHost.fixture.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCode2Adapter from "./adapter.ts";

const layer = Layer.mergeAll(
  IdAllocator.layer,
  openCodeTestRuntimeHostLayer,
  TestProviderHost.layer({ cwd: "/workspace" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("OpenCode2Adapter native request lifecycle", (it) => {
  it.effect.each(["http-only", "event-before-http", "cancel"] as const)(
    "emits one native question closure for %s and ignores another session's reply",
    (mode) => Effect.gen(function* () {
      const sessionId = "ses_source_question";
      const formId = "frm_source_question";
      const instanceId = ProviderInstanceId.make("opencode-source-question");
      const threadId = ThreadId.make("thread-source-question");
      const nativeEvents = yield* Queue.unbounded<OpenCode2Client.OpenCode2StreamEvent>();
      const shown = yield* Deferred.make<OrchestrationV2RuntimeRequest>();
      const closed = yield* Deferred.make<void>();
      const fence = yield* Deferred.make<void>();
      const terminal = yield* Deferred.make<void>();
      const seen: ProviderAdapter.ProviderAdapterV2Event[] = [];
      let sequence = 0;
      const send = (type: string, data: Record<string, unknown>) => Queue.offer(nativeEvents,
        Schema.decodeUnknownSync(OpenCodeEvent)({
          id: `evt_source_${++sequence}`, type, data, created: 1,
          ...(!type.startsWith("form.") ? {
            durable: { aggregateID: String(data.sessionID), seq: sequence, version: 1 },
          } : {}),
        }),
      ).pipe(Effect.asVoid);
      const model = { providerID: "native-api", id: "model/one" };
      const native = {
        id: sessionId, projectID: "prj_source", agent: "build", model,
        title: "Source question", location: { directory: "/workspace" },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        permissions: [], time: { created: 1, updated: 1, idle: 1 },
      };
      const http = HttpClient.make((request) => Effect.gen(function* () {
        const url = new URL(request.url);
        let body: unknown;
        if (url.pathname === "/api/model") body = { location: { directory: "/workspace" }, data: [] };
        else if (request.method === "POST" && url.pathname === "/api/session") body = { data: native };
        else if (url.pathname.endsWith("/prompt")) body = { data: {
          id: "msg_source_prompt", sessionID: sessionId, type: "user", delivery: "queue",
          payload: { text: "hello", files: [], agents: [], skills: [] }, time: { created: 1 },
        } };
        else if ((request.method === "POST" && url.pathname === `/api/session/${sessionId}/form/${formId}/reply`)
          || (request.method === "DELETE" && url.pathname === `/api/session/${sessionId}/form/${formId}`)) {
          if (mode !== "http-only") {
            yield* send(mode === "cancel" ? "form.cancelled" : "form.replied", {
              sessionID: sessionId, id: formId, ...(mode === "cancel" ? {} : { answer: { color: "blue" } }),
            });
            // The source must publish the real native event while the HTTP answer is in flight.
            yield* Deferred.await(closed);
          }
          if (mode === "cancel") yield* send("session.execution.interrupted", { sessionID: sessionId, reason: "user" });
        } else if (!(request.method === "PATCH" && url.pathname === `/api/session/${sessionId}`)
          && !url.pathname.includes("/instructions/")) {
          return yield* Effect.die(new Error(`Unexpected native request: ${request.method} ${url.pathname}`));
        }
        return HttpClientResponse.fromWeb(request, body === undefined ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
      }));
      const api = yield* OpenCode2Client.make.pipe(Effect.provideService(HttpClient.HttpClient, http));
      const connection = yield* api.connect({ baseUrl: "http://native.invalid", password: "" });
      const adapter = yield* OpenCode2Adapter.make(instanceId).pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, OpenCode2Server.OpenCode2Server.of({
          withConnection: (use) => use({
            ...connection, url: "http://native.invalid", version: "2.1.2", external: false,
            events: Effect.succeed(Stream.fromQueue(nativeEvents)),
          }),
        })),
      );
      const modelSelection = { instanceId, model: "native-api/model/one", options: [] };
      const runtimePolicy = {
        runtimeMode: "full-access" as const, interactionMode: "default" as const, cwd: "/workspace",
      };
      const runtime = yield* adapter.openSession({
        providerSessionId: ProviderSessionId.make("session-source-question"), threadId, modelSelection, runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      yield* runtime.events.pipe(Stream.runForEach((event) => Effect.gen(function* () {
        seen.push(event);
        if (event.type === "runtime_request.updated") {
          if (event.runtimeRequest.status === "pending") yield* Deferred.succeed(shown, event.runtimeRequest);
          else yield* Deferred.succeed(closed, undefined);
        }
        if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          && event.turnItem.text === "native-fence") yield* Deferred.succeed(fence, undefined);
        if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
      })), Effect.forkScoped);
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        appThread: {
          id: threadId, projectId: ProjectId.make("project-source-question"), title: "Source question",
          providerInstanceId: instanceId, modelSelection, runtimeMode: "full-access", interactionMode: "default",
          branch: null, worktreePath: null, activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
          createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
          archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
        },
        threadId, providerThread, modelSelection, runtimePolicy,
        runId: RunId.make("run-source-question"), attemptId: RunAttemptId.make("attempt-source-question"),
        rootNodeId: NodeId.make("node-source-question"), runOrdinal: 1, providerTurnOrdinal: 1,
        message: { messageId: MessageId.make("message-source-question"), text: "hello", attachments: [],
          createdBy: "user", creationSource: "web" },
      });
      yield* send("session.execution.started", { sessionID: sessionId });
      yield* send("form.created", { form: {
        id: formId, sessionID: sessionId, title: "Color", metadata: { kind: "question" },
        fields: [{ key: "color", type: "string", title: "Color", options: [{ value: "blue", label: "Blue" }], custom: false }],
      } });
      const request = yield* Deferred.await(shown);
      yield* send("form.replied", { sessionID: "ses_foreign", id: formId, answer: { color: "blue" } });
      yield* send("session.text.ended", {
        sessionID: sessionId, assistantMessageID: "msg_source_answer", ordinal: 0, text: "native-fence",
      });
      yield* Deferred.await(fence);
      assert.equal(seen.filter((event) => event.type === "runtime_request.updated"
        && event.runtimeRequest.status !== "pending").length, 0);
      yield* runtime.respondToRuntimeRequest({ requestId: request.id,
        ...(mode === "cancel" ? { decision: "cancel" as const } : { answers: { color: "blue" } }) });
      yield* Deferred.await(closed);
      // Replayed native closure cannot emit a second resolved item or revive the live answer channel.
      yield* send(mode === "cancel" ? "form.cancelled" : "form.replied", {
        sessionID: sessionId, id: formId, ...(mode === "cancel" ? {} : { answer: { color: "blue" } }),
      });
      const stale = yield* Effect.flip(runtime.respondToRuntimeRequest({ requestId: request.id, answers: { color: "blue" } }));
      assert.equal(stale._tag, "ProviderAdapterProtocolError");
      if (mode !== "cancel") yield* send("session.execution.succeeded", { sessionID: sessionId });
      yield* Deferred.await(terminal);
      const requests = seen.flatMap((event) => event.type === "runtime_request.updated" ? [event.runtimeRequest] : []);
      assert.deepStrictEqual(requests.map((entry) => entry.status), ["pending", mode === "cancel" ? "cancelled" : "resolved"]);
      const items = seen.flatMap((event) => event.type === "turn_item.updated"
        && event.turnItem.type === "user_input_request" ? [event.turnItem] : []);
      assert.deepStrictEqual(items.map((item) => item.status), ["waiting", mode === "cancel" ? "cancelled" : "completed"]);
      assert.isNotNull(items.at(-1)?.completedAt);
      const end = seen.find((event) => event.type === "turn.terminal");
      assert.equal(end?.type === "turn.terminal" ? end.status : undefined, mode === "cancel" ? "interrupted" : "completed");
    }).pipe(Effect.timeout("5 seconds"), Effect.scoped),
  );
});
